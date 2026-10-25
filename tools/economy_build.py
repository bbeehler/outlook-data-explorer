#!/usr/bin/env python3
"""Build economy/data.json for the Research Hub's Economy section.

Pulls a small set of series from Statistics Canada's Web Data Service (open licence) and the Bank of Canada's
Valet API, and writes them as figures in the same format as the Outlook figures, each tagged with the topics it
relates to (so the hub can link them to research findings). Run by the "Economy data" GitHub Action monthly.
Usage: python3 tools/economy_build.py [output path]
"""
import json, sys, datetime, urllib.request
from collections import OrderedDict
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "economy/data.json")
WDS = "https://www150.statcan.gc.ca/t1/wds/rest/"
MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def post(path, body):
    req = urllib.request.Request(WDS + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=120))


def coord(*ids):
    ids = list(ids) + [0] * (10 - len(ids))
    return ".".join(str(i) for i in ids)


def statcan(pid, ids, n):
    """Return OrderedDict refPer(YYYY-MM-DD) -> value (scaled), oldest first."""
    r = post("getDataFromCubePidCoordAndLatestNPeriods", [{"productId": pid, "coordinate": coord(*ids), "latestN": n}])[0]
    if r.get("status") != "SUCCESS":
        raise RuntimeError(f"{pid} {ids}: {r}")
    pts = r["object"]["vectorDataPoint"]
    out = OrderedDict()
    for p in sorted(pts, key=lambda p: p["refPer"]):
        v = p.get("value")
        if v is None:
            continue
        out[p["refPer"]] = float(v) * (10 ** int(p.get("scalarFactorCode") or 0))
    return out


def boc(series, start):
    url = f"https://www.bankofcanada.ca/valet/observations/{series}/json?start_date={start}"
    j = json.load(urllib.request.urlopen(url, timeout=120))
    out = OrderedDict()
    for o in j["observations"]:
        v = o.get(series, {}).get("v")
        if v not in (None, ""):
            out[o["d"]] = float(v)
    return out


def month_label(d):  # 2024-03-01 -> Mar 2024
    return f"{MON[int(d[5:7]) - 1]} {d[:4]}"


def quarter_label(d):
    return f"Q{(int(d[5:7]) - 1) // 3 + 1} {d[:4]}"


def yoy(series):
    """Year-over-year change as a fraction, for monthly series keyed by YYYY-MM-DD."""
    out = OrderedDict()
    for d, v in series.items():
        prev = series.get(f"{int(d[:4]) - 1}{d[4:]}")
        if prev:
            out[d] = round(v / prev - 1, 4)
    return out


def monthly_last(series):
    """Daily -> last value of each month."""
    out = OrderedDict()
    for d, v in series.items():
        out[d[:7] + "-01"] = v
    return out


def monthly_mean(series):
    acc = OrderedDict()
    for d, v in series.items():
        acc.setdefault(d[:7] + "-01", []).append(v)
    return OrderedDict((k, sum(v) / len(v)) for k, v in acc.items())


def align(named, label, since=None):
    keys = sorted(set().union(*[s.keys() for s in named.values()]))
    if since:
        keys = [k for k in keys if k >= since]
    return [label(k) for k in keys], [{"name": n, "vals": [s.get(k) for k in keys]} for n, s in named.items()]


def fig(id, title, cats, series, unit, tags, source, note="", chart="line", insight=None):
    d = {"id": id, "topic": "macro", "ref": "Economy", "title": title, "unit": unit, "chart": chart,
         "cats": cats, "series": series, "source": source, "note": note, "tags": tags}
    if insight:
        d["insight"] = insight
    return d


