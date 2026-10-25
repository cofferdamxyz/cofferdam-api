"""Print the comparison as Markdown tables from results/<model>/results.json (Cofferdam, 2026-10-25)."""

import json
import os
import sys

BASE = "/Users/hoff/Development/workrb-bench/results"
MODELS = sys.argv[1:] or ["bge-m3", "embeddinggemma", "qwen3", "bge-m3+rerank"]

LABELS = {
    ("Job to Skills WorkBench", "en"): "Occupation → skills (en)",
    ("Job to Skills WorkBench", "es"): "Occupation → skills (es)",
    ("Job to Skills WorkBench", "pt"): "Occupation → skills (pt)",
    ("MELO", "usa_q_en_c_en"): "National title → occupation (US, en)",
    ("MELO", "esp_q_es_c_es"): "National title → occupation (Spain, es)",
    ("MELO", "prt_q_pt_c_pt"): "National title → occupation (Portugal, pt)",
    ("Job Normalization", "en"): "Vacancy title → occupation (en)",
    ("Skill Extraction House", "en"): "Job-ad sentence → skills, House (en)",
    ("Skill Extraction Tech", "en"): "Job-ad sentence → skills, Tech (en)",
}

rows: dict[tuple, dict[str, dict]] = {}
for m in MODELS:
    path = os.path.join(BASE, m, "results.json")
    if os.path.exists(path):
        r = json.load(open(path))
    elif os.path.exists(os.path.join(BASE, m, "checkpoint.json")):
        # A run still going: the datasets it has finished.
        r = json.load(open(os.path.join(BASE, m, "checkpoint.json")))["results"]
    else:
        continue
    for task, t in r["task_results"].items():
        for ds, d in t["datasetid_results"].items():
            rows.setdefault((task, ds), {})[m] = d["metrics_dict"]

present = [m for m in MODELS if any(m in v for v in rows.values())]
for metric in ["map", "mrr", "hit@1", "rp@10"]:
    lines = []
    for key, label in LABELS.items():
        vals = rows.get(key, {})
        if not any(metric in vals.get(m, {}) for m in present):
            continue
        cells = [f"{100 * vals[m][metric]:.1f}" if metric in vals.get(m, {}) else "—" for m in present]
        lines.append(f"| {label} | " + " | ".join(cells) + " |")
    if lines:
        print(f"\n{metric.upper()} (%)\n")
        print("| Task | " + " | ".join(present) + " |")
        print("|---|" + "---|" * len(present))
        print("\n".join(lines))
