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
 * every line's id and metadata are kept and its `metadata.label` is embedded
 * again: the label as the index holds it, cut at 200 characters (5 of ESCO's
 * 229,810), with runs of white space as one space (131), since
 * llama-embedding reads one text a line. Output: `vectors-v3-001.ndjson`, …
 * (5,000 a file) for `wrangler vectorize upsert token-registry-v3`, and, for
 * `test/registry.tau.test.ts`, each kind's texts and vectors under the τ
 * cache's names (`<out>/tau-cache/embeddinggemma-2-GGUF-Q8_0-doc-<8 hex>-<kind>.json`
 * and `.f32`, `test/fixtures/work/registryTools.ts`).
 *
 * `--widths 768,512` also writes each narrower width's files from the same
 * vectors, cut to their first dimensions and normalised again (EmbeddingGemma
 * 2 is trained for Matryoshka truncation to 512, 256 or 128):
 * `vectors-v3-512-001.ndjson`, …
 *
 * Each run of llama-embedding is saved as it ends (`<out>/parts/`), so a run
 * that stops resumes where it stopped; the parts are deleted once the files
 * are written.
 *
 *   node scripts/work/embed-registry.mjs --in ~/Development/esco/import/registry-embeddinggemma-300m --out ~/Development/esco/import/registry-embeddinggemma-2
 *
 * Options: --hf <repo:quant> (default ggml-org/embeddinggemma-2-GGUF:Q8_0,
 * resolved from llama.cpp's Hugging Face cache) or --model <path to .gguf>;
 * --batch <texts a run> (default 4000); --limit <n> (the first n lines, to
 * try it). Needs brew's llama-embedding (llama.cpp). Writes nothing to
 * Cloudflare.
 */

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const DOCUMENT = 'title: none | text: ';
const DIMS = 768;
const PER_FILE = 5_000;
// The τ cache's stem, as `cacheStem` in test/fixtures/work/registryTools.ts names it: the model, its document prompt's fingerprint.
const TAU_STEM = `embeddinggemma-2-GGUF-Q8_0-doc-${createHash('sha256').update(DOCUMENT).digest('hex').slice(0, 8)}`;

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
const widths = option('widths', String(DIMS)).split(',').map(Number);
if (!widths.includes(DIMS) || widths.some((w) => !Number.isInteger(w) || w < 1 || w > DIMS)) {
  console.error(`--widths lists ${DIMS} and narrower widths, e.g. ${DIMS},512`);
  process.exit(2);
}

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
const clean = (label) => label.replace(/\s+/g, ' ').trim();
const texts = [...new Set(lines.map((l) => clean(l.metadata.label)))];
const row = new Map(texts.map((t, i) => [t, i]));
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

// Every text's vector, a run at a time; a run saved by an earlier attempt is read back.
const all = new Float32Array(texts.length * DIMS);
const parts = join(out, 'parts');
mkdirSync(parts, { recursive: true });
const t0 = Date.now();
for (let i = 0, n = 0; i < texts.length; i += batch, n++) {
  const chunk = texts.slice(i, i + batch);
  const stem = join(parts, String(n).padStart(4, '0'));
  if (existsSync(`${stem}.json`) && existsSync(`${stem}.f32`) && JSON.stringify(JSON.parse(readFileSync(`${stem}.json`, 'utf8'))) === JSON.stringify(chunk)) {
    const buf = readFileSync(`${stem}.f32`);
    all.set(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), i * DIMS);
    continue;
  }
  const part = new Float32Array(chunk.length * DIMS);
  embed(chunk).forEach((v, j) => part.set(v, j * DIMS));
  writeFileSync(`${stem}.f32`, Buffer.from(part.buffer));
  writeFileSync(`${stem}.json`, JSON.stringify(chunk));
  all.set(part, i * DIMS);
  console.log(`embedded ${Math.min(i + batch, texts.length)} of ${texts.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
}
const vectorOf = (label) => {
  const at = row.get(clean(label)) * DIMS;
  return all.subarray(at, at + DIMS);
};

/** A vector cut to its first `width` dimensions and normalised again, rounded as the index files hold it. */
function cut(v, width) {
  const head = v.subarray(0, width);
  const n = Math.sqrt(head.reduce((s, x) => s + x * x, 0)) || 1;
  return Array.from(head, (x) => Math.round((x / n) * 1e6) / 1e6);
}

// The index's files, written one at a time: `vectors-v3-NNN` at the full width, `vectors-v3-<width>-NNN` at each narrower one.
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (/^vectors-v3-(\d+-)?\d{3}\.ndjson$/.test(f)) rmSync(join(out, f));
let files = 0;
for (let i = 0; i < lines.length; i += PER_FILE) {
  files++;
  for (const width of widths) {
    const rows = lines.slice(i, i + PER_FILE).map((l) => JSON.stringify({ id: l.id, values: cut(vectorOf(l.metadata.label), width), metadata: l.metadata }));
    writeFileSync(join(out, `vectors-v3-${width === DIMS ? '' : `${width}-`}${String(files).padStart(3, '0')}.ndjson`), rows.join('\n') + '\n');
  }
}

// The τ calibration's documents, by kind.
const cache = join(out, 'tau-cache');
mkdirSync(cache, { recursive: true });
for (const kind of ['pos', 'skill']) {
  const kindTexts = [...new Set(lines.filter((l) => l.metadata.kind === kind).map((l) => clean(l.metadata.label)))];
  const f32 = new Float32Array(kindTexts.length * DIMS);
  kindTexts.forEach((t, i) => f32.set(vectorOf(t), i * DIMS));
  writeFileSync(join(cache, `${TAU_STEM}-${kind}.f32`), Buffer.from(f32.buffer));
  writeFileSync(join(cache, `${TAU_STEM}-${kind}.json`), JSON.stringify(kindTexts));
}
rmSync(parts, { recursive: true, force: true });
console.log(
  [
    `wrote ${lines.length} vectors in ${files} files a width (${widths.join(', ')}) to ${out}, and the τ cache (${DIMS}) to ${cache}, in ${Math.round((Date.now() - t0) / 1000)} s`,
    'load them one file at a time into the v3 index, once the founder has created it:',
    `  for f in ${out}/vectors-v3-[0-9][0-9][0-9].ndjson; do wrangler vectorize upsert token-registry-v3 --file="$f" || break; done`,
  ].join('\n'),
);
