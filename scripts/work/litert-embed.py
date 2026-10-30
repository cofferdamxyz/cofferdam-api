# Copyright (c) 2026 Cofferdam Inc.
# SPDX-License-Identifier: Apache-2.0
# /// script
# requires-python = ">=3.10"
# dependencies = ["litert-lm-api-nightly==0.19.0.dev20261028", "numpy>=2"]
# ///
"""Texts embedded on the Mac with LiteRT-LM, as the phone embeds them (workspace decision 0068).

EmbeddingGemma 2 from Google's text-only `.litertlm` file (the app's embedder since
2026-10-30, the v2 index generation's artefact) through LiteRT-LM's Python API on the CPU,
with the engine's defaults the phone uses too: special tokens inserted, pooled as the file
declares, L2-normalised, 768 values. The `llama-embedding` of this artefact for the scripts
that build and calibrate an index (`embed-registry.mjs --litert`, `tier2-floor.mjs --litert`,
`test/fixtures/work/registryTools.ts` `litertEmbed`).

Reads one text a line from `--in` (each with its role's prompt already before it, as the
phone sends it), and writes the vectors to `--out` as little-endian float32, one after the
other, in the texts' order. Prints the count and the time; never a text.

  uv run scripts/work/litert-embed.py --model <embeddinggemma-2-text-270m.litertlm> --in <texts.txt> --out <vectors.f32> [--threads N]
"""

import argparse
import sys
import time

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("--model", required=True)
ap.add_argument("--in", dest="inp", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--threads", type=int, default=None)
ap.add_argument("--dims", type=int, default=768)
args = ap.parse_args()

import litert_lm  # noqa: E402

with open(args.inp, encoding="utf-8") as f:
    texts = [line.rstrip("\n") for line in f]
if texts and texts[-1] == "":
    texts.pop()

backend = litert_lm.Backend.CPU(thread_count=args.threads) if args.threads else litert_lm.Backend.CPU()
engine = litert_lm.EmbeddingEngine(args.model, backend=backend)
out = np.empty((len(texts), args.dims), dtype=np.float32)
t0 = time.time()
for i, text in enumerate(texts):
    v = np.asarray(engine.compute_embedding(text).embedding, dtype=np.float32)
    if v.shape != (args.dims,):
        sys.exit(f"text {i}: {v.shape[0]} values, not {args.dims}")
    n = float(np.linalg.norm(v))
    if not n:
        sys.exit(f"text {i}: a zero vector")
    out[i] = v / n
engine.close()
out.astype("<f4").tofile(args.out)
print(f"{len(texts)} texts in {time.time() - t0:.1f} s", file=sys.stderr)
