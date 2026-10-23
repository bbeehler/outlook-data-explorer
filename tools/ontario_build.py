#!/usr/bin/env python3
"""Build ontario/data.json from Ontario's open "Vehicle population data" (Ministry of Transportation).

Usage: python3 tools/ontario_build.py <folder with the yearly ZIPs> [output path]
The ZIPs come from the `ontario-raw` branch (the "Ontario vehicle data" workflow downloads them).

Each yearly file is a snapshot "as at December 31" of that year. We count FIT-ACTIVE vehicles
(fit, with a valid registration) as vehicles on the road. 2015's published file is a stub with a
few dozen vehicles, so that year is skipped.
"""
import csv, io, json, re, sys, zipfile, datetime
from collections import defaultdict
from pathlib import Path

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "raw")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "ontario/data.json")
SKIP_YEARS = {2015}
ROAD = ("PASSENGER", "COMMERCIAL")  # light and commercial road vehicles

MAKES = {
    "ACUR": "Acura", "ALFA": "Alfa Romeo", "ASTO": "Aston Martin", "AUDI": "Audi", "AUST": "Austin", "BENT": "Bentley",
    "BMW": "BMW", "BUIC": "Buick", "CADI": "Cadillac", "CHEV": "Chevrolet", "CHRY": "Chrysler", "DATS": "Datsun",
    "DODG": "Dodge", "FCCC": "Freightliner Custom Chassis", "FERR": "Ferrari", "FIAT": "Fiat", "FORD": "Ford",
    "FREI": "Freightliner", "FRHT": "Freightliner", "GENS": "Genesis", "GMC": "GMC", "HINO": "Hino", "HOND": "Honda",
    "HUMM": "Hummer", "HYUN": "Hyundai", "INFI": "Infiniti", "INTE": "International", "INTL": "International",
    "ISU": "Isuzu", "JAGU": "Jaguar", "JEEP": "Jeep", "KENW": "Kenworth", "KIA": "Kia", "KW": "Kenworth",
    "LAMO": "Lamborghini", "LAND": "Land Rover", "LEXS": "Lexus", "LINC": "Lincoln", "LNDR": "Land Rover",
    "LOTU": "Lotus", "MACK": "Mack", "MASE": "Maserati", "MAZD": "Mazda", "MCLA": "McLaren", "MERC": "Mercury",
    "MERZ": "Mercedes-Benz", "MG": "MG", "MITS": "Mitsubishi", "MNNI": "MINI", "NISS": "Nissan", "OLDS": "Oldsmobile",
    "PETE": "Peterbilt", "PLSR": "Polestar", "PLYM": "Plymouth", "PONT": "Pontiac", "PORS": "Porsche",
    "PTRB": "Peterbilt", "RAM": "Ram", "ROL": "Rolls-Royce", "SAA": "Saab", "SMRT": "smart", "SPAR": "Spartan",
    "STRG": "Sterling", "STRN": "Saturn", "SUBA": "Subaru", "SUZI": "Suzuki", "TESL": "Tesla", "TOYT": "Toyota",
    "TRIU": "Triumph", "VNFS": "VinFast", "VOLK": "Volkswagen", "VOLV": "Volvo", "WRKH": "Workhorse",
    "WSTR": "Western Star", "****": "Not coded",
}
# Our reading of the Ministry's 3-character model codes. Only codes with a clear match; the rest stay as codes.
MODELS = {
    "ACUR": {"RDX": "RDX", "MDX": "MDX"}, "AUDI": {"Q5": "Q5"}, "BMW": {"BX5": "X5", "BX3": "X3"},
    "BUIC": {"ENC": "Encore", "ENR": "Enclave"}, "CADI": {"XT5": "XT5"},
    "CHEV": {"SIL": "Silverado", "EQU": "Equinox", "TRV": "Traverse", "EXP": "Express", "TRA": "Trax"},
    "DODG": {"CAR": "Grand Caravan", "JOU": "Journey", "DUR": "Durango"},
    "FORD": {"EDG": "Edge", "RNG": "Ranger", "MUS": "Mustang", "TRN": "Transit"},
    "GMC": {"SIE": "Sierra", "TER": "Terrain", "ACA": "Acadia", "CAN": "Canyon", "SAV": "Savana", "YUK": "Yukon"},
    "HOND": {"CRV": "CR-V", "HRV": "HR-V", "PIL": "Pilot", "RID": "Ridgeline"},
    "HYUN": {"TUC": "Tucson", "SAN": "Santa Fe"},
    "JEEP": {"GCK": "Grand Cherokee", "CHK": "Cherokee", "CMP": "Compass", "WRA": "Wrangler"},
    "KIA": {"SPO": "Sportage", "SOR": "Sorento", "SOU": "Soul"}, "LEXS": {"RX": "RX", "RX5": "RX", "NX": "NX"},
    "MAZD": {"CX5": "CX-5", "CX9": "CX-9"}, "MERZ": {"GLC": "GLC"}, "MITS": {"OUT": "Outlander", "RVR": "RVR"},
    "MNNI": {"COO": "Cooper"}, "NISS": {"ROG": "Rogue", "MUR": "Murano", "KIC": "Kicks", "FRT": "Frontier", "QAS": "Qashqai"},
    "SUBA": {"FOR": "Forester", "CRO": "Crosstrek", "OBK": "Outback"}, "TESL": {"YGE": "Model Y", "3": "Model 3"},
    "TOYT": {"RV4": "RAV4", "RAV": "RAV4", "COR": "Corolla", "TAC": "Tacoma", "TUN": "Tundra", "SIE": "Sienna",
             "HIG": "Highlander", "CAM": "Camry", "PRI": "Prius", "VEN": "Venza", "RUN": "4Runner"},
    "VOLK": {"TIG": "Tiguan", "ATL": "Atlas", "TAO": "Taos", "GLF": "Golf"}, "VOLV": {"XC9": "XC90", "XC6": "XC60"},
}
# Motive power codes grouped. The data dictionary lists F as "Diesel-Butane", but the counts are far too large for
# that, so it is shown on its own as "Code F" rather than guessed.
FUEL = {"G": "Gasoline", "D": "Diesel", "L": "Hybrid (gas-electric)", "V": "Plug-in hybrid or battery electric",
        "E": "Plug-in hybrid or battery electric", "F": "Code F"}
