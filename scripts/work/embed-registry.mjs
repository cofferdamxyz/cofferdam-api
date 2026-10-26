#!/usr/bin/env node
// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The registry snapshot embedded with EmbeddingGemma 2 for the v3 index
 * generation (`token-registry-v3`), on the Mac, with the GGUF the phone runs
 * (llama.rn): `ggml-org/embeddinggemma-2-GGUF`, Q8_0, mean pooling, L2
 * normalised, each label behind the document prefix `title: none | text: `.
 * The plane pins the model as `gguf:ggml-org/embeddinggemma-2-GGUF:Q8_0`
 * (`src/services/work/registry.ts`, EMBEDDINGGEMMA_2_GGUF); Workers AI does
 * not run it, so this script and the phone are its only embedders.
 *
 * Input: a snapshot of the registry's vectors in NDJSON (`{ id, values,
 * metadata }`, for example `test/registry.reembed.test.ts`'s v2 files):
 * every line's id and metadata are kept and its `metadata.label` (the label,
 * cut at 200 characters as the index holds it) is embedded again. Output:
 * `vectors-v3-001.ndjson`, … (5,000 a file) for
 * `wrangler vectorize upsert token-registry-v3`, and, for
 * `test/registry.tau.test.ts`, each kind's texts and vectors
 * (`<out>/tau-cache/embeddinggemma-2-GGUF-Q8_0-prompted-<kind>.json` and
 * `.f32`).
 *
 *   node scripts/work/embed-registry.mjs --in ~/Development/esco/import/registry-embeddinggemma-300m --out ~/Development/esco/import/registry-embeddinggemma-2
 *
 * Options: --hf <repo:quant> (default ggml-org/embeddinggemma-2-GGUF:Q8_0,
 * resolved from llama.cpp's Hugging Face cache) or --model <path to .gguf>;
 * --batch <lines a run> (default 4000); --limit <n> (the first n lines, to
 * try it). Needs brew's llama-embedding (llama.cpp). Writes nothing to
 * Cloudflare.
 */

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const DOCUMENT = 'title: none | text: ';
const DIMS = 768;
const PER_FILE = 5_000;
const TAU_TAG = 'embeddinggemma-2-GGUF-Q8_0-prompted';

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const home = (p) => p?.replace(/^~(?=\/)/, homedir());

const input = home(option('in'));
const out = home(option('out'));
if (!input || !out) {
  console.error('usage: embed-registry.mjs --in <dir of NDJSON vectors> --out <dir> [--hf repo:quant | --model file.gguf] [--batch n] [--limit n]');
  process.exit(2);
}
const model = home(option('model'));
const hf = option('hf', 'ggml-org/embeddinggemma-2-GGUF:Q8_0');
const batch = Number(option('batch', '4000'));
const limit = Number(option('limit', '0'));

// The snapshot: ids, metadata, the texts to embed.
const lines = [];
for (const f of readdirSync(input).filter((f) => /\.ndjson$/.test(f)).sort()) {
  for (const line of readFileSync(join(input, f), 'utf8').split('\n')) {
    if (!line) continue;
    const { id, metadata } = JSON.parse(line);
    lines.push({ id, metadata });
    if (limit && lines.length >= limit) break;
  }
  if (limit && lines.length >= limit) break;
}
const texts = [...new Set(lines.map((l) => l.metadata.label.replace(/\s+/g, ' ').trim()))];
console.log(`${lines.length} vectors, ${texts.length} distinct texts, ${batch} a run`);

/** One llama-embedding run over these texts: their unit vectors, in order. */
function embed(chunk) {
  const dir = mkdtempSync(join(tmpdir(), 'embed-registry-'));
  try {
    const file = join(dir, 'prompts.txt');
    writeFileSync(file, chunk.map((t) => DOCUMENT + t).join('\n') + '\n');
    const args = [...(model ? ['-m', model] : ['-hf', hf]), '--pooling', 'mean', '--embd-normalize', '2', '--embd-output-format', 'json', '-f', file, '-b', '8192', '-ub', '8192', '-c', '8192'];
    const run = spawnSync('llama-embedding', args, { encoding: 'utf8', maxBuffer: 1 << 30 });
    if (run.status !== 0) throw new Error(`llama-embedding exited ${run.status}: ${(run.stderr ?? '').split('\n').slice(-5).join(' ')}`);
    const data = JSON.parse(run.stdout).data;
    if (data.length !== chunk.length) throw new Error(`llama-embedding answered ${data.length} embeddings for ${chunk.length} texts`);
    return data.map((d) => {
      const v = d.embedding;
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      if (v.length !== DIMS || Math.abs(n - 1) > 1e-3) throw new Error(`an embedding of ${v.length} dimensions and length ${n}`);
      return v;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const vectors = new Map();
const t0 = Date.now();
for (let i = 0; i < texts.length; i += batch) {
  const chunk = texts.slice(i, i + batch);
  embed(chunk).forEach((v, j) => vectors.set(chunk[j], v));
  const done = Math.min(i + batch, texts.length);
  console.log(`embedded ${done} of ${texts.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
}

// The index's files.
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (/^vectors-v3-\d{3}\.ndjson$/.test(f)) rmSync(join(out, f));
const rows = lines.map((l) => JSON.stringify({ id: l.id, values: vectors.get(l.metadata.label.replace(/\s+/g, ' ').trim()).map((x) => Math.round(x * 1e6) / 1e6), metadata: l.metadata }));
let files = 0;
for (let i = 0; i < rows.length; i += PER_FILE) {
  writeFileSync(join(out, `vectors-v3-${String(++files).padStart(3, '0')}.ndjson`), rows.slice(i, i + PER_FILE).join('\n') + '\n');
}

// The τ calibration's documents, by kind.
const cache = join(out, 'tau-cache');
mkdirSync(cache, { recursive: true });
for (const kind of ['pos', 'skill']) {
  const kindTexts = [...new Set(lines.filter((l) => l.metadata.kind === kind).map((l) => l.metadata.label.replace(/\s+/g, ' ').trim()))];
  const f32 = new Float32Array(kindTexts.length * DIMS);
  kindTexts.forEach((t, i) => f32.set(vectors.get(t), i * DIMS));
  writeFileSync(join(cache, `${TAU_TAG}-${kind}.f32`), Buffer.from(f32.buffer));
  writeFileSync(join(cache, `${TAU_TAG}-${kind}.json`), JSON.stringify(kindTexts));
}
console.log(
  [
    `wrote ${rows.length} vectors in ${files} files to ${out}, and the τ cache to ${cache}, in ${Math.round((Date.now() - t0) / 1000)} s`,
    'load them one file at a time into the v3 index, once the founder has created it:',
    `  for f in ${out}/vectors-v3-[0-9][0-9][0-9].ndjson; do wrangler vectorize upsert token-registry-v3 --file="$f" || break; done`,
  ].join('\n'),
);
