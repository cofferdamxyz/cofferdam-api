#!/usr/bin/env node
// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The registry snapshot embedded with EmbeddingGemma 2 on the Mac, as the
 * phone embeds it, for an index generation the plane cannot embed for:
 *
 * - `--litert <file.litertlm>`: the v2 generation (`token-registry-v2`), the
 *   app's embedder since 2026-10-30, Google's text-only LiteRT-LM file
 *   (`litert-community/embeddinggemma-2-text-270m-litert-lm`), through
 *   `scripts/work/litert-embed.py` on the CPU; the plane pins it as
 *   `EMBEDDINGGEMMA_2_LITERT` (`src/services/work/registry.ts`). Its vectors
 *   are not the GGUF's (workspace decision 0068, the founder's ruling of
 *   2026-10-30), hence a generation of its own.
 * - otherwise the GGUF the phone ran through llama.rn until then
 *   (`ggml-org/embeddinggemma-2-GGUF`, Q8_0) through brew's `llama-embedding`,
 *   for the v3 generation that was never published (`EMBEDDINGGEMMA_2_GGUF`).
 *
 * Both: each label behind the document prefix `title: none | text: `, pooled
 * as the file declares, L2 normalised. Workers AI runs neither, so this script
 * and the phone are their only embedders.
 *
 * Input: a snapshot of the registry's vectors in NDJSON (`{ id, values,
 * metadata }`, for example `test/registry.reembed.test.ts`'s files):
 * every line's id and metadata are kept, except the deleted certificate
 * seed's (kind `cert`, source `seed`), and its `metadata.label` is embedded
 * again: the label as the index holds it, cut at 200 characters (5 of ESCO's
 * 229,810), with runs of white space as one space (131), since
 * both embedders read one text a line. Output: `vectors-<generation>-001.ndjson`,
 * … (5,000 a file; v2 with `--litert`, else v3) for `wrangler vectorize upsert
 * token-registry-<generation>`, and, for `test/registry.tau.test.ts`, each
 * kind's texts and vectors under the τ cache's names
 * (`<out>/tau-cache/<model's stem>-doc-<8 hex>-<kind>.json` and `.f32`, as
 * `cacheStem` in `test/fixtures/work/registryTools.ts` names them).
 *
 * `--widths 768,512` also writes each narrower width's files from the same
 * vectors, cut to their first dimensions and normalised again (EmbeddingGemma
 * 2 is trained for Matryoshka truncation to 512, 256 or 128):
 * `vectors-<generation>-512-001.ndjson`, …
 *
 * Each run of llama-embedding is saved as it ends (`<out>/parts/`), so a run
 * that stops resumes where it stopped; the parts are deleted once the files
 * are written.
 *
 *   node scripts/work/embed-registry.mjs --in ~/Development/esco/import/registry-embeddinggemma-300m --out ~/Development/esco/import/registry-embeddinggemma-2-litert --litert <embeddinggemma-2-text-270m.litertlm> --jobs 3
 *
 * Options: --litert <file.litertlm> (with --jobs <runs at once>, default 1,
 * and --threads <CPU threads a run>); else --hf <repo:quant> (default
 * ggml-org/embeddinggemma-2-GGUF:Q8_0, resolved from llama.cpp's Hugging Face
 * cache) or --model <path to .gguf>; --batch <texts a run> (default 4000);
 * --limit <n> (the first n lines, to try it). Writes nothing to Cloudflare.
 */

import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const DOCUMENT = 'title: none | text: ';
const DIMS = 768;
const PER_FILE = 5_000;
const GGUF_MODEL = 'gguf:ggml-org/embeddinggemma-2-GGUF:Q8_0';
const LITERT_MODEL = 'litertlm:litert-community/embeddinggemma-2-text-270m-litert-lm:embeddinggemma-2-text-270m.litertlm';
/** The SHA-256 of the file the app pins (cofferdam-app `src/lib/localAi/models.ts`): v2 is made with that file or not at all. */
const LITERT_SHA256 = '2d079ee2f6f066b1f368e8d7c819f55214eaef1d0513b312321901f30ab286fb';
const LITERT_EMBED = new URL('./litert-embed.py', import.meta.url).pathname;

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const home = (p) => p?.replace(/^~(?=\/)/, homedir());

