// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What the opt-in registry scripts on the Mac share:
 * - the label vectors cached per model, document prompt and kind
 *   (`test/registry.tau.test.ts` writes them, `test/registry.reembed.test.ts`
 *   reuses them, `scripts/work/embed-registry.mjs` writes EmbeddingGemma 2's
 *   under the same names): a cache is read by text, so a vector is only ever
 *   taken for the text it was made from, and a zero vector (a text the model
 *   refused) is no vector;
 * - the read-only export of the labels the plane minted, which no import file
 *   holds and a new index needs too (`wrangler d1 execute --json`, the runbook's
 *   query);
 * - embeddings on the Mac for a model the plane cannot run, as the scripts and the
 *   phone make them: EmbeddingGemma 2's GGUF through brew's `llama-embedding`, and
 *   its LiteRT-LM file, the v2 generation's (workspace decision 0068), through
 *   `scripts/work/litert-embed.py` (`macEmbed` picks by the model's id).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { vectorLine } from '../../../src/services/work/esco.js';
import {
  EMBED_DIMS_BY_MODEL,
  EMBED_PROMPTS_BY_MODEL,
  EMBEDDINGGEMMA_2_LITERT,
  labelNorm,
  type EmbedRole,
  type RegistryLabel,
  type RegistryToken,
  type TokenKind,
  type TokenSource,
} from '../../../src/services/work/registry.js';

export type CachedKind = 'pos' | 'skill';

/**
 * A cache's file stem: the model's name, its document prompt's fingerprint
 * when it has one (so a changed prompt is a new cache), and the kind:
 * `bge-m3-pos`, `embeddinggemma-300m-doc-<8 hex>-skill`.
 */
export function cacheStem(model: string, kind: CachedKind): string {
  const name = model.split('/').pop()!.replace(/[^A-Za-z0-9._-]+/g, '-');
  const prompt = EMBED_PROMPTS_BY_MODEL[model]?.document;
  return `${name}${prompt ? `-doc-${createHash('sha256').update(prompt).digest('hex').slice(0, 8)}` : ''}-${kind}`;
}

/** A model's cached documents of a kind, by text, without the texts it refused; null when there is no cache. */
export function readVectorCache(dir: string, model: string, kind: CachedKind, dims: number): Map<string, Float32Array> | null {
  const stem = join(dir, cacheStem(model, kind));
  if (!existsSync(`${stem}.json`) || !existsSync(`${stem}.f32`)) return null;
  const texts = JSON.parse(readFileSync(`${stem}.json`, 'utf8')) as string[];
  const buf = readFileSync(`${stem}.f32`);
  const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  if (all.length !== texts.length * dims) throw new Error(`${stem}.f32 holds ${all.length} values, not ${texts.length} vectors of ${dims}`);
  const out = new Map<string, Float32Array>();
  texts.forEach((t, i) => {
    const v = all.subarray(i * dims, (i + 1) * dims);
    if (v.some((x) => x !== 0)) out.set(t, v);
  });
  return out;
}

/** Writes a model's documents of a kind: the texts, and their vectors in that order (zero for a text it refused). */
export function writeVectorCache(dir: string, model: string, kind: CachedKind, texts: readonly string[], vectors: Float32Array): void {
  const dims = vectors.length / Math.max(1, texts.length);
  if (!Number.isInteger(dims)) throw new Error(`${vectors.length} values for ${texts.length} texts`);
  const stem = join(dir, cacheStem(model, kind));
  writeFileSync(`${stem}.f32`, Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));
  writeFileSync(`${stem}.json`, JSON.stringify(texts));
}

/** One row of the export of the plane's minted labels. */
export interface ExportedLabel {
  label_id: string;
  token: string;
  lang: string;
  label: string;
  kind: TokenKind;
  source: TokenSource;
  isco_code: string | null;
}

const KINDS: ReadonlySet<string> = new Set(['pos', 'skill', 'cert']);
const SOURCES: ReadonlySet<string> = new Set(['esco', 'emergent', 'seed']);

