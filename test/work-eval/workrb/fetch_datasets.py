"""Fetch the Hugging Face datasets the comparison needs, one at a time with backoff, into HF_HOME."""
import os, time
os.environ.setdefault("HF_HOME", "/Users/hoff/Development/workrb-bench/hf-cache")
from huggingface_hub import snapshot_download
WANT = [
    ("Avature/MELO-Benchmark", ["README.md", "esp_q_es_c_es/*", "esp_q_es_c_en/*", "prt_q_pt_c_pt/*", "prt_q_pt_c_en/*", "usa_q_en_c_en/*"]),
    ("TechWolf/JobBERT-evaluation-dataset", None),
    ("TechWolf/skill-extraction-house", None),
    ("TechWolf/skill-extraction-tech", None),
]
for repo, patterns in WANT:
    for attempt in range(8):
        try:
            path = snapshot_download(repo_id=repo, repo_type="dataset", allow_patterns=patterns)
            files = sum(len(f) for _, _, f in os.walk(path))
            print(f"{repo}: {files} files", flush=True)
            break
        except Exception as e:
            wait = min(120, 10 * 2 ** attempt)
            print(f"{repo}: {type(e).__name__}, retrying in {wait}s", flush=True)
            time.sleep(wait)
    else:
        raise SystemExit(f"{repo}: gave up")
    time.sleep(5)
