#!/usr/bin/env python3
"""Build provinces/data.json for the "Vehicles by province" page.

Every province and territory, from Statistics Canada (Statistics Canada Open Licence):
  - Vehicles on the road by vehicle type and fuel type, yearly ... Table 23-10-0308-01
  - New vehicle registrations by fuel type, quarterly ........... Table 20-10-0025-01
Plus Alberta's own yearly tables (Alberta Transportation, Open Government Licence – Alberta), read from the PDFs it
publishes: registered vehicles by fuel type and by body style, as of March 31.

Members are found by name in each table's metadata, so the script survives Statistics Canada renumbering them.
A description of what was found is written next to the output as structure.txt (for checking; not used by the page).
Usage: python3 tools/provinces_build.py [output path] [folder with Alberta PDF texts]
"""
import json, sys, re, time, datetime, urllib.request
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "provinces/data.json")
AB_DIR = Path(sys.argv[2]) if len(sys.argv) > 2 else None
WDS = "https://www150.statcan.gc.ca/t1/wds/rest/"
UA = {"Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (AIA Canada Research Hub data build)"}
PLACES = [("ca", "Canada"), ("nl", "Newfoundland and Labrador"), ("pe", "Prince Edward Island"), ("ns", "Nova Scotia"),
          ("nb", "New Brunswick"), ("qc", "Quebec"), ("on", "Ontario"), ("mb", "Manitoba"), ("sk", "Saskatchewan"),
          ("ab", "Alberta"), ("bc", "British Columbia"), ("yt", "Yukon"), ("nt", "Northwest Territories"), ("nu", "Nunavut")]
errors, notes = [], []


def post(path, body):
    for attempt in range(5):
        try:
            req = urllib.request.Request(WDS + path, data=json.dumps(body).encode(), headers=UA)
            return json.load(urllib.request.urlopen(req, timeout=300))
        except Exception as e:
            if attempt == 4:
                raise
            time.sleep(8 * (attempt + 1))


def meta(pid):
    return post("getCubeMetadata", [{"productId": pid}])[0]["object"]


def coord(ids):
    ids = list(ids) + [0] * (10 - len(ids))
    return ".".join(str(i) for i in ids)


def fetch(pid, coords, n):
    out = {}
    for i in range(0, len(coords), 40):
        batch = coords[i:i + 40]
        res = post("getDataFromCubePidCoordAndLatestNPeriods", [{"productId": pid, "coordinate": c, "latestN": n} for c in batch])
        for r in res:  # results don't always come back in request order: key them by the coordinate returned
            if r.get("status") != "SUCCESS":
                continue
            c = coord([int(x) for x in r["object"]["coordinate"].split(".") if x != ""][:10])
            pts = {p["refPer"]: float(p["value"]) * (10 ** int(p.get("scalarFactorCode") or 0)) for p in r["object"]["vectorDataPoint"] if p.get("value") is not None}
            out[c] = dict(sorted(pts.items()))
    return out


def describe(m):
    lines = [f"## {m['productId']} {m.get('cubeTitleEn')} | {m.get('cubeStartDate')} to {m.get('cubeEndDate')}"]
    for d in m["dimension"]:
        lines.append(f"  dim {d['dimensionPositionId']} {d['dimensionNameEn']} ({len(d['member'])} members)")
        for x in d["member"][:40]:
            lines.append(f"    {x['memberId']} {x['memberNameEn']}")
    return lines


def geo_ids(m):
    names = {x["memberNameEn"].strip(): x["memberId"] for x in m["dimension"][0]["member"]}
    ids = {}
    for key, name in PLACES:
        mid = names.get(name) or next((v for k, v in names.items() if k.startswith(name + " ") or k.startswith(name + ",")), None)
        if mid:
            ids[key] = mid
    return ids


def quarter(d):
    return f"Q{(int(d[5:7]) - 1) // 3 + 1} {d[:4]}"