const input = home(option('in'));
const out = home(option('out'));
if (!input || !out) {
  console.error('usage: embed-registry.mjs --in <dir of NDJSON vectors> --out <dir> [--litert file.litertlm [--jobs n] [--threads n] | --hf repo:quant | --model file.gguf] [--batch n] [--limit n]');
  process.exit(2);
}
const model = home(option('model'));
const hf = option('hf', 'ggml-org/embeddinggemma-2-GGUF:Q8_0');
const litert = home(option('litert'));
const count = (name, fallback, min) => {
  const v = Number(option(name, fallback));
  if (!Number.isInteger(v) || v < min) {
    console.error(`--${name} takes a whole number from ${min}, not ${option(name, fallback)}`);
    process.exit(2);
  }
  return v;
};
const jobs = count('jobs', '1', 1);
const threads = option('threads');
const MODEL_ID = litert ? LITERT_MODEL : GGUF_MODEL;
const GENERATION = litert ? 'v2' : 'v3';
// The τ cache's stem, as `cacheStem` in test/fixtures/work/registryTools.ts names it: the model, its document prompt's fingerprint.
const TAU_STEM = `${MODEL_ID.split('/').pop().replace(/[^A-Za-z0-9._-]+/g, '-')}-doc-${createHash('sha256').update(DOCUMENT).digest('hex').slice(0, 8)}`;
const batch = count('batch', '4000', 1);
const limit = count('limit', '0', 0);
// The artefact itself: the LiteRT-LM file must be the one the app pins.
const sha256 = litert ? createHash('sha256').update(readFileSync(litert)).digest('hex') : null;
if (litert && sha256 !== LITERT_SHA256) {
  console.error(`${litert} is not the pinned file (SHA-256 ${sha256}, the pin ${LITERT_SHA256})`);
  process.exit(2);
}
const widths = option('widths', String(DIMS)).split(',').map(Number);
if (!widths.includes(DIMS) || widths.some((w) => !Number.isInteger(w) || w < 1 || w > DIMS)) {
  console.error(`--widths lists ${DIMS} and narrower widths, e.g. ${DIMS},512`);
  process.exit(2);
}

// The snapshot: ids, metadata, the texts to embed. The deleted certificate seed's labels (kind cert, source seed;
// workspace decision 0070, 2026-10-30), which snapshots written before then hold, are left out: no index loads them.
const lines = [];
let seedLeftOut = 0;
for (const f of readdirSync(input).filter((f) => /\.ndjson$/.test(f)).sort()) {
  for (const line of readFileSync(join(input, f), 'utf8').split('\n')) {
    if (!line) continue;
    const { id, metadata } = JSON.parse(line);
    if (metadata?.kind === 'cert' && metadata?.source === 'seed') {
      seedLeftOut++;
      continue;
    }
    lines.push({ id, metadata });
    if (limit && lines.length >= limit) break;
  }
  if (limit && lines.length >= limit) break;
}
const clean = (label) => label.replace(/\s+/g, ' ').trim();
const texts = [...new Set(lines.map((l) => clean(l.metadata.label)))];
const row = new Map(texts.map((t, i) => [t, i]));
console.log(`${lines.length} vectors, ${texts.length} distinct texts, ${batch} a run${seedLeftOut ? `; ${seedLeftOut} of the deleted certificate seed left out` : ''}`);

/** One LiteRT-LM run over these texts (`litert-embed.py`, its own process): their unit vectors, in order, as one Float32Array. */
function embedLitert(chunk) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), 'embed-registry-'));
    const done = (err, value) => {
      rmSync(dir, { recursive: true, force: true });
      if (err) reject(err);
      else resolve(value);
    };
    const inp = join(dir, 'texts.txt');
    const outFile = join(dir, 'vectors.f32');
    writeFileSync(inp, chunk.map((t) => DOCUMENT + t).join('\n') + '\n');
    const args = ['run', '--quiet', LITERT_EMBED, '--model', litert, '--in', inp, '--out', outFile, '--dims', String(DIMS), ...(threads ? ['--threads', threads] : [])];
    const child = spawn('uv', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    child.on('close', (code) => {
      if (code !== 0) return done(new Error(`litert-embed exited ${code}: ${stderr.split('\n').filter((l) => !/^(INFO|WARNING|I0000|W0000)/.test(l)).slice(-3).join(' ')}`));
      const buf = readFileSync(outFile);
      const v = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      if (v.length !== chunk.length * DIMS) return done(new Error(`litert-embed wrote ${v.length} values for ${chunk.length} texts`));
      done(null, v);
    });
  });
}

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

