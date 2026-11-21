#!/usr/bin/env python3
"""Build jobs/data.json for the Research Hub's "Auto care jobs across Canada" page.

Sources (all open data, Government of Canada):
- Job Bank wages by occupation, province and economic region (open.canada.ca dataset adad580f-..., newest year's CSV)
- Job Bank 3-year employment outlooks by province and economic region (dataset b0e112e9-..., newest NOC 2021 workbook)
- Canadian Occupational Projection System (COPS), national 10-year projections of job openings and job seekers
- Statistics Canada 2021 Census, tables 98-10-0449-01 (labour force status, education, age, gender by occupation) and
  98-10-0593-01 (class of worker by occupation), for Canada and each province and territory
Ontario-only detail (job postings, skills, employment trend) comes from tools/jobs_build.py (jobs/ontario.json).
"""
import csv, io, json, re, sys, time, datetime, urllib.request
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "jobs/data.json")
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 AIA-Canada-Research-Hub",
      "Accept": "application/json"}
CKAN = "https://open.canada.ca/data/api/action/"
WDS = "https://www150.statcan.gc.ca/t1/wds/rest/"
NOCS = [("72411", "Collision, refinishing and glass technicians"), ("72410", "Automotive service technicians"),
        ("74203", "Parts installers and servicers")]
PROVS = [("CA", "Canada"), ("NL", "Newfoundland and Labrador"), ("PE", "Prince Edward Island"), ("NS", "Nova Scotia"), ("NB", "New Brunswick"),
         ("QC", "Quebec"), ("ON", "Ontario"), ("MB", "Manitoba"), ("SK", "Saskatchewan"), ("AB", "Alberta"), ("BC", "British Columbia"),
         ("YT", "Yukon"), ("NT", "Northwest Territories"), ("NU", "Nunavut")]
PNAME = dict(PROVS)


def fetch(url, body=None, tries=4):
    for attempt in range(tries):
        try:
            h = dict(UA, **({"Content-Type": "application/json"} if body else {}))
            return urllib.request.urlopen(urllib.request.Request(url, data=body, headers=h), timeout=300).read()
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(10 * (attempt + 1))


def ckan(action, **q):
    return json.loads(fetch(CKAN + action + "?" + "&".join(f"{k}={urllib.request.quote(str(v))}" for k, v in q.items())))["result"]


def num(v):
    try:
        return float(str(v).replace(",", "").replace("$", "").strip())
    except Exception:
        return None


def text(s):
    s = re.sub(r"<[^>]+>", " ", s or "")
    return re.sub(r"\s+", " ", s.replace("&nbsp;", " ").replace("&amp;", "&")).strip()


def paras(s):
    s = re.sub(r"(?i)<li[^>]*>", "\n• ", s or "")
    s = re.sub(r"(?i)</p>|<br\s*/?>|</li>|<p[^>]*>|</?ul[^>]*>", "\n", s)
    return [l for l in (text(x) for x in s.split("\n")) if l]


def code(v):
    m = re.search(r"(\d{5})", str(v or ""))
    return m.group(1) if m else None


# ---------- Job Bank wages ----------
def wages():
    pkg = ckan("package_show", id="adad580f-76b0-4502-bd05-20c125de9116")
    res = [r for r in pkg["resources"] if str(r.get("format")).upper() == "CSV" and re.match(r"\s*\d{4} Wages", r.get("name", ""))]
    res.sort(key=lambda r: int(re.match(r"\s*(\d{4})", r["name"]).group(1)), reverse=True)
    raw = fetch(res[0]["url"])
    txt = raw.decode("utf-8-sig") if raw[:3] == b"\xef\xbb\xbf" else raw.decode("cp1252", "replace")
    out, period = {}, None
    want = {n for n, _ in NOCS}
    for row in csv.reader(io.StringIO(txt)):
        if not row or not row[0].startswith("NOC_") or code(row[0]) not in want:
            continue
        noc, prov, er, name = code(row[0]), row[3], row[4], row[5]
        prov = "CA" if prov == "NAT" else prov
        low, med, high, avg = num(row[7]), num(row[8]), num(row[9]), num(row[10])
        annual = len(row) > 18 and row[18].strip() == "1"
        period = period or (row[16] if len(row) > 16 else None)
        if med is None and low is None:
            continue
        rec = {"low": low, "median": med, "high": high, "avg": avg, "annual": annual, "source": row[14] if len(row) > 14 else ""}
        o = out.setdefault(noc, {}).setdefault(prov, {"regions": {}})
        er_code = er.replace("ER", "")
        if len(er_code) <= 2:  # ER00 = Canada, ER35 = Ontario
            o.update(rec)
        else:
            o["regions"][name.replace("--", "–").replace(" - ", "–")] = rec
    return out, {"wagesYear": re.match(r"\s*(\d{4})", res[0]["name"]).group(1), "wagesUrl": res[0]["url"]}


