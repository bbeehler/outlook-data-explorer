#!/usr/bin/env python3
"""Build jobs/data.json for the Research Hub's "Auto care jobs in Ontario" page.

Source: Ontario Ministry of Labour, Immigration, Training and Skills Development, Labour Market Information job profiles
(https://www.services.labour.gov.on.ca/labourmarket-ui/jobProfile?nocCode=72411). The job profile app reads an open JSON
feed, /labourmarket/api/jobProfile/<NOC 2021 code>; this script reads the same feed for the auto care trades below.
"""
import json, re, sys, time, datetime, urllib.request
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "jobs/data.json")
API = "https://www.services.labour.gov.on.ca/labourmarket/api/jobProfile/"
PAGE = "https://www.services.labour.gov.on.ca/labourmarket-ui/jobProfile?nocCode="
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 AIA-Canada-Research-Hub",
      "Accept": "application/json"}
NOCS = [("72411", "Collision, refinishing and glass technicians"), ("72410", "Automotive service technicians"),
        ("74203", "Parts installers and servicers")]
REGIONS = {"3510": "Ottawa", "3515": "Kingston–Pembroke", "3520": "Muskoka–Kawarthas", "3530": "Toronto", "3540": "Kitchener–Waterloo–Barrie",
           "3550": "Hamilton–Niagara Peninsula", "3560": "London", "3570": "Windsor–Sarnia", "3580": "Stratford–Bruce Peninsula",
           "3590": "Northeast", "3595": "Northwest", "R35": "Ontario", "R00": "Canada"}
OUTLOOK = {"JO1": "Very limited", "JO2": "Limited", "JO3": "Moderate", "JO4": "Good", "JO5": "Very good", "JO6": "Not available", "JO7": "Undetermined"}


def get(noc):
    for attempt in range(4):
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(API + noc, headers=UA), timeout=120))
        except Exception:
            if attempt == 3:
                raise
            time.sleep(10 * (attempt + 1))


def text(s):
    s = re.sub(r"<[^>]+>", " ", s or "")
    return re.sub(r"\s+", " ", s.replace("&nbsp;", " ").replace("&amp;", "&")).strip()


def paras(s):
    """HTML outlook text -> list of paragraphs; list items start with a bullet."""
    s = re.sub(r"(?i)<li[^>]*>", "\n• ", s or "")
    s = re.sub(r"(?i)</p>|<br\s*/?>|</li>|<h\d[^>]*>|</h\d>|<p[^>]*>", "\n", s)
    return [l for l in (text(x) for x in s.split("\n")) if l]


def years_map(m):
    return {str(k): v for k, v in sorted((m or {}).items()) if v is not None}


