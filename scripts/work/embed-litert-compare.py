# Copyright (c) 2026 Cofferdam Inc.
# SPDX-License-Identifier: Apache-2.0
# /// script
# requires-python = ">=3.10"
# dependencies = ["litert-lm-api-nightly==0.19.0.dev20261028", "numpy>=2"]
# ///
"""EmbeddingGemma 2 through LiteRT-LM against the GGUF behind token-registry-v3 (workspace
decision 0068, the rulings of 2026-10-29, night: before the phone's vectors from LiteRT-LM's
artefact meet v3, they must match the GGUF's on the same strings, prefixes and pooling).

Same strings, the same prefixes, the special tokens each runtime inserts (`<bos>` and `<eos>`
on both), the pooling each artefact declares, L2-normalised, 768 values. Reads the v3 index
files `scripts/work/embed-registry.mjs` wrote, embeds a stratified sample of their labels with
both runtimes (llama.cpp's `llama-embedding` as that script runs it, LiteRT-LM's Python API in
process), and writes `report-<backend>.json`: the cosine per string between the two, the GGUF
today against the stored v3 vector, and what the snap and the tier-2 world would see with
LiteRT-LM's vectors. Nothing leaves the Mac; the strings are ESCO's labels and the synthetic
fixtures.

  uv run scripts/work/embed-litert-compare.py --registry ~/Development/esco/import/registry-embeddinggemma-2 \
      --gguf <embeddinggemma-2-Q8_0.gguf> --litert <embeddinggemma-2-text-270m.litertlm> \
      --fixtures test/fixtures/work --out <dir> [--per-stratum 400] [--backend cpu|gpu]
"""

import argparse
import glob
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import time

import numpy as np

QUERY = "task: search result | query: "
DOCUMENT = "title: none | text: "
DIMS = 768

ap = argparse.ArgumentParser()
ap.add_argument("--registry", required=True)
ap.add_argument("--gguf", required=True)
ap.add_argument("--litert", required=True)
ap.add_argument("--fixtures", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--per-stratum", type=int, default=400)
ap.add_argument("--queries-per-stratum", type=int, default=100)
ap.add_argument("--backend", default="cpu")
ap.add_argument("--seed", type=int, default=68)
args = ap.parse_args()
os.makedirs(args.out, exist_ok=True)
rng = random.Random(args.seed)
clean = lambda t: re.sub(r"\s+", " ", t).strip()

# ---- The v3 index as the Mac holds it: every label's stored vector. ----
t0 = time.time()
ids, labels, kinds, langs, rows = [], [], [], [], []
for f in sorted(glob.glob(os.path.join(args.registry, "vectors-v3-[0-9][0-9][0-9].ndjson"))):
    for line in open(f, encoding="utf-8"):
        if not line.strip():
            continue
        r = json.loads(line)
        m = r["metadata"]
        if m.get("kind") == "cert" and m.get("source") == "seed":
            continue  # the deleted certificate seed (decision 0070)
        ids.append(r["id"])
        labels.append(clean(m["label"]))
        kinds.append(m["kind"])
        langs.append(m.get("lang"))
        rows.append(np.asarray(r["values"], dtype=np.float32))
pool = np.stack(rows)
del rows
print(f"v3: {len(ids)} vectors loaded in {time.time() - t0:.0f} s", flush=True)

# ---- The sample, stratified by kind and language. ----
strata = {}
for i, (k, l) in enumerate(zip(kinds, langs)):
    strata.setdefault((k, l), []).append(i)
doc_idx, query_idx = [], []
for key in sorted(strata):
    members = strata[key][:]
    rng.shuffle(members)
    doc_idx += members[: args.per_stratum]
    query_idx += members[args.per_stratum : args.per_stratum + args.queries_per_stratum]

fx = args.fixtures
synth = json.load(open(os.path.join(fx, "tier2-floor.json"), encoding="utf-8"))
prompts = [p for p in json.load(open(os.path.join(fx, "hirer-prompts.json"), encoding="utf-8"))["prompts"] if not p["expected"].get("refuse")]

# Long listing-shaped documents: up to five titles, thirty skills, as the phone sends a listing.
long_docs = []
for lang in ("en", "es", "pt"):
    pos = [i for i in strata[("pos", lang)]]
    skl = [i for i in strata[("skill", lang)]]
    for _ in range(20):
        titles = [labels[i] for i in rng.sample(pos, 3)]
        skills = [labels[i] for i in rng.sample(skl, 30)]
        long_docs.append("; ".join(titles) + ". " + "; ".join(skills))

items = []  # (set, role, text, registry index or -1)
items += [("registry document", "document", labels[i], i) for i in doc_idx]
items += [("registry query", "query", labels[i], i) for i in query_idx]
items += [("hirer sentence (tier2-floor)", "query", s["text"], -1) for s in synth["sentences"]]
items += [("hirer sentence (hirer-prompts)", "query", p["text"], -1) for p in prompts]
items += [("synthetic listing", "document", l["text"], -1) for l in synth["listings"]]
items += [("long listing", "document", t, -1) for t in long_docs]
texts = [(QUERY if role == "query" else DOCUMENT) + clean(t) for _, role, t, _ in items]
print(f"{len(items)} strings to embed", flush=True)

# ---- The GGUF, as embed-registry.mjs runs it. ----
def gguf_embed(batch):
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "prompts.txt")
        with open(p, "w", encoding="utf-8") as f:
            f.write("\n".join(batch) + "\n")
        run = subprocess.run(
            ["llama-embedding", "-m", args.gguf, "--pooling", "mean", "--embd-normalize", "2", "--embd-output-format", "json",
             "-f", p, "-b", "8192", "-ub", "8192", "-c", "8192"],
            capture_output=True, text=True)
        if run.returncode != 0:
            sys.exit(f"llama-embedding exited {run.returncode}: {run.stderr[-500:]}")
        data = json.loads(run.stdout)["data"]
        assert len(data) == len(batch)
        return [d["embedding"] for d in data]

