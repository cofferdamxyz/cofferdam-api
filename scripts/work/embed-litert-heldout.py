# Copyright (c) 2026 Cofferdam Inc.
# SPDX-License-Identifier: Apache-2.0
# /// script
# requires-python = ">=3.10"
# dependencies = ["litert-lm-api-nightly==0.19.0.dev20261028", "numpy>=2"]
# ///
"""Held-out retrieval in each runtime's own space: does a label find its own token? (Workspace
decision 0068; the companion of `embed-litert-compare.py`.)

Samples tokens with at least three labels per kind from the v3 index files, takes one label of
each as a query and every other label of the sampled tokens as the documents (the query's own
text left out in every language), and scores recall at 1 and 5 by token for GGUF queries on
GGUF documents (v3 as stored), LiteRT-LM on LiteRT-LM, and LiteRT-LM queries on GGUF documents
(a mixed index), with the median cosine of unrelated pairs in each space. Writes
`heldout.json`, counts only.

  uv run scripts/work/embed-litert-heldout.py --registry ~/Development/esco/import/registry-embeddinggemma-2 \
      --gguf <embeddinggemma-2-Q8_0.gguf> --litert <embeddinggemma-2-text-270m.litertlm> --out <dir>
"""

import argparse
import glob
import json
import os
import random
import re
import subprocess
import tempfile
import time

import numpy as np

QUERY = "task: search result | query: "
DOCUMENT = "title: none | text: "

ap = argparse.ArgumentParser()
ap.add_argument("--registry", required=True)
ap.add_argument("--gguf", required=True)
ap.add_argument("--litert", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--tokens", type=int, default=600)
ap.add_argument("--seed", type=int, default=69)
args = ap.parse_args()
rng = random.Random(args.seed)
clean = lambda t: re.sub(r"\s+", " ", t).strip()

by_token = {}
stored = {}
for f in sorted(glob.glob(os.path.join(args.registry, "vectors-v3-[0-9][0-9][0-9].ndjson"))):
    for line in open(f, encoding="utf-8"):
        if not line.strip():
            continue
        r = json.loads(line)
        m = r["metadata"]
        if m.get("kind") not in ("pos", "skill"):
            continue
        key = (m["kind"], m["token"])
        lab = clean(m["label"])
        by_token.setdefault(key, []).append((lab, m.get("lang")))
        stored[(m["kind"], lab)] = np.asarray(r["values"], dtype=np.float32)

report = {}
import litert_lm  # noqa: E402

eng = litert_lm.EmbeddingEngine(args.litert, backend=litert_lm.Backend.CPU())

def lite(texts):
    out = np.asarray([eng.compute_embedding(t).embedding for t in texts], dtype=np.float32)
    return out / np.linalg.norm(out, axis=1, keepdims=True)

def gguf(texts):
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "p.txt")
        open(p, "w", encoding="utf-8").write("\n".join(texts) + "\n")
        run = subprocess.run(["llama-embedding", "-m", args.gguf, "--pooling", "mean", "--embd-normalize", "2", "--embd-output-format", "json",
                              "-f", p, "-b", "8192", "-ub", "8192", "-c", "8192"], capture_output=True, text=True, check=True)
        out = np.asarray([x["embedding"] for x in json.loads(run.stdout)["data"]], dtype=np.float32)
        return out / np.linalg.norm(out, axis=1, keepdims=True)

for kind in ("pos", "skill"):
    tokens = [k for k, labs in by_token.items() if k[0] == kind and len({l for l, _ in labs}) >= 3]
    rng.shuffle(tokens)
    tokens = tokens[: args.tokens]
    queries, docs = [], []
    for k in tokens:
        labs = sorted({l for l, _ in by_token[k]})
        q = rng.choice(labs)
        queries.append((q, k[1]))
        docs += [(l, k[1]) for l in labs if l != q]
    doc_texts = [l for l, _ in docs]
    doc_tokens = np.asarray([t for _, t in docs])
    t0 = time.time()
    Gd = np.stack([stored[(kind, l)] for l in doc_texts])
    Gd /= np.linalg.norm(Gd, axis=1, keepdims=True)
    Gq = gguf([QUERY + q for q, _ in queries])
    Ld = lite([DOCUMENT + l for l in doc_texts])
    Lq = lite([QUERY + q for q, _ in queries])
    secs = time.time() - t0

    def recall(Q, D):
        s = Q @ D.T
        r1 = r5 = 0
        for i, (_, tok) in enumerate(queries):
            order = np.argsort(-s[i])
            r1 += int(doc_tokens[order[0]] == tok)
            # recall at 5 by distinct token
            seen = []
            for j in order:
                if doc_tokens[j] not in seen:
                    seen.append(doc_tokens[j])
                if len(seen) == 5:
                    break
            r5 += int(tok in seen)
        return r1, r5

    def unrelated(D):
        idx = [rng.randrange(len(doc_texts)) for _ in range(4000)]
        jdx = [rng.randrange(len(doc_texts)) for _ in range(4000)]
        vals = [float(D[i] @ D[j]) for i, j in zip(idx, jdx) if doc_tokens[i] != doc_tokens[j]]
        return float(np.median(vals))

    report[kind] = {
        "tokens": len(tokens), "documents": len(docs), "seconds": round(secs),
        "gguf_gguf": recall(Gq, Gd), "litert_litert": recall(Lq, Ld), "litert_query_gguf_documents": recall(Lq, Gd),
        "unrelated_median_gguf": unrelated(Gd), "unrelated_median_litert": unrelated(Ld),
    }
    print(kind, json.dumps(report[kind]), flush=True)

json.dump(report, open(os.path.join(args.out, "heldout.json"), "w"), indent=1)