# ---------- Job Bank 3-year outlooks ----------
def outlooks():
    import openpyxl
    pkg = ckan("package_show", id="b0e112e9-cf53-4e79-8838-23cd98debe5b")
    res = [r for r in pkg["resources"] if "NOC 2021" in r.get("name", "") and "en" in (r.get("language") or []) and str(r.get("url", "")).lower().endswith(".xlsx")]
    res.sort(key=lambda r: r["name"], reverse=True)
    wb = openpyxl.load_workbook(io.BytesIO(fetch(res[0]["url"])), read_only=True)
    rows = wb.worksheets[0].iter_rows(values_only=True)
    head = [str(h or "") for h in next(rows)]
    ix = {k: head.index(k) for k in ["NOC_Code", "Outlook", "Employment Trends", "Release Date", "Province", "Economic Region Code", "Economic Region Name"]}
    want = {n for n, _ in NOCS}
    out, released = {}, None
    for r in rows:
        noc = code(r[ix["NOC_Code"]])
        if noc not in want:
            continue
        prov, erc, ern = r[ix["Province"]], str(r[ix["Economic Region Code"]] or ""), str(r[ix["Economic Region Name"]] or "")
        ps = paras(r[ix["Employment Trends"]])
        cut = next((i for i, p in enumerate(ps) if p.lower().startswith("here are some key facts")), len(ps))
        m = re.search(r"Approximately ([\d,]+) people work", " ".join(ps))
        rec = {"outlook": r[ix["Outlook"]], "text": ps[:cut], "workers": int(m.group(1).replace(",", "")) if m else None}
        released = released or r[ix["Release Date"]]
        o = out.setdefault(noc, {}).setdefault(prov, {"regions": {}})
        if erc.endswith("00") and len(erc) == 4:  # 1000 = the whole of Newfoundland and Labrador
            o.update(rec)
        else:
            o["regions"][ern.replace(" - ", "–").replace("--", "–")] = {k: rec[k] for k in ("outlook", "workers")}
    period = re.search(r"(\d{4}-\d{4})", res[0]["name"])
    return out, {"outlookPeriod": period.group(1) if period else "", "outlookReleased": str(released)[:10] if released else ""}


# ---------- COPS national projections ----------
def cops():
    found = ckan("package_search", q='title:"Canadian Occupational Projection System"', sort="metadata_modified desc", rows=10)["results"]
    pkg = next(p for p in found if "COPS" in p["title"] and re.search(r"\d{4} to \d{4}", p["title"]))
    res = {r["name"]: r["url"] for r in pkg["resources"]}
    pick = lambda pat: next(u for n, u in res.items() if re.search(pat, n, re.I))
    url = lambda u: u if u.startswith("http") else "https://open.canada.ca" + u
    rd = lambda u: list(csv.reader(io.StringIO(fetch(url(u)).decode("cp1252", "replace"))))
    want = {n for n, _ in NOCS} | {"00000"}
    summ = rd(pick(r"^Summary of the Components"))
    h = summ[0]
    out = {}
    for row in summ[1:]:
        if row and row[0] in want:
            g = lambda k: num(row[h.index(k)]) if k in h else None
            out[row[0]] = {"employment": g("Employment_emploi_2025") or num(row[3]), "growth": num(row[4]), "retirements": num(row[5]), "otherReplacement": num(row[6]),
                           "openings": num(row[7]), "schoolLeavers": num(row[8]), "immigrants": num(row[9]), "otherSeekers": num(row[10]), "seekers": num(row[11]),
                           "recent": row[12], "future": row[14] if len(row) > 14 else ""}
    emp = rd(pick(r"Employment by occupation"))
    years = [c for c in emp[0][3:]]
    for row in emp[1:]:
        if row and row[0] in out:
            out[row[0]]["path"] = {re.sub(r"\D", "", y)[-4:]: num(v) for y, v in zip(years, row[3:]) if num(v) is not None}
    span = re.search(r"(\d{4}) to (\d{4})", pkg["title"])
    return out, {"copsTitle": pkg["title"], "copsPeriod": f"{span.group(1)}–{span.group(2)}" if span else "", "copsUrl": f"https://open.canada.ca/data/en/dataset/{pkg['id']}"}


