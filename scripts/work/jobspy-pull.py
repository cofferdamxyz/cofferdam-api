# Copyright (c) 2026 Cofferdam Inc.
# SPDX-License-Identifier: Apache-2.0
# /// script
# requires-python = ">=3.10"
# dependencies = ["python-jobspy"]
# ///
"""Pull real vacancies for the Work pipeline benchmark (test/workJobs.eval.test.ts).

Indeed through JobSpy (https://github.com/speedyapply/JobSpy), one query per
search term and location in the three launch markets, deduplicated by job
id, written as JSONL per country under --out/<date>/ with a manifest. The
emails column is dropped; descriptions keep whatever the ad says (Markdown,
so headings and bullets survive), so the benchmark de-identifies them before
any hosted call. Nothing here enters a
repository: the output folder lives outside the workspace.

  uv run scripts/work/jobspy-pull.py --out ~/Development/jobs-bench/raw [--per 25] [--sites indeed] [--format markdown]

Terms are the trades and roles of Cofferdam's target industries, with a few
professional ones for contrast, in the language of each market.
"""

import argparse
import json
import sys
import time
from datetime import date
from pathlib import Path

import jobspy

MARKETS = {
    "usa": {
        "lang": "en",
        "locations": ["Houston, TX", "New Orleans, LA", "Miami, FL", "Corpus Christi, TX"],
        "terms": [
            "offshore electrician", "electrician", "plumber", "welder", "pipefitter", "rigger", "crane operator",
            "HVAC technician", "diesel mechanic", "marine engineer", "deckhand", "truck driver", "warehouse associate",
            "accountant", "paralegal", "registered nurse", "software developer",
        ],
    },
    "brazil": {
        "lang": "pt",
        "locations": ["Rio de Janeiro, RJ", "São Paulo, SP", "Macaé, RJ"],
        "terms": [
            "eletricista", "encanador", "soldador", "mecânico", "operador de guindaste", "técnico de refrigeração",
            "motorista", "auxiliar de logística", "contador", "advogado", "enfermeiro", "desenvolvedor",
        ],
    },
    "mexico": {
        "lang": "es",
        "locations": ["Monterrey, N.L.", "Ciudad del Carmen, Camp.", "Veracruz, Ver."],
        "terms": [
            "electricista", "plomero", "soldador", "mecánico", "operador de grúa", "técnico en refrigeración",
            "chofer", "auxiliar de almacén", "contador", "abogado", "enfermera", "desarrollador",
        ],
    },
}

KEEP = ["id", "site", "job_url", "title", "company", "location", "date_posted", "job_type", "is_remote", "description", "skills"]


def clean(v):
    if v is None:
        return None
    if isinstance(v, float) and v != v:  # NaN
        return None
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--per", type=int, default=25, help="results wanted per term and location")
    ap.add_argument("--sites", default="indeed", help="comma-separated JobSpy sites")
    ap.add_argument("--sleep", type=float, default=1.5)
    ap.add_argument("--markets", default=",".join(MARKETS))
    ap.add_argument("--format", default="markdown", help="JobSpy description_format: markdown keeps headings and bullets")
    args = ap.parse_args()
    sites = args.sites.split(",")
    out = Path(args.out).expanduser() / date.today().isoformat()
    out.mkdir(parents=True, exist_ok=True)
    manifest = {"date": date.today().isoformat(), "sites": sites, "per": args.per, "format": args.format, "markets": {}}
    for country in args.markets.split(","):
        m = MARKETS[country]
        seen = {}
        failures = []
        for location in m["locations"]:
            for term in m["terms"]:
                t0 = time.time()
                try:
                    df = jobspy.scrape_jobs(site_name=sites, search_term=term, location=location, results_wanted=args.per, country_indeed=country, description_format=args.format, verbose=0)
                except Exception as e:  # a board's refusal is a row in the manifest, never a stop
                    failures.append({"location": location, "term": term, "error": type(e).__name__})
                    print(f"{country} {location} {term}: {type(e).__name__}", file=sys.stderr)
                    time.sleep(args.sleep)
                    continue
                n = 0
                for _, r in df.iterrows():
                    key = r.get("id") or r.get("job_url")
                    if not key or key in seen:
                        continue
                    row = {k: clean(r.get(k)) for k in KEEP}
                    if not row["description"]:
                        continue
                    row.update({"country": country, "lang": m["lang"], "term": term, "query_location": location})
                    seen[key] = row
                    n += 1
                print(f"{country} {location} {term}: {len(df)} rows, {n} new, {time.time() - t0:.1f}s", flush=True)
                time.sleep(args.sleep)
        path = out / f"{country}.jsonl"
        with path.open("w", encoding="utf-8") as f:
            for row in seen.values():
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        manifest["markets"][country] = {"vacancies": len(seen), "failures": failures, "file": path.name}
        print(f"{country}: {len(seen)} vacancies -> {path}", flush=True)
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