def main():
    figs, errors = [], []
    since = "2019-01-01"
    SC = "Statistics Canada"

    def safe(fn):
        try:
            figs.append(fn())
        except Exception as e:  # keep going; one table failing should not blank the page
            errors.append(f"{fn.__name__}: {e}")

    def cpi_repair():
        s = OrderedDict((n, yoy(statcan(18100004, [2, m], 100))) for n, m in [
            ("All items (overall inflation)", 2), ("Vehicle parts, maintenance and repairs", 185),
            ("Maintenance and repair services", 187), ("Parts, accessories and supplies", 186)])
        cats, series = align(s, month_label, since)
        return fig("econ-cpi-repair", "Vehicle repair and parts prices vs. overall inflation, Canada",
                   cats, series, "%", ["repair-prices", "inflation", "maintenance", "parts", "service-choice"],
                   f"{SC}, Table 18-10-0004-01 (Consumer Price Index, monthly, not seasonally adjusted)",
                   "Change from the same month a year earlier.")

    def cpi_ownership():
        s = OrderedDict((n, yoy(statcan(18100004, [2, m], 100))) for n, m in [
            ("All items (overall inflation)", 2), ("Purchase of passenger vehicles", 180), ("Gasoline", 184),
            ("Vehicle insurance premiums", 189)])
        cats, series = align(s, month_label, since)
        return fig("econ-cpi-ownership", "Cost of owning a vehicle: price change by item, Canada",
                   cats, series, "%", ["vehicle-sales", "fuel-prices", "insurance", "household-finances", "inflation"],
                   f"{SC}, Table 18-10-0004-01 (Consumer Price Index, monthly, not seasonally adjusted)",
                   "Change from the same month a year earlier.")

    def zev_share():
        tot = statcan(20100025, [1, 4, 1, 1], 40)
        parts = OrderedDict((n, statcan(20100025, [1, m, 1, 1], 40)) for n, m in [
            ("Battery electric", 2), ("Plug-in hybrid", 3), ("Hybrid (not plug-in)", 7)])
        s = OrderedDict((n, OrderedDict((k, round(v / tot[k], 4)) for k, v in p.items() if tot.get(k))) for n, p in parts.items())
        cats, series = align(s, quarter_label)
        return fig("econ-zev-share", "Electric and hybrid share of new vehicle registrations, Canada",
                   cats, series, "%", ["ev", "vehicle-sales"], f"{SC}, Table 20-10-0025-01 (New motor vehicle registrations, quarterly)",
                   "Share of all new vehicles registered in the quarter.", chart="stacked")

    def new_regs():
        s = OrderedDict([("New vehicles registered", statcan(20100025, [1, 4, 1, 1], 40))])
        cats, series = align(s, quarter_label)
        return fig("econ-new-registrations", "New vehicle registrations per quarter, Canada", cats, series, "",
                   ["vehicle-sales", "vehicles-on-road"], f"{SC}, Table 20-10-0025-01 (New motor vehicle registrations, quarterly)", chart="bar")

    def fleet_fuel():
        s = OrderedDict((n, statcan(23100308, [1, 2, m, 1], 10)) for n, m in [
            ("Battery electric", 4), ("Plug-in hybrid", 6), ("Hybrid (not plug-in)", 5)])
        cats, series = align(s, lambda d: d[:4])
        return fig("econ-fleet-electrified", "Electric and hybrid light vehicles on the road, Canada", cats, series, "",
                   ["ev", "vehicles-on-road", "maintenance"], f"{SC}, Table 23-10-0308-01 (Vehicle registrations, by type of vehicle and fuel type)",
                   "Vehicles weighing 4,536 kg or less registered in the year.", chart="bar")

    def parts_sales():
        s = OrderedDict([("Auto parts, accessories and tire retailers", OrderedDict((k, v / 1e6) for k, v in statcan(20100056, [1, 7, 1, 2], 100).items()))])
        cats, series = align(s, month_label, since)
        return fig("econ-parts-retail", "Monthly sales at auto parts, accessories and tire retailers, Canada", cats, series, "$M",
                   ["parts", "tires", "maintenance", "independent-shops"], f"{SC}, Table 20-10-0056-01 (Monthly retail trade sales, seasonally adjusted)")

    def repair_jobs():
        s = OrderedDict([("Automotive repair and maintenance", statcan(14100201, [1, 1, 379], 100))])
        cats, series = align(s, month_label, since)
        return fig("econ-repair-jobs", "People employed in automotive repair and maintenance, Canada", cats, series, "",
                   ["labour", "technicians", "independent-shops"], f"{SC}, Table 14-10-0201-01 (Employment by industry, monthly, unadjusted, NAICS 8111)",
                   "Unadjusted for seasonality: compare the same month across years.")

    def repair_pay():
        s = OrderedDict((n, statcan(14100203, [1, 1, 1, m], 100)) for n, m in [
            ("Automotive repair and maintenance", 379), ("All industries", 2)])
        cats, series = align(s, month_label, since)
        return fig("econ-repair-earnings", "Average weekly earnings: automotive repair vs. all industries, Canada", cats, series, "$",
                   ["labour", "technicians", "repair-prices"], f"{SC}, Table 14-10-0203-01 (Average weekly earnings by industry, monthly, including overtime)")

    def repair_gdp():
        s = OrderedDict([("Automotive repair and maintenance", OrderedDict((k, v / 1e6) for k, v in statcan(36100434, [1, 1, 1, 320], 100).items()))])
        cats, series = align(s, month_label, since)
        return fig("econ-repair-gdp", "Economic output of automotive repair and maintenance, Canada", cats, series, "$M",
                   ["maintenance", "service-choice", "independent-shops"], f"{SC}, Table 36-10-0434-01 (GDP at basic prices by industry, chained 2017 dollars)",
                   "Seasonally adjusted at annual rates.")

    def unemployment():
        s = OrderedDict([("Unemployment rate", OrderedDict((k, v / 100) for k, v in statcan(14100287, [1, 7, 1, 1, 1, 1], 100).items()))])
        cats, series = align(s, month_label, since)
        return fig("econ-unemployment", "Unemployment rate, Canada", cats, series, "%", ["household-finances", "labour"],
                   f"{SC}, Table 14-10-0287-01 (Labour Force Survey, seasonally adjusted)")

    def rates():
        s = OrderedDict([("Bank of Canada policy rate", OrderedDict((k, v / 100) for k, v in monthly_last(boc("V39079", since)).items()))])
        cats, series = align(s, month_label, since)
        return fig("econ-policy-rate", "Bank of Canada policy interest rate", cats, series, "%", ["interest-rates", "household-finances", "vehicle-sales"],
                   "Bank of Canada, Valet API (series V39079, target for the overnight rate)", "Rate at the end of each month.")

    def fx():
        s = OrderedDict([("US cents per Canadian dollar", OrderedDict((k, round(100 / v, 2)) for k, v in monthly_mean(boc("FXUSDCAD", since)).items()))])
        cats, series = align(s, month_label, since)
        return fig("econ-cad-usd", "Canadian dollar in US cents", cats, series, "index", ["parts", "repair-prices"],
                   "Bank of Canada, Valet API (series FXUSDCAD, monthly average)", "Most replacement parts are priced in US dollars, so a weaker Canadian dollar tends to raise parts costs.")

    for fn in [cpi_repair, cpi_ownership, zev_share, new_regs, fleet_fuel, parts_sales, repair_jobs, repair_pay, repair_gdp, unemployment, rates, fx]:
        safe(fn)
    out = {"datasets": figs, "errors": errors, "built": datetime.date.today().isoformat()}
    if OUT.exists():
        old = json.loads(OUT.read_text())
        if {k: v for k, v in old.items() if k != "built"} == json.loads(json.dumps({k: v for k, v in out.items() if k != "built"})):
            print("unchanged"); return
    if not figs:
        raise SystemExit("No series could be fetched: " + "; ".join(errors))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {OUT}: {len(figs)} figures; errors: {errors}")


if __name__ == "__main__":
    main()
