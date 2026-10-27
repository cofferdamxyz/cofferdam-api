// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Work pipeline on real vacancies (opt-in: JOBS_EVAL=1), from the Mac:
 * the engine v2 settings measured on job ads JobSpy pulled from Indeed
 * (`scripts/work/jobspy-pull.py`) in the three launch markets, under the v3
 * generation (EmbeddingGemma 2 at 768, the phone's embeddings) with the real
 * hosted models (the extractor, Clef, the pivot, the intent parse) over the
 * Workers AI REST API.
 *
 * Each sampled vacancy is both sides of the market. As a listing: its
 * description, de-identified like the phone would (emails, links, phone
 * numbers and handles as placeholders, then the plane's own tripwire), is
 * cut into an experience block (the title and the duties), a skills block
 * (the requirements) and a certificates block (the lines that name a licence
 * or a course), each extracted on `work-extract`; the title, the skills and
 * the certificates then publish through `publishListing`, snapping against a
 * replica of the registry (the ESCO import's SQL, the US layer's SQL and the
 * certificate seed in node:sqlite; the v3 vectors in memory) with the
 * vectors llama-embedding makes, as the phone does. As a hirer: the title and
 * an excerpt of the requirements, at most 1,000 characters, go through
 * `hirerQuery` with the sentence's query vector, and recall runs over the
 * other vacancies' listings. Relevance is self-supervised: two vacancies
 * whose titles snapped to tokens of one ISCO unit group are the same
 * occupation (right), of one minor group adjacent (near), of one sub-major
 * group the same industry, else far.
 *
 * Measured: the extractor (blocks refused by the tripwire, fields read, cost),
 * the snaps per kind and language (label, auto, chosen, pivot, minted,
 * unmatched; Clef's probabilities; the strings Clef could not decide), the
 * hirer plans (needs, scope, mode), recall (finalists by tier and relation,
 * the tier-2 floor sweep on real relations), and, for the strings Clef left
 * undecided, the Thinking model's pick (`chat-reasoning`, DeepSeek V4.1
 * Flash at low effort) beside Clef's; Clef's own probabilities on every
 * adjudication, so a looser floor can be simulated; the vector-only ranking
 * of the listings in the sentence's region (the fast lane: the relation of
 * the first, precision at 3 and 5, and what sits within a margin of the
 * top); which tier-1 finalists came through an occupation token and which
 * through skills alone; and the titles an exact label holds on several
 * tokens, which the shortcut cannot take. Writes
 * `test/work-eval/jobs-<date>-n<N>-seed<seed>.md`, numbers and strings from the
 * ads only, never a company name or a link, and the run's data (drafts,
 * vectors, decisions, plans, finalists) as JSON under JOBS_OUT (default
 * `<JOBS_DIR>/../../runs`, outside the workspace) for later analysis.
 *
 *   cd cofferdam-api && JOBS_EVAL=1 JOBS_DIR=~/Development/jobs-bench/raw/2026-10-27 JOBS_N=300 \
 *     ESCO_SQL=~/Development/esco/import/cofferdam-import US_SQL=~/Development/us-layer-data/cofferdam-import \
 *     V3_DIR=~/Development/esco/import/registry-embeddinggemma-2 direnv exec .. yarn vitest run test/workJobs.eval.test.ts
 *
 * JOBS_N vacancies (default 300; half from the US, a quarter each from
 * Brazil and Mexico), JOBS_SEED the sample's seed, JOBS_THINK the undecided
 * strings re-asked (default 120), JOBS_PARALLEL hosted calls at once (default
 * 4) and JOBS_THINK_PARALLEL for the reasoning model (default 2, one retry).
 * Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInference, type Inference } from '../src/services/inference/index.js';
import { BLOCK_MAX_CHARS, checkBlock, type BlockLang, type DeidentifiedBlock } from '../src/services/work/blocks.js';
import { planCertificateImport } from '../src/services/work/certificates.js';
import { adjudicationState } from '../src/services/work/clef.js';
import { extractBlock } from '../src/services/work/executor.js';
import { list, str, type WorkCall } from '../src/services/work/fields.js';
import { hirerQuery, type HireDeps } from '../src/services/work/hire.js';
import { claimKey, D1ListingStore, listingText, publishListing, type ClaimVectors, type ListingDraft, type PublishDeps } from '../src/services/work/listings.js';
import { callCostMicroUsd } from '../src/services/work/meter.js';
import { D1RegistryStore, EMBEDDINGGEMMA_2_GGUF, labelLangs, labelNorm, tauFor, type IndexMatch, type IndexVector, type RegistryDeps, type TokenKind, type VectorIndex } from '../src/services/work/registry.js';
import { createRestAi } from './chat-eval/restAi.js';
import { sqliteD1 } from './fixtures/work/d1.js';
import { memoryIndex } from './fixtures/work/fakes.js';
import { llamaEmbed } from './fixtures/work/registryTools.js';

const RUN = process.env.JOBS_EVAL === '1';
const MODEL = EMBEDDINGGEMMA_2_GGUF;
const DIMS = 768;
const home = (p: string) => p.replace(/^~(?=\/)/, homedir());

// ── The sample ─────────────────────────────────────────────────────────────

interface Vacancy {
  id: string;
  title: string;
  description: string;
  country: 'usa' | 'brazil' | 'mexico';
  lang: BlockLang;
  queryLocation: string;
  isRemote: boolean;
  term: string;
}

/** The coarse region of a query location, as a listing publishes it (decision 0019). */
const REGIONS: Record<string, string> = {
  'Houston, TX': 'us-tx',
  'Corpus Christi, TX': 'us-tx',
  'New Orleans, LA': 'us-la',
  'Miami, FL': 'us-fl',
  'Rio de Janeiro, RJ': 'br-rj',
  'Macaé, RJ': 'br-rj',
  'São Paulo, SP': 'br-sp',
  'Monterrey, N.L.': 'mx-nle',
  'Ciudad del Carmen, Camp.': 'mx-cam',
  'Veracruz, Ver.': 'mx-ver',
};

/** A seeded generator of 32-bit integers (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const a = [...items];
  const draw = rng(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = draw() % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function readVacancies(dir: string): Vacancy[] {
  const out: Vacancy[] = [];
  for (const country of ['usa', 'brazil', 'mexico'] as const) {
    const path = join(dir, `${country}.jsonl`);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as Record<string, unknown>;
      const description = typeof r.description === 'string' ? r.description : '';
      const title = typeof r.title === 'string' ? r.title.trim() : '';
      if (description.length < 200 || !title) continue;
      out.push({
        id: String(r.id ?? r.job_url),
        title,
        description,
        country,
        lang: r.lang as BlockLang,
        queryLocation: String(r.query_location),
        isRemote: r.is_remote === true,
        term: String(r.term),
      });
    }
  }
  return out;
}

/** Half from the US, a quarter each from Brazil and Mexico, at random under the seed. */
function sample(all: Vacancy[], n: number, seed: number): Vacancy[] {
  const quota = { usa: Math.round(n / 2), brazil: Math.round(n / 4), mexico: n - Math.round(n / 2) - Math.round(n / 4) };
  const out: Vacancy[] = [];
  for (const country of ['usa', 'brazil', 'mexico'] as const) out.push(...shuffled(all.filter((v) => v.country === country), seed).slice(0, quota[country]));
  return out;
}