/** The rows of a `wrangler d1 execute --json` answer of one statement, past anything printed before it; anything else stops the run. */
export function readLabelExport(text: string): ExportedLabel[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('the export holds no JSON array');
  const sets = JSON.parse(text.slice(start, end + 1)) as { results?: unknown; success?: unknown }[];
  if (!Array.isArray(sets) || sets.length !== 1 || sets[0]!.success !== true || !Array.isArray(sets[0]!.results)) throw new Error('the export is not the answer of one statement');
  return (sets[0]!.results as Record<string, unknown>[]).map((row, i) => {
    for (const k of ['label_id', 'token', 'lang', 'label', 'kind', 'source']) {
      if (typeof row[k] !== 'string' || !row[k]) throw new Error(`export row ${i} has no ${k}`);
    }
    if (!KINDS.has(row.kind as string) || !SOURCES.has(row.source as string)) throw new Error(`export row ${i} has kind ${String(row.kind)} and source ${String(row.source)}`);
    if (row.isco_code != null && typeof row.isco_code !== 'string') throw new Error(`export row ${i} has an ISCO code that is not text`);
    return {
      label_id: row.label_id as string,
      token: row.token as string,
      lang: row.lang as string,
      label: row.label as string,
      kind: row.kind as TokenKind,
      source: row.source as TokenSource,
      isco_code: (row.isco_code as string | null | undefined) ?? null,
    };
  });
}

/** An exported label's index line, in the import's shape (`vectorLine` reads the label's id, token, language and text, and the token's kind, source and ISCO code). */
export function exportedLabelLine(row: ExportedLabel, values: readonly number[]): string {
  const label: RegistryLabel = { labelId: row.label_id, token: row.token, lang: row.lang, label: row.label, labelNorm: labelNorm(row.label), kind: 'observed', embedded: true };
  const token: RegistryToken = { token: row.token, kind: row.kind, source: row.source, labelEn: row.label, escoUri: null, iscoCode: row.isco_code, status: 'pending', mergedInto: null };
  return vectorLine(label, token, [...values]);
}

/** The GGUF a client-embedded model names, as llama.cpp's `-hf` reads it (`gguf:<repo>:<quant>`), else null. */
export function ggufOf(model: string): string | null {
  return model.startsWith('gguf:') ? model.slice('gguf:'.length) : null;
}

/**
 * Texts embedded on the Mac with brew's `llama-embedding` (llama.cpp), as
 * `scripts/work/embed-registry.mjs` and the phone make them: the role's
 * prompt before each text, mean pooling, L2-normalised. It reads one text a
 * line, so runs of white space are one space. `file` is a local .gguf in
 * place of the model's Hugging Face name. Stops on a failed run or a vector
 * of another size.
 */
