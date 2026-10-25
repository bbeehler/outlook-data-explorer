#!/usr/bin/env python3
"""Build cities/data.json for the Research Hub's Cities page: a profile of every census metropolitan area (CMA).

All from Statistics Canada's Web Data Service (Statistics Canada Open Licence):
  - Population and age mix, July 1 each year ............ Table 17-10-0148-01 (2021 boundaries)
  - Unemployment rate and employment, monthly ........... Table 14-10-0459-01 (three-month moving average, seasonally adjusted)
  - Median household income, 2020 and 2015 .............. Table 98-10-0061-01 (2021 Census)
  - How people get to work, average commute ............. Table 98-10-0457-01 (2021 Census)
  - New vehicle registrations by fuel type, quarterly ... Table 20-10-0025-01
  - Consumer prices (all items), for cities covered ..... Table 18-10-0004-01
Metro areas are matched across tables by name. Anything that can't be matched or fetched is listed under "errors".
Usage: python3 tools/cities_build.py [output path]
"""
import json, sys, re, datetime, unicodedata, urllib.request
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "cities/data.json")
WDS = "https://www150.statcan.gc.ca/t1/wds/rest/"
MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
errors = []


def post(path, body):
    req = urllib.request.Request(WDS + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=300))


def meta(pid):
    return post("getCubeMetadata", [{"productId": pid}])[0]["object"]


def geo_members(m):
    return [(x["memberId"], x["memberNameEn"]) for x in [d for d in m["dimension"] if d["dimensionPositionId"] == 1][0]["member"]]


def norm(name):
    """'St. Catharines - Niagara (CMA), Ontario' / 'St. Catharines-Niagara, Ontario' -> 'stcatharinesniagara'"""
    n = re.sub(r"\(CMA\)|\(CA\)", "", name)
    n = re.sub(r"\((Ontario|Quebec) part\)", "", n)
    n = n.split(",")[0].split("/")[0]
    n = unicodedata.normalize("NFKD", n).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z]", "", n)


def coord(*ids):
    ids = list(ids) + [0] * (10 - len(ids))
    return ".".join(str(i) for i in ids)


def fetch(pid, coords, n):
    """Many series from one table: {coordinate: {refPer: value}}. Requests are sent in batches."""
    out = {}
    for i in range(0, len(coords), 100):
        batch = coords[i:i + 100]
        res = post("getDataFromCubePidCoordAndLatestNPeriods", [{"productId": pid, "coordinate": c, "latestN": n} for c in batch])
        for r in res:  # results don't come back in request order: key them by the coordinate StatCan returns
            if r.get("status") != "SUCCESS":
                continue
            c = r["object"]["coordinate"]
            c = coord(*[int(x) for x in c.split(".") if x != ""][:10]) if c else None
            if c not in batch:
                continue
            pts = {}
            for p in r["object"]["vectorDataPoint"]:
                if p.get("value") is not None:
                    pts[p["refPer"]] = float(p["value"]) * (10 ** int(p.get("scalarFactorCode") or 0))
            out[c] = dict(sorted(pts.items()))
    return out


def month_label(d): return f"{MON[int(d[5:7]) - 1]} {d[:4]}"
def quarter_label(d): return f"Q{(int(d[5:7]) - 1) // 3 + 1} {d[:4]}"


