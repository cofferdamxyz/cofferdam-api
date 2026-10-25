"""Fetch the TechWolf reference models file by file, checking each size against the Hub's record; retry on a short file."""
import os, time
os.environ.setdefault("HF_HOME", "/Users/hoff/Development/workrb-bench/hf-cache")
from huggingface_hub import HfApi, hf_hub_download
api = HfApi()
for repo in ["TechWolf/ConTeXT-Skill-Extraction-base", "TechWolf/JobBERT-v3"]:
    info = api.model_info(repo, files_metadata=True)
    files = [(s.rfilename, s.size) for s in info.siblings if not s.rfilename.startswith(".") and not s.rfilename.endswith((".onnx", ".bin", ".h5", ".msgpack", ".ot")) and "onnx/" not in s.rfilename and "openvino/" not in s.rfilename]
    total = sum(size or 0 for _, size in files)
    print(f"{repo}: {len(files)} files, {total / 1e6:.0f} MB", flush=True)
    for name, size in sorted(files, key=lambda f: f[1] or 0):
        for attempt in range(10):
            try:
                path = hf_hub_download(repo_id=repo, filename=name, force_download=attempt > 0)
                got = os.path.getsize(path)
                if size is not None and got != size:
                    raise IOError(f"{name}: {got} of {size} bytes")
                if (size or 0) > 10_000_000:
                    print(f"  {name}: {got / 1e6:.0f} MB", flush=True)
                break
            except Exception as e:
                wait = min(120, 5 * 2 ** attempt)
                print(f"  {name}: {type(e).__name__}: {str(e)[:100]}; retry in {wait}s", flush=True)
                time.sleep(wait)
        else:
            raise SystemExit(f"{repo}: {name} failed")
    print(f"{repo}: complete", flush=True)