// ── De-identification and blocks ───────────────────────────────────────────

/** Contact details and links as the phone's placeholders, so the plane's tripwire reads an ad as it reads a CV. */
function deidentify(text: string): string {
  const counters: Record<string, number> = {};
  const mark = (cls: string) => {
    counters[cls] = Math.min(99, (counters[cls] ?? 0) + 1);
    return `[${cls}_${counters[cls]}]`;
  };
  return text
    .replace(/\r/g, '')
    .replace(/\[([^\]]+)\]\((?:https?:)?[^)]*\)/g, (_m, label: string) => `${label} ${mark('LINK')}`)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, () => mark('EMAIL'))
    .replace(/\bhttps?:\/\/\S+/gi, () => mark('LINK'))
    .replace(/\bwww\.\S+/gi, () => mark('LINK'))
    .replace(/\b[\w-]+\.(com|net|org|io|co|gov|edu|br|mx)\b(\/\S*)?/gi, () => mark('LINK'))
    .replace(/(^|\s)@[\w.]{3,}/g, (_m, lead: string) => `${lead}${mark('ID')}`)
    .replace(/\+?\(?\d{2,4}\)?[\s.-]\d{3,5}[\s.-]\d{4}\b/g, () => mark('PHONE'))
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\\([*_#\-.])/g, '$1')
    .replace(/^\s*[*•·]\s+/gm, '- ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const HEADING =
  /^\s*(?:-\s*)?(requirements?|job requirements|qualifications?|minimum qualifications|basic qualifications|required qualifications|preferred qualifications|what you.ll need|what you.ll bring|what we.re looking for|who you are|skills?(?:\s*(?:and|&|\/)\s*(?:experience|qualifications|abilities))?|experience(?: required)?|education|required|requisitos(?: obrigat[óo]rios)?|qualifica[çc][õo]es|diferenciais|forma[çc][ãa]o desejada|escolaridade|experi[êe]ncia|perfil(?: desejado| del puesto| requerido)?|habilidades|compet[êe]ncias|conocimientos|experiencia requerida|requerimientos|escolaridad)\b[^\n]{0,40}$/i;
/** Where an ad stops describing the work and the worker: the benefits, the pay, the company. */
const ENDING = /^\s*(?:-\s*)?(benefits|what we offer|compensation|salary|pay rate|about us|about the company|equal opportunity|eeo|benef[íi]cios|remunera[çc][ãa]o|informa[çc][õo]es adicionais|ofrecemos|beneficios|horario|hor[áa]rio|pergunta\(s\)|pregunta\(s\))\b[^\n]{0,40}$/i;
const CERT_LINE = /licen|certif|\bcard\b|osha|\bnr-?\d|twic|\bcdl\b|stcw|bosiet|nccco|\baws\b|asme|\bcpr\b|\bbls\b|\bepa\b|habilita[çc][ãa]o|\bcnh\b|carteira|credencial|\bdc-?3\b|cédula/i;

interface AdBlocks {
  experience: string;
  skills: string | null;
  certificates: string | null;
  /** The requirements, or the duties, for the hirer's sentence. */
  excerpt: string;
}

const cut = (t: string, max: number) => (t.length <= max ? t : t.slice(0, max).replace(/\s+\S*$/, ''));

function blocksOf(v: Vacancy): AdBlocks {
  const text = deidentify(v.description);
  const lines = text.split('\n').filter((l) => l.trim());
  let at = lines.findIndex((l, i) => i > 0 && l.length <= 60 && HEADING.test(l));
  // Without a heading, a long ad's second half is where the requirements tend to be.
  if (at < 0 && lines.length >= 8) at = Math.floor(lines.length / 2);
  // The requirements end where the benefits, the pay or the company begin.
  const end = at > 0 ? lines.findIndex((l, i) => i > at && l.length <= 60 && ENDING.test(l)) : -1;
  const duties = (at > 0 ? lines.slice(0, at) : lines).join('\n');
  const requirements = at > 0 ? lines.slice(at, end > at ? end : undefined).join('\n') : '';
  const bullets = (part: string) => part.split('\n').filter((l) => /^- /.test(l));
  const forExcerpt = bullets(requirements).length >= 2 ? bullets(requirements) : requirements ? [requirements] : bullets(duties).length >= 2 ? bullets(duties) : [duties];
  const certLines = lines.filter((l) => CERT_LINE.test(l)).join('\n');
  const room = BLOCK_MAX_CHARS - 200;
  return {
    experience: cut(`${cleanTitle(v.title)}\n${duties || text}`, room),
    skills: requirements.length >= 40 ? cut(requirements, room) : null,
    certificates: certLines.length >= 12 ? cut(certLines, room) : null,
    excerpt: cut(forExcerpt.map((l) => l.replace(/^- /, '')).join('; '), 700),
  };
}

/** A job board's title without its location, pay or shift suffix, within the registry's string limit. */
function cleanTitle(raw: string): string {
  const first = raw.split(/\s*[-–|]\s+|\s+[-–|]\s*|\s*\(\s*/)[0]!.trim();
  return cut(first.length >= 6 ? first : raw.trim(), 100);
}

// ── The registry replica ───────────────────────────────────────────────────

interface Meta {
  id: string;
  token: string;
  kind: string;
  lang: string;
  label: string;
  source: string;
  isco: string;
}

/** The v3 vectors (`vectors-v3-NNN.ndjson`, 768 wide) in memory, with brute-force retrieval by kind; mints go to a side list. */
class ReplicaIndex implements VectorIndex {
  private readonly rows: Meta[] = [];
  private values = new Float32Array(0);
  private readonly byKind = new Map<string, Int32Array>();
  private readonly extra = new Map<string, IndexVector>();
  readonly queries = { count: 0, ms: 0 };

  static load(dir: string): ReplicaIndex {
    const idx = new ReplicaIndex();
    const cacheDir = join(dir, 'bench-cache');
    const f32 = join(cacheDir, `v3-${DIMS}.f32`);
    const meta = join(cacheDir, `v3-${DIMS}.meta.json`);
    if (existsSync(f32) && existsSync(meta)) {
      const buf = readFileSync(f32);
      idx.values = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      for (const r of JSON.parse(readFileSync(meta, 'utf8')) as Meta[]) idx.rows.push(r);
    } else {
      const files = readdirSync(dir)
        .filter((f) => /^vectors-v3-\d{3}\.ndjson$/.test(f))
        .sort();
      if (!files.length) throw new Error(`no vectors-v3-NNN.ndjson in ${dir}`);
      const chunks: Float32Array[] = [];
      for (const f of files) {
        for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
          if (!line) continue;
          const r = JSON.parse(line) as { id: string; values: number[]; metadata: Record<string, string> };
          if (r.values.length !== DIMS) throw new Error(`${f}: a vector of ${r.values.length}`);
          chunks.push(Float32Array.from(r.values));
          idx.rows.push({ id: r.id, token: r.metadata.token ?? '', kind: r.metadata.kind ?? '', lang: r.metadata.lang ?? '', label: r.metadata.label ?? '', source: r.metadata.source ?? '', isco: r.metadata.isco ?? '' });
        }
        process.stdout.write(`${f}: ${idx.rows.length} vectors\n`);
      }
      idx.values = new Float32Array(idx.rows.length * DIMS);
      chunks.forEach((c, i) => idx.values.set(c, i * DIMS));
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(f32, Buffer.from(idx.values.buffer, idx.values.byteOffset, idx.values.byteLength));
      writeFileSync(meta, JSON.stringify(idx.rows));
    }
    const lists = new Map<string, number[]>();
    idx.rows.forEach((r, i) => (lists.get(r.kind) ?? lists.set(r.kind, []).get(r.kind)!).push(i));
    for (const [k, l] of lists) idx.byKind.set(k, Int32Array.from(l));
    return idx;
  }

  get size() {
    return this.rows.length;
  }

  async query(vector: number[], opts: { topK: number; namespace?: string; filter?: Record<string, string | number | boolean> }): Promise<IndexMatch[]> {
    const t0 = Date.now();
    const kind = typeof opts.filter?.kind === 'string' ? opts.filter.kind : null;
    const q = Float32Array.from(vector);
    const top: { i: number; s: number }[] = [];
    const consider = (i: number, s: number) => {
      if (top.length < opts.topK) {
        top.push({ i, s });
        if (top.length === opts.topK) top.sort((a, b) => a.s - b.s);
      } else if (s > top[0]!.s) {
        top[0] = { i, s };
        for (let k = 0; k + 1 < top.length && top[k]!.s > top[k + 1]!.s; k++) [top[k], top[k + 1]] = [top[k + 1]!, top[k]!];
      }
    };
    const rows = kind ? (this.byKind.get(kind) ?? new Int32Array(0)) : Int32Array.from(this.rows.keys());
    const V = this.values;
    for (const i of rows) {
      const o = i * DIMS;
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      for (let d = 0; d < DIMS; d += 4) {
        s0 += V[o + d]! * q[d]!;
        s1 += V[o + d + 1]! * q[d + 1]!;
        s2 += V[o + d + 2]! * q[d + 2]!;
        s3 += V[o + d + 3]! * q[d + 3]!;
      }
      consider(i, s0 + s1 + s2 + s3);
    }
    const out: IndexMatch[] = top.map(({ i, s }) => {
      const r = this.rows[i]!;
      return { id: r.id, score: s, metadata: { token: r.token, kind: r.kind, lang: r.lang, label: r.label, source: r.source } };
    });
    // Minted labels (the side list), the same filter.
    for (const v of this.extra.values()) {
      if (kind && v.metadata.kind !== kind) continue;
      let s = 0;
      for (let d = 0; d < DIMS; d++) s += v.values[d]! * q[d]!;
      out.push({ id: v.id, score: s, metadata: { ...v.metadata } });
    }
    this.queries.count++;
    this.queries.ms += Date.now() - t0;
    return out.sort((a, b) => b.score - a.score).slice(0, opts.topK);
  }

  async upsert(vectors: IndexVector[]): Promise<void> {
    for (const v of vectors) this.extra.set(v.id, v);
  }

  async deleteByIds(ids: string[]): Promise<void> {
    for (const id of ids) this.extra.delete(id);
  }
}

/** ESCO's and the US layer's SQL (the import files the founder loads into D1), then the certificate seed, into node:sqlite. */
async function loadReplica(escoSql: string, usSql: string) {
  const db = sqliteD1();
  const files = (dir: string, re: RegExp) =>
    readdirSync(dir)
      .filter((f) => re.test(f))
      .sort()
      .map((f) => join(dir, f));
  db.sqlite.exec('PRAGMA foreign_keys = OFF');
  let statements = 0;
  for (const f of [...files(escoSql, /^registry-\d{3}\.sql$/), ...files(usSql, /^national-\d{3}\.sql$/)]) {
    const sql = readFileSync(f, 'utf8');
    db.sqlite.exec(sql);
    statements += (sql.match(/^INSERT /gm) ?? []).length;
  }
  db.sqlite.exec('PRAGMA foreign_keys = ON');
  const store = new D1RegistryStore(db.d1);
  const certificates = await planCertificateImport();
  for (const t of certificates.tokens) await store.insertToken(t, certificates.labels.filter((l) => l.token === t.token), 0);
  const tokens = (db.sqlite.prepare('SELECT COUNT(*) AS n FROM registry_tokens').get() as { n: number }).n;
  const labels = (db.sqlite.prepare('SELECT COUNT(*) AS n FROM registry_labels').get() as { n: number }).n;
  return { db, store, statements, tokens, labels, certificateTokens: certificates.tokens.length };
}

// ── Vectors, as the phone makes them ──────────────────────────────────────

/** Every distinct text embedded once per role, in runs of 2,000, read back by text. */
function embedAll(texts: Iterable<string>, role: 'query' | 'document'): Map<string, number[]> {
  const all = [...new Set([...texts].map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean))];
  const out = new Map<string, number[]>();
  for (let i = 0; i < all.length; i += 2_000) {
    const batch = all.slice(i, i + 2_000);
    llamaEmbed(MODEL, batch, role).forEach((v, j) => out.set(batch[j]!, v));
    process.stdout.write(`${role}: ${Math.min(i + 2_000, all.length)} of ${all.length}\n`);
  }
  return out;
}

const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
const cosine = (a: readonly number[], b: readonly number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

// ── Relations by ISCO ──────────────────────────────────────────────────────

type Relation = 'right' | 'near' | 'industry' | 'far';
function relation(a: string | null, b: string | null): Relation | null {
  if (!a || !b) return null;
  if (a === b) return 'right';
  if (a.slice(0, 3) === b.slice(0, 3)) return 'near';
  if (a.slice(0, 2) === b.slice(0, 2)) return 'industry';
  return 'far';
}

// ── The report's helpers ───────────────────────────────────────────────────

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');
const f3 = (x: number | null | undefined) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(3));
const usd = (micro: number) => `$${(micro / 1e6).toFixed(4)}`;
const stats = (xs: number[]) => {
  if (!xs.length) return '—';
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return `${f3(s.reduce((a, b) => a + b, 0) / s.length)} (${f3(q(0.05))} to ${f3(q(0.95))}, min ${f3(s[0])}, max ${f3(s[s.length - 1])})`;
};
const mean = (xs: number[], digits = 2) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(digits) : '—');
const cost = (calls: readonly WorkCall[]) => calls.reduce((s, c) => s + callCostMicroUsd(c), 0);
/** A string in a report cell: one line, pipes escaped, at most 80 characters. */
const cell = (t: string) => cut(t.replace(/\s+/g, ' ').replace(/\|/g, '\\|'), 80);

interface Decision {
  kind: TokenKind;
  raw: string;
  lang: string;
  decision: string;
  token: string | null;
  score: number | null;
  probability: number | null;
  candidates: { token: string; score: number }[];
  model: string | null;
}

/** The text of a reasoning answer: OpenAI-style, or Workers AI's `response`. */
function answerText(result: unknown): string {
  const r = result as { choices?: { message?: { content?: unknown } }[]; response?: unknown } | null;
  const text = r?.choices?.[0]?.message?.content ?? r?.response;
  return typeof text === 'string' ? text : '';
}

function answerUsage(result: unknown): { tokensIn: number; tokensOut: number } {
  const u = (result as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null)?.usage;
  return { tokensIn: u?.prompt_tokens ?? 0, tokensOut: u?.completion_tokens ?? 0 };
}

/** Hosted calls `n` at a time, in order. */
async function parallel<T, R>(items: readonly T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

describe.skipIf(!RUN)('the Work pipeline on real vacancies (opt-in, from the Mac)', () => {
  it('extracts, publishes, queries and measures a sample of job ads', async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const jobsDir = home(process.env.JOBS_DIR ?? '');
    const escoSql = home(process.env.ESCO_SQL ?? '');
    const usSql = home(process.env.US_SQL ?? '');
    const v3Dir = home(process.env.V3_DIR ?? '');
    if (!accountId || !token || !jobsDir || !escoSql || !usSql || !v3Dir) throw new Error('JOBS_EVAL needs JOBS_DIR, ESCO_SQL, US_SQL, V3_DIR, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    const n = Number(process.env.JOBS_N ?? 300);
    const seed = Number(process.env.JOBS_SEED ?? 68);
    const thinkN = Number(process.env.JOBS_THINK ?? 120);
    const parallelN = Number(process.env.JOBS_PARALLEL ?? 4);
    const thinkParallel = Number(process.env.JOBS_THINK_PARALLEL ?? 2);
    const outDir = home(process.env.JOBS_OUT ?? join(jobsDir, '..', '..', 'runs'));
    const started = Date.now();
    const lines: string[] = [];
    const say = (l = '') => lines.push(l);
    const date = new Date().toISOString().slice(0, 10);

    // The sample.
    const all = readVacancies(jobsDir);
    const picked = sample(all, n, seed);
    const byCountry = (vs: Vacancy[]) => (['usa', 'brazil', 'mexico'] as const).map((c) => `${c} ${vs.filter((v) => v.country === c).length}`).join(', ');
    process.stdout.write(`${all.length} vacancies (${byCountry(all)}); sampled ${picked.length} (${byCountry(picked)})\n`);

    // The registry replica and the models.
    const t0 = Date.now();
    const replica = await loadReplica(escoSql, usSql);
    const index = ReplicaIndex.load(v3Dir);
    process.stdout.write(`replica: ${replica.tokens} tokens, ${replica.labels} labels, ${index.size} vectors, ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
    const ai = createRestAi({ accountId, token });
    const seam: Inference = createInference({ WORK_EMBED_MODEL: MODEL }, { ai })!;
    /** Every Clef adjudication's answer: the state's first line (the kind and locale), its last (the string) and the probabilities by key. */
    const clefLog: { head: string; raw: string; choice: string | null; probabilities: Record<string, number> }[] = [];
    const inference: Inference = {
      model: (op) => seam.model(op),
      async run(op, input, call) {
        const result = await seam.run(op, input, call);
        if (op === 'work-adjudicate' && typeof input.state === 'string') {
          const a = (result as { answers?: { match?: { choice?: unknown; probabilities?: Record<string, unknown> } } } | null)?.answers?.match;
          const probabilities: Record<string, number> = {};
          for (const [k, v] of Object.entries(a?.probabilities ?? {})) if (typeof v === 'number') probabilities[k] = v;
          const lines = input.state.split('\n');
          clefLog.push({ head: lines[0] ?? '', raw: lines[lines.length - 1] ?? '', choice: typeof a?.choice === 'string' ? a.choice : null, probabilities });
        }
        return result;
      },
    };
    const registry: RegistryDeps = { inference, store: replica.store, index };
    const tau = tauFor(MODEL);
    const listings = new D1ListingStore(replica.db.d1);
    {
      const d1 = replica.db.d1 as unknown as { batch: (stmts: unknown[]) => Promise<unknown> };
      const rawBatch = d1.batch.bind(d1);
      let chain: Promise<unknown> = Promise.resolve();
      d1.batch = (stmts) => {
        const run = chain.then(() => rawBatch(stmts));
        chain = run.catch(() => undefined);
        return run;
      };
    }
    const jobsIndex = memoryIndex();
    const publish: PublishDeps = { inference, registry, listings, index: jobsIndex };
    const hire: HireDeps = { registry, recall: { inference, index: jobsIndex, listings } };

    // 1. Blocks through the tripwire and the extractor.
    interface Extracted {
      v: Vacancy;
      blocks: AdBlocks;
      refused: { kind: string; reason: string }[];
      title: string | null;
      skills: string[];
      certificates: string[];
      calls: WorkCall[];
      failed: string[];
    }
    const extracted = await parallel(picked, parallelN, async (v): Promise<Extracted> => {
      const blocks = blocksOf(v);
      const out: Extracted = { v, blocks, refused: [], title: null, skills: [], certificates: [], calls: [], failed: [] };
      const parts: [AdBlocks['experience'] | null, 'experience' | 'skills' | 'certificates'][] = [
        [blocks.experience, 'experience'],
        [blocks.skills, 'skills'],
        [blocks.certificates, 'certificates'],
      ];
      for (const [text, kind] of parts) {
        if (!text) continue;
        const checked = checkBlock({ kind, lang: v.lang, text });
        if (!checked.ok) {
          out.refused.push({ kind, reason: checked.reason });
          continue;
        }
        const r = await extractBlock(inference, checked.block as DeidentifiedBlock);
        out.calls.push(...r.calls);
        if (!r.ok) {
          out.failed.push(kind);
          continue;
        }
        const f = r.extraction.fields;
        if (kind === 'experience') out.title = str(f.title);
        const skills = list(f.skills).filter((s): s is string => typeof s === 'string');
        const certs = list(f.certificates).filter((s): s is string => typeof s === 'string');
        out.skills.push(...skills);
        out.certificates.push(...certs);
      }
      return out;
    });
    const noPlaceholder = (s: string) => !/\[[A-Z]+_\d+\]/.test(s);
    const drafts = extracted.map((e, i): { e: Extracted; draft: ListingDraft } => {
      const titles = [...new Set([cleanTitle(e.v.title), ...(e.title ? [cut(norm(e.title), 100)] : [])].map(norm))].filter(noPlaceholder).slice(0, 5);
      const skills = [...new Set(e.skills.map((s) => cut(norm(s), 100)))].filter((s) => s.length >= 3 && noPlaceholder(s)).slice(0, 30);
      const certificates = [...new Set(e.certificates.map((s) => cut(norm(s), 100)))].filter((s) => s.length >= 3 && noPlaceholder(s)).slice(0, 20);
      const draft: ListingDraft = {
        pseudonym: `v${i}`,
        profileId: 'main',
        region: REGIONS[e.v.queryLocation] ?? e.v.country.slice(0, 2),
        scope: e.v.isRemote ? 'remote' : 'onsite',
        tier: 1,
        lang: e.v.lang,
        titles,
        skills,
        certificates,
        languages: [e.v.lang],
      };
      return { e, draft };
    });
    const extractCost = cost(extracted.flatMap((e) => e.calls));
    process.stdout.write(`extracted ${drafts.length} drafts, ${usd(extractCost)}, ${((Date.now() - started) / 1000).toFixed(0)} s\n`);

    // 2. The phone's vectors: the listing text as a document, every claim as a query and a document, the hirer's sentence as a query.
    const sentences = new Map<string, string>();
    for (const { e, draft } of drafts) sentences.set(draft.pseudonym, cut(`${draft.titles[0] ?? e.v.title}. ${e.blocks.excerpt}`, 1_000));
    const claimTexts = drafts.flatMap(({ draft }) => [...draft.titles, ...draft.skills, ...draft.certificates]);
    const docs = embedAll([...drafts.map(({ draft }) => listingText(draft, [])), ...claimTexts], 'document');
    const queries = embedAll([...claimTexts, ...sentences.values()], 'query');

    // 3. Publish each vacancy as a listing: the snaps run inside, against the replica.
    let publishedCount = 0;
    const published = await parallel(drafts, parallelN, async ({ draft }) => {
      const claims = new Map<string, ClaimVectors>();
      const add = (kind: TokenKind, texts: string[]) => {
        for (const t of texts) {
          const q = queries.get(norm(t));
          const d = docs.get(norm(t));
          if (q && d) claims.set(claimKey(kind, t), { query: q, document: d });
        }
      };
      add('pos', draft.titles);
      add('skill', draft.skills);
      add('cert', draft.certificates);
      const t1 = Date.now();
      const out = await publishListing(publish, draft, { listing: docs.get(norm(listingText(draft, []))), claims });
      if (++publishedCount % 25 === 0) process.stdout.write(`published ${publishedCount} of ${drafts.length}, ${((Date.now() - started) / 1000).toFixed(0)} s\n`);
      return { draft, ok: out.ok, error: out.ok ? null : out.error, tokens: out.ok ? out.tokens : [], calls: out.calls, ms: Date.now() - t1, listingId: out.ok ? out.listingId : null };
    });
    const publishCost = cost(published.flatMap((p) => p.calls));

    // The snaps, as the registry recorded them.
    const decisions = (replica.db.sqlite.prepare('SELECT kind, raw, lang, decision, token, score, probability, candidates, model FROM registry_decisions ORDER BY created_at').all() as Record<string, unknown>[]).map(
      (r): Decision => ({
        kind: r.kind as TokenKind,
        raw: String(r.raw),
        lang: String(r.lang),
        decision: String(r.decision),
        token: (r.token as string | null) ?? null,
        score: (r.score as number | null) ?? null,
        probability: (r.probability as number | null) ?? null,
        candidates: JSON.parse(String(r.candidates ?? '[]')) as { token: string; score: number }[],
        model: (r.model as string | null) ?? null,
      }),
    );
    // Exact labels are not recorded as decisions: count them from the publishes' token lists against the decisions.
    const labelsByToken = new Map<string, string>();
    const allTokens = [...new Set([...published.flatMap((p) => p.tokens), ...decisions.flatMap((d) => [d.token ?? '', ...d.candidates.map((c) => c.token)])].filter(Boolean))];
    const tokenRows = await replica.store.tokens(allTokens);
    for (const [t, row] of tokenRows) labelsByToken.set(t, row.labelEn);
    const iscoOf = (t: string | null) => (t ? (tokenRows.get(t)?.iscoCode ?? null) : null);

    // The title's token per vacancy: the first title's snap (a decision), else an exact label (no decision) read back from the record's tokens.
    const titleToken = new Map<string, string | null>();
    for (const p of published) {
      const first = p.draft.titles[0];
      const d = decisions.find((x) => x.kind === 'pos' && x.raw === first);
      const t = d?.token ?? p.tokens.find((x) => x.startsWith('pos:')) ?? null;
      titleToken.set(p.draft.pseudonym, t);
    }

    // 4. The hirer's side: each vacancy's sentence against the pool.
    interface Asked {
      pseudonym: string;
      region: string;
      lang: BlockLang;
      ok: boolean;
      error: string | null;
      needs: { token: string; p: number }[];
      scope: string | null;
      mode: string | null;
      missing: string[];
      certificate: string | null;
      finalists: { pseudonym: string; score: number; tier: 1 | 2; rel: Relation | null; matched: string[] }[];
      recalled: number;
      calls: WorkCall[];
      ms: number;
    }
    const byListingId = new Map(published.filter((p) => p.listingId).map((p) => [p.listingId!, p.draft.pseudonym]));
    let askedCount = 0;
    const asked = await parallel(drafts, parallelN, async ({ draft }): Promise<Asked> => {
      const sentence = sentences.get(draft.pseudonym)!;
      const vector = queries.get(norm(sentence));
      const t1 = Date.now();
      const out = await hirerQuery(hire, { sentence, lang: draft.lang, regions: [draft.region], ...(vector ? { vector } : {}) });
      const mine = iscoOf(titleToken.get(draft.pseudonym) ?? null);
      const a: Asked = { pseudonym: draft.pseudonym, region: draft.region, lang: draft.lang, ok: out.ok, error: out.ok ? null : out.error, needs: [], scope: null, mode: null, missing: [], certificate: null, finalists: [], recalled: 0, calls: out.calls, ms: Date.now() - t1 };
      if (out.ok) {
        a.needs = out.plan.needs.map((x) => ({ token: x.token, p: x.p }));
        a.scope = out.plan.scope;
        a.mode = out.plan.intent.mode;
        a.missing = out.plan.missing;
        a.certificate = out.plan.certificate;
        if (out.recall.ok) {
          a.recalled = out.recall.recalled;
          a.finalists = out.recall.finalists
            .map((f) => ({ pseudonym: byListingId.get(f.listingId) ?? f.listingId, score: f.score, tier: f.gateTier, rel: null as Relation | null, matched: f.matched }))
            .filter((f) => f.pseudonym !== draft.pseudonym)
            .map((f) => ({ ...f, rel: relation(mine, iscoOf(titleToken.get(f.pseudonym) ?? null)) }));
        }
      }
      if (++askedCount % 25 === 0) process.stdout.write(`asked ${askedCount} of ${drafts.length}, ${((Date.now() - started) / 1000).toFixed(0)} s\n`);
      return a;
    });
    const hireCost = cost(asked.flatMap((a) => a.calls));

    // 5. Every sentence against every other listing's vector, by relation: the floor on real pairs.
    const pairs: Record<Relation, number[]> = { right: [], near: [], industry: [], far: [] };
    const sameRegionPairs: Record<Relation, number[]> = { right: [], near: [], industry: [], far: [] };
    let labelled = 0;
    for (const q of drafts) {
      const qv = queries.get(norm(sentences.get(q.draft.pseudonym)!));
      const qi = iscoOf(titleToken.get(q.draft.pseudonym) ?? null);
      if (!qv || !qi) continue;
      labelled++;
      for (const l of drafts) {
        if (l === q) continue;
        const lv = docs.get(norm(listingText(l.draft, [])));
        const rel = relation(qi, iscoOf(titleToken.get(l.draft.pseudonym) ?? null));
        if (!lv || !rel) continue;
        const s = cosine(qv, lv);
        pairs[rel].push(s);
        if (l.draft.region === q.draft.region) sameRegionPairs[rel].push(s);
      }
    }

    // 5b. The fast lane: every sentence against the listings of its own region, ranked by cosine alone.
    const DELTAS = [0.02, 0.05, 0.08, 0.1, 0.15];
    const rankFirst: Record<Relation, number> = { right: 0, near: 0, industry: 0, far: 0 };
    let ranked = 0;
    const precision: Record<number, number[]> = { 3: [], 5: [] };
    const within: Record<number, Record<Relation, number>> = Object.fromEntries(DELTAS.map((d) => [d, { right: 0, near: 0, industry: 0, far: 0 }])) as Record<number, Record<Relation, number>>;
    for (const q of drafts) {
      const qv = queries.get(norm(sentences.get(q.draft.pseudonym)!));
      const qi = iscoOf(titleToken.get(q.draft.pseudonym) ?? null);
      if (!qv || !qi) continue;
      const scored: { rel: Relation; s: number }[] = [];
      for (const l of drafts) {
        if (l === q || l.draft.region !== q.draft.region) continue;
        const lv = docs.get(norm(listingText(l.draft, [])));
        const rel = relation(qi, iscoOf(titleToken.get(l.draft.pseudonym) ?? null));
        if (lv && rel) scored.push({ rel, s: cosine(qv, lv) });
      }
      if (!scored.length) continue;
      scored.sort((a, b) => b.s - a.s);
      ranked++;
      rankFirst[scored[0]!.rel]++;
      for (const k of [3, 5]) if (scored.length >= k) precision[k]!.push(scored.slice(0, k).filter((x) => x.rel === 'right' || x.rel === 'near').length / k);
      for (const d of DELTAS) for (const x of scored) if (x.s >= scored[0]!.s - d) within[d]![x.rel]++;
    }

    // 5c. Clef's floor on the undecided strings, from its own probabilities: what a rule that reads the mass on none would take.
    const clefOf = (raw: string) => [...clefLog].reverse().find((c) => c.raw === raw);
    interface Loosened {
      d: Decision;
      none: number;
      top: { key: string; p: number } | null;
      mass: number;
    }
    const loosened: Loosened[] = [];
    for (const d of decisions) {
      if (!(d.kind === 'pos' || d.kind === 'skill') || d.decision === 'chosen' || d.decision === 'auto' || !d.candidates.length) continue;
      const c = clefOf(d.raw);
      if (!c) continue;
      const entries = Object.entries(c.probabilities).filter(([k]) => k !== 'none');
      const top = entries.sort((a, b) => b[1] - a[1])[0];
      loosened.push({ d, none: c.probabilities.none ?? 0, top: top ? { key: top[0], p: top[1] } : null, mass: entries.reduce((s, [, p]) => s + p, 0) });
    }
    const RULE = { noneMax: 0.15, topMin: 0.25 };
    const converted = loosened.filter((l) => l.none <= RULE.noneMax && l.top && l.top.p >= RULE.topMin);

    // 5d. Titles an exact label holds on several tokens, which the shortcut cannot take.
    const ambiguous: { title: string; lang: string; tokens: string[] }[] = [];
    for (const { draft } of drafts) {
      const title = draft.titles[0];
      if (!title) continue;
      const held = await replica.store.tokensByLabel(labelNorm(title), 'pos', labelLangs(draft.lang));
      if (held.length >= 2) ambiguous.push({ title, lang: draft.lang, tokens: held.map((t) => t.labelEn) });
    }

    // 6. The strings Clef left undecided, re-asked of the Thinking model; and a check of its agreement where Clef was sure.
    const undecided = decisions.filter((d) => (d.kind === 'pos' || d.kind === 'skill') && d.decision !== 'chosen' && d.decision !== 'auto' && d.candidates.length > 0 && d.score != null && d.score >= tau.low);
    const sure = decisions.filter((d) => (d.kind === 'pos' || d.kind === 'skill') && d.decision === 'chosen' && (d.probability ?? 0) >= 0.5);
    const think = async (d: Decision) => {
      const entries = d.candidates.map((c, i) => `- c${i}: ${labelsByToken.get(c.token) ?? c.token}`).join('\n');
      const noun = d.kind === 'pos' ? 'occupation' : 'skill';
      const state = adjudicationState(d.kind as 'pos' | 'skill', d.raw, { lang: d.lang as BlockLang });
      const messages = [
        { role: 'system', content: `You classify strings from the job market against a registry of ${noun}s. Answer with one JSON object on a single line, {"match": KEY, "reason": SHORT}, where KEY is one of the entry keys or "none".` },
        { role: 'user', content: `${state}\n\nEntries:\n${entries}\n- none: None of these: a different ${noun}\n\nWhich entry names the same ${noun} as the text, or the broader ${noun} it is a specialization of?` },
      ];
      const t1 = Date.now();
      let failure = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // Room for the reasoning as well as the answer: DeepSeek's reasoning counts against the completion budget.
          const result = await inference.run('chat-reasoning', { messages, max_completion_tokens: 900, reasoning_effort: 'low' });
          const text = answerText(result);
          const m = /"match"\s*:\s*"([^"]+)"/.exec(text);
          return { d, pick: m?.[1] ?? null, ms: Date.now() - t1, usage: answerUsage(result), text: text || 'empty answer' };
        } catch (err) {
          failure = (err as Error).message.replace(/\s+/g, ' ').slice(0, 80);
          await new Promise((r) => setTimeout(r, 3_000 * (attempt + 1)));
        }
      }
      return { d, pick: null, ms: Date.now() - t1, usage: { tokensIn: 0, tokensOut: 0 }, text: `error: ${failure}` };
    };
    const thought = await parallel(shuffled(undecided, seed).slice(0, thinkN), thinkParallel, think);
    const agreed = await parallel(shuffled(sure, seed).slice(0, Math.min(60, sure.length)), thinkParallel, think);
    const thinkCost = [...thought, ...agreed].reduce((s, t) => s + (t.usage.tokensIn * 0.3 + t.usage.tokensOut * 1.2), 0);

    // ── The report ───────────────────────────────────────────────────────
    say(`# The Work pipeline on real vacancies, ${MODEL} at ${DIMS}, ${date}`);
    say();
    say(`${picked.length} vacancies sampled (seed ${seed}) from ${all.length} JobSpy pulled from Indeed (${byCountry(all)}), each both a listing and a hirer's sentence, through the real hosted models over the Workers AI REST API and the phone's embeddings from llama-embedding (${MODEL}, ${DIMS} wide), against a replica of the registry: ${replica.tokens} tokens and ${replica.labels} labels (ESCO, the US layer and the certificate seed), ${index.size} label vectors. τ ${tau.auto} and ${tau.low}. ${((Date.now() - started) / 60_000).toFixed(1)} minutes; hosted cost ${usd(extractCost + publishCost + hireCost + thinkCost)} (extraction ${usd(extractCost)}, publishing ${usd(publishCost)}, hirer queries ${usd(hireCost)}, the Thinking re-asks ${usd(thinkCost)}).`);
    say();
    say('## The listings: blocks and extraction');
    say();
    const refusals = new Map<string, number>();
    for (const e of extracted) for (const r of e.refused) refusals.set(`${r.kind}: ${r.reason}`, (refusals.get(`${r.kind}: ${r.reason}`) ?? 0) + 1);
    const blocksSent = extracted.reduce((s, e) => s + [e.blocks.experience, e.blocks.skills, e.blocks.certificates].filter(Boolean).length, 0);
    const extractCalls = extracted.flatMap((e) => e.calls);
    say(`${blocksSent} blocks built from ${extracted.length} ads (an experience block each, ${extracted.filter((e) => e.blocks.skills).length} skills blocks, ${extracted.filter((e) => e.blocks.certificates).length} certificates blocks); ${extracted.reduce((s, e) => s + e.refused.length, 0)} refused by the tripwire${refusals.size ? ` (${[...refusals].map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}; ${extractCalls.length} extraction calls, ${extractCalls.filter((c) => !c.ok).length} failed, ${extractCalls.filter((c) => c.op === 'work-extract-fallback').length} on the fallback; ${extracted.filter((e) => e.failed.length).length} ads with a failed block. Titles read from the experience block: ${extracted.filter((e) => e.title).length}. Per draft: titles ${stats(drafts.map((d) => d.draft.titles.length))}, skills ${stats(drafts.map((d) => d.draft.skills.length))}, certificates ${stats(drafts.map((d) => d.draft.certificates.length))}.`);
    say();
    say('## The snaps');
    say();
    say(`${published.filter((p) => p.ok).length} of ${published.length} listings published${published.some((p) => !p.ok) ? ` (${published.filter((p) => !p.ok).map((p) => p.error).join(', ')})` : ''}, ${published.reduce((s, p) => s + p.tokens.length, 0)} tokens in all, ${mean(published.map((p) => p.ms / 1000), 1)} s each on average; ${index.queries.count} index queries, ${(index.queries.ms / Math.max(1, index.queries.count)).toFixed(0)} ms each. Strings that met an exact label leave no decision; the table counts the rest.`);
    say();
    say('| Kind | Language | Decisions | auto | chosen | pivot | minted | unmatched | Clef p, chosen | Best cosine, all |');
    say('|---|---|---|---|---|---|---|---|---|---|');
    for (const kind of ['pos', 'skill', 'cert'] as const) {
      for (const lang of ['en', 'pt', 'es']) {
        const ds = decisions.filter((d) => d.kind === kind && d.lang === lang);
        if (!ds.length) continue;
        const share = (dec: string) => pct(ds.filter((d) => d.decision === dec).length, ds.length);
        say(`| ${kind} | ${lang} | ${ds.length} | ${share('auto')} | ${share('chosen')} | ${share('pivot')} | ${share('minted')} | ${share('unmatched')} | ${stats(ds.filter((d) => d.decision === 'chosen').map((d) => d.probability!))} | ${stats(ds.filter((d) => d.score != null).map((d) => d.score!))} |`);
      }
    }
    say();
    say(`Clef in the band: ${decisions.filter((d) => d.model?.includes('clef')).length} calls; ${undecided.length} strings Clef left undecided with candidates at or above τ_low (none, below its floor, or no answer); the exact-label and auto paths need no model.`);
    say();
    say('A random 60 of the title snaps, for the eye:');
    say();
    say('| Title | Lang | Decision | Token | Cosine | Clef p |');
    say('|---|---|---|---|---|---|');
    for (const d of shuffled(decisions.filter((d) => d.kind === 'pos'), seed).slice(0, 60)) say(`| ${cell(d.raw)} | ${d.lang} | ${d.decision} | ${d.token ? cell(labelsByToken.get(d.token) ?? d.token) : '—'} | ${f3(d.score)} | ${f3(d.probability)} |`);
    say();
    say('## The hirer side');
    say();
    const okAsked = asked.filter((a) => a.ok);
    const errors = new Map<string, number>();
    for (const a of asked) if (!a.ok) errors.set(a.error ?? '?', (errors.get(a.error ?? '?') ?? 0) + 1);
    say(`${okAsked.length} of ${asked.length} sentences planned${errors.size ? ` (${[...errors].map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}; needs per plan ${stats(okAsked.map((a) => a.needs.length))}, Clef's p on a need ${stats(okAsked.flatMap((a) => a.needs.map((x) => x.p)))}; on-site ${okAsked.filter((a) => a.scope === 'onsite').length}, remote ${okAsked.filter((a) => a.scope === 'remote').length}; Instant ${okAsked.filter((a) => a.mode === 'instant').length}, Curated ${okAsked.filter((a) => a.mode === 'curated').length}; a certificate required by ${okAsked.filter((a) => a.certificate).length}; ${mean(asked.map((a) => a.ms / 1000), 1)} s a query.`);
    say();
    const fin = okAsked.flatMap((a) => a.finalists);
    const tier = (t: 1 | 2) => fin.filter((f) => f.tier === t);
    const relShare = (fs: typeof fin) => (['right', 'near', 'industry', 'far'] as const).map((r) => `${r} ${pct(fs.filter((f) => f.rel === r).length, fs.filter((f) => f.rel).length)}`).join(', ');
    say(`Recall over the other vacancies in the sentence's region: ${mean(okAsked.map((a) => a.recalled), 1)} recalled and ${mean(okAsked.map((a) => a.finalists.length), 1)} finalists a query; ${okAsked.filter((a) => a.finalists.length === 0).length} queries with none. Tier 1 (through the token gate): ${tier(1).length} finalists, by relation ${relShare(tier(1))}. Tier 2 (a token miss at cosine ${0.5} or more): ${tier(2).length}, by relation ${relShare(tier(2))}. A finalist whose title or the query's did not snap to a token with an ISCO code has no relation and is left out of the shares.`);
    say();
    say('## The tier-2 floor on real pairs');
    say();
    say(`${labelled} sentences whose title snapped to a token with an ISCO code, each against every other vacancy's listing vector (all regions), by relation: cosine, mean (5th to 95th percentile, min, max).`);
    say();
    say('| Relation | Pairs | Cosine | Pairs, same region | Cosine, same region |');
    say('|---|---|---|---|---|');
    for (const r of ['right', 'near', 'industry', 'far'] as const) say(`| ${r} | ${pairs[r].length} | ${stats(pairs[r])} | ${sameRegionPairs[r].length} | ${stats(sameRegionPairs[r])} |`);
    say();
    say('| Floor | Right kept | Near kept | Industry admitted | Far admitted |');
    say('|---|---|---|---|---|');
    for (const f of [0.5, 0.55, 0.6, 0.62, 0.64, 0.65, 0.66, 0.67, 0.68, 0.69, 0.7, 0.72, 0.74, 0.76, 0.78, 0.8]) {
      const at = (xs: number[]) => xs.filter((x) => x >= f).length;
      say(`| ${f} | ${pct(at(pairs.right), pairs.right.length)} | ${pct(at(pairs.near), pairs.near.length)} | ${pct(at(pairs.industry), pairs.industry.length)} | ${pct(at(pairs.far), pairs.far.length)} |`);
    }
    say();
    say('## The fast lane: the vector ranking alone, in the sentence\'s region');
    say();
    say(`${ranked} sentences with a title token and at least one other listing in their region, each listing ranked by the cosine of the sentence's query vector and the listing's document vector, no token gate. The first listing is right for ${pct(rankFirst.right, ranked)}, adjacent for ${pct(rankFirst.near, ranked)}, of the same industry for ${pct(rankFirst.industry, ranked)} and far for ${pct(rankFirst.far, ranked)}. Right or adjacent among the first three: ${mean(precision[3]!.map((x) => 100 * x), 1)}% (${precision[3]!.length} sentences with three or more); among the first five: ${mean(precision[5]!.map((x) => 100 * x), 1)}% (${precision[5]!.length}).`);
    say();
    say('What sits within a margin of the best score, by relation (a relative floor, against the absolute one above):');
    say();
    say('| Margin below the best | right | near | industry | far | Listings a sentence |');
    say('|---|---|---|---|---|---|');
    for (const d of DELTAS) {
      const w = within[d]!;
      const total = w.right + w.near + w.industry + w.far;
      say(`| ${d} | ${pct(w.right, total)} | ${pct(w.near, total)} | ${pct(w.industry, total)} | ${pct(w.far, total)} | ${(total / Math.max(1, ranked)).toFixed(1)} |`);
    }
    say();
    const byPos = fin.filter((f) => f.tier === 1 && f.matched.some((t) => t.startsWith('pos:')));
    const bySkill = fin.filter((f) => f.tier === 1 && !f.matched.some((t) => t.startsWith('pos:')));
    say(`Tier-1 finalists that matched an occupation token: ${byPos.length}, by relation ${relShare(byPos)}; through skill tokens alone: ${bySkill.length}, by relation ${relShare(bySkill)}.`);
    say();
    say('## Clef\'s floor, from its own probabilities');
    say();
    say(`${loosened.length} undecided occupation and skill strings with Clef's answer on record: the mass Clef put on none ${stats(loosened.map((l) => l.none))}, on its best candidate ${stats(loosened.map((l) => l.top?.p ?? 0))}, on all candidates together ${stats(loosened.map((l) => l.mass))}. A rule that takes the best candidate when none holds at most ${RULE.noneMax} and the best at least ${RULE.topMin} (the US layer's reading of Clef, \`ONET_NONE_MAX\`) would take ${converted.length} of them (${pct(converted.length, loosened.length)}); a random 40, for the eye:`);
    say();
    say('| String | Kind | Lang | none | Best (p) | Then |');
    say('|---|---|---|---|---|---|');
    for (const l of shuffled(converted, seed).slice(0, 40)) {
      const c = clefOf(l.d.raw)!;
      const second = Object.entries(c.probabilities).filter(([k]) => k !== 'none' && k !== l.top!.key).sort((a, b) => b[1] - a[1])[0];
      const name = (key: string) => cell(labelsByToken.get(l.d.candidates[Number(key.slice(1))]?.token ?? '') ?? key);
      say(`| ${cell(l.d.raw)} | ${l.d.kind} | ${l.d.lang} | ${f3(l.none)} | ${name(l.top!.key)} (${f3(l.top!.p)}) | ${second ? `${name(second[0])} (${f3(second[1])})` : '—'} |`);
    }
    say();
    say('## Titles an exact label holds on several tokens');
    say();
    say(`${ambiguous.length} of ${drafts.length} first titles are an exact label of two or more tokens in the title's language or English, so the shortcut could not take them and they went through the vector path, Clef and the pivot:`);
    say();
    say('| Title | Lang | Tokens holding it |');
    say('|---|---|---|');
    for (const a of ambiguous.slice(0, 40)) say(`| ${cell(a.title)} | ${a.lang} | ${a.tokens.map(cell).join('; ')} |`);
    say();
    say('## The Thinking model where Clef fell short');
    say();
    const picks = (ts: typeof thought) => ({ answered: ts.filter((t) => t.pick).length, none: ts.filter((t) => t.pick === 'none').length, candidate: ts.filter((t) => t.pick && t.pick !== 'none').length });
    const tp = picks(thought);
    say(`${thought.length} of the ${undecided.length} undecided strings re-asked of the Thinking model (DeepSeek V4.1 Flash, low effort, no Clef): ${tp.answered} answered, ${tp.candidate} chose a candidate, ${tp.none} chose none; ${mean(thought.map((t) => t.ms / 1000), 1)} s a call, ${mean(thought.map((t) => t.usage.tokensOut), 0)} output tokens. Where Clef was sure (${agreed.length} of its choices at p ≥ 0.5): the Thinking model agreed on ${agreed.filter((t) => t.pick && t.d.candidates[Number(t.pick.slice(1))]?.token === t.d.token).length}, chose another candidate on ${agreed.filter((t) => t.pick && t.pick !== 'none' && t.d.candidates[Number(t.pick.slice(1))]?.token !== t.d.token).length}, none on ${agreed.filter((t) => t.pick === 'none').length}.`);
    say();
    say('| String | Kind | Lang | Clef decision | Clef p | Candidates (best first) | Thinking pick |');
    say('|---|---|---|---|---|---|---|');
    for (const t of thought) {
      const cands = t.d.candidates.map((c, i) => `c${i} ${cell(labelsByToken.get(c.token) ?? c.token)} ${f3(c.score)}`).join('; ');
      const pick = t.pick && t.pick !== 'none' ? `${t.pick} ${cell(labelsByToken.get(t.d.candidates[Number(t.pick.slice(1))]?.token ?? '') ?? '?')}` : (t.pick ?? `no pick: ${cell(t.text)}`);
      say(`| ${cell(t.d.raw)} | ${t.d.kind} | ${t.d.lang} | ${t.d.decision} | ${f3(t.d.probability)} | ${cands} | ${pick} |`);
    }
    say();
    const file = join('test', 'work-eval', `jobs-${date}-n${picked.length}-seed${seed}.md`);
    writeFileSync(file, lines.join('\n') + '\n');
    process.stdout.write(`wrote ${file}\n`);
    mkdirSync(outDir, { recursive: true });
    const round = (v: number[] | undefined) => v?.map((x) => Math.round(x * 1e5) / 1e5);
    const data = {
      model: MODEL,
      dims: DIMS,
      seed,
      date,
      tau,
      vacancies: drafts.map(({ e, draft }) => ({
        pseudonym: draft.pseudonym,
        id: e.v.id,
        country: e.v.country,
        lang: draft.lang,
        region: draft.region,
        scope: draft.scope,
        titles: draft.titles,
        skills: draft.skills,
        certificates: draft.certificates,
        sentence: sentences.get(draft.pseudonym),
        titleToken: titleToken.get(draft.pseudonym) ?? null,
        isco: iscoOf(titleToken.get(draft.pseudonym) ?? null),
        listingVector: round(docs.get(norm(listingText(draft, [])))),
        sentenceVector: round(queries.get(norm(sentences.get(draft.pseudonym)!))),
      })),
      tokens: Object.fromEntries([...tokenRows].map(([t, r]) => [t, { labelEn: r.labelEn, isco: r.iscoCode }])),
      decisions,
      clef: clefLog,
      asked,
      thought: thought.map((t) => ({ raw: t.d.raw, kind: t.d.kind, lang: t.d.lang, decision: t.d.decision, pick: t.pick, ms: t.ms, usage: t.usage, text: t.text })),
      agreed: agreed.map((t) => ({ raw: t.d.raw, kind: t.d.kind, lang: t.d.lang, token: t.d.token, pick: t.pick, ms: t.ms, usage: t.usage })),
    };
    const dataFile = join(outDir, `${date}-n${picked.length}-seed${seed}.json`);
    writeFileSync(dataFile, JSON.stringify(data));
    process.stdout.write(`wrote ${dataFile}\n`);
    expect(published.filter((p) => p.ok).length).toBeGreaterThan(0);
  }, 3 * 60 * 60 * 1000);
});