def main():
    # ---- the list of metro areas comes from the population table ----
    pm = meta(17100148)
    cmas = []
    for mid, name in geo_members(pm):
        if "(CMA)" in name and " part" not in name:
            city, _, prov = name.partition("(CMA)")
            cmas.append({"key": norm(name), "name": city.strip(), "province": prov.strip(" ,"), "_pop": mid})
    by_key = {c["key"]: c for c in cmas}
    CANADA = {"key": "canada", "name": "Canada", "province": ""}

    def match(m, label, accept=lambda n: True):
        ids = {}
        for mid, name in geo_members(m):
            if name == "Canada":
                ids["canada"] = mid
            elif accept(name) and not re.search(r"\bpart\b", name):  # skip the Ontario/Quebec halves of Ottawa - Gatineau
                k = norm(name)
                if k not in by_key:  # e.g. 'Belleville, Ontario' for 'Belleville - Quinte West'
                    cand = [x for x in by_key if x.startswith(k) and len(k) >= 6]
                    k = cand[0] if len(cand) == 1 else None
                if k and k not in ids:
                    ids[k] = mid
        missing = [c["name"] for c in cmas if c["key"] not in ids]
        if missing:
            errors.append(f"{label}: no match for {', '.join(missing)}")
        return ids

    keys = ["canada"] + [c["key"] for c in cmas]
    data = {k: {} for k in keys}

    # ---- population and age mix ----
    try:
        pop_ids = {"canada": 1, **{c["key"]: c["_pop"] for c in cmas}}
        ages = {"all": 1, "young": 111, "working": 112, "senior": 113, "median": 114}
        res = fetch(17100148, [coord(pop_ids[k], 1, a) for k in keys for a in ages.values()], 10)
        for k in keys:
            s = {name: res.get(coord(pop_ids[k], 1, a), {}) for name, a in ages.items()}
            yrs = sorted(s["all"])
            if not yrs:
                continue
            last = yrs[-1]
            data[k]["pop"] = {"years": [y[:4] for y in yrs], "vals": [round(s["all"][y]) for y in yrs]}
            tot = s["all"][last]
            data[k]["ages"] = {"year": last[:4], "young": round(s["young"].get(last, 0) / tot, 4), "working": round(s["working"].get(last, 0) / tot, 4),
                               "senior": round(s["senior"].get(last, 0) / tot, 4), "median": s["median"].get(last)}
    except Exception as e:
        errors.append(f"population: {e}")

    # ---- jobs ----
    try:
        lm = meta(14100459)
        ids = match(lm, "jobs", lambda n: "," in n)
        res = fetch(14100459, [coord(ids[k], ch, 1, 1) for k in keys if k in ids for ch in (5, 3)], 61)
        for k in keys:
            if k not in ids:
                continue
            un = res.get(coord(ids[k], 5, 1, 1), {}); em = res.get(coord(ids[k], 3, 1, 1), {})
            if un:
                data[k]["jobs"] = {"months": [month_label(d) for d in un], "unemp": [round(v / 100, 4) for v in un.values()],
                                   "employed": [round(v) for v in em.values()] if len(em) == len(un) else None}
    except Exception as e:
        errors.append(f"jobs: {e}")

    # ---- 2021 Census: household income and commuting ----
    try:
        im = meta(98100061)
        ids = match(im, "census income", lambda n: "(CMA)" in n and "part)" not in n)
        res = fetch(98100061, [coord(ids[k], 1, 1, s) for k in keys if k in ids for s in (2, 10)], 1)
        for k in keys:
            if k in ids:
                a = list(res.get(coord(ids[k], 1, 1, 2), {}).values()); b = list(res.get(coord(ids[k], 1, 1, 10), {}).values())
                if a:
                    data[k]["income"] = {"median2020": round(a[-1]), "median2015": round(b[-1]) if b else None}
    except Exception as e:
        errors.append(f"census income: {e}")
    try:
        cm = meta(98100457)
        ids = match(cm, "census commuting", lambda n: "(CMA)" in n and "part)" not in n)
        modes = {"total": 1, "car": 2, "transit": 12, "active": 17}
        cs = [coord(ids[k], 1, 1, 1, 1, md, 1) for k in keys if k in ids for md in modes.values()] + [coord(ids[k], 1, 1, 1, 1, 1, 7) for k in keys if k in ids]
        res = fetch(98100457, cs, 1)
        for k in keys:
            if k not in ids:
                continue
            v = {name: list(res.get(coord(ids[k], 1, 1, 1, 1, md, 1), {}).values()) for name, md in modes.items()}
            avg = list(res.get(coord(ids[k], 1, 1, 1, 1, 1, 7), {}).values())
            if v["total"] and v["total"][-1]:
                t = v["total"][-1]
                data[k]["commute"] = {"car": round(v["car"][-1] / t, 4) if v["car"] else None, "transit": round(v["transit"][-1] / t, 4) if v["transit"] else None,
                                      "active": round(v["active"][-1] / t, 4) if v["active"] else None, "avgMin": round(avg[-1], 1) if avg else None, "commuters": round(t)}
    except Exception as e:
        errors.append(f"census commuting: {e}")

    # ---- new vehicle registrations by fuel type ----
    try:
        vm = meta(20100025)
        ids = match(vm, "vehicle registrations", lambda n: "," in n)
        fuels = {"all": 4, "bev": 2, "phev": 3, "hybrid": 7}
        res = fetch(20100025, [coord(ids[k], f, 1, 1) for k in keys if k in ids for f in fuels.values()], 12)
        for k in keys:
            if k not in ids:
                continue
            s = {name: res.get(coord(ids[k], f, 1, 1), {}) for name, f in fuels.items()}
            qs = sorted(s["all"])
            if qs:
                data[k]["vehicles"] = {"quarters": [quarter_label(q) for q in qs], **{name: [round(s[name].get(q)) if s[name].get(q) is not None else None for q in qs] for name in fuels}}
    except Exception as e:
        errors.append(f"vehicle registrations: {e}")

    # ---- consumer prices, cities covered by the CPI ----
    try:
        pm2 = meta(18100004)
        ids = match(pm2, "prices", lambda n: "," in n)
        found = [k for k in keys if k in ids]
        errors[:] = [e for e in errors if not e.startswith("prices:")]  # most metro areas have no CPI of their own; not an error
        res = fetch(18100004, [coord(ids[k], 2) for k in found], 73)
        for k in found:
            s = res.get(coord(ids[k], 2), {})
            yoy = {d: round(v / s[f"{int(d[:4]) - 1}{d[4:]}"] - 1, 4) for d, v in s.items() if s.get(f"{int(d[:4]) - 1}{d[4:]}")}
            if yoy:
                data[k]["prices"] = {"months": [month_label(d) for d in yoy], "yoy": list(yoy.values())}
    except Exception as e:
        errors.append(f"prices: {e}")

    cities = [{"key": c["key"], "name": c["name"], "province": c["province"], **data[c["key"]]} for c in cmas]
    out = {"canada": {**CANADA, **data["canada"]}, "cities": cities, "errors": errors, "built": datetime.date.today().isoformat(),
           "sources": {"pop": "Statistics Canada, Table 17-10-0148-01", "jobs": "Statistics Canada, Table 14-10-0459-01 (three-month moving average, seasonally adjusted)",
                       "income": "Statistics Canada, 2021 Census, Table 98-10-0061-01", "commute": "Statistics Canada, 2021 Census, Table 98-10-0457-01",
                       "vehicles": "Statistics Canada, Table 20-10-0025-01", "prices": "Statistics Canada, Table 18-10-0004-01"}}
    if OUT.exists():
        old = json.loads(OUT.read_text())
        if {k: v for k, v in old.items() if k != "built"} == json.loads(json.dumps({k: v for k, v in out.items() if k != "built"})):
            print("unchanged"); return
    if not any(len(c) > 3 for c in cities):
        raise SystemExit("No city data could be fetched: " + "; ".join(errors))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {OUT}: {len(cities)} metro areas; errors: {errors}")


if __name__ == "__main__":
    main()