t0 = time.time()
G = []
for i in range(0, len(texts), 1000):
    G += gguf_embed(texts[i : i + 1000])
G = np.asarray(G, dtype=np.float32)
G /= np.linalg.norm(G, axis=1, keepdims=True)
gguf_s = time.time() - t0
print(f"GGUF: {len(G)} in {gguf_s:.0f} s", flush=True)

# ---- LiteRT-LM's artefact, its defaults: special tokens inserted, normalised, 768. ----
import litert_lm  # noqa: E402

backend = litert_lm.Backend.CPU() if args.backend == "cpu" else litert_lm.Backend.GPU()
eng = litert_lm.EmbeddingEngine(args.litert, backend=backend)
t0 = time.time()
L, per_ms = [], []
for t in texts:
    s = time.time()
    v = eng.compute_embedding(t).embedding
    per_ms.append((time.time() - s) * 1000)
    assert len(v) == DIMS, len(v)
    L.append(v)
L = np.asarray(L, dtype=np.float32)
L /= np.linalg.norm(L, axis=1, keepdims=True)
litert_s = time.time() - t0
print(f"LiteRT-LM ({args.backend}): {len(L)} in {litert_s:.0f} s, median {np.median(per_ms):.1f} ms a string", flush=True)

cos = np.sum(G * L, axis=1)

def stats(xs):
    xs = np.sort(np.asarray(xs))
    q = lambda p: float(xs[min(len(xs) - 1, int(p * len(xs)))])
    return {"n": int(len(xs)), "min": float(xs[0]), "p0.1": q(0.001), "p1": q(0.01), "p5": q(0.05), "median": q(0.5), "mean": float(xs.mean()), "max": float(xs[-1])}

report = {"backend": args.backend, "strings": len(items), "gguf_s": gguf_s, "litert_s": litert_s, "litert_ms_median": float(np.median(per_ms))}
sets = {}
for (name, role, _, _), c in zip(items, cos):
    sets.setdefault(name, []).append(c)