STATUS = ["FIT-ACTIVE", "FIT-INACTIVE", "UNFIT", "WRECKED", "OUT-OF-PROV", "SOLD", "SUSPENDED", "TEMPORARY", "TOTAL"]


def files_for(zpath):
    """Yield (name, text) for every .txt inside a yearly zip, including zips nested inside it. English reports only."""
    def walk(zf):
        for n in zf.namelist():
            low = n.lower()
            if low.endswith(".zip"):
                yield from walk(zipfile.ZipFile(io.BytesIO(zf.read(n))))
            elif low.endswith(".txt") and "reg_veh" in low:
                yield n, zf.read(n).decode("latin-1")
    yield from walk(zipfile.ZipFile(zpath))


def rows(text):
    r = csv.reader(io.StringIO(text.replace("\r", "")), delimiter="\t")
    head = [h.strip().replace("_", "-") for h in next(r)]
    for row in r:
        if len(row) >= len(head):
            yield dict(zip(head, [c.strip() for c in row]))


def num(v):
    try:
        return int(v)
    except ValueError:
        return 0


def title(s):
    s = s.title().replace(" Of ", " of ").replace(" & ", " & ")
    return re.sub(r",(\S)", r", \1", s)


def main():
    years = {}
    for z in sorted(SRC.glob("*.zip")):
        m = re.search(r"(20\d\d)", z.name)
        if m and int(m.group(1)) not in SKIP_YEARS:
            years[int(m.group(1))] = z
    out = {"years": sorted(years), "classes": {}, "fuel": {}, "county": {}, "makes": {}, "age": {}, "status": {}}
    latest = max(years)
    detail, prev_models = {}, defaultdict(int)
    for y, z in sorted(years.items()):
        reps = {}
        for name, text in files_for(z):
            m = re.search(r"Report(\w+?)_", name)
            if m:
                reps[m.group(1)] = text
        # Report 2: class by status
        out["classes"][y] = {r["VEHICLE-CLASS"].title(): num(r["FIT-ACTIVE"]) for r in rows(reps["2"])}
        out["status"][y] = {s: sum(num(r[s]) for r in rows(reps["2"]) if r["VEHICLE-CLASS"] in ROAD) for s in STATUS}
        # Report 5: motive power (fuel), road vehicles, active
        fuel = defaultdict(int)
        for r in rows(reps["5"]):
            if r["VEHICLE-CLASS"] in ROAD and r["DESCRIPTOR"] == "MOTIVE POWER":
                fuel[FUEL.get(r["VALUE"], "Other")] += num(r["FIT-ACTIVE"])
        out["fuel"][y] = dict(fuel)
        # Report 3: county, road vehicles, active
        cty = defaultdict(int)
        for r in rows(reps["3"]):
            if r["VEHICLE-CLASS"] in ROAD and r["COUNTY"] != "COUNTY":
                cty[title(r["COUNTY"])] += num(r["FIT-ACTIVE"])
        out["county"][y] = dict(cty)
        # Report A (Report 6 in 2014): make, model, model year
        a = reps.get("A") or reps.get("6")
        makes, age = defaultdict(lambda: [0, 0]), defaultdict(int)
        for r in rows(a):
            c = r["VEHICLE-CLASS"]
            if c not in ROAD:
                continue
            n = num(r["FIT-ACTIVE"])
            if not n:
                continue
            mk, md, my = r["MAKE"], r["MODEL"], num(r["MODEL-YEAR"])
            makes[mk][0 if c == "PASSENGER" else 1] += n
            if 1900 < my <= y + 1:
                age[my] += n
            if y == latest:
                detail.setdefault(mk, {}).setdefault(md, defaultdict(int))[my] += n
            if y == latest - 1:
                prev_models[(mk, md)] += n
        out["makes"][y] = {k: v for k, v in makes.items()}
        out["age"][y] = dict(sorted(age.items()))
    # Latest-year make/model/model-year detail with last year's model totals for change
    out["detail"] = {mk: {md: {"y": dict(sorted(ys.items())), "prev": prev_models.get((mk, md), 0)} for md, ys in mds.items()}
                     for mk, mds in detail.items()}
    out["makeNames"] = MAKES
    out["modelNames"] = MODELS
    out["latest"] = latest
    out["built"] = datetime.date.today().isoformat()
    # Keep the file byte-identical when nothing but the build date would change, so the monthly run commits only real updates.
    if OUT.exists():
        old = json.loads(OUT.read_text())
        if {k: v for k, v in old.items() if k != "built"} == json.loads(json.dumps({k: v for k, v in out.items() if k != "built"})):
            print(f"{OUT} unchanged"); return
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size:,} bytes), years {out['years']}")


if __name__ == "__main__":
    main()
