// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Work pipeline on real vacancies (opt-in: JOBS_EVAL=1), from the Mac:
 * the engine v2 settings measured on job ads JobSpy pulled from Indeed
 * (`scripts/work/jobspy-pull.py`) in the three launch markets, under an index
 * generation of EmbeddingGemma 2 at 768 (the phone's embeddings): the v2
 * generation, the LiteRT-LM file the phone runs, when JOBS_LITERT_FILE names
 * the local `.litertlm`, else the GGUF the runs of 2026-10-27 measured; with
 * the real hosted models (the extractor, Clef, the pivot, the intent parse)
 * over the Workers AI REST API.
 *
 * Each sampled vacancy is both sides of the market. As a listing: its
 * description, de-identified like the phone would (emails, links, phone
 * numbers and handles as placeholders, then the plane's own tripwire), is
 * cut into an experience block (the title and the duties), a skills block
 * (the requirements) and a certificates block (the lines that name a licence
 * or a course), each extracted on `work-extract`; the title, the skills and
 * the certificates then publish through `publishListing`, snapping against a
 * replica of the registry (the ESCO import's SQL and the US layer's SQL in
 * node:sqlite, no certificate token; the generation's label vectors in memory,
 * VECTORS_DIR, or V3_DIR for the GGUF's) with the vectors the same model makes
 * on the Mac, as the phone does. As a hirer: the title and
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
 *     VECTORS_DIR=~/Development/esco/import/registry-embeddinggemma-2-litert \
 *     JOBS_LITERT_FILE=~/models/embeddinggemma-2-litert/embeddinggemma-2-text-270m.litertlm \
 *     direnv exec .. yarn vitest run test/workJobs.eval.test.ts
 *
 * The label files must be the model's own generation (`GENERATION_OF_MODEL`),
 * and the model must have its own τ (`DEFAULT_TAU_BY_MODEL`): the run stops
 * otherwise.
 *
 * JOBS_N vacancies (default 300; half from the US, a quarter each from
 * Brazil and Mexico), JOBS_SEED the sample's seed, JOBS_THINK the undecided
 * strings re-asked (default 120; 0 asks the Thinking model nothing),
 * JOBS_PARALLEL hosted calls at once (default 4) and JOBS_THINK_PARALLEL for
 * the reasoning model (default 2, one retry). WORK_PIVOT_BAND=1 puts the
 * English pivot in the band, as the plane's variable does. Needs
 * CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.
 *
 * JOBS_ARMS (default `market`) snaps the sample in arms, on one extraction
 * and one set of vectors (`test/work-eval/localeArms.ts`): `market` is
 * production, where a worker's titles and skills snap with their listing's
 * region; `language` takes that market out of what Clef's band state and the
 * pivot's message say of a string, as production says it of a string with no
 * market (workspace `docs/product/engine.md`, Token registry, "What the model
 * steps are told"). Only the eval switches it, on the requests' way out. Each
 * arm publishes against a fresh replica and writes its own report and data
 * (`-<arm>` after the seed, unless production runs alone). With both arms
 * (`JOBS_ARMS=market,language`) the run also writes
 * `test/work-eval/jobs-locale-<date>-n<N>-seed<seed>.md`: Clef's answers on
 * the bands both arms showed it, the snaps side by side per kind and
 * language, the titles against the search term that found their ad, recall
 * by ISCO relation, the pivot's English names, and the strings whose snaps
 * differ, judged by the Thinking model with the ad's own words (JOBS_JUDGE of
 * them, default 400; 0 judges none) and counted by cause (`causeOf`) with a
 * sign test. In every arm a band call (Clef's, the pivot's) that throws is
 * tried again, twice at most, unless the registry cancelled it
 * (`withBandRetries`): transient errors strike the arms unevenly, since they
 * run one after the other, and a string whose call failed all three tries in
 * either arm, or that Clef answered with nothing, is left out of the judge.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInference, type Inference } from '../src/services/inference/index.js';
import { BLOCK_MAX_CHARS, checkBlock, scanText, type BlockLang, type DeidentifiedBlock } from '../src/services/work/blocks.js';
import { adjudicationState } from '../src/services/work/clef.js';
import { extractBlock } from '../src/services/work/executor.js';
import { list, readFieldsAnswer, str, type WorkCall } from '../src/services/work/fields.js';
import { hirerQuery, type HireDeps } from '../src/services/work/hire.js';
import { claimKey, D1ListingStore, listingText, publishListing, type ClaimVectors, type ListingDraft, type PublishDeps } from '../src/services/work/listings.js';
import { callCostMicroUsd } from '../src/services/work/meter.js';
import { tier2FloorFor } from '../src/services/work/recall.js';
import { DEFAULT_TAU_BY_MODEL, EMBEDDINGGEMMA_2_GGUF, EMBEDDINGGEMMA_2_LITERT, labelLangs, labelNorm, PIVOT_FIELDS, tauFor, validPivot, type RegistryDeps, type SnapRecord, type TokenKind, type VectorIndex } from '../src/services/work/registry.js';
import { createRestAi } from './chat-eval/restAi.js';
import { memoryIndex } from './fixtures/work/fakes.js';
import {
  armsOf,
  bandKey,
  CAUSES,
  causeOf,
  judgeMessages,
  judgePick,
  marketPhrases,
  namesMarket,
  signTest,
  stringKey,
  termRelation,
  withBandRetries,
  withoutMarket,
  type Arm,
  type ArmSnap,
  type Cause,
  type Relation,
} from './work-eval/localeArms.js';
import { embedAll, GENERATION_OF_MODEL, loadReplica, ReplicaIndex } from './work-eval/replica.js';

const RUN = process.env.JOBS_EVAL === '1';
const home = (p: string) => p.replace(/^~(?=\/)/, homedir());
/** The v2 generation's LiteRT-LM file, when the run names it; else the GGUF. */
const LITERT_FILE = process.env.JOBS_LITERT_FILE ? home(process.env.JOBS_LITERT_FILE) : '';
const MODEL = LITERT_FILE ? EMBEDDINGGEMMA_2_LITERT : EMBEDDINGGEMMA_2_GGUF;
const EMBEDDER = LITERT_FILE ? "LiteRT-LM on the Mac's CPU" : 'llama-embedding';
const DIMS = 768;

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

/** A country's code, the region of an ad whose query location `REGIONS` does not map. */
const COUNTRY_REGION: Record<Vacancy['country'], string> = { usa: 'us', brazil: 'br', mexico: 'mx' };

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

const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
const cosine = (a: readonly number[], b: readonly number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

// ── Relations by ISCO ──────────────────────────────────────────────────────

function relation(a: string | null, b: string | null): Relation | null {
  if (!a || !b) return null;
  if (a === b) return 'right';
  if (a.slice(0, 3) === b.slice(0, 3)) return 'near';
  if (a.slice(0, 2) === b.slice(0, 2)) return 'industry';
  return 'far';
}

const RELATIONS = ['right', 'near', 'industry', 'far'] as const;

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
/** The Thinking model's cost, in micro-dollars: $0.30 a million tokens in, $1.20 out. */
const reasoningCost = (u: { tokensIn: number; tokensOut: number }) => u.tokensIn * 0.3 + u.tokensOut * 1.2;

interface Decision {
  /** When the snap started (`created_at`) and when it recorded this decision (ms; null if the eval did not see it end). */
  at: number;
  end: number | null;
  kind: TokenKind;
  raw: string;
  lang: string;
  decision: string;
  token: string | null;
  score: number | null;
  probability: number | null;
  /** The nearest candidates with their cosines; with the pivot in the band, its token after them, with the English name. */
  candidates: { token: string; score?: number; pivot?: string }[];
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

// ── An arm's record ────────────────────────────────────────────────────────

/** When a hosted call ran: while the listings published (the worker's snaps), or during the hirer queries. */
type Phase = 'publish' | 'hire';

/** One Clef call in the registry's band, as the arm sent it. */
interface ClefEntry {
  phase: Phase;
  /** When the call was first sent (ms): a string's first answer is the one first asked, retries left out. */
  startedAt: number;
  /** The state's first line: the kind and the locale, as sent. */
  head: string;
  /** The state's last line: the string. */
  raw: string;
  /** The string as the arms compare it (`stringKey`). */
  key: string | null;
  /** The band's entries by key, as sent: each token's English name and the label that brought it. */
  entries: Record<string, string>;
  choice: string | null;
  probabilities: Record<string, number>;
}

/** A band call (Clef's or the pivot's) that still failed on its third try, which the registry read as no answer. */
interface BandFailure {
  phase: Phase;
  /** When the call was first sent (ms). */
  startedAt: number;
  op: string;
  /** The string it was about (`stringKey`). */
  key: string | null;
  error: string;
}

/** One answer of the pivot, as the arm asked it: the English name, or null when it named nothing valid. */
interface PivotEntry {
  phase: Phase;
  /** When the call was first sent (ms), as for Clef's. */
  startedAt: number;
  key: string | null;
  english: string | null;
}

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

/** What an arm leaves for the comparison of arms. */
interface ArmRun {
  arm: Arm;
  /** Every decision the arm's registry recorded, the worker's snaps first. */
  decisions: Decision[];
  /** How many of them are the worker's: recorded while the listings published, before any hirer query. */
  workerDecisions: number;
  clefLog: ClefEntry[];
  pivots: PivotEntry[];
  /** The band calls that failed three times, and how many tries the band calls took again, by phase. */
  failures: BandFailure[];
  retried: Record<Phase, number>;
  /** Each vacancy's title token, by pseudonym. */
  titleToken: Map<string, string | null>;
  /** Every token the arm reached or showed Clef, with its English name and ISCO code (a mint's has none). */
  tokens: Map<string, { labelEn: string; isco: string | null }>;
  asked: Asked[];
  costs: { publish: number; hire: number; think: number };
  seconds: number;
  /** The requests whose worker's market the language arm took out. */
  rewritten: number;
}

describe.skipIf(!RUN)('the Work pipeline on real vacancies (opt-in, from the Mac)', () => {
  it('extracts, publishes, queries and measures a sample of job ads', async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const jobsDir = home(process.env.JOBS_DIR ?? '');
    const escoSql = home(process.env.ESCO_SQL ?? '');
    const usSql = home(process.env.US_SQL ?? '');
    const vectorsDir = home(process.env.VECTORS_DIR ?? process.env.V3_DIR ?? '');
    if (!accountId || !token || !jobsDir || !escoSql || !usSql || !vectorsDir) throw new Error('JOBS_EVAL needs JOBS_DIR, ESCO_SQL, US_SQL, VECTORS_DIR (or V3_DIR), CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    if (!(MODEL in DEFAULT_TAU_BY_MODEL)) throw new Error(`${MODEL} has no τ of its own yet (DEFAULT_TAU_BY_MODEL): measure it (test/registry.tau.test.ts) before this run`);
    const n = Number(process.env.JOBS_N ?? 300);
    const seed = Number(process.env.JOBS_SEED ?? 68);
    const thinkN = Number(process.env.JOBS_THINK ?? 120);
    const parallelN = Number(process.env.JOBS_PARALLEL ?? 4);
    const thinkParallel = Number(process.env.JOBS_THINK_PARALLEL ?? 2);
    const judgeN = Number(process.env.JOBS_JUDGE ?? 400);
    const arms = armsOf(process.env.JOBS_ARMS);
    const pivotBand = process.env.WORK_PIVOT_BAND === '1';
    const outDir = home(process.env.JOBS_OUT ?? join(jobsDir, '..', '..', 'runs'));
    const started = Date.now();
    const date = new Date().toISOString().slice(0, 10);
    /**
     * What a run's files are named after, so runs on one day, sample and seed never overwrite each other: a generation
     * other than the GGUF's (`-v2`), the pivot in the band (`-pivot-band`), and an arm's name unless production runs alone.
     */
    const runName = `${MODEL === EMBEDDINGGEMMA_2_GGUF ? '' : `-${GENERATION_OF_MODEL[MODEL]}`}${pivotBand ? '-pivot-band' : ''}`;
    const suffix = (arm: Arm) => `${runName}${arms.length > 1 || arm !== 'market' ? `-${arm}` : ''}`;

    // The sample.
    const all = readVacancies(jobsDir);
    const picked = sample(all, n, seed);
    const byCountry = (vs: Vacancy[]) => (['usa', 'brazil', 'mexico'] as const).map((c) => `${c} ${vs.filter((v) => v.country === c).length}`).join(', ');
    process.stdout.write(`${all.length} vacancies (${byCountry(all)}); sampled ${picked.length} (${byCountry(picked)}); arms ${arms.join(', ')}${pivotBand ? '; the pivot in the band' : ''}\n`);

    // The label vectors, one index every arm reads (each arm's own additions go when it ends), and the models.
    const t0 = Date.now();
    const index = ReplicaIndex.load(vectorsDir, MODEL);
    process.stdout.write(`index: ${index.size} ${index.generation} vectors, ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
    const ai = createRestAi({ accountId, token });
    const seam: Inference = createInference({ WORK_EMBED_MODEL: MODEL }, { ai })!;
    const tau = tauFor(MODEL);

    // 1. Blocks through the tripwire and the extractor, once for every arm.
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
        const r = await extractBlock(seam, checked.block as DeidentifiedBlock);
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
        region: REGIONS[e.v.queryLocation] ?? COUNTRY_REGION[e.v.country],
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
    const docs = embedAll([...drafts.map(({ draft }) => listingText(draft, [])), ...claimTexts], 'document', MODEL, LITERT_FILE || undefined);
    const queries = embedAll([...claimTexts, ...sentences.values()], 'query', MODEL, LITERT_FILE || undefined);
    const embeddedAt = Date.now();

    /** What production says of a worker's string in this sample's markets, and what it says with no market: the language arm's switch. */
    const phrases = marketPhrases(drafts.map(({ draft }) => ({ lang: draft.lang, region: draft.region })));

    // 3 to 6, and the arm's report, per arm.
    const runArm = async (arm: Arm): Promise<ArmRun> => {
      const armStarted = Date.now();
      const lines: string[] = [];
      const say = (l = '') => lines.push(l);
      const replica = await loadReplica(escoSql, usSql);
      process.stdout.write(`${arm}: replica ${replica.tokens} tokens, ${replica.labels} labels\n`);

      const clefLog: ClefEntry[] = [];
      const pivots: PivotEntry[] = [];
      const leaks: string[] = [];
      const failures: BandFailure[] = [];
      const retried: Record<Phase, number> = { publish: 0, hire: 0 };
      // The errors the retried tries met (a timeout, the API's status and code), each with how often.
      const retryErrors = new Map<string, number>();
      let rewritten = 0;
      let phase: Phase = 'publish';
      const pivotModel = await seam.model('work-pivot');
      const inference: Inference = {
        model: (op) => seam.model(op),
        async run(op, input, call) {
          // The language arm: the worker's market out of every request on its way out, so the rest runs as in production.
          let sent = input;
          if (arm === 'language') {
            sent = withoutMarket(input, phrases);
            if (namesMarket(input)) rewritten++;
            if (namesMarket(sent)) leaks.push(`${op}: ${cell(JSON.stringify(sent))}`);
          }
          // A band call (Clef's or the pivot's) that throws is tried again, twice at most, unless the registry cancelled it
          // (`withBandRetries`); one that fails three times fails in the registry too. Answers are paired with the snap that
          // asked by when the call started, retries left out.
          const startedAt = Date.now();
          const result = await withBandRetries(
            op,
            call,
            () => seam.run(op, sent, call),
            (error, final) => {
              if (final) failures.push({ phase, startedAt, op, key: bandKey(sent), error });
              else {
                retried[phase]++;
                retryErrors.set(error, (retryErrors.get(error) ?? 0) + 1);
              }
            },
          );
          if (op === 'work-adjudicate' && typeof sent.state === 'string') {
            const a = (result as { answers?: { match?: { choice?: unknown; probabilities?: Record<string, unknown> } } } | null)?.answers?.match;
            const probabilities: Record<string, number> = {};
            for (const [k, v] of Object.entries(a?.probabilities ?? {})) if (typeof v === 'number') probabilities[k] = v;
            const stateLines = sent.state.split('\n');
            const criteria = (sent.questions as { match?: { criteria?: Record<string, string> } } | undefined)?.match?.criteria ?? {};
            clefLog.push({ phase, startedAt, head: stateLines[0] ?? '', raw: stateLines[stateLines.length - 1] ?? '', key: bandKey(sent.state), entries: { ...criteria }, choice: typeof a?.choice === 'string' ? a.choice : null, probabilities });
          }
          if (op === 'work-pivot') {
            const read = readFieldsAnswer(pivotModel, PIVOT_FIELDS, result);
            const english = read.ok ? read.fields.english?.value : null;
            pivots.push({ phase, startedAt, key: bandKey(sent), english: typeof english === 'string' ? validPivot(english) : null });
          }
          return result;
        },
      };
      // The arm's own vectors (mints) leave the shared index when it ends, so the next arm starts from the registry as loaded.
      const added = new Set<string>();
      const armIndex: VectorIndex = {
        query: (vector, opts) => index.query(vector, opts),
        async upsert(vectors) {
          for (const v of vectors) added.add(v.id);
          await index.upsert(vectors);
        },
        async deleteByIds(ids) {
          for (const id of ids) added.delete(id);
          await index.deleteByIds(ids);
        },
      };
      // When each snap ended, by its decision's id: from its start (`created_at`) to then is the span its band calls fall in.
      const endedAt = new Map<string, number>();
      const store = new Proxy(replica.store, {
        get(target, prop, receiver) {
          if (prop === 'recordDecision') {
            return (r: SnapRecord) => {
              endedAt.set(r.id, Date.now());
              return target.recordDecision(r);
            };
          }
          const value: unknown = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
      const registry: RegistryDeps = { inference, store, index: armIndex, ...(pivotBand ? { pivotBand: true } : {}) };
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
      const queriesBefore = { ...index.queries };

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
        if (++publishedCount % 25 === 0) process.stdout.write(`${arm}: published ${publishedCount} of ${drafts.length}, ${((Date.now() - started) / 1000).toFixed(0)} s\n`);
        return { draft, ok: out.ok, error: out.ok ? null : out.error, tokens: out.ok ? out.tokens : [], calls: out.calls, ms: Date.now() - t1, listingId: out.ok ? out.listingId : null };
      });
      const publishCost = cost(published.flatMap((p) => p.calls));
      if (leaks.length) throw new Error(`the language arm sent a worker's market in ${leaks.length} requests: ${leaks.slice(0, 3).join('; ')}`);
      const workerDecisions = (replica.db.sqlite.prepare('SELECT COUNT(*) AS n FROM registry_decisions').get() as { n: number }).n;
      phase = 'hire';

      // The snaps, as the registry recorded them: the hirer's come after every listing's.
      const decisions = (replica.db.sqlite.prepare('SELECT id, created_at, kind, raw, lang, decision, token, score, probability, candidates, model FROM registry_decisions ORDER BY created_at, rowid').all() as Record<string, unknown>[]).map(
        (r): Decision => ({
          at: Number(r.created_at),
          end: endedAt.get(String(r.id)) ?? null,
          kind: r.kind as TokenKind,
          raw: String(r.raw),
          lang: String(r.lang),
          decision: String(r.decision),
          token: (r.token as string | null) ?? null,
          score: (r.score as number | null) ?? null,
          probability: (r.probability as number | null) ?? null,
          candidates: JSON.parse(String(r.candidates ?? '[]')) as Decision['candidates'],
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
        if (++askedCount % 25 === 0) process.stdout.write(`${arm}: asked ${askedCount} of ${drafts.length}, ${((Date.now() - started) / 1000).toFixed(0)} s\n`);
        return a;
      });
      const hireCost = cost(asked.flatMap((a) => a.calls));
      if (leaks.length) throw new Error(`the language arm sent a worker's market in ${leaks.length} requests: ${leaks.slice(0, 3).join('; ')}`);

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
      const thought = thinkN > 0 ? await parallel(shuffled(undecided, seed).slice(0, thinkN), thinkParallel, think) : [];
      const agreed = thinkN > 0 ? await parallel(shuffled(sure, seed).slice(0, Math.min(60, sure.length)), thinkParallel, think) : [];
      const thinkCost = [...thought, ...agreed].reduce((s, t) => s + reasoningCost(t.usage), 0);

      // ── The arm's report ─────────────────────────────────────────────────
      const armNote =
        arm === 'language'
          ? ' The **language** arm: production, except that the eval took the worker\'s market out of what Clef\'s band state and the pivot\'s message say of a string, as production says it with no market ("written in Portuguese by a worker or a hirer").'
          : arms.length > 1
            ? ' The **market** arm: production, where a worker\'s titles and skills snap with their listing\'s region ("written in Brazilian Portuguese by a worker in Brazil (br-sp)").'
            : '';
      const armMinutes = ((embeddedAt - started + Date.now() - armStarted) / 60_000).toFixed(1);
      const queriesRun = index.queries.count - queriesBefore.count;
      say(`# The Work pipeline on real vacancies, ${MODEL} at ${DIMS}, ${date}${arms.length > 1 || arm !== 'market' ? `, the ${arm} arm` : ''}`);
      say();
      say(`${picked.length} vacancies sampled (seed ${seed}) from ${all.length} JobSpy pulled from Indeed (${byCountry(all)}), each both a listing and a hirer's sentence, through the real hosted models over the Workers AI REST API and the phone's embeddings from ${EMBEDDER} (${MODEL}, ${DIMS} wide), against a replica of the registry: ${replica.tokens} tokens and ${replica.labels} labels (ESCO and the US layer; no certificate token), ${index.size} label vectors. τ ${tau.auto} and ${tau.low}${pivotBand ? '; the English pivot in the band (`WORK_PIVOT_BAND=1`)' : ''}.${armNote} ${armMinutes} minutes${arms.length > 1 ? ' (the extraction and the embeddings, which every arm shares, then this arm)' : ''}; hosted cost ${usd(extractCost + publishCost + hireCost + thinkCost)} (extraction ${usd(extractCost)}, publishing ${usd(publishCost)}, hirer queries ${usd(hireCost)}, the Thinking re-asks ${usd(thinkCost)}).`);
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
      say(`${published.filter((p) => p.ok).length} of ${published.length} listings published${published.some((p) => !p.ok) ? ` (${published.filter((p) => !p.ok).map((p) => p.error).join(', ')})` : ''}, ${published.reduce((s, p) => s + p.tokens.length, 0)} tokens in all, ${mean(published.map((p) => p.ms / 1000), 1)} s each on average; ${queriesRun} index queries, ${((index.queries.ms - queriesBefore.ms) / Math.max(1, queriesRun)).toFixed(0)} ms each. Strings that met an exact label leave no decision; the table counts the rest.`);
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
      say(`Clef in the band: ${decisions.filter((d) => d.model?.includes('clef')).length} calls; ${undecided.length} strings Clef left undecided with candidates at or above τ_low (none, below its floor, or no answer); the exact-label and auto paths need no model. Retries of band calls (Clef's, the pivot's) after an error: ${retried.publish + retried.hire}${retryErrors.size ? ` (${[...retryErrors].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([e, k]) => `${k} × ${cell(e)}`).join('; ')})` : ''}; failed all three tries, which the registry read as no answer: ${failures.length}.${arm === 'language' ? ` The language arm took the market out of ${rewritten} requests.` : ''}`);
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
      const relShare = (fs: typeof fin) => RELATIONS.map((r) => `${r} ${pct(fs.filter((f) => f.rel === r).length, fs.filter((f) => f.rel).length)}`).join(', ');
      say(`Recall over the other vacancies in the sentence's region: ${mean(okAsked.map((a) => a.recalled), 1)} recalled and ${mean(okAsked.map((a) => a.finalists.length), 1)} finalists a query; ${okAsked.filter((a) => a.finalists.length === 0).length} queries with none. Tier 1 (through the token gate): ${tier(1).length} finalists, by relation ${relShare(tier(1))}. Tier 2 (a token miss at cosine ${tier2FloorFor(MODEL)} or more, the model's floor): ${tier(2).length}, by relation ${relShare(tier(2))}. A finalist whose title or the query's did not snap to a token with an ISCO code has no relation and is left out of the shares.`);
      say();
      say('## The tier-2 floor on real pairs');
      say();
      say(`${labelled} sentences whose title snapped to a token with an ISCO code, each against every other vacancy's listing vector (all regions), by relation: cosine, mean (5th to 95th percentile, min, max).`);
      say();
      say('| Relation | Pairs | Cosine | Pairs, same region | Cosine, same region |');
      say('|---|---|---|---|---|');
      for (const r of RELATIONS) say(`| ${r} | ${pairs[r].length} | ${stats(pairs[r])} | ${sameRegionPairs[r].length} | ${stats(sameRegionPairs[r])} |`);
      say();
      say('| Floor | Right kept | Near kept | Industry admitted | Far admitted |');
      say('|---|---|---|---|---|');
      for (const f of [0.5, 0.55, 0.6, 0.62, 0.64, 0.65, 0.66, 0.67, 0.68, 0.69, 0.7, 0.72, 0.74, 0.76, 0.78, 0.8]) {
        const at = (xs: number[]) => xs.filter((x) => x >= f).length;
        say(`| ${f} | ${pct(at(pairs.right), pairs.right.length)} | ${pct(at(pairs.near), pairs.near.length)} | ${pct(at(pairs.industry), pairs.industry.length)} | ${pct(at(pairs.far), pairs.far.length)} |`);
      }
      say();
      say("## The fast lane: the vector ranking alone, in the sentence's region");
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
      say("## Clef's floor, from its own probabilities");
      say();
      say(`${loosened.length} undecided occupation and skill strings with Clef's answer on record: the mass Clef put on none ${stats(loosened.map((l) => l.none))}, on its best candidate ${stats(loosened.map((l) => l.top?.p ?? 0))}, on all candidates together ${stats(loosened.map((l) => l.mass))}. A rule that takes the best candidate when none holds at most ${RULE.noneMax} and the best at least ${RULE.topMin} (the US layer's reading of Clef, \`ONET_NONE_MAX\`) would take ${converted.length} of them (${pct(converted.length, loosened.length)}); a random 40, for the eye:`);
      say();
      say('| String | Kind | Lang | none | Best (p) | Then |');
      say('|---|---|---|---|---|---|');
      for (const l of shuffled(converted, seed).slice(0, 40)) {
        const c = clefOf(l.d.raw)!;
        const second = Object.entries(c.probabilities)
          .filter(([k]) => k !== 'none' && k !== l.top!.key)
          .sort((a, b) => b[1] - a[1])[0];
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
      if (thinkN > 0) {
        say(`${thought.length} of the ${undecided.length} undecided strings re-asked of the Thinking model (DeepSeek V4.1 Flash, low effort, no Clef): ${tp.answered} answered, ${tp.candidate} chose a candidate, ${tp.none} chose none; ${mean(thought.map((t) => t.ms / 1000), 1)} s a call, ${mean(thought.map((t) => t.usage.tokensOut), 0)} output tokens. Where Clef was sure (${agreed.length} of its choices at p ≥ 0.5): the Thinking model agreed on ${agreed.filter((t) => t.pick && t.d.candidates[Number(t.pick.slice(1))]?.token === t.d.token).length}, chose another candidate on ${agreed.filter((t) => t.pick && t.pick !== 'none' && t.d.candidates[Number(t.pick.slice(1))]?.token !== t.d.token).length}, none on ${agreed.filter((t) => t.pick === 'none').length}.`);
        say();
        say('| String | Kind | Lang | Clef decision | Clef p | Candidates (best first) | Thinking pick |');
        say('|---|---|---|---|---|---|---|');
        for (const t of thought) {
          const cands = t.d.candidates.map((c, i) => `c${i} ${cell(labelsByToken.get(c.token) ?? c.token)} ${f3(c.score)}`).join('; ');
          const pick = t.pick && t.pick !== 'none' ? `${t.pick} ${cell(labelsByToken.get(t.d.candidates[Number(t.pick.slice(1))]?.token ?? '') ?? '?')}` : (t.pick ?? `no pick: ${cell(t.text)}`);
          say(`| ${cell(t.d.raw)} | ${t.d.kind} | ${t.d.lang} | ${t.d.decision} | ${f3(t.d.probability)} | ${cands} | ${pick} |`);
        }
      } else {
        say('Not asked in this run (`JOBS_THINK=0`).');
      }
      say();
      const file = join('test', 'work-eval', `jobs-${date}-n${picked.length}-seed${seed}${suffix(arm)}.md`);
      writeFileSync(file, lines.join('\n') + '\n');
      process.stdout.write(`wrote ${file}\n`);
      mkdirSync(outDir, { recursive: true });
      const round = (v: number[] | undefined) => v?.map((x) => Math.round(x * 1e5) / 1e5);
      const data = {
        model: MODEL,
        dims: DIMS,
        seed,
        date,
        arm,
        pivotBand,
        tau,
        vacancies: drafts.map(({ e, draft }) => ({
          pseudonym: draft.pseudonym,
          id: e.v.id,
          country: e.v.country,
          term: e.v.term,
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
        workerDecisions,
        clef: clefLog,
        pivots,
        failures,
        retried,
        retryErrors: Object.fromEntries(retryErrors),
        asked,
        thought: thought.map((t) => ({ raw: t.d.raw, kind: t.d.kind, lang: t.d.lang, decision: t.d.decision, pick: t.pick, ms: t.ms, usage: t.usage, text: t.text })),
        agreed: agreed.map((t) => ({ raw: t.d.raw, kind: t.d.kind, lang: t.d.lang, token: t.d.token, pick: t.pick, ms: t.ms, usage: t.usage })),
      };
      const dataFile = join(outDir, `${date}-n${picked.length}-seed${seed}${suffix(arm)}.json`);
      writeFileSync(dataFile, JSON.stringify(data));
      process.stdout.write(`wrote ${dataFile}\n`);
      expect(published.filter((p) => p.ok).length).toBeGreaterThan(0);

      // The arm's mints leave the index the next arm reads.
      await index.deleteByIds([...added]);
      const tokens = new Map([...tokenRows].map(([t, r]) => [t, { labelEn: r.labelEn, isco: r.iscoCode }]));
      return { arm, decisions, workerDecisions, clefLog, pivots, failures, retried, titleToken, tokens, asked, costs: { publish: publishCost, hire: hireCost, think: thinkCost }, seconds: (Date.now() - armStarted) / 1000, rewritten };
    };

    const runs: ArmRun[] = [];
    for (const arm of arms) runs.push(await runArm(arm));
    if (runs.length < 2) return;

    // ── Both arms: what the worker's market in the model steps changes ─────
    // By name, whatever order JOBS_ARMS gave them in: `a` is production's, `b` the language arm.
    const a = runs.find((r) => r.arm === 'market');
    const b = runs.find((r) => r.arm === 'language');
    if (!a || !b) throw new Error(`a comparison needs both arms, not ${runs.map((r) => r.arm).join(' and ')}`);
    const lines: string[] = [];
    const say = (l = '') => lines.push(l);
    const tokenInfo = new Map([...b.tokens, ...a.tokens]);
    const labelOf = (t: string | null) => (t ? (tokenInfo.get(t)?.labelEn ?? t) : '—');
    const iscoOfToken = (t: string | null) => (t ? (tokenInfo.get(t)?.isco ?? null) : null);
    const both = <T>(f: (r: ArmRun) => T): [T, T] => [f(a), f(b)];
    const pair = (x: string | number, y: string | number) => `${x} / ${y}`;

    // Where each string first occurs among the drafts, for its context: the ad, its region.
    const contextOf = new Map<string, { e: Extracted; draft: ListingDraft }>();
    for (const x of drafts) {
      for (const [kind, texts] of [
        ['pos', x.draft.titles],
        ['skill', x.draft.skills],
        ['cert', x.draft.certificates],
      ] as const) {
        for (const t of texts) {
          const k = stringKey(kind, x.draft.lang, t);
          if (!contextOf.has(k)) contextOf.set(k, x);
        }
      }
    }
    const countryOf = (k: string) => contextOf.get(k)?.e.v.country ?? '?';

    /**
     * The worker's snaps: each string's first snap in each arm, with the band calls it made: the string's calls first sent
     * within the snap's span, from its start (`created_at`) to its decision's record, so a later snap's answers, a retry's
     * late end and another listing's snap of the string are never read as its own. When a second snap of the string
     * started before the first ended (two listings at once), which answers were the first's is unknown: `overlapped`.
     */
    interface FirstSnap {
      d: Decision;
      clef?: ClefEntry;
      pivot?: PivotEntry;
      failed: boolean;
      overlapped: boolean;
    }
    const firstSnaps = (r: ArmRun): Map<string, FirstSnap> => {
      const byKey = <T extends { phase: Phase; key: string | null }>(xs: readonly T[]) => {
        const m = new Map<string, T[]>();
        for (const x of xs) if (x.phase === 'publish' && x.key) (m.get(x.key) ?? m.set(x.key, []).get(x.key)!).push(x);
        return m;
      };
      const [clefs, names, failed] = [byKey(r.clefLog), byKey(r.pivots), byKey(r.failures)];
      const snaps = new Map<string, Decision[]>();
      for (const d of r.decisions.slice(0, r.workerDecisions)) {
        const k = stringKey(d.kind, d.lang, d.raw);
        (snaps.get(k) ?? snaps.set(k, []).get(k)!).push(d);
      }
      const out = new Map<string, FirstSnap>();
      for (const [k, ds] of snaps) {
        const d = ds[0]!;
        const end = d.end ?? Infinity;
        const within = <T extends { startedAt: number }>(xs: readonly T[] | undefined) => (xs ?? []).filter((x) => x.startedAt >= d.at && x.startedAt <= end).sort((x, y) => x.startedAt - y.startedAt)[0];
        out.set(k, { d, clef: within(clefs.get(k)), pivot: within(names.get(k)), failed: within(failed.get(k)) != null, overlapped: ds[1] != null && ds[1].at <= end });
      }
      return out;
    };
    const [sa, sb] = both(firstSnaps);
    /** One part of each string's first snap, where it has one. */
    const partOf = <T>(snaps: Map<string, FirstSnap>, f: (s: FirstSnap) => T | undefined) => {
      const out = new Map<string, T>();
      for (const [k, s] of snaps) {
        const v = f(s);
        if (v !== undefined) out.set(k, v);
      }
      return out;
    };
    const [fa, fb] = [partOf(sa, (s) => s.d), partOf(sb, (s) => s.d)];
    const keys = [...new Set([...fa.keys(), ...fb.keys()])];
    const shared = keys.filter((k) => fa.has(k) && fb.has(k));
    const differing = shared.filter((k) => fa.get(k)!.token !== fb.get(k)!.token);

    // Clef's answers on the bands both arms showed it, each string's first snap in each: the same entries, the state's market the only difference.
    const [ca, cb] = [partOf(sa, (s) => s.clef), partOf(sb, (s) => s.clef)];
    const bandKeys = [...ca.keys()].filter((k) => cb.has(k));
    const sameBand = bandKeys.filter((k) => JSON.stringify(ca.get(k)!.entries) === JSON.stringify(cb.get(k)!.entries));
    const pOf = (c: ClefEntry) => (c.choice ? (c.probabilities[c.choice] ?? 0) : 0);
    const picked50 = (c: ClefEntry, floor = 0.5) => c.choice != null && c.choice !== 'none' && pOf(c) >= floor;
    const none50 = (c: ClefEntry, floor = 0.5) => c.choice === 'none' && pOf(c) >= floor;
    const topCandidate = (c: ClefEntry) => Math.max(0, ...Object.entries(c.probabilities).filter(([k]) => k !== 'none').map(([, p]) => p));
    /** What an answer does at the shipped floor: a candidate by key, none, or neither (below the floor, or no answer). */
    const outcome = (c: ClefEntry) => (picked50(c) ? c.choice! : none50(c) ? 'none' : 'neither');

    // The pivot's English names, where both arms asked it for the same string in its first snap.
    const [pa, pb] = [partOf(sa, (s) => s.pivot), partOf(sb, (s) => s.pivot)];
    const pivotBoth = [...pa.keys()].filter((k) => pb.has(k));
    const pivotDiffer = pivotBoth.filter((k) => pa.get(k)!.english !== pb.get(k)!.english);

    // Why each string's snaps differ (`causeOf`): a failed call, an overlap, the registry, Clef's answer, the pivot's name, or both.
    const snapOf = ({ d, clef, pivot, failed, overlapped }: FirstSnap): ArmSnap => ({
      decision: d.decision,
      token: d.token,
      nearest: d.candidates.filter((c) => c.pivot == null).map((c) => c.token),
      clef: clef ? { entries: JSON.stringify(clef.entries), outcome: outcome(clef) } : null,
      pivot: pivot ? { english: pivot.english } : null,
      // Clef's answer with no probabilities is no answer to the registry, as a failed call is.
      failed: failed || (clef != null && Object.keys(clef.probabilities).length === 0),
      overlapped,
    });
    const causes = new Map<string, Cause>(differing.map((k) => [k, causeOf(snapOf(sa.get(k)!), snapOf(sb.get(k)!))]));
    /** The strings whose snaps differ for a reason the market can be behind: what the judge reads. */
    const differ = differing.filter((k) => causes.get(k) !== 'failed');

    // The judge: the strings whose snaps differ, with the ad's own words, every token either arm reached by English name only.
    interface Judged {
      key: string;
      tokens: string[];
      /** The token the judge picked, `none` (no token is `kind:…`), or null without an answer. */
      pick: string | null;
      reason: string;
      usage: { tokensIn: number; tokensOut: number };
    }
    /**
     * The ad's own words around the string's first occurrence (else the block it was most likely read from), de-identified,
     * and only as the plane's tripwire passes them, as every other hosted call here is: empty when it refuses them.
     */
    const judgeExcerpt = (raw: string, kind: TokenKind, e: Extracted): string => {
      const text = deidentify(e.v.description);
      // The first whole-word occurrence: "CAD" is not the start of "cadastro".
      const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      const at = text.search(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu'));
      let around: string;
      if (at >= 0) {
        const start = Math.max(0, at - 400);
        around = text.slice(start, at + raw.length + 400);
        if (start > 0) around = around.replace(/^\S*\s+/, '');
      } else around = kind === 'pos' ? e.blocks.experience : (e.blocks.skills ?? e.blocks.experience);
      const excerpt = cut(around, 900);
      return checkBlock({ kind: 'experience', lang: e.v.lang, text: excerpt }).ok ? excerpt : '';
    };
    const judge = async (k: string): Promise<Judged> => {
      const da = fa.get(k)!;
      const db = fb.get(k)!;
      const ctx = contextOf.get(k);
      const tokens = [...new Set([...da.candidates.map((c) => c.token), ...db.candidates.map((c) => c.token), ...[da.token, db.token].filter((t): t is string => t != null)])].sort((x, y) => labelOf(x).localeCompare(labelOf(y)));
      const title = ctx ? cleanTitle(ctx.e.v.title) : '';
      const messages = judgeMessages({ kind: da.kind, raw: da.raw, lang: da.lang, region: ctx?.draft.region ?? '', title: title && !scanText(title) ? title : '', excerpt: ctx ? judgeExcerpt(da.raw, da.kind, ctx.e) : '', entries: tokens.map(labelOf) });
      // An answer that names no entry is asked once more; an error (Workers AI answers 429 when DeepSeek is busy) is tried
      // again after 5, 10 and 20 s. The reasoning counts against the completion budget, so it is wide.
      let failure = '';
      let unread = 0;
      const usage = { tokensIn: 0, tokensOut: 0 };
      for (let attempt = 0; attempt < 4 && unread < 2; attempt++) {
        try {
          const result = await seam.run('chat-reasoning', { messages, max_completion_tokens: 1_600, reasoning_effort: 'low' });
          const u = answerUsage(result);
          usage.tokensIn += u.tokensIn;
          usage.tokensOut += u.tokensOut;
          const read = judgePick(answerText(result), tokens.length);
          if (read.pick != null) return { key: k, tokens, pick: read.pick === 'none' ? 'none' : tokens[read.pick]!, reason: read.reason, usage };
          failure = `no pick: ${cell(answerText(result)) || 'empty answer'}`;
          unread++;
        } catch (err) {
          failure = `error: ${(err as Error).message.replace(/\s+/g, ' ').slice(0, 120)}`;
          if (attempt < 3) await new Promise((r) => setTimeout(r, 5_000 * 2 ** attempt));
        }
      }
      return { key: k, tokens, pick: null, reason: failure, usage };
    };
    const toJudge = shuffled(differ, seed).slice(0, Math.max(0, judgeN));
    const judged = await parallel(toJudge, thinkParallel, judge);
    const judgeCost = judged.reduce((s, j) => s + reasoningCost(j.usage), 0);
    const verdict = (armToken: string | null, pick: Judged['pick']): 'right' | 'wrong' | null => (pick == null ? null : pick === 'none' ? (armToken ? 'wrong' : 'right') : armToken === pick ? 'right' : 'wrong');

    say(`# Clef's market on real vacancies, ${MODEL} at ${DIMS}, ${date}`);
    say();
    say(
      `${picked.length} vacancies (seed ${seed}) from ${all.length} JobSpy pulled from Indeed (${byCountry(all)}), extracted once and embedded once (the phone's vectors from ${EMBEDDER}, ${MODEL}, ${DIMS} wide), then published and asked in two arms, each against a fresh replica of the registry (ESCO and the US layer, ${index.size} label vectors; τ ${tau.auto} and ${tau.low}${pivotBand ? '; the English pivot in the band' : ''}): **${a.arm}**, production, where a worker's titles and skills snap with their listing's region ("written in Brazilian Portuguese by a worker in Brazil (br-sp)"); **${b.arm}**, the same with the market out of Clef's band state and the pivot's message ("written in Portuguese by a worker or a hirer"), switched by the eval on the requests' way out (\`test/work-eval/localeArms.ts\`; ${b.rewritten} requests rewritten, none left naming a market). The eval changes no other request; the hirer's requests and the decision pass carry each arm's own tokens. ${((Date.now() - started) / 60_000).toFixed(1)} minutes in all; hosted cost ${usd(extractCost + a.costs.publish + a.costs.hire + a.costs.think + b.costs.publish + b.costs.hire + b.costs.think + judgeCost)} (the shared extraction ${usd(extractCost)}; publishing ${pair(usd(a.costs.publish), usd(b.costs.publish))}, hirer queries ${pair(usd(a.costs.hire), usd(b.costs.hire))}, Thinking re-asks ${pair(usd(a.costs.think), usd(b.costs.think))}, ${a.arm} / ${b.arm}; the judge ${usd(judgeCost)}). Each arm's own report: \`jobs-${date}-n${picked.length}-seed${seed}${runName}-${a.arm}.md\` and \`-${b.arm}.md\`. In every table, a pair of numbers is ${a.arm} / ${b.arm}.`,
    );
    say();
    say("## Clef on the same band");
    say();
    say(`${bandKeys.length} of the worker's strings (each by its exact spelling) reached Clef in both arms; for ${sameBand.length} of them Clef saw the same entries in the same order, so the state's market was the only difference in what it was asked. On those, the outcome at the floor is a candidate, none, or neither (below the floor, or no answer); the same outcome is the same candidate, or none in both, or neither in both:`);
    say();
    say('| Kind | Language | Strings | Picked a candidate at p ≥ 0.5 | None at p ≥ 0.5 | Below the floor or no answer | Picks at p ≥ 0.8 | Same outcome | Mean p on none | Mean p on the best candidate |');
    say('|---|---|---|---|---|---|---|---|---|---|');
    for (const kind of ['pos', 'skill', 'cert'] as const) {
      for (const lang of ['en', 'pt', 'es']) {
        const ks = sameBand.filter((k) => k.startsWith(`${kind}|${lang}|`));
        if (!ks.length) continue;
        const count = (m: Map<string, ClefEntry>, f: (c: ClefEntry) => boolean) => ks.filter((k) => f(m.get(k)!)).length;
        const meanOf = (m: Map<string, ClefEntry>, f: (c: ClefEntry) => number) => mean(ks.map((k) => f(m.get(k)!)), 3);
        const samePick = ks.filter((k) => outcome(ca.get(k)!) === outcome(cb.get(k)!)).length;
        say(
          `| ${kind} | ${lang} | ${ks.length} | ${pair(count(ca, (c) => picked50(c)), count(cb, (c) => picked50(c)))} | ${pair(count(ca, (c) => none50(c)), count(cb, (c) => none50(c)))} | ${pair(count(ca, (c) => !picked50(c) && !none50(c)), count(cb, (c) => !picked50(c) && !none50(c)))} | ${pair(count(ca, (c) => picked50(c, 0.8)), count(cb, (c) => picked50(c, 0.8)))} | ${samePick} | ${pair(meanOf(ca, (c) => c.probabilities.none ?? 0), meanOf(cb, (c) => c.probabilities.none ?? 0))} | ${pair(meanOf(ca, topCandidate), meanOf(cb, topCandidate))} |`,
        );
      }
    }
    say();
    say('The same answers read at other floors (the shipped floor is 0.5; 0.8 is where a band alias counts at once under decision 0067, rule 8):');
    say();
    say('| Floor | Picked a candidate | Picked the same candidate in both | None |');
    say('|---|---|---|---|');
    for (const floor of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
      const sameCandidate = sameBand.filter((k) => picked50(ca.get(k)!, floor) && picked50(cb.get(k)!, floor) && ca.get(k)!.choice === cb.get(k)!.choice).length;
      say(`| ${floor} | ${pair(sameBand.filter((k) => picked50(ca.get(k)!, floor)).length, sameBand.filter((k) => picked50(cb.get(k)!, floor)).length)} | ${sameCandidate} | ${pair(sameBand.filter((k) => none50(ca.get(k)!, floor)).length, sameBand.filter((k) => none50(cb.get(k)!, floor)).length)} |`);
    }
    say();
    const switched = sameBand.filter((k) => {
      const x = ca.get(k)!;
      const y = cb.get(k)!;
      return (picked50(x) || picked50(y)) && !(picked50(x) && picked50(y) && x.choice === y.choice);
    });
    // An entry by its token's English name, without the label that matched.
    const answerCell = (c: ClefEntry) => `${c.choice === 'none' ? 'none' : c.choice ? cell((c.entries[c.choice] ?? c.choice).replace(/ \(matched .*\)$/, '')) : 'no answer'} (${f3(pOf(c))})`;
    say(`Where one arm's answer took a candidate at the floor and the other's did not take the same one: ${switched.length} strings; ${switched.length > 60 ? 'a random 60' : 'all of them'}:`);
    say();
    say(`| String | Kind | Language | ${a.arm} | ${b.arm} |`);
    say('|---|---|---|---|---|');
    for (const k of shuffled(switched, seed).slice(0, 60)) {
      const x = ca.get(k)!;
      const [kind, lang] = k.split('|');
      say(`| ${cell(x.raw)} | ${kind} | ${lang} | ${answerCell(x)} | ${answerCell(cb.get(k)!)} |`);
    }
    say();
    say('## The snaps side by side');
    say();
    say(`The worker's snaps only (the hirer's words carry no market in either arm): each string's first decision, ${fa.size} / ${fb.size} strings. Strings that met an exact label leave no decision.`);
    say();
    say('| Kind | Language | Decisions | auto | chosen | pivot | minted | unmatched | Clef p on a choice, mean | Choices at p ≥ 0.8 |');
    say('|---|---|---|---|---|---|---|---|---|---|');
    for (const kind of ['pos', 'skill', 'cert'] as const) {
      for (const lang of ['en', 'pt', 'es']) {
        const [da, db] = both((r) => [...(r === a ? fa : fb).values()].filter((d) => d.kind === kind && d.lang === lang));
        if (!da.length && !db.length) continue;
        const share = (dec: string) => pair(pct(da.filter((d) => d.decision === dec).length, da.length), pct(db.filter((d) => d.decision === dec).length, db.length));
        const chosenP = (ds: Decision[]) => mean(ds.filter((d) => d.decision === 'chosen').map((d) => d.probability ?? 0), 3);
        const high = (ds: Decision[]) => ds.filter((d) => d.decision === 'chosen' && (d.probability ?? 0) >= 0.8).length;
        say(`| ${kind} | ${lang} | ${pair(da.length, db.length)} | ${share('auto')} | ${share('chosen')} | ${share('pivot')} | ${share('minted')} | ${share('unmatched')} | ${pair(chosenP(da), chosenP(db))} | ${pair(high(da), high(db))} |`);
      }
    }
    say();
    say('## Titles against the search term that found their ad');
    say();
    say(
      "Each ad was found by a search term (\"soldador\", \"truck driver\"), and the term names an occupation (`TERM_ISCO`). A title whose token falls in the term's ISCO unit groups is right, in their minor group near, in their sub-major group of the same industry, else far. The search also returns neighbouring jobs, the same in both arms, so this compares the arms, not their accuracy. The vacancy's title token is its first title's snap.",
    );
    say();
    say('| Country | Titles | right | near | industry | far | No ISCO code |');
    say('|---|---|---|---|---|---|---|');
    const termRel = (r: ArmRun, x: (typeof drafts)[number]) => termRelation(x.e.v.term, iscoOfToken(r.titleToken.get(x.draft.pseudonym) ?? null));
    for (const country of ['usa', 'brazil', 'mexico', 'all'] as const) {
      const xs = drafts.filter((x) => country === 'all' || x.e.v.country === country);
      const count = (r: ArmRun, rel: Relation | null) => xs.filter((x) => termRel(r, x) === rel).length;
      say(`| ${country} | ${xs.length} | ${RELATIONS.map((rel) => pair(count(a, rel), count(b, rel))).join(' | ')} | ${pair(count(a, null), count(b, null))} |`);
    }
    say();
    const titleMoved = drafts.filter((x) => (a.titleToken.get(x.draft.pseudonym) ?? null) !== (b.titleToken.get(x.draft.pseudonym) ?? null));
    say(`${titleMoved.length} vacancies' title tokens differ between the arms:`);
    say();
    say(`| Term | Title | Lang | ${a.arm} | ${b.arm} |`);
    say('|---|---|---|---|---|');
    for (const x of titleMoved) {
      const at = (r: ArmRun) => {
        const t = r.titleToken.get(x.draft.pseudonym) ?? null;
        return `${cell(labelOf(t))} (${termRel(r, x) ?? 'no ISCO'})`;
      };
      say(`| ${x.e.v.term} | ${cell(x.draft.titles[0] ?? '')} | ${x.draft.lang} | ${at(a)} | ${at(b)} |`);
    }
    say();
    say('## Recall by ISCO relation, the benchmark\'s own measure');
    say();
    say("Each hirer's sentence against the other vacancies in its region; a finalist's relation is between its title token and the query's, so each arm is measured against its own title snaps.");
    say();
    say('| Arm | Finalists a query | Queries with none | Tier 1 | right | near | industry | far | Tier 2 | right | near | industry | far |');
    say('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of runs) {
      const ok = r.asked.filter((x) => x.ok);
      const fs = ok.flatMap((x) => x.finalists);
      const tierCells = (t: 1 | 2) => {
        const ts = fs.filter((f) => f.tier === t);
        const withRel = ts.filter((f) => f.rel).length;
        return [String(ts.length), ...RELATIONS.map((rel) => pct(ts.filter((f) => f.rel === rel).length, withRel))].join(' | ');
      };
      say(`| ${r.arm} | ${mean(ok.map((x) => x.finalists.length), 1)} | ${ok.filter((x) => x.finalists.length === 0).length} | ${tierCells(1)} | ${tierCells(2)} |`);
    }
    say();
    say("## The pivot's English names");
    say();
    say(`The pivot answered for ${pivotBoth.length} of the worker's strings in both arms (below the band or on Clef's none, in any language${pivotBand ? '; and, in the band, for every Portuguese or Spanish occupation or skill that misses the exact label, a call a τ_auto take cancels answering nothing' : ''}); the English name differs for ${pivotDiffer.length}${pivotDiffer.length > 60 ? ', a random 60' : ''}:`);
    say();
    say(`| String | Kind | Language | ${a.arm} | ${b.arm} | Snap, ${a.arm} | Snap, ${b.arm} |`);
    say('|---|---|---|---|---|---|---|');
    for (const k of shuffled(pivotDiffer, seed).slice(0, 60)) {
      const [kind, lang] = k.split('|');
      const raw = fa.get(k)?.raw ?? fb.get(k)?.raw ?? k.split('|')[2]!;
      say(`| ${cell(raw)} | ${kind} | ${lang} | ${pa.get(k)!.english ?? '—'} | ${pb.get(k)!.english ?? '—'} | ${cell(labelOf(fa.get(k)?.token ?? null))} | ${cell(labelOf(fb.get(k)?.token ?? null))} |`);
    }
    say();
    say('## Where the snaps differ');
    say();
    say(
      `Of ${shared.length} strings the worker's snaps decided in both arms, ${differing.length} ended on a different token (or on a token in one arm and none in the other)${keys.length - shared.length ? `; ${keys.length - shared.length} were decided in one arm only, by an alias in the other` : ''}. ${differing.length > differ.length ? `${differing.length - differ.length} of them differ where a band call failed all three tries in either arm, or Clef answered nothing, which says nothing of the market: the judge leaves them out, and the table by cause counts them as failed` : 'None of them differ where a band call failed all three tries or Clef answered nothing'} (while the listings published: band calls that failed all three tries ${pair(...both((r) => r.failures.filter((f) => f.phase === 'publish').length))}, retries after an error ${pair(a.retried.publish, b.retried.publish)}, and Clef's answers with nothing in them ${pair(...both((r) => r.clefLog.filter((c) => c.phase === 'publish' && !Object.keys(c.probabilities).length).length))})${differing.some((k) => causes.get(k) === 'overlap') ? `; ${differing.filter((k) => causes.get(k) === 'overlap').length} differ where two snaps of the string ran at once in an arm, so their cause is unknown (judged, and counted apart below)` : ''}. ${judged.length} of the ${differ.length} left${judged.length < differ.length ? ` (a random ${judged.length})` : ''} went to a judge: the Thinking model (DeepSeek V4.1 Flash, low effort) with the ad's title and its own words around the string, de-identified, choosing among every token either arm reached for it, by English name only, or none, with Clef's question (the same thing, or the broader thing it specializes). An arm is right when it reached the judge's pick, or nothing when the judge chose none.`,
    );
    say();
    /** A row's counts: the strings that differ, those judged, each arm right (at most one is, the snaps differing), neither, the judge's none, no answer. */
    const verdictCounts = (dk: readonly string[], js: readonly Judged[]) => {
      const rightA = js.filter((j) => verdict(fa.get(j.key)!.token, j.pick) === 'right').length;
      const rightB = js.filter((j) => verdict(fb.get(j.key)!.token, j.pick) === 'right').length;
      const neither = js.filter((j) => verdict(fa.get(j.key)!.token, j.pick) === 'wrong' && verdict(fb.get(j.key)!.token, j.pick) === 'wrong').length;
      return { cells: `${dk.length} | ${js.length} | ${rightA} | ${rightB} | ${neither} | ${js.filter((j) => j.pick === 'none').length} | ${js.filter((j) => j.pick == null).length}`, rightA, rightB };
    };
    const verdictHead = `Differ | Judged | Right, ${a.arm} | Right, ${b.arm} | Neither | Judge chose none | No answer`;
    say(`| Kind | Language | ${verdictHead} |`);
    say('|---|---|---|---|---|---|---|---|---|');
    for (const kind of ['pos', 'skill', 'cert'] as const) {
      for (const lang of ['en', 'pt', 'es']) {
        const dk = differ.filter((k) => k.startsWith(`${kind}|${lang}|`));
        if (!dk.length) continue;
        say(`| ${kind} | ${lang} | ${verdictCounts(dk, judged.filter((j) => j.key.startsWith(`${kind}|${lang}|`))).cells} |`);
      }
    }
    say(`| all | all | ${verdictCounts(differ, judged).cells} |`);
    say();
    say(
      `By cause, the first that applies, each string's first snap in each arm (\`localeArms.ts\` \`causeOf\`): **failed**, a band call that failed all three tries in either arm, or Clef answered nothing (not judged); **overlap**, two snaps of the string ran at once in an arm (two listings), so which answers were the first's is unknown; **registry**, the nearest candidates differ, a vector one arm's earlier snaps added being behind it; **Clef**, both arms showed Clef the same entries and its answer differs at the floor, the state's market the only difference in what it was asked, and no arm went on past Clef with an English name the other arm's pivot gave otherwise; **Clef and pivot**, the names differ, and either the entries differ only by the token one name named, or Clef's answers differ and the language arm went on past Clef (its none, or an answer under the floor) with its own name, where the market's name would have gone on instead, so the name and Clef's state moved together; **pivot**, Clef saw the same entries and answered alike (or neither arm asked it), the names differ, and an arm's token came from its name (the token step 3 took, or a mint); **registry** also for the rest (an alias or a token one arm's earlier snaps made).`,
    );
    say();
    /** The causes the market acts through directly: each of their strings made calls of its own, so the sign test holds. */
    const direct: readonly Cause[] = ['Clef', 'Clef and pivot', 'pivot'];
    const pText = (x: number, y: number) => (x + y ? (signTest(x, y) < 0.001 ? '<0.001' : f3(signTest(x, y))) : '—');
    say(`| Cause | ${verdictHead} | Sign test p |`);
    say('|---|---|---|---|---|---|---|---|---|');
    const causeRow = (label: string, of: readonly Cause[], test: boolean) => {
      const dk = differing.filter((k) => of.includes(causes.get(k)!));
      if (!dk.length) return;
      const v = verdictCounts(
        dk,
        judged.filter((j) => of.includes(causes.get(j.key)!)),
      );
      say(`| ${label} | ${v.cells} | ${test ? pText(v.rightA, v.rightB) : '—'} |`);
    };
    for (const cause of CAUSES) causeRow(cause, [cause], direct.includes(cause));
    causeRow('the market directly (Clef, Clef and pivot, pivot)', direct, true);
    say();
    say(
      `The sign test weighs the strings where exactly one arm reached the judge's pick: p is the chance of a split at least that uneven if each arm were as likely to be the right one (two-sided, exact). It holds where each string made its own calls, so it is given for the three causes the market acts through directly and their sum (four tests: a p under 0.0125 is under 0.05 once they are counted), not for the registry's knock-on effects, which move together, nor for the rows by kind and language, which hold them. What each answer for the founder keeps: dropping the market keeps the ${b.arm} arm everywhere, keeping it the ${a.arm} arm; keeping it for the pivot alone would keep the ${a.arm} arm's answers on the pivot's rows and the ${b.arm} arm's on Clef's, while on the Clef-and-pivot rows, where both moved at once, these two arms ran no such mix: only a third arm, the market in the pivot's message alone, would tell. One gap in Clef's rows: ${pivotBand ? 'an English string asks the pivot' : 'with the pivot out of the band, every string asks it'} only once Clef has passed it on, so where the ${b.arm} arm went past Clef and the ${a.arm} arm picked, the market's English name was never asked, and the pivot alone with the market could name it otherwise (the names differ for the share of strings the pivot's table above shows).`,
    );
    say();
    const judgedPos = judged.filter((j) => j.key.startsWith('pos|') && j.pick && j.pick !== 'none');
    const relCounts = (m: Map<string, Decision>) => [...RELATIONS, null].map((rel) => judgedPos.filter((j) => relation(iscoOfToken(m.get(j.key)!.token), iscoOfToken(j.pick as string)) === rel).length);
    const [ra, rb] = [relCounts(fa), relCounts(fb)];
    say(`The occupations, by how far each arm's token sits from the judge's pick (ISCO, as recall measures relevance), over the ${judgedPos.length} where the judge chose a token: right ${pair(ra[0]!, rb[0]!)}, near ${pair(ra[1]!, rb[1]!)}, industry ${pair(ra[2]!, rb[2]!)}, far ${pair(ra[3]!, rb[3]!)}, no token or no ISCO code ${pair(ra[4]!, rb[4]!)}.`);
    say();
    const shown = judged.filter((j) => !j.key.startsWith('skill|'));
    const skillsShown = shuffled(
      judged.filter((j) => j.key.startsWith('skill|')),
      seed,
    ).slice(0, 80);
    say(`The judged strings: every occupation and certificate, and ${skillsShown.length < judged.length - shown.length ? `a random ${skillsShown.length} of the ${judged.length - shown.length} skills` : 'every skill'}; ${a.arm} and ${b.arm} give the decision, the token and Clef's p, the judge its pick and its reason.`);
    say();
    say(`| String | Kind | Language, region | Cause | ${a.arm} | ${b.arm} | Judge |`);
    say('|---|---|---|---|---|---|---|');
    const snapCell = (d: Decision, pick: Judged['pick']) => {
      const v = verdict(d.token, pick);
      const what = `${d.decision} ${cell(labelOf(d.token))}${d.probability != null ? ` (${f3(d.probability)})` : ''}`;
      return v === 'wrong' ? `**${what}**` : what;
    };
    for (const j of [...shown.sort((x, y) => x.key.localeCompare(y.key)), ...skillsShown.sort((x, y) => x.key.localeCompare(y.key))]) {
      const [kind, lang] = j.key.split('|');
      const da = fa.get(j.key)!;
      const pickText = j.pick === 'none' ? 'none' : j.pick ? cell(labelOf(j.pick)) : 'no answer';
      say(`| ${cell(da.raw)} | ${kind} | ${lang}, ${contextOf.get(j.key)?.draft.region ?? countryOf(j.key)} | ${causes.get(j.key)} | ${snapCell(da, j.pick)} | ${snapCell(fb.get(j.key)!, j.pick)} | ${pickText}${j.reason ? `: ${cell(j.reason)}` : ''} |`);
    }
    say();
    const compareFile = join('test', 'work-eval', `jobs-locale-${date}-n${picked.length}-seed${seed}${runName}.md`);
    writeFileSync(compareFile, lines.join('\n') + '\n');
    process.stdout.write(`wrote ${compareFile}\n`);
    const compareData = {
      model: MODEL,
      dims: DIMS,
      seed,
      date,
      arms: runs.map((r) => r.arm),
      pivotBand,
      differ: differing.map((k) => ({ key: k, cause: causes.get(k), [a.arm]: fa.get(k), [b.arm]: fb.get(k), judged: judged.find((j) => j.key === k) ?? null, region: contextOf.get(k)?.draft.region ?? null })),
      sameBand: sameBand.map((k) => ({ key: k, [a.arm]: ca.get(k), [b.arm]: cb.get(k) })),
      pivots: pivotBoth.map((k) => ({ key: k, [a.arm]: pa.get(k)!.english, [b.arm]: pb.get(k)!.english })),
      titles: drafts.map((x) => ({ pseudonym: x.draft.pseudonym, term: x.e.v.term, title: x.draft.titles[0] ?? null, [a.arm]: a.titleToken.get(x.draft.pseudonym) ?? null, [b.arm]: b.titleToken.get(x.draft.pseudonym) ?? null })),
      tokens: Object.fromEntries(tokenInfo),
    };
    const compareDataFile = join(outDir, `${date}-n${picked.length}-seed${seed}${runName}-locale.json`);
    writeFileSync(compareDataFile, JSON.stringify(compareData));
    process.stdout.write(`wrote ${compareDataFile}\n`);
  }, 3 * 60 * 60 * 1000);
});
