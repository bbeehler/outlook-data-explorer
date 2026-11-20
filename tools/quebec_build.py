#!/usr/bin/env python3
"""Build quebec/data.json from the SAAQ's open "Véhicules en circulation" files (Données Québec, CC BY 4.0).

Usage: python3 tools/quebec_build.py <year>=<csv path or URL> [...] [--out quebec/data.json]
Each yearly file lists every vehicle authorised to circulate in Quebec at the end of the year, one row per vehicle.
We keep light road vehicles: class PAU (automobile or light truck, personal use) and CAU (same, institutional,
professional or business use). The output has the same shape as ontario/data.json so the page code is shared:
makes[year][make] = [personal, business]; fuel[year][fuel] (2017 on, when the SAAQ began recording fuel);
county[year][administrative region]; age[year][model year]; detail[make][model] = {y: {model year: n}, prev: n}.
Files are read as a stream, so nothing large is kept in memory or on disk.
"""
import csv, io, json, sys, datetime, urllib.request
from collections import defaultdict
from pathlib import Path

args = [a for a in sys.argv[1:] if not a.startswith("--")]
OUT = Path(next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--out=")), "quebec/data.json"))
SRCS = dict(a.split("=", 1) for a in args)

FUEL = {"E": "Gasoline", "D": "Diesel", "H": "Hybrid", "W": "Plug-in hybrid", "L": "Battery electric"}  # the rest -> Other
MAKES = {
    "ACURA": "Acura", "ALFA": "Alfa Romeo", "AUDI": "Audi", "BMW": "BMW", "BUICK": "Buick", "CADIL": "Cadillac",
    "CHEVR": "Chevrolet", "CHRYS": "Chrysler", "DODGE": "Dodge", "FIAT": "Fiat", "FORD": "Ford", "GENES": "Genesis",
    "GMC": "GMC", "HONDA": "Honda", "HUMME": "Hummer", "HYUND": "Hyundai", "INFIN": "Infiniti", "JAGUA": "Jaguar",
    "JEEP": "Jeep", "KIA": "Kia", "LAND": "Land Rover", "LEXUS": "Lexus", "LINCO": "Lincoln", "MAZDA": "Mazda",
    "MERCE": "Mercedes-Benz", "MERCU": "Mercury", "MINI": "MINI", "MITSU": "Mitsubishi", "NISSA": "Nissan",
    "OLDSM": "Oldsmobile", "PONTI": "Pontiac", "PORSC": "Porsche", "RAM": "Ram", "SAAB": "Saab", "SATUR": "Saturn",
    "SMART": "smart", "SUBAR": "Subaru", "SUZUK": "Suzuki", "TESLA": "Tesla", "TOYOT": "Toyota", "VOLKS": "Volkswagen",
    "VOLVO": "Volvo", "POLES": "Polestar", "RIVIA": "Rivian", "LUCID": "Lucid", "MASER": "Maserati", "FERRA": "Ferrari",
    "BENTL": "Bentley", "ROLLS": "Rolls-Royce", "LAMBO": "Lamborghini", "ASTON": "Aston Martin", "MCLAR": "McLaren",
    "LOTUS": "Lotus", "ISUZU": "Isuzu", "FREIG": "Freightliner", "INTER": "International", "PLYMO": "Plymouth",
    "VINFA": "VinFast", "SCION": "Scion", "DAEWO": "Daewoo", "GEO": "Geo", "EAGLE": "Eagle", "AMC": "AMC",
    "LANDR": "Land Rover", "AUSTI": "Austin", "DATSU": "Datsun", "CITRO": "Citroën", "TRIUM": "Triumph", "WILLY": "Willys",
    "BOMBA": "Bombardier", "MG": "MG", "AC": "AC", "?": "Not stated",
}
# The SAAQ keeps the first 5 characters of each model name. Our reading of the common ones; the rest are shown as is.
MODELS = {
    "TOYOT": {"COROL": "Corolla", "MATRI": "Matrix", "TACOM": "Tacoma", "SIENN": "Sienna", "HIGHL": "Highlander", "TUNDR": "Tundra",
              "VENZA": "Venza", "4RUNN": "4Runner", "TERCE": "Tercel", "CAMRY": "Camry", "YARIS": "Yaris", "PRIUS": "Prius", "ECHO": "Echo"},
    "HONDA": {"ACCOR": "Accord", "ODYSS": "Odyssey", "RIDGE": "Ridgeline", "PILOT": "Pilot", "PASSP": "Passport", "HRV": "HR-V", "CIVIC": "Civic", "FIT": "Fit"},
    "HYUND": {"ELANT": "Elantra", "ACCEN": "Accent", "TUCSO": "Tucson", "SANTA": "Santa Fe", "SONAT": "Sonata", "IONIQ": "Ioniq",
              "VELOS": "Veloster", "PALIS": "Palisade", "GENES": "Genesis", "KONA": "Kona", "VENUE": "Venue"},
    "FORD": {"F150": "F-150", "F250": "F-250", "F350": "F-350", "ESCAP": "Escape", "FOCUS": "Focus", "TRANS": "Transit", "RANGE": "Ranger",
             "FUSIO": "Fusion", "EXPLO": "Explorer", "MUSTA": "Mustang", "FIEST": "Fiesta", "ECONO": "Econoline", "BRONC": "Bronco",
             "ECOSP": "EcoSport", "TAURU": "Taurus", "EXPED": "Expedition", "EDGE": "Edge"},
    "NISSA": {"ROGUE": "Rogue", "SENTR": "Sentra", "VERSA": "Versa", "MICRA": "Micra", "QASHQ": "Qashqai", "KICKS": "Kicks", "ALTIM": "Altima",
              "MURAN": "Murano", "PATHF": "Pathfinder", "FRONT": "Frontier", "MAXIM": "Maxima", "TITAN": "Titan", "X-TRA": "X-Trail",
              "XTERR": "Xterra", "LEAF": "Leaf", "JUKE": "Juke"},
    "CHEVR": {"SILVE": "Silverado", "CRUZE": "Cruze", "EQUIN": "Equinox", "MALIB": "Malibu", "SPARK": "Spark", "COLOR": "Colorado",
              "COBAL": "Cobalt", "EXPRE": "Express", "SONIC": "Sonic", "IMPAL": "Impala", "TRAVE": "Traverse", "TRAIL": "Trailblazer",
              "UPLAN": "Uplander", "CAMAR": "Camaro", "CAVAL": "Cavalier", "BLAZE": "Blazer", "SUBUR": "Suburban", "TAHOE": "Tahoe",
              "ORLAN": "Orlando", "CORVE": "Corvette", "BOLT": "Bolt", "VOLT": "Volt", "TRAX": "Trax", "AVEO": "Aveo"},
    "MAZDA": {"3": "Mazda3", "5": "Mazda5", "6": "Mazda6", "2": "Mazda2", "CX-5": "CX-5", "CX5": "CX-5", "CX-3": "CX-3", "CX30": "CX-30",
              "CX-9": "CX-9", "CX-7": "CX-7", "TRIBU": "Tribute", "MX-5": "MX-5", "B4000": "B4000"},
    "KIA": {"FORTE": "Forte", "SOREN": "Sorento", "SPORT": "Sportage", "RONDO": "Rondo", "SELTO": "Seltos", "OPTIM": "Optima",
            "SEDON": "Sedona", "TELLU": "Telluride", "SPECT": "Spectra", "SOUL": "Soul", "NIRO": "Niro", "RIO": "Rio"},
    "VOLKS": {"JETTA": "Jetta", "GOLF": "Golf", "TIGUA": "Tiguan", "ATLAS": "Atlas", "PASSA": "Passat", "BEETL": "Beetle", "RABBI": "Rabbit",
              "TOUAR": "Touareg", "E-GOL": "e-Golf", "NEWBE": "New Beetle", "TAOS": "Taos", "GTI": "GTI", "EOS": "Eos"},
    "DODGE": {"GRAND": "Grand Caravan", "JOURN": "Journey", "RAM": "Ram", "DAKOT": "Dakota", "CARAV": "Caravan", "DURAN": "Durango",
              "CHARG": "Charger", "CALIB": "Caliber", "DART": "Dart", "AVENG": "Avenger"},
    "SUBAR": {"IMPRE": "Impreza", "OUTBA": "Outback", "CROSS": "Crosstrek", "FORES": "Forester", "LEGAC": "Legacy", "XVCRO": "XV Crosstrek",
              "ASCEN": "Ascent", "WRX": "WRX"},
    "GMC": {"SIERR": "Sierra", "TERRA": "Terrain", "SAVAN": "Savana", "CANYO": "Canyon", "ACADI": "Acadia", "YUKON": "Yukon"},
    "JEEP": {"WRANG": "Wrangler", "CHERO": "Cherokee", "GRAND": "Grand Cherokee", "COMPA": "Compass", "PATRI": "Patriot", "LIBER": "Liberty", "GLADI": "Gladiator"},
    "MITSU": {"OUTLA": "Outlander", "LANCE": "Lancer", "ECLIP": "Eclipse Cross", "MIRAG": "Mirage", "RVR": "RVR"},
    "RAM": {"PROMA": "ProMaster", "1500": "1500", "2500": "2500"}, "TESLA": {"MODEL": "Model 3 / Y / S / X", "S": "Model S"},
    "CHRYS": {"PACIF": "Pacifica", "SEBRI": "Sebring", "TOWN": "Town & Country", "PTCRU": "PT Cruiser", "200": "200", "300": "300"},
    "BUICK": {"ENCOR": "Encore", "VERAN": "Verano", "ALLUR": "Allure", "ENCLA": "Enclave", "ENVIS": "Envision"},
    "PONTI": {"VIBE": "Vibe", "MONTA": "Montana", "SUNFI": "Sunfire", "TORRE": "Torrent", "WAVE": "Wave", "G5": "G5", "G6": "G6"},
    "MINI": {"COOPE": "Cooper"}, "MERCE": {"SPRIN": "Sprinter", "C": "C-Class", "E": "E-Class"},
    "SUZUK": {"GRAND": "Grand Vitara"}, "SMART": {"FORTW": "Fortwo"}, "SATUR": {"ION": "Ion", "VUE": "Vue"},
    "CADIL": {"ESCAL": "Escalade"}, "LINCO": {"MKX": "MKX"}, "PORSC": {"CAYEN": "Cayenne", "MACAN": "Macan"},
    "LANDR": {"RANGE": "Range Rover"}, "LEXUS": {"RX": "RX", "NX": "NX", "IS": "IS", "ES": "ES"},
}


def rows(src):
    stream = urllib.request.urlopen(urllib.request.Request(src, headers={"User-Agent": "Mozilla/5.0"}), timeout=600) if src.startswith("http") else open(src, "rb")
    text = io.TextIOWrapper(stream, encoding="utf-8-sig", errors="replace", newline="")
    rd = csv.reader(text)
    head = [h.strip() for h in next(rd)]
    ix = {h: i for i, h in enumerate(head)}
    want = ["CLAS", "MARQ_VEH", "MODEL_VEH", "ANNEE_MOD", "TYP_CARBU", "REG_ADM"]
    for row in rd:  # plain reader + column positions: much faster than DictReader on ~10 million rows a year
        yield {k: (row[ix[k]] if k in ix and ix[k] < len(row) else "") for k in want}


def main():
    years = sorted(SRCS, key=int)
    makes, fuel, county, age = {}, {}, {}, {}
    models = {}  # year -> (make, model) -> {model year: n}
    for y in years:
        mk, fu, co, ag, md = defaultdict(lambda: [0, 0]), defaultdict(int), defaultdict(int), defaultdict(int), defaultdict(lambda: defaultdict(int))
        n = 0
        for r in rows(SRCS[y]):
            cl = r.get("CLAS", "")
            if cl not in ("PAU", "CAU"):
                continue
            n += 1
            m = (r.get("MARQ_VEH") or "").strip() or "?"
            mk[m][0 if cl == "PAU" else 1] += 1
            if int(y) >= 2017:
                fu[FUEL.get((r.get("TYP_CARBU") or "").strip(), "Other")] += 1
            reg = (r.get("REG_ADM") or "").strip()
            co[reg.rsplit(" (", 1)[0].replace("―", "–") if reg else "Outside Quebec or not stated"] += 1
            my = (r.get("ANNEE_MOD") or "").strip()
            if my.isdigit() and 1900 < int(my) <= int(y) + 1:
                ag[my] += 1
                if int(y) >= int(years[-1]) - 1:
                    md[(m, (r.get("MODEL_VEH") or "").strip() or "?")][my] += 1
        print(y, n, "light vehicles", flush=True)
        makes[y] = {k: v for k, v in mk.items() if sum(v) >= 50 or k in MAKES}
        if fu:
            fuel[y] = dict(fu)
        county[y], age[y] = dict(co), dict(ag)
        if md:
            models[y] = md
    L, P = years[-1], str(int(years[-1]) - 1)
    detail = defaultdict(dict)
    for (m, mdl), ys in models.get(L, {}).items():
        tot = sum(ys.values())
        if tot < 100 or m not in makes[L]:
            continue
        detail[m][mdl] = {"y": dict(sorted(ys.items())), "prev": sum(models.get(P, {}).get((m, mdl), {}).values())}
    out = {"years": [int(y) for y in years], "makes": makes, "fuel": fuel, "county": county, "age": age, "detail": detail,
           "makeNames": {k: v for k, v in MAKES.items() if any(k in makes[y] for y in years)},
           "modelNames": {mk: {c: n for c, n in mm.items() if c in detail.get(mk, {})} for mk, mm in MODELS.items() if mk in detail},
           "latest": int(L), "built": datetime.date.today().isoformat()}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {OUT}: {len(years)} years, {sum(len(v) for v in detail.values())} models")


if __name__ == "__main__":
    main()