# ---------- 2021 Census ----------
def census():
    meta = lambda pid: json.loads(fetch(WDS + "getCubeMetadata", json.dumps([{"productId": pid}]).encode()))[0]["object"]["dimension"]

    def data(pid, coords):
        res = {}
        for i in range(0, len(coords), 100):
            batch = coords[i:i + 100]
            r = json.loads(fetch(WDS + "getDataFromCubePidCoordAndLatestNPeriods", json.dumps(
                [{"productId": pid, "coordinate": ".".join(map(str, list(c) + [0] * (10 - len(c)))), "latestN": 1} for c in batch]).encode()))
            for x in r:
                o = x.get("object") or {}
                pts = o.get("vectorDataPoint") or []
                if pts and pts[-1].get("value") is not None:
                    res[tuple(int(v) for v in o["coordinate"].split(".") if v != "0")] = float(pts[-1]["value"])
            time.sleep(1)
        return res

    d = meta(98100449)
    geo = {m["memberNameEn"]: m["memberId"] for m in d[0]["member"] if m.get("parentMemberId") in (None, 1) and m["memberNameEn"] in PNAME.values()}
    occ = {code(m["memberNameEn"]): m["memberId"] for m in d[4]["member"] if code(m["memberNameEn"]) in {n for n, _ in NOCS}}
    occ["all"] = next(m["memberId"] for m in d[4]["member"] if m["memberNameEn"] == "All occupations")
    EDU = [(2, "No certificate"), (3, "High school"), (6, "Apprenticeship or trades"), (9, "College"), (10, "University below bachelor"), (11, "Bachelor's or higher")]
    AGE = [(2, "15 to 24"), (7, "25 to 34"), (10, "35 to 44"), (11, "45 to 54"), (12, "55 to 64"), (13, "65 and over")]
    coords = []
    for g in geo.values():
        for o in occ.values():
            coords += [(g, 1, 1, 1, o, 1), (g, 1, 1, 1, o, 3), (g, 1, 1, 3, o, 1)]
            coords += [(g, e, 1, 1, o, 1) for e, _ in EDU] + [(g, 1, a, 1, o, 1) for a, _ in AGE]
    v = data(98100449, coords)
    # class of worker: employed, all classes vs self-employed
    d2 = meta(98100593)
    geo2 = {m["memberNameEn"]: m["memberId"] for m in d2[0]["member"] if m.get("parentMemberId") in (None, 1) and m["memberNameEn"] in PNAME.values()}
    occ2 = {code(m["memberNameEn"]): m["memberId"] for m in d2[5]["member"] if code(m["memberNameEn"]) in {n for n, _ in NOCS}}
    occ2["all"] = next(m["memberId"] for m in d2[5]["member"] if m["memberNameEn"] == "All occupations")
    v2 = data(98100593, [(g, 1, 2, 1, 1, o, c) for g in geo2.values() for o in occ2.values() for c in (3, 5)])
    out = {}
    for pc, pn in PROVS:
        g, g2 = geo.get(pn), geo2.get(pn)
        if not g:
            continue
        for key, o in occ.items():
            lf = v.get((g, 1, 1, 1, o, 1))
            if not lf:
                continue
            un = v.get((g, 1, 1, 1, o, 3))
            emp_all, self_emp = (v2.get((g2, 1, 2, 1, 1, occ2[key], 3)), v2.get((g2, 1, 2, 1, 1, occ2[key], 5))) if g2 else (None, None)
            out.setdefault(key, {})[pc] = {
                "labourForce": lf, "unemployment": round(un / lf * 100, 1) if un is not None else None,
                "women": round(v.get((g, 1, 1, 3, o, 1), 0) / lf * 100, 1),
                "education": [[n, round(v.get((g, e, 1, 1, o, 1), 0) / lf * 100, 1)] for e, n in EDU],
                "ages": [[n, round(v.get((g, 1, a, 1, o, 1), 0) / lf * 100, 1)] for a, n in AGE],
                "selfEmployed": round(self_emp / emp_all * 100, 1) if emp_all and self_emp is not None else None,
            }
    return out


def main():
    meta, errors, parts = {}, [], {}
    for name, fn in [("wages", wages), ("outlooks", outlooks), ("cops", cops), ("census", census)]:
        try:
            r = fn()
            if isinstance(r, tuple):
                parts[name], m = r
                meta.update(m)
            else:
                parts[name] = r
        except Exception as e:
            errors.append(f"{name}: {e!r}"[:300])
    old = json.loads(OUT.read_text()) if OUT.exists() else {}
    if errors and old:  # keep the last good copy of any source that failed this time
        for name in ("wages", "outlooks", "cops", "census"):
            if name not in parts and name in old.get("parts", {}):
                parts[name] = old["parts"][name]
        meta = {**old.get("meta", {}), **meta}
    if not parts:
        raise SystemExit("Nothing fetched: " + "; ".join(errors))
    out = {"trades": [{"noc": n, "short": s} for n, s in NOCS], "provinces": [{"code": c, "name": n} for c, n in PROVS],
           "parts": parts, "meta": meta, "errors": errors, "built": datetime.date.today().isoformat()}
    if old and {k: v for k, v in old.items() if k != "built"} == json.loads(json.dumps({k: v for k, v in out.items() if k != "built"})):
        print("unchanged"); return
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":"), default=str))
    print(f"wrote {OUT}; errors: {errors}")
    for n, _ in NOCS:
        print(n, "wages", len(parts.get("wages", {}).get(n, {})), "outlooks", len(parts.get("outlooks", {}).get(n, {})),
              "census", len(parts.get("census", {}).get(n, {})), "cops", parts.get("cops", {}).get(n, {}).get("future"))


if __name__ == "__main__":
    main()