report["cosine_by_set"] = {k: stats(v) for k, v in sets.items()}
report["cosine_all"] = stats(cos)
by_stratum = {}
for (name, role, _, ri), c in zip(items, cos):
    if ri >= 0:
        by_stratum.setdefault(f"{role} {kinds[ri]} {langs[ri]}", []).append(c)
report["cosine_by_stratum"] = {k: stats(v) for k, v in sorted(by_stratum.items())}
worst = np.argsort(cos)[:15]
report["worst"] = [{"set": items[i][0], "text": items[i][2][:120], "cosine": float(cos[i])} for i in worst]

# Sanity: the GGUF today against the stored v3 vector of the same label.
doc_rows = [j for j, it in enumerate(items) if it[0] == "registry document"]
stored = pool[[items[j][3] for j in doc_rows]]
stored = stored / np.linalg.norm(stored, axis=1, keepdims=True)
report["gguf_now_vs_v3_stored"] = stats(np.sum(G[doc_rows] * stored, axis=1))
report["litert_vs_v3_stored"] = stats(np.sum(L[doc_rows] * stored, axis=1))

# ---- The snap: a claim string (query) against v3's labels of its kind, its own label left out. ----
poolN = pool / np.linalg.norm(pool, axis=1, keepdims=True)
kinds_arr = np.asarray(kinds)
q_rows = [j for j, it in enumerate(items) if it[0] == "registry query"]
agree1, agree5, deltas = 0, 0, []
cross = {0.96: [0, 0], 0.81: [0, 0], 0.65: [0, 0]}  # [GGUF over and LiteRT under, GGUF under and LiteRT over]
for j in q_rows:
    ri = items[j][3]
    mask = kinds_arr == kinds[ri]
    mask[ri] = False
    cand = np.nonzero(mask)[0]
    sg = poolN[cand] @ G[j]
    sl = poolN[cand] @ L[j]
    top_g = np.argsort(-sg)[:5]
    top_l = np.argsort(-sl)[:5]
    agree1 += int(top_g[0] == top_l[0])
    agree5 += len(set(cand[top_g]) & set(cand[top_l]))
    best = top_g[0]
    deltas.append(float(sl[best] - sg[best]))
    for tau in cross:
        if sg[best] >= tau and sl[best] < tau:
            cross[tau][0] += 1
        if sg[best] < tau and sl[best] >= tau:
            cross[tau][1] += 1
report["snap"] = {
    "queries": len(q_rows),
    "top1_same": agree1,
    "top5_overlap_mean": agree5 / len(q_rows) / 5,
    "score_delta_on_gguf_top1": stats(deltas),
    "threshold_crossings": {str(k): {"gguf_over_litert_under": v[0], "gguf_under_litert_over": v[1]} for k, v in cross.items()},
}

# ---- The tier-2 world: sentences against synthetic listings, mixed (LiteRT query, GGUF documents) and pure. ----
sent_rows = [j for j, it in enumerate(items) if it[0] == "hirer sentence (tier2-floor)"]
list_rows = [j for j, it in enumerate(items) if it[0] == "synthetic listing"]
listing_ids = [l["id"] for l in synth["listings"]]
def first_right(Q, D):
    n = 0
    for si, s in enumerate(synth["sentences"]):
        scores = D @ Q[si]
        n += int(listing_ids[int(np.argmax(scores))] in s["right"])
    return n
report["tier2_first_right"] = {
    "sentences": len(sent_rows),
    "gguf_gguf": first_right(G[sent_rows], G[list_rows]),
    "litert_query_gguf_documents": first_right(L[sent_rows], G[list_rows]),
    "litert_litert": first_right(L[sent_rows], L[list_rows]),
}

json.dump(report, open(os.path.join(args.out, f"report-{args.backend}.json"), "w"), indent=1, ensure_ascii=False)
np.save(os.path.join(args.out, f"cos-{args.backend}.npy"), cos)
print(json.dumps({k: report[k] for k in ("cosine_all", "gguf_now_vs_v3_stored", "litert_vs_v3_stored", "snap", "tier2_first_right")}, indent=1))