def statcan():
    data = {k: {} for k, _ in PLACES}
    structure = []
    # ---- vehicles on the road, by type and fuel ----
    try:
        m = meta(23100308)
        structure += describe(m)
        geos = geo_ids(m)
        dims = m["dimension"]
        other = [[(x["memberId"], x["memberNameEn"]) for x in d["member"]] for d in dims[1:]]
        # every combination of the non-geography dimensions (they are small)
        combos = [[]]
        for mem in other:
            combos = [c + [x] for c in combos for x in mem]
        coords = {(k, tuple(i for i, _ in c)): coord([geos[k]] + [i for i, _ in c]) for k in geos for c in combos}
        res = fetch(23100308, list(coords.values()), 12)
        names = {tuple(i for i, _ in c): [n for _, n in c] for c in combos}
        for (k, ids), cd in coords.items():
            s = res.get(cd)
            if not s:
                continue
            nm = names[ids]
            data[k].setdefault("fleet", []).append({"dims": nm, "years": [p[:4] for p in s], "vals": [round(v) for v in s.values()]})
        notes.append(f"23-10-0308: {len(res)} series for {len(geos)} places; dimension names: {[d['dimensionNameEn'] for d in dims]}")
    except Exception as e:
        errors.append(f"vehicles on the road (23-10-0308): {e}")
    # ---- new registrations by fuel, quarterly ----
    try:
        m = meta(20100025)
        structure += describe(m)
        geos = geo_ids(m)
        dims = m["dimension"]
        fuels = [(x["memberId"], x["memberNameEn"]) for x in dims[1]["member"]]
        rest = [d["member"][0]["memberId"] for d in dims[2:]]  # totals for vehicle type and statistics
        coords = {(k, f): coord([geos[k], f] + rest) for k in geos for f, _ in fuels}
        res = fetch(20100025, list(coords.values()), 40)
        fname = dict(fuels)
        for (k, f), cd in coords.items():
            s = res.get(cd)
            if s:
                data[k].setdefault("newregs", {})[fname[f]] = {quarter(q): round(v) for q, v in s.items()}
        notes.append(f"20-10-0025: {len(res)} series; fuel members {[n for _, n in fuels]}; other dims at {[d['member'][0]['memberNameEn'] for d in dims[2:]]}")
    except Exception as e:
        errors.append(f"new registrations (20-10-0025): {e}")
    return data, structure


# Alberta renamed some rows over the years; one name per row so the years line up.
AB_ALIASES = {"Gas": "Gasoline", "Motorhomes": "Motor Homes", "Buses (All Categories Of Bus)": "Buses", "Trucks (All Truck Types)": "Trucks",
              "Vans (All Van Body Types)": "Vans", "Truck/Trailer Units": "Truck-Trailer Units", "2 Door Sedans": "2-Door Coupe",
              "3 Door Coupe": "3-Door Coupe", "4 Door": "4-Door", "5 Door Sedan": "5-Door Sedan", "Flexible": "Flexible (E85)"}


def alberta_tables(folder):
    """Read Alberta's 'as of March 31' PDF tables (as text from pdftotext -layout): returns {kind: {label: {year: n}}}."""
    out = {}
    if not folder or not folder.exists():
        return out
    for f in sorted(folder.glob("*.txt")):
        kind = "fuel" if "fuel" in f.name else "style" if "style" in f.name else None
        if not kind:
            continue
        years = None
        for line in f.read_text(errors="ignore").splitlines():
            ys = re.findall(r"\b((?:19|20)\d\d)\b", line)
            if len(ys) >= 3 and (re.search(r"year", line, re.I) or not re.sub(r"(?:19|20)\d\d|\s", "", line)):
                years = ys
                continue
            if not years:
                continue
            mt = re.match(r"^\s*([A-Za-z0-9][A-Za-z0-9 /&()*.,:'-]*?)\s{2,}([\d,\s-]+)$", line)
            if not mt:
                continue
            nums = re.findall(r"\d[\d,]*", mt.group(2))
            if len(nums) != len(years):
                continue
            label = re.sub(r"\s+", " ", re.sub(r"\(\d\)", " ", mt.group(1))).strip(" *:").title()
            label = AB_ALIASES.get(label, label)
            for y, n in zip(years, nums):  # first table on the page wins when a label repeats (e.g. "Other vehicles")
                out.setdefault(kind, {}).setdefault(label, {}).setdefault(y, int(n.replace(",", "")))
    return out


def main():
    data, structure = statcan()
    ab = alberta_tables(AB_DIR)
    if AB_DIR and not ab:
        errors.append("Alberta: no tables could be read from the PDFs")
    places = [{"key": k, "name": n, **data[k]} for k, n in PLACES if data[k]]
    out = {"places": places, "alberta": {kind: {"years": sorted({y for v in t.values() for y in v}), "series": {lab: v for lab, v in t.items()}} for kind, t in ab.items()},
           "errors": errors, "built": datetime.date.today().isoformat(),
           "sources": {"fleet": "Statistics Canada, Table 23-10-0308-01 (Vehicle registrations, by type of vehicle and fuel type)",
                       "newregs": "Statistics Canada, Table 20-10-0025-01 (New motor vehicle registrations, quarterly)",
                       "alberta": "Alberta Transportation and Economic Corridors, registered motorized vehicles as of March 31 (open.alberta.ca)"}}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    Path(str(OUT) + ".structure.txt").write_text("\n".join(notes + errors + structure))
    if not any("fleet" in p or "newregs" in p for p in places):
        raise SystemExit("No provincial data could be fetched: " + "; ".join(errors))
    if OUT.exists():
        old = json.loads(OUT.read_text())
        if {k: v for k, v in old.items() if k != "built"} == json.loads(json.dumps({k: v for k, v in out.items() if k != "built"})):
            print("unchanged"); return
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {OUT}: {len(places)} places; errors: {errors}")


if __name__ == "__main__":
    main()
