"""Run the Cofferdam encoder comparison on WorkRB for one model (2026-10-25).

    direnv exec /Users/hoff/Development/Cofferdam \
      /Users/hoff/Development/workrb-bench/.venv/bin/python \
      /Users/hoff/Development/workrb-bench/bench/run.py <bge-m3|embeddinggemma|qwen3|bge-m3+rerank|context|jobbert-v3>

Tasks, all on their test split:
- ESCOJob2SkillRanking (occupation name -> its ESCO skills), en, es, pt
- MELORanking (national occupation names -> ESCO occupations), monolingual en, es, pt
- JobBERTJobNormRanking (vacancy titles -> ESCO occupations), en
- HouseSkillExtractRanking and TechSkillExtractRanking (job-ad sentences -> skills), en
Results land in /Users/hoff/Development/workrb-bench/results/<model>/.
"""

import os
import sys
import time

BASE = "/Users/hoff/Development/workrb-bench"
os.environ.setdefault("HF_HOME", f"{BASE}/hf-cache")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import workrb  # noqa: E402
from workrb.tasks import (  # noqa: E402
    ESCOJob2SkillRanking,
    HouseSkillExtractRanking,
    JobBERTJobNormRanking,
    MELORanking,
    TechSkillExtractRanking,
)

# The datasets were fetched once by fetch_datasets.py; load them from those local
# snapshots so a run makes no Hugging Face API calls (anonymous calls get 429s).
import datasets as _datasets  # noqa: E402
import workrb.tasks.ranking.jobnorm as _jobnorm  # noqa: E402
import workrb.tasks.ranking.melo as _melo  # noqa: E402
import workrb.tasks.ranking.skill_extraction as _skill_extraction  # noqa: E402
import glob  # noqa: E402

# Only the needed MELO subsets were fetched, so resolve each snapshot folder directly.
_LOCAL = {
    repo: glob.glob(f"{os.environ['HF_HOME']}/hub/datasets--{repo.replace('/', '--')}/snapshots/*/")[0]
    for repo in ["Avature/MELO-Benchmark", "TechWolf/JobBERT-evaluation-dataset", "TechWolf/skill-extraction-house", "TechWolf/skill-extraction-tech"]
}


def _load_local(path, *args, **kwargs):
    if path == "Avature/MELO-Benchmark":
        # One subset's own files; the README lists subsets that were never fetched.
        folder = f"{_LOCAL[path]}{args[0]}"
        return _datasets.load_dataset("parquet", data_files={
            "queries": f"{folder}/queries-00000-of-00001.parquet",
            "corpus": f"{folder}/corpus-00000-of-00001.parquet",
        })
    return _datasets.load_dataset(_LOCAL.get(path, path), *args, **kwargs)


for _module in (_jobnorm, _melo, _skill_extraction):
    _module.load_dataset = _load_local

# ESCO's CSVs go to ~/Library/Caches by default, which macOS empties when the disk
# runs low (it did on 2026-10-25); keep them beside the bench instead.
import workrb.data.esco as _esco  # noqa: E402

_esco.appdirs.user_cache_dir = lambda *a, **k: f"{BASE}/wteb-cache"


def _with_retries(build):
    """ESCO downloads from ec.europa.eu can fail on a slow link; build the tasks again."""
    for attempt in range(6):
        try:
            return build()
        except RuntimeError as e:
            if "ESCO data" not in str(e) or attempt == 5:
                raise
            print(f"ESCO download failed ({e}); retrying in {30 * (attempt + 1)} s", flush=True)
            time.sleep(30 * (attempt + 1))

HOSTED = {
    "bge-m3": "@cf/baai/bge-m3",
    "embeddinggemma": "@cf/google/embeddinggemma-300m",
    "qwen3": "@cf/qwen/qwen3-embedding-0.6b",
}


def model_for(key: str):
    if key in HOSTED:
        from workers_ai_model import WorkersAIEmbedModel

        return WorkersAIEmbedModel(HOSTED[key], cache_dir=f"{BASE}/cache")
    if key == "bge-m3+rerank":
        from rerank_model import RerankModel
        from workers_ai_model import WorkersAIEmbedModel

        return RerankModel(WorkersAIEmbedModel(HOSTED["bge-m3"], cache_dir=f"{BASE}/cache"), cache_dir=f"{BASE}/cache", workers=10)
    if key == "context":
        from workrb.models import ConTeXTMatchModel

        return ConTeXTMatchModel()
    if key == "jobbert-v3":
        from workrb.models import JobBERTModel

        return JobBERTModel(model_name="TechWolf/JobBERT-v3")
    raise SystemExit(f"unknown model {key}")


def main():
    key = sys.argv[1]
    # The reranker makes one call per query, so it runs on the smaller set (about 5,400 queries):
    # English occupation -> skills, the three MELO sets and the two skill-extraction sets.
    if key == "bge-m3+rerank":
        tasks = [
            ESCOJob2SkillRanking(split="test", languages=["en"]),
            MELORanking(split="test", languages=["en", "es", "pt"]),
            HouseSkillExtractRanking(split="test", languages=["en"]),
            TechSkillExtractRanking(split="test", languages=["en"]),
        ]
        model = model_for(key)
        started = time.time()
        results = workrb.evaluate(model, tasks, output_folder=f"{BASE}/results/{key}", description=f"Cofferdam encoder comparison: {key}")
        print(results)
        print(f"done in {time.time() - started:.0f} s, {model.calls} reranker calls")
        return
    tasks = _with_retries(lambda: [
        ESCOJob2SkillRanking(split="test", languages=["en", "es", "pt"]),
        MELORanking(split="test", languages=["en", "es", "pt"]),
        JobBERTJobNormRanking(split="test", languages=["en"]),
        HouseSkillExtractRanking(split="test", languages=["en"]),
        TechSkillExtractRanking(split="test", languages=["en"]),
    ])
    model = model_for(key)
    started = time.time()
    results = workrb.evaluate(model, tasks, output_folder=f"{BASE}/results/{key}", description=f"Cofferdam encoder comparison: {key}")
    print(results)
    calls = getattr(model, "calls", None)
    print(f"done in {time.time() - started:.0f} s" + (f", {calls} Workers AI calls" if calls is not None else ""))


if __name__ == "__main__":
    main()