// Every text's vector, a run at a time (LiteRT-LM: `--jobs` runs at once); a run saved by an earlier attempt is read back.
const all = new Float32Array(texts.length * DIMS);
const parts = join(out, 'parts');
mkdirSync(parts, { recursive: true });
// The runs saved in `parts/` are this model's: a resume with another model, or another file, stops here.
const made = JSON.stringify({ model: MODEL_ID, sha256 });
const madeFile = join(parts, 'model.json');
if (existsSync(madeFile) ? readFileSync(madeFile, 'utf8') !== made : readdirSync(parts).some((f) => f.endsWith('.f32'))) {
  console.error(`${parts} holds runs of another model (or of no recorded one): clear it, or write ${made} to ${madeFile} if they are this model's`);
  process.exit(2);
}
writeFileSync(madeFile, made);
const t0 = Date.now();
const runs = [];
for (let i = 0, n = 0; i < texts.length; i += batch, n++) runs.push({ i, chunk: texts.slice(i, i + batch), stem: join(parts, String(n).padStart(4, '0')) });
let embedded = 0;
const saved = (r, part) => {
  writeFileSync(`${r.stem}.f32`, Buffer.from(part.buffer));
  writeFileSync(`${r.stem}.json`, JSON.stringify(r.chunk));
  all.set(part, r.i * DIMS);
  embedded += r.chunk.length;
  console.log(`embedded ${embedded} of ${texts.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
};
const pending = [];
for (const r of runs) {
  const whole = existsSync(`${r.stem}.f32`) && readFileSync(`${r.stem}.f32`).byteLength === r.chunk.length * DIMS * 4;
  if (whole && existsSync(`${r.stem}.json`) && JSON.stringify(JSON.parse(readFileSync(`${r.stem}.json`, 'utf8'))) === JSON.stringify(r.chunk)) {
    const buf = readFileSync(`${r.stem}.f32`);
    all.set(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), r.i * DIMS);
    embedded += r.chunk.length;
    continue;
  }
  pending.push(r);
}
if (litert) {
  let next = 0;
  const worker = async () => {
    while (next < pending.length) {
      const r = pending[next++];
      saved(r, await embedLitert(r.chunk));
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, pending.length) }, worker));
} else {
  for (const r of pending) {
    const part = new Float32Array(r.chunk.length * DIMS);
    embed(r.chunk).forEach((v, j) => part.set(v, j * DIMS));
    saved(r, part);
  }
}
const vectorOf = (label) => {
  const at = row.get(clean(label)) * DIMS;
  return all.subarray(at, at + DIMS);
};
// Nothing is written unless every text has its unit vector: a run that never ran leaves zeros.
if (embedded !== texts.length) throw new Error(`${embedded} of ${texts.length} texts embedded; nothing written`);
texts.forEach((t, i) => {
  const v = all.subarray(i * DIMS, (i + 1) * DIMS);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (!(Math.abs(n - 1) <= 1e-3)) throw new Error(`text ${i} has a vector of length ${n}; nothing written`);
});

/** A vector cut to its first `width` dimensions and normalised again, rounded as the index files hold it. */
function cut(v, width) {
  const head = v.subarray(0, width);
  const n = Math.sqrt(head.reduce((s, x) => s + x * x, 0)) || 1;
  return Array.from(head, (x) => Math.round((x / n) * 1e6) / 1e6);
}

// The index's files, written one at a time: `vectors-<generation>-NNN` at the full width, `vectors-<generation>-<width>-NNN` at each narrower one.
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (new RegExp(`^vectors-${GENERATION}-(\\d+-)?\\d{3}\\.ndjson$`).test(f)) rmSync(join(out, f));
let files = 0;
for (let i = 0; i < lines.length; i += PER_FILE) {
  files++;
  for (const width of widths) {
    const rows = lines.slice(i, i + PER_FILE).map((l) => JSON.stringify({ id: l.id, values: cut(vectorOf(l.metadata.label), width), metadata: l.metadata }));
    writeFileSync(join(out, `vectors-${GENERATION}-${width === DIMS ? '' : `${width}-`}${String(files).padStart(3, '0')}.ndjson`), rows.join('\n') + '\n');
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
    `load them one file at a time into the ${GENERATION} index, once the founder has created it:`,
    `  for f in ${out}/vectors-${GENERATION}-[0-9][0-9][0-9].ndjson; do wrangler vectorize upsert token-registry-${GENERATION} --file="$f" || break; done`,
  ].join('\n'),
);