def profile(noc, short):
    d = get(noc)
    w = d["nocWrapper"]
    wages = {}
    for x in w.get("economicRegionWageListTotal") or []:
        r = REGIONS.get(str(x.get("regionCode")))
        vals = [x.get("lowHourlyWage"), x.get("medHourlyWage"), x.get("highHourlyWage")]
        if r and any(vals):
            wages[r] = vals
    share = {REGIONS[x["regionCode"]]: x["employmentPct"] for x in w.get("nocLocationsList") or [] if x.get("regionCode") in REGIONS}
    share_all = {REGIONS[x["regionCode"]]: x["employmentPct"] for x in w.get("allLocationsList") or [] if x.get("regionCode") in REGIONS}
    outlook = {REGIONS.get(x["regionCode"], x["regionCode"]): OUTLOOK.get(x.get("jobOutlookCode"), "") for x in w.get("economicRegionOutlooks") or []}
    on_outlook = OUTLOOK.get((w.get("jobOutlook") or {}).get("jobOutlookCode"), "")
    trend = {REGIONS.get(x["regionCode"], x["regionCode"]): paras(x.get("employmentTrendsEn")) for x in w.get("economicRegionOutlooks") or [] if x.get("employmentTrendsEn")}
    workers = {}
    for r, s in trend.items():
        m = re.search(r"Approximately ([\d,]+) people work", " ".join(s))
        if m:
            workers[r] = int(m.group(1).replace(",", ""))
    on_text = " ".join(trend.get("Ontario", []))
    num = lambda pat: (lambda m: int(m.group(1)) if m else None)(re.search(pat, on_text))
    ec = {x["characteristicsCode"]: x["characteristicsAmount"] for x in w.get("empCharacteristicsList") or []}
    reqs = []
    for x in w.get("employmentRequirementList") or []:
        s = text(x.get("empmRqmtDescConverted") or x.get("empmRqmtDesc"))
        if x.get("languageCode") == "EN" and s.endswith(".") and s not in reqs:  # skip the sub-group headings and repeats
            reqs.append(s)
    return {
        "noc": noc, "short": short, "title": w.get("nocEnTitle"), "description": text((w.get("noc") or {}).get("nocEnDescription")),
        "url": PAGE + noc, "jobBank": d.get("jobBankLink"),
        "outlook": on_outlook, "outlookByRegion": outlook, "trend": trend, "workers": workers,
        "openings": d.get("openingCategoryFormatted"),  # projected job openings in Ontario, 2024 to 2028
        "postings": years_map(d.get("jobOpeningsMap")),  # annual online job postings
        "growth": {"occupation": years_map(d.get("nocJobGrowthMap")), "group": years_map(d.get("categoryJobGrowthMap")),
                   "all": years_map(d.get("allJobGrowthMap"))},  # % change in employment since the base year
        "wages": wages,  # hourly [low, median, high]
        "share": share, "shareAll": share_all,  # % of the occupation's (and all) Ontario workers in each economic region
        "unemployment": ec.get("EC5"), "fullTime": num(r"Full-time workers: (\d+)%"), "selfEmployed": num(r"(\d+)% of [^.]*? are self-employed"),
        "allFullTime": num(r"Full-time workers: \d+% compared to (\d+)%"), "allSelfEmployed": num(r"self-employed compared to an average of (\d+)%"), "women": ec.get("G2"), "men": ec.get("G1"),
        "ages": [[x.get("charDescEng"), x["characteristicsAmount"]] for x in sorted(w.get("empCharacteristicsAGList") or [], key=lambda x: int(re.sub(r"\D", "", x["characteristicsCode"]) or 0))],
        "education": [[x.get("charDescEng"), x["characteristicsAmount"]] for x in w.get("empCharacteristicsEAList") or [] if x["characteristicsAmount"]],
        "industries": sorted([[x.get("enTitle"), x["employmentPct"]] for x in w.get("industriesList") or []], key=lambda r: -(r[1] or 0)),
        "skills": {k: [[x["skillName"], x.get("skillCount")] for x in w.get(f) or []]
                   for k, f in [("specialized", "specializedSkillsList"), ("soft", "softwareSkillsList"), ("baseline", "baselineSkillsList")]},
        "apprenticeships": [{"name": x.get("enProgramName"), "code": x.get("apprenticeshipCode"), "url": x.get("enURL"),
                             "mandatory": x.get("programRequirement") not in (None, "", "V"),
                             "requirement": x.get("programRequirement"), "redSeal": x.get("redSealFlag") == "Y"} for x in w.get("apprenticeshipExtList") or []],
        "requirements": reqs,
        "titles": [x["nocTitle"] for x in w.get("nocTitlesList") or [] if x.get("languageCode") == "EN"][:40],
    }


def main():
    occs, errors = [], []
    for noc, short in NOCS:
        try:
            occs.append(profile(noc, short))
        except Exception as e:
            errors.append(f"{noc}: {e}")
    if OUT.exists() and errors:  # keep the last good profile for any occupation that failed this time
        have = {o["noc"] for o in occs}
        occs += [o for o in json.loads(OUT.read_text()).get("occupations", []) if o["noc"] not in have]
    if not occs:
        raise SystemExit("Nothing fetched: " + "; ".join(errors))
    occs.sort(key=lambda o: [n for n, _ in NOCS].index(o["noc"]))
    out = {"occupations": occs, "errors": errors, "built": datetime.date.today().isoformat(),
           "source": "Ontario Ministry of Labour, Immigration, Training and Skills Development, Ontario labour market information (job profiles)"}
    if OUT.exists():
        old = json.loads(OUT.read_text())
        if {k: v for k, v in old.items() if k != "built"} == json.loads(json.dumps({k: v for k, v in out.items() if k != "built"})):
            print("unchanged"); return
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {OUT}: {len(occs)} occupations; errors: {errors}")


if __name__ == "__main__":
    main()
