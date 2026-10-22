"""Offline registry availability audit. Python 3.9+, standard library only.
Usage: python analysis.py registry_source.json --out rerun
The default as-of date is frozen in the source snapshot; no network is used.
"""
import argparse, calendar, collections, csv, datetime as dt, hashlib, json, re
from pathlib import Path

GBM = re.compile(r"glioblastoma|\bGBM\b", re.I)
OTHER = re.compile(r"tumou?r|neoplas|cancer|carcinoma|glioma|gliomas|astrocyt|gliosarcoma|lymphoma|melanoma|sarcoma|blastoma|ganglio|cytoma|meningioma|chordoid", re.I)
BINS = ["<1 year", "1–<3 years", "3–<5 years", "≥5 years", "Unknown/invalid date"]

def bounds(value):
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value or ""):
            d = dt.date.fromisoformat(value)
            return d, d, "day"
        if re.fullmatch(r"\d{4}-\d{2}", value or ""):
            y, m = map(int, value.split("-"))
            return dt.date(y,m,1), dt.date(y,m,calendar.monthrange(y,m)[1]), "month"
        if re.fullmatch(r"\d{4}", value or ""):
            y = int(value)
            return dt.date(y,1,1), dt.date(y,12,31), "year"
    except ValueError:
        pass
    return None, None, "missing/invalid"

def group(years):
    if years is None or years < 0:
        return BINS[4]
    return BINS[0] if years < 1 else BINS[1] if years < 3 else BINS[2] if years < 5 else BINS[3]

def write_csv(path, rows):
    assert rows
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

def analyze(source, out, as_of=None):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    snapshot = dt.date.fromisoformat(as_of or source["as_of_date"])
    candidates = [t for p in source["search_pages"] for t in p["response"]["items"]]
    ids = [t["nct_id"] for t in candidates]
    assert len(ids) == len(set(ids)), "Duplicate search IDs"
    assert len(ids) == source["search_pages"][0]["response"]["total"], "Incomplete search"
    assert not source["search_pages"][-1]["response"].get("next_page_token"), "Unconsumed page"
    details = {d["nct_id"]:d["response"] for d in source["details"]}
    assert len(details) == len(source["details"]), "Duplicate details"
    lower, upper = dt.date(2020,1,1), dt.date(2025,12,31)
    rows = []
    for candidate in sorted(candidates, key=lambda t:t["nct_id"]):
        nid = candidate["nct_id"]
        response = details.get(nid, {})
        found = response.get("found") is True
        t = response.get("trial", candidate)
        conditions = t.get("conditions") or []
        date = t.get("primary_completion_date")
        lo, hi, precision = bounds(date)
        exclusions = []
        if not found: exclusions.append("detail_unavailable")
        if t.get("status") != "COMPLETED": exclusions.append("not_completed")
        if t.get("study_type") != "INTERVENTIONAL": exclusions.append("not_interventional")
        if "PHASE2" not in (t.get("phase") or []): exclusions.append("no_phase2")
        if not any(GBM.search(c) for c in conditions): exclusions.append("no_explicit_gbm_condition")
        if lo is not None and (hi < lower or lo > upper): exclusions.append("date_outside_window")
        # Missing date is retained with timing unknown; search determined window eligibility.
        flag = t.get("has_results") if found else None
        result = "yes" if flag is True else "no" if flag is False else "unknown"
        days_min = (snapshot-hi).days if hi else None
        days_max = (snapshot-lo).days if lo else None
        days_mid = (days_min+days_max)/2 if lo else None
        elapsed = [d/365.25 if d is not None else None for d in [days_mid, days_min, days_max]]
        other_conditions = [c for c in conditions if not GBM.search(c) and OTHER.search(c)]
        # Screening flag: broader disease terms can be umbrella labels, not actual extra cohorts.
        within_condition_broad = [c for c in conditions if GBM.search(c) and re.search(r"gliomas?\b", c, re.I)]
        row = dict(nct_id=nid, url=t.get("url") or "https://clinicaltrials.gov/study/"+nid,
                   title=t.get("title"), status=t.get("status"), study_type=t.get("study_type"),
                   phase="|".join(t.get("phase") or []), conditions=json.dumps(conditions,ensure_ascii=False),
                   included=not exclusions, exclusion_reason=";".join(exclusions),
                   potential_mixed_disease=bool(other_conditions or within_condition_broad),
                   mixed_disease_flag_evidence=json.dumps(other_conditions+within_condition_broad,ensure_ascii=False),
                   has_registry_results=result, primary_completion_date=date,
                   date_precision=precision, date_earliest=lo.isoformat() if lo else "",
                   date_latest=hi.isoformat() if hi else "", as_of_date=snapshot.isoformat(),
                   elapsed_years_midpoint=elapsed[0], elapsed_years_min=elapsed[1], elapsed_years_max=elapsed[2],
                   stratum_midpoint=group(elapsed[0]), stratum_latest_completion=group(elapsed[1]),
                   stratum_earliest_completion=group(elapsed[2]),
                   stratum_sensitive=group(elapsed[1])!=group(elapsed[2]))
        rows.append(row)
    included = [r for r in rows if r["included"]]
    summaries = []
    for scenario, key in [("midpoint","stratum_midpoint"),("latest_completion","stratum_latest_completion"),("earliest_completion","stratum_earliest_completion")]:
        for band in ["Overall"]+BINS:
            subset = included if band == "Overall" else [r for r in included if r[key]==band]
            counts = collections.Counter(r["has_registry_results"] for r in subset)
            known = counts["yes"]+counts["no"]
            summaries.append(dict(scenario=scenario,stratum=band,total_trials=len(subset),
                                  results_yes=counts["yes"],results_no=counts["no"],results_unknown=counts["unknown"],
                                  known_denominator=known,
                                  percent_with_results_known=round(100*counts["yes"]/known,2) if known else "",
                                  percent_with_results_all=round(100*counts["yes"]/len(subset),2) if subset else ""))
        current = [s for s in summaries if s["scenario"]==scenario]
        assert sum(s["total_trials"] for s in current[1:])==len(included)
        assert all(s["results_yes"]+s["results_no"]+s["results_unknown"]==s["total_trials"] for s in current)
    assert len(rows)==len(ids)
    write_csv(out/"trial_calculations.csv",rows)
    write_csv(out/"availability_summary.csv",summaries)
    return rows, summaries

