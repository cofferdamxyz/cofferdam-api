# WorkRB encoder comparison (2026-10-25)

The scripts behind [`../encoders-2026-10-25.md`](../encoders-2026-10-25.md), as they ran on the Mac. They are a record, not a maintained tool, and they assume the bench folder `/Users/hoff/Development/workrb-bench`.

```bash
brew install uv
cd ~/Development/workrb-bench && uv venv --python 3.12 .venv && VIRTUAL_ENV=$PWD/.venv uv pip install workrb
.venv/bin/python bench/fetch_datasets.py && .venv/bin/python bench/fetch_models2.py
HF_HUB_OFFLINE=1 HF_DATASETS_OFFLINE=1 direnv exec ~/Development/Cofferdam .venv/bin/python bench/run.py bge-m3   # or embeddinggemma, qwen3, bge-m3+rerank, context, jobbert-v3
.venv/bin/python bench/table.py
```

The hosted models need `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (the workspace `.envrc`); the adapter never prints or stores the token.