export function llamaEmbed(model: string, texts: readonly string[], role: EmbedRole, file?: string): number[][] {
  const gguf = ggufOf(model);
  const dims = EMBED_DIMS_BY_MODEL[model];
  if ((!gguf && !file) || !dims) throw new Error(`${model} is no GGUF of a known size`);
  if (!texts.length) return [];
  const prompt = EMBED_PROMPTS_BY_MODEL[model]?.[role] ?? '';
  const dir = mkdtempSync(join(tmpdir(), 'llama-embed-'));
  try {
    const prompts = join(dir, 'prompts.txt');
    writeFileSync(prompts, texts.map((t) => prompt + t.replace(/\s+/g, ' ').trim()).join('\n') + '\n');
    const args = [...(file ? ['-m', file] : ['-hf', gguf!]), '--pooling', 'mean', '--embd-normalize', '2', '--embd-output-format', 'json', '-f', prompts, '-b', '8192', '-ub', '8192', '-c', '8192'];
    const run = spawnSync('llama-embedding', args, { encoding: 'utf8', maxBuffer: 1 << 30 });
    if (run.status !== 0) throw new Error(`llama-embedding exited ${run.status}: ${(run.stderr ?? '').split('\n').slice(-5).join(' ')}`);
    const data = (JSON.parse(run.stdout) as { data: { embedding: number[] }[] }).data;
    if (data.length !== texts.length) throw new Error(`llama-embedding answered ${data.length} embeddings for ${texts.length} texts`);
    return data.map(({ embedding }) => {
      if (embedding.length !== dims) throw new Error(`llama-embedding answered ${embedding.length} dimensions, not ${dims}`);
      return embedding;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The `.litertlm` file a client-embedded model names (`litertlm:<repo>:<file>`), else null. */
export function litertOf(model: string): string | null {
  if (!model.startsWith('litertlm:')) return null;
  const file = model.split(':').pop()!;
  return file.endsWith('.litertlm') ? file : null;
}

const LITERT_EMBED = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/work/litert-embed.py');

/**
 * The SHA-256 of the file each LiteRT-LM model id names, as the app pins it
 * (cofferdam-app `src/lib/localAi/models.ts`): vectors that may reach an index
 * (the re-embed's, the τ cache's) are made with that file or not at all.
 * `scripts/work/embed-registry.mjs` holds the same value.
 */
export const LITERT_SHA256: Readonly<Record<string, string>> = {
  [EMBEDDINGGEMMA_2_LITERT]: '2d079ee2f6f066b1f368e8d7c819f55214eaef1d0513b312321901f30ab286fb',
};
const pinnedFiles = new Set<string>();

/** Throws unless `file` is the file `model`'s pin names, by its SHA-256 (read once a file). */
export function assertPinnedLitert(model: string, file: string): void {
  if (pinnedFiles.has(`${model}\n${file}`)) return;
  const got = createHash('sha256').update(readFileSync(file)).digest('hex');
  if (got !== LITERT_SHA256[model]) throw new Error(`${file} is not ${model}'s pinned file (SHA-256 ${got})`);
  pinnedFiles.add(`${model}\n${file}`);
}

/**
 * Texts embedded on the Mac with LiteRT-LM (`scripts/work/litert-embed.py`, `uv run`), as
 * the phone embeds them: the role's prompt before each text, LiteRT-LM's defaults (special
 * tokens, pooling, L2 normalisation) on the CPU. `file` is the local `.litertlm` the model's
 * id names, which this does not download. Runs of white space are one space, as
 * `llamaEmbed` writes them. Stops on a failed run or a vector of another size.
 */
export function litertEmbed(model: string, texts: readonly string[], role: EmbedRole, file: string): number[][] {
  const dims = EMBED_DIMS_BY_MODEL[model];
  if (!litertOf(model) || !dims) throw new Error(`${model} is no LiteRT-LM file of a known size`);
  if (!texts.length) return [];
  assertPinnedLitert(model, file);
  const prompt = EMBED_PROMPTS_BY_MODEL[model]?.[role] ?? '';
  const dir = mkdtempSync(join(tmpdir(), 'litert-embed-'));
  try {
    const inp = join(dir, 'texts.txt');
    const out = join(dir, 'vectors.f32');
    writeFileSync(inp, texts.map((t) => prompt + t.replace(/\s+/g, ' ').trim()).join('\n') + '\n');
    const run = spawnSync('uv', ['run', '--quiet', LITERT_EMBED, '--model', file, '--in', inp, '--out', out, '--dims', String(dims)], { encoding: 'utf8', maxBuffer: 1 << 26 });
    if (run.status !== 0) throw new Error(`litert-embed exited ${run.status}: ${(run.stderr ?? '').split('\n').filter((l) => !/^(INFO|WARNING|I0000|W0000)/.test(l)).slice(-5).join(' ')}`);
    const buf = readFileSync(out);
    const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    if (all.length !== texts.length * dims) throw new Error(`litert-embed wrote ${all.length} values for ${texts.length} texts of ${dims}`);
    return texts.map((_, i) => Array.from(all.subarray(i * dims, (i + 1) * dims)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A client-embedded model's texts on the Mac, by its id: LiteRT-LM for a `litertlm:` file (which `file` must name), llama.cpp for a GGUF. */
export function macEmbed(model: string, texts: readonly string[], role: EmbedRole, file?: string): number[][] {
  if (litertOf(model)) {
    if (!file) throw new Error(`${model} needs its local .litertlm file`);
    return litertEmbed(model, texts, role, file);
  }
  return llamaEmbed(model, texts, role, file);
}