def selfcheck():
    assert bounds("2024-02")[1] == dt.date(2024,2,29)
    assert bounds("2023")[1] == dt.date(2023,12,31)
    assert bounds("2024-02-30")[0] is None
    assert [group(x) for x in [0,0.99999,1,2.99999,3,4.99999,5,None,-1]] == [BINS[i] for i in [0,0,1,1,2,2,3,4,4]]
    synthetic = {"as_of_date":"2026-09-29","search_pages":[{"response":{"total":1,"next_page_token":None,"items":[{"nct_id":"TEST"}]}}],"details":[{"nct_id":"TEST","response":{"found":True,"trial":{"nct_id":"TEST","status":"COMPLETED","study_type":"INTERVENTIONAL","phase":["PHASE2"],"conditions":["Glioblastoma"],"primary_completion_date":"2025-09","has_results":None}}}]}
    # Pure date sensitivity: September 2025 crosses the one-year boundary.
    lo,hi,_=bounds("2025-09")
    assert group((dt.date(2026,9,29)-lo).days/365.25)!=group((dt.date(2026,9,29)-hi).days/365.25)

if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source",type=Path)
    parser.add_argument("--out",type=Path,default=Path("rerun"))
    parser.add_argument("--as-of",help="Optional scenario date YYYY-MM-DD; default frozen retrieval date")
    args=parser.parse_args()
    selfcheck()
    content=args.source.read_bytes()
    rows,summaries=analyze(json.loads(content),args.out,args.as_of)
    print("Source SHA256:",hashlib.sha256(content).hexdigest())
    print("Candidate / included:",len(rows),sum(r["included"] for r in rows))
    print(json.dumps([s for s in summaries if s["scenario"]=="midpoint"],indent=2,ensure_ascii=False))
