// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The real-resume benchmark (opt-in: RESUME_EVAL=1), from the Mac: workspace
 * decision 0021, the founder's exception of 2026-10-28, and
 * `docs/product/engine.md`, Whole-document parse. Kaggle's public resume
 * dataset (`snehaanbhawal/resume-dataset`: LiveCareer resumes, employers and
 * names removed by the site), never in a repository; the resumes that still
 * carry an email or a phone number are left out. Each sampled resume's pages
 * are rendered as the phone sends them (`scripts/work/pdf-pages.swift`: JPEG,
 * the long side 1,600 px) and read by:
 *
 *   the cloud pipeline: two readers in parallel over Workers AI's REST API
 *     (no gateway), code merging what they agree on, `clef-flash` choosing
 *     between the two values of each disputed field over the PDF's own text,
 *     DeepSeek at high effort on what Clef leaves unsure, and, with
 *     RESUME_REVIEW=1, DeepSeek's full check of the result;
 *   the local readers (RESUME_LOCAL, as WORK_PARSE_LOCAL), each alone with the
 *     code's checks, as on a phone, and two of them merged by code alone.
 *
 * Every reading is scored against the labels in the resume's own HTML
 * (`test/work-eval/resumeBench.ts`): the jobs found, each job's title, start
 * and end, its length in months, the schools and the certificates its
 * certifications section names; a field is right, asked (still open, so the
 * worker would answer it) or silently wrong. Writes
 * `test/work-eval/resumes-<date>-n<N>.md`, counts only, never a resume's text,
 * title or date. The readings themselves stay under RESUME_OUT/cache, outside
 * every repository, one file per reader and resume, so a later run adds a
 * reader without repeating the others, and the report covers every reader in
 * the cache for the sample.
 *
 *   cd cofferdam-api && RESUME_EVAL=1 direnv exec .. yarn vitest run test/workResume.eval.test.ts
 *   RESUME_EVAL=1 RESUME_CLOUD= RESUME_LOCAL='[{"label":"LFM3-VL-2B QAD-Q4_0, 1,024 image tokens","url":"http://127.0.0.1:8081","model":"lfm3-vl-2b"}]' \
 *     yarn vitest run test/workResume.eval.test.ts
 *
 * RESUME_DIR the dataset (default ~/Development/cv-bench/kagle-pdf-dataset),
 * RESUME_OUT pages, cache and run data (default ~/Development/cv-bench/runs),
 * RESUME_PLAN `CATEGORY:N,…` (default 50 from the trades, 25 engineering,
 * 25 IT), RESUME_SEED (1), RESUME_CLOUD the two cloud readers, comma-separated
 * (default Gemma 4 and DeepSeek V4.1 Flash; empty for none), RESUME_PARALLEL
 * resumes at once on the cloud (4), RESUME_CLEF_FLOOR Clef's floor (0.6),
 * RESUME_REVIEW=1 the full check. The cloud needs CLOUDFLARE_ACCOUNT_ID and
 * CLOUDFLARE_API_TOKEN; the local readers need their servers
 * (workspace `docs/runbooks/android-build.md`, Local readers on the Mac).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInference, MODEL_PRICES, type AiBinding } from '../src/services/inference/index.js';
import { clefInput, OTHER_FLOOR, readChoice, readNoul } from '../src/services/work/clef.js';
import { usageOf } from '../src/services/work/fields.js';
import { MAX_PAGES, PARSE_JSON_SCHEMA, PARSE_SYSTEM, parseRequest, readParse, type ParsePage } from '../src/services/work/parse.js';
import { planHire, type HireDeps, type HirePlan } from '../src/services/work/hire.js';
import { claimKey, D1ListingStore, listingText, publishListing, type ClaimVectors, type ListingDraft, type PublishDeps } from '../src/services/work/listings.js';
import { callCostMicroUsd } from '../src/services/work/meter.js';
import { recall, TIER2_FLOOR } from '../src/services/work/recall.js';
import { EMBEDDINGGEMMA_2_GGUF, type RegistryDeps } from '../src/services/work/registry.js';
import type { D1Database } from '@cloudflare/workers-types';
import { createRestAi } from './chat-eval/restAi.js';
import { memoryIndex } from './fixtures/work/fakes.js';
import { createLocalAi, parseLocalReaders, type LocalReader } from './work-eval/localAi.js';
import { embedAll, loadReplica, ReplicaIndex } from './work-eval/replica.js';
import {
  addScores,
  applyReview,
  applyValue,
  arbiterRequest,
  clefState,
  CLEF_STATE_MAX_CHARS,
  consideredOf,
  DECISION_RULES,
  disputeQuestions,
  dropAbsent,
  GROUPS,
  hasContact,
  mergeReadings,
  pickSample,
  readArbiter,
  readingGaps,
  readingOf,
  readPlan,
  readResumeCsv,
  replayRule,
  resumeTruth,
  reviewRequest,
  scoreReading,
  type ConsideredSearch,
  type Dispute,
  type Outcome,
  type Reading,
  type ResumeRecord,
  type ResumeScore,
  type ResumeTruth,
  type ScoredField,
} from './work-eval/resumeBench.js';

const RUN = process.env.RESUME_EVAL === '1';
const home = (p: string) => p.replace(/^~(?=\/|$)/, homedir());
const CLEF = '@cf/cloudflare/clef-flash';
const ARBITER = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
const DEFAULT_PLAN = 'CONSTRUCTION:15,AVIATION:10,AUTOMOBILE:10,AGRICULTURE:5,CHEF:10,ENGINEERING:25,INFORMATION-TECHNOLOGY:25';
/** Workers AI bills $0.011 per 1,000 neurons: 11 micro-dollars a neuron. */
const MICRO_USD_PER_NEURON = 11;
/** The parse prompt and schema a reading was made with: a cache folder per tag, so a prompt change reads again. */
const PROMPT_TAG = createHash('sha256').update(PARSE_SYSTEM + JSON.stringify(PARSE_JSON_SCHEMA)).digest('hex').slice(0, 8);

/** One reader's reading of one resume, as cached: values stay outside the repository. */
interface CachedReading {
  ok: boolean;
  failure: string | null;
  ms: number;
  costMicroUsd: number | null;
  reading: Reading | null;
}

/** The cloud pipeline's trace for one resume. */
interface PipelineTrace {
  disputes: Dispute[];
  /** Clef's answer per dispute: the probability of its pick (or of yes) and the pick. */
  clef: Record<string, { pick: string | null; p: number | null }>;
  clefMs: number;
  clefCost: number;
  clefTruncated: boolean;
  arbiter: Record<string, { value: string | null; present: boolean | null }>;
  arbiterMs: number;
  arbiterCost: number;
  arbiterFailure: string | null;
  /** Disputes Clef settled at the floor, and those the arbiter settled after it. */
  settledByClef: number;
  settledByArbiter: number;
  /** The reading after Clef, after the arbiter, and the paths each leaves open. */
  afterClef: { reading: Reading; open: string[] };
  afterArbiter: { reading: Reading; open: string[] };
  review?: { reading: Reading; open: string[]; corrections: number; added: number; ms: number; cost: number; failure: string | null };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const slug = (s: string) => s.replace(/^@cf\//, '').replace(/[^A-Za-z0-9.-]+/g, '_').slice(0, 80);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '–');
/** A quantile of times in milliseconds, in seconds. */
const quantile = (ms: number[], p: number) => {
  if (!ms.length) return '–';
  const s = [...ms].sort((a, b) => a - b);
  return (s[Math.min(s.length - 1, Math.floor(p * s.length))]! / 1000).toFixed(1);
};

async function parallel<T, R>(items: readonly T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

/** A call's cost from the neurons it reported, else its token prices, else null. */
function costOf(model: string, result: unknown): number | null {
  const u = usageOf(result);
  if (u.neurons != null && u.neurons > 0) return Math.round(u.neurons * MICRO_USD_PER_NEURON);
  const p = MODEL_PRICES[model];
  if (!p || (!u.tokensIn && !u.tokensOut)) return null;
  return Math.round(u.tokensIn * p.input + u.tokensOut * p.output);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** One reader on one resume, cached by reader and resume id. */
async function readOnce(cacheDir: string, reader: string, id: string, run: () => Promise<{ result: unknown; model: string }>): Promise<CachedReading> {
  const file = join(cacheDir, `${slug(reader)}-${PROMPT_TAG}`, `${id}.json`);
  const cached = readJson<CachedReading>(file);
  if (cached) return cached;
  let out: CachedReading | null = null;
  // A rate limit (429) is waited out, up to four tries; any other failure is final for this run.
  for (let attempt = 0; attempt < 4 && !out; attempt++) {
    const t0 = Date.now();
    try {
      const { result, model } = await run();
      out = { ok: true, failure: null, ms: Date.now() - t0, costMicroUsd: costOf(model, result), reading: readingOf(readParse(result)) };
    } catch (err) {
      const failure = String((err as Error)?.message ?? err).slice(0, 200);
      if (/\b429\b|rate limit/i.test(failure) && attempt < 3) {
        await sleep(15_000 * 2 ** attempt);
        continue;
      }
      out = { ok: false, failure, ms: Date.now() - t0, costMicroUsd: null, reading: null };
    }
  }
  // Only a reading is cached: a failed call is tried again on the next run.
  if (out!.ok) {
    mkdirSync(join(cacheDir, `${slug(reader)}-${PROMPT_TAG}`), { recursive: true });
    writeFileSync(file, JSON.stringify(out) + '\n');
  }
  return out!;
}

/**
 * The cloud pipeline on two readings: merge, Clef on every dispute, the
 * arbiter on what Clef leaves under the floor, and the paths still open
 * (unsettled disputes and the code's gaps) after each step.
 */
async function cloudPipeline(
  ai: AiBinding,
  a: Reading,
  b: Reading,
  pages: ParsePage[],
  text: string,
  floor: number,
): Promise<PipelineTrace> {
  const { reading: merged, disputes } = mergeReadings(a, b);
  const trace: PipelineTrace = {
    disputes,
    clef: {},
    clefMs: 0,
    clefCost: 0,
    clefTruncated: text.length > CLEF_STATE_MAX_CHARS,
    arbiter: {},
    arbiterMs: 0,
    arbiterCost: 0,
    arbiterFailure: null,
    settledByClef: 0,
    settledByArbiter: 0,
    afterClef: { reading: merged, open: [] },
    afterArbiter: { reading: merged, open: [] },
  };
  // Clef, ten questions a call.
  const t0 = Date.now();
  for (let i = 0; i < disputes.length; i += 10) {
    const chunk = disputes.slice(i, i + 10);
    try {
      const result = await ai.run(CLEF as never, clefInput(CLEF, clefState(text), disputeQuestions(chunk)) as never, { signal: AbortSignal.timeout(30_000) } as never);
      trace.clefCost += costOf(CLEF, result) ?? 0;
      for (const d of chunk) {
        if (d.kind === 'presence') trace.clef[d.id] = { pick: null, p: readNoul(result, d.id) };
        else {
          const c = readChoice(result, d.id, ['a', 'b', 'other'] as const, 0);
          trace.clef[d.id] = { pick: c.choice, p: c.choice ? c.p : null };
        }
      }
    } catch {
      for (const d of chunk) trace.clef[d.id] = { pick: null, p: null };
    }
  }
  trace.clefMs = Date.now() - t0;

  // What Clef settles at the floor.
  const settle = (r: Reading, extra: (d: Dispute) => { value?: string | null; present?: boolean } | null) => {
    const out: Reading = { jobs: r.jobs.map((j) => ({ ...j })), schools: r.schools.map((s) => ({ ...s })), certificates: [...r.certificates], skills: r.skills };
    const open: string[] = [];
    const absent: string[] = [];
    for (const d of disputes) {
      const s = extra(d);
      if (!s) {
        open.push(d.path);
        continue;
      }
      if (d.kind === 'presence') {
        if (s.present === false) absent.push(d.path);
      } else applyValue(out, d.path, s.value ?? null);
    }
    // Gaps found by the code's checks on what is kept; paths shift once absent items drop, so gaps are read after.
    const kept = dropAbsent(out, absent);
    const shiftedOpen = shiftPaths(open, absent);
    return { reading: kept, open: [...new Set([...shiftedOpen, ...readingGaps(kept)])] };
  };
  const byClef = (d: Dispute) => {
    const c = trace.clef[d.id];
    if (!c || c.p == null) return null;
    if (d.kind === 'presence') return c.p >= floor ? { present: true } : 1 - c.p >= floor ? { present: false } : null;
    if (c.p < floor || !c.pick || c.pick === 'other') return null;
    return { value: c.pick === 'a' ? d.a : d.b };
  };
  trace.afterClef = settle(merged, byClef);
  trace.settledByClef = disputes.filter((d) => byClef(d)).length;

  // The arbiter on what Clef left open.
  const openDisputes = disputes.filter((d) => !byClef(d));
  if (openDisputes.length) {
    const t1 = Date.now();
    try {
      const result = await ai.run(ARBITER as never, arbiterRequest(pages, openDisputes) as never, { signal: AbortSignal.timeout(240_000) } as never);
      trace.arbiterCost = costOf(ARBITER, result) ?? 0;
      for (const [id, v] of readArbiter(result)) trace.arbiter[id] = v;
    } catch (err) {
      trace.arbiterFailure = String((err as Error)?.message ?? err).slice(0, 200);
    }
    trace.arbiterMs = Date.now() - t1;
  }
  const byArbiter = (d: Dispute) => {
    const v = trace.arbiter[d.id];
    if (!v) return null;
    if (d.kind === 'presence') return v.present == null ? null : { present: v.present };
    return { value: v.value };
  };
  trace.afterArbiter = settle(merged, (d) => byClef(d) ?? byArbiter(d));
  trace.settledByArbiter = openDisputes.filter((d) => byArbiter(d)).length;
  return trace;
}

/** Open paths renumbered after absent items of the same list were dropped. */
function shiftPaths(open: readonly string[], absent: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of open) {
    const [list, k, ...rest] = p.split('.');
    const i = Number(k);
    if (absent.includes(`${list}.${i}`)) continue;
    const before = absent.filter((a) => a.startsWith(`${list}.`) && Number(a.split('.')[1]) < i).length;
    out.push([list, String(i - before), ...rest].join('.'));
  }
  return out;
}

interface PathResult {
  id: string;
  category: string;
  score: ResumeScore | null;
  ms: number | null;
  costMicroUsd: number | null;
  failed: boolean;
}

const FIELDS: ScoredField[] = ['job', 'title', 'start', 'end', 'months', 'school', 'certificate'];
const FIELD_NAMES: Record<ScoredField, string> = { job: 'Jobs found', title: 'Title', start: 'Start', end: 'End', months: 'Months', school: 'School', certificate: 'Certificates' };

function cell(o: Record<Outcome, number>): string {
  const n = o.right + o['asked-right'] + o['asked-wrong'] + o.silent;
  if (!n) return '–';
  const right = o.right + o['asked-right'];
  return `${pct(right, n)} (${pct(o.silent, n)} silent)`;
}

function summaryRows(paths: Map<string, PathResult[]>, filter: (r: PathResult) => boolean): string[] {
  const out = ['| Path | Resumes | ' + FIELDS.map((f) => FIELD_NAMES[f]).join(' | ') + ' | Spurious jobs | Questions per resume | Median s | Cost per resume |', '|---|---|' + FIELDS.map(() => '---').join('|') + '|---|---|---|---|'];
  for (const [name, results] of paths) {
    const rs = results.filter(filter);
    const ok = rs.filter((r) => r.score);
    if (!rs.length) continue;
    const total = addScores(ok.map((r) => r.score!));
    const costs = rs.map((r) => r.costMicroUsd).filter((c): c is number => c != null);
    const ms = rs.map((r) => r.ms).filter((m): m is number => m != null);
    out.push(
      `| ${name} | ${ok.length}/${rs.length} | ${FIELDS.map((f) => cell(total.outcomes[f])).join(' | ')} | ${ok.length ? (total.jobs.spurious / ok.length).toFixed(2) : '–'} | ${ok.length ? (total.questions / ok.length).toFixed(1) : '–'} | ${ms.length ? (median(ms) / 1000).toFixed(1) : '–'} | ${costs.length ? `$${(costs.reduce((s, c) => s + c, 0) / costs.length / 1e6).toFixed(4)}` : 'on device'} |`,
    );
  }
  return out;
}

/** One variant's work profiles and the hirer's search over them. */
interface CwpResult {
  variant: string;
  resumes: number;
  published: number;
  /** Resumes whose occupation tokens equal the labels' own, of those both published. */
  same: number;
  compared: number;
  /** The labels' occupation tokens the variant's listing also holds. */
  kept: number;
  labelTokens: number;
  /** The hirer's search, a sentence written from the resume's latest true title: its own listing among the finalists, first, in the top five, in tier 1. */
  searched: number;
  found: number;
  first: number;
  top5: number;
  tier1: number;
  /**
   * Why the rest were not found, first cause first: no listing (nothing read, or the draft refused); the plan searched remote
   * work; the decision pass saw it and called it other work, or left a token miss in tier 2 (no fit, which an Instant search
   * drops); it lacks a token the plan requires (a certificate, a language: the benchmark's listings hold no certificate); else
   * past the vector's 50, under the cosine floor, or not among the fifty the gate passed on.
   */
  missUnpublished: number;
  missRemote: number;
  missOther: number;
  missRelated: number;
  missRequired: number;
  missRank: number;
  missFloor: number;
  missCut: number;
  /** Decision-pass calls that failed (the gate's tier stood). */
  decideFailed: number;
  costMicroUsd: number;
  /** Each search's wall time on the Mac (the replica's stores are local; Clef's calls are the real ones), its Clef calls, and the searches' cost. */
  searchMs: number[];
  decideCalls: number[];
  searchCostMicroUsd: number;
  /** Each rule of `DECISION_RULES` replayed on this variant's decisions; the built rule's row repeats the search's own counts. */
  replay: Record<string, { found: number; first: number; top5: number; kept: number; asked: number }>;
  /** Every finalist the pass considered, per search: numbers only, for the run's JSON outside the repository. */
  decisions: ConsideredSearch[];
}

const dot = (a: readonly number[], b: readonly number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

/** node:sqlite's D1 shim takes one batch at a time: chain them, as the job-ad benchmark does. */
function serialBatches(d1: D1Database): void {
  const db = d1 as unknown as { batch: (stmts: unknown[]) => Promise<unknown> };
  const rawBatch = db.batch.bind(db);
  let chain: Promise<unknown> = Promise.resolve();
  db.batch = (stmts) => {
    const run = chain.then(() => rawBatch(stmts));
    chain = run.catch(() => undefined);
    return run;
  };
}

describe.skipIf(!RUN)('Real-resume benchmark (live: Workers AI and local readers)', () => {
  it('reads the sampled resumes on every path and writes the report', async () => {
    const dir = home(process.env.RESUME_DIR ?? '~/Development/cv-bench/kagle-pdf-dataset');
    const out = home(process.env.RESUME_OUT ?? '~/Development/cv-bench/runs');
    const plan = readPlan(process.env.RESUME_PLAN ?? DEFAULT_PLAN);
    const seed = Number(process.env.RESUME_SEED ?? 1);
    const cloudReaders = (process.env.RESUME_CLOUD ?? '@cf/google/gemma-4-26b-a4b-it,@cf/deepseek-ai/deepseek-v4.1-flash-1017').split(',').map((s) => s.trim()).filter(Boolean);
    const localReaders: LocalReader[] = parseLocalReaders(process.env.RESUME_LOCAL);
    const parallelN = Number(process.env.RESUME_PARALLEL ?? 4);
    const floor = Number(process.env.RESUME_CLEF_FLOOR ?? 0.6);
    const review = process.env.RESUME_REVIEW === '1';
    if (cloudReaders.length > 2) throw new Error('RESUME_CLOUD names one or two readers, or none');
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (cloudReaders.length && (!accountId || !token)) throw new Error('the cloud pipeline needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    const started = Date.now();
    const pagesDir = join(out, 'pages');
    const cacheDir = join(out, 'cache');
    mkdirSync(pagesDir, { recursive: true });

    // The sample: no contact details, at least one labelled job, at most MAX_PAGES pages.
    const records = readResumeCsv(readFileSync(join(dir, 'Resume', 'Resume.csv'), 'utf8'));
    const pdfOf = (r: ResumeRecord) => join(dir, 'data', 'data', r.category, `${r.id}.pdf`);
    const truthOf = new Map<string, ResumeTruth>();
    const eligible = (r: ResumeRecord) => {
      if (hasContact(r.text) || !existsSync(pdfOf(r))) return false;
      const t = resumeTruth(r.html);
      truthOf.set(r.id, t);
      return t.jobs.length > 0;
    };
    const generous = Object.fromEntries(Object.entries(plan).map(([c, n]) => [c, n + Math.ceil(n / 5) + 2]));
    const candidates = pickSample(records, generous, seed, eligible);
    const render = spawnSync('swift', [join(__dirname, '..', 'scripts', 'work', 'pdf-pages.swift'), pagesDir, '1600', ...candidates.map(pdfOf)], { encoding: 'utf8', maxBuffer: 1 << 24 });
    if (render.status !== 0) throw new Error(`pdf-pages.swift exited ${render.status}: ${(render.stderr ?? '').split('\n').slice(-4).join(' ')}`);
    process.stdout.write(`${render.stdout.trim()}\n`);
    const pageCount = (id: string) => Number(readFileSync(join(pagesDir, id, 'pages.txt'), 'utf8').trim()) || 0;
    const sample: ResumeRecord[] = [];
    for (const [category, n] of Object.entries(plan)) {
      sample.push(...candidates.filter((r) => r.category === category && pageCount(r.id) >= 1 && pageCount(r.id) <= MAX_PAGES).slice(0, n));
    }
    const excluded = records.filter((r) => hasContact(r.text)).length;
    process.stdout.write(`sample: ${sample.length} resumes (${Object.entries(plan).map(([c, n]) => `${c} ${sample.filter((r) => r.category === c).length}/${n}`).join(', ')}); ${excluded} of ${records.length} left out for contact details\n`);
    const pagesOf = (id: string): ParsePage[] =>
      readdirSync(join(pagesDir, id))
        .filter((f) => /^p\d+\.jpg$/.test(f))
        .sort((x, y) => Number(x.slice(1, -4)) - Number(y.slice(1, -4)))
        .map((f) => ({ mime: 'image/jpeg' as const, base64: readFileSync(join(pagesDir, id, f)).toString('base64') }));
    const textOf = (id: string) => readFileSync(join(pagesDir, id, 'text.txt'), 'utf8');

    // The cloud: both readers per resume in parallel, then the pipeline.
    const ai = cloudReaders.length ? createRestAi({ accountId: accountId!, token: token! }) : null;
    const cloud = new Map<string, { a: CachedReading; b: CachedReading | null; trace: PipelineTrace | null }>();
    if (ai) {
      await parallel(sample, parallelN, async (r, i) => {
        const pages = pagesOf(r.id);
        const [a, b] = await Promise.all(
          cloudReaders.map((model) =>
            readOnce(cacheDir, model, r.id, async () => ({ model, result: await ai.run(model as never, parseRequest(model, { kind: 'image', pages }) as never, { signal: AbortSignal.timeout(180_000) } as never) })),
          ),
        );
        let trace: PipelineTrace | null = null;
        if (b && a!.reading && b.reading) {
          const file = join(cacheDir, `pipeline-${slug(cloudReaders.join('+'))}-floor${floor}${review ? '-review' : ''}-${PROMPT_TAG}`, `${r.id}.json`);
          trace = readJson<PipelineTrace>(file);
          if (!trace) {
            trace = await cloudPipeline(ai, a!.reading, b.reading, pages, textOf(r.id), floor);
            if (review) {
              const t0 = Date.now();
              try {
                const result = await ai.run(ARBITER as never, reviewRequest(pages, trace.afterArbiter.reading) as never, { signal: AbortSignal.timeout(240_000) } as never);
                const rv = applyReview(trace.afterArbiter.reading, result);
                trace.review = { reading: rv.reading, open: [...new Set([...trace.afterArbiter.open, ...readingGaps(rv.reading)])], corrections: rv.corrections, added: rv.added, ms: Date.now() - t0, cost: costOf(ARBITER, result) ?? 0, failure: null };
              } catch (err) {
                trace.review = { reading: trace.afterArbiter.reading, open: trace.afterArbiter.open, corrections: 0, added: 0, ms: Date.now() - t0, cost: 0, failure: String((err as Error)?.message ?? err).slice(0, 200) };
              }
            }
            mkdirSync(join(file, '..'), { recursive: true });
            writeFileSync(file, JSON.stringify(trace) + '\n');
          }
        }
        cloud.set(r.id, { a: a!, b: b ?? null, trace });
        process.stdout.write(`cloud ${i + 1}/${sample.length}: ${[a, b].filter(Boolean).map((x) => (x!.ok ? 'ok' : `FAIL ${x!.failure}`)).join(' ')}, ${trace ? `${trace.disputes.length} disputes, ${trace.afterArbiter.open.length} open` : 'no pipeline'}\n`);
        await sleep(200);
      });
    }

    // The local readers, one at a time (one server each).
    const local = new Map<string, Map<string, CachedReading>>();
    for (const reader of localReaders) {
      const lai = createLocalAi(reader);
      const byId = new Map<string, CachedReading>();
      for (const [i, r] of sample.entries()) {
        const reading = await readOnce(cacheDir, `local-${reader.label}`, r.id, async () => ({
          model: 'local',
          result: await lai.run('local' as never, parseRequest(`local:${reader.label}`, { kind: 'image', pages: pagesOf(r.id) }) as never, { signal: AbortSignal.timeout(900_000) } as never),
        }));
        byId.set(r.id, reading);
        process.stdout.write(`${reader.label} ${i + 1}/${sample.length}: ${reading.ok ? 'ok' : `FAIL ${reading.failure}`} ${(reading.ms / 1000).toFixed(1)} s\n`);
      }
      local.set(reader.label, byId);
    }

    // Every path in the cache for this sample, scored.
    const paths = new Map<string, PathResult[]>();
    const addPath = (name: string, r: ResumeRecord, reading: Reading | null, open: readonly string[], ms: number | null, cost: number | null) => {
      const truth = truthOf.get(r.id)!;
      const list = paths.get(name) ?? [];
      list.push({ id: r.id, category: r.category, score: reading ? scoreReading(reading, truth, new Set(open)) : null, ms, costMicroUsd: cost, failed: !reading });
      paths.set(name, list);
    };
    const short = (m: string) => m.split('/').pop()!;
    const cloudCacheReaders = cloudReaders.length ? cloudReaders : [];
    for (const r of sample) {
      const c = cloud.get(r.id);
      // The second reader and the pipeline only when there are two; the local readers below are scored either way.
      if (c) addPath(`${short(cloudCacheReaders[0]!)} alone`, r, c.a.reading, c.a.reading ? readingGaps(c.a.reading) : [], c.a.ms, c.a.costMicroUsd);
      if (c?.b) {
        addPath(`${short(cloudCacheReaders[1]!)} alone`, r, c.b.reading, c.b.reading ? readingGaps(c.b.reading) : [], c.b.ms, c.b.costMicroUsd);
        const both = (c.a.costMicroUsd ?? 0) + (c.b.costMicroUsd ?? 0);
        const readMs = Math.max(c.a.ms, c.b.ms);
        if (c.trace) {
          const t = c.trace;
          const merged = mergeReadings(c.a.reading!, c.b.reading!);
          addPath('Both, merged by code (every dispute asked)', r, merged.reading, [...merged.disputes.map((d) => d.path), ...readingGaps(merged.reading)], readMs, both);
          addPath(`+ clef-flash at ${floor}`, r, t.afterClef.reading, t.afterClef.open, readMs + t.clefMs, both + t.clefCost);
          addPath('+ DeepSeek on what Clef left open', r, t.afterArbiter.reading, t.afterArbiter.open, readMs + t.clefMs + t.arbiterMs, both + t.clefCost + t.arbiterCost);
          if (t.review) addPath('+ DeepSeek full check', r, t.review.reading, t.review.open, readMs + t.clefMs + t.arbiterMs + t.review.ms, both + t.clefCost + t.arbiterCost + t.review.cost);
        } else {
          addPath('Both, merged by code (every dispute asked)', r, null, [], null, both);
        }
      }
      for (const [label, byId] of local) {
        const x = byId.get(r.id)!;
        addPath(`${label} (on device)`, r, x.reading, x.reading ? readingGaps(x.reading) : [], x.ms, null);
      }
      if (local.size === 2) {
        const [x, y] = [...local.values()].map((m) => m.get(r.id)!);
        if (x!.reading && y!.reading) {
          const m = mergeReadings(x!.reading, y!.reading);
          addPath('Both local readers, merged by code', r, m.reading, [...m.disputes.map((d) => d.path), ...readingGaps(m.reading)], x!.ms + y!.ms, null);
        } else addPath('Both local readers, merged by code', r, null, [], null, null);
      }
    }

    // The work profiles (RESUME_CWP=1): each variant's job titles and skills published as a listing on a replica of its own,
    // snapped as the plane snaps them (exact labels, the phone's EmbeddingGemma 2 vectors, clef-flash in the band), and a hirer's
    // sentence written from the resume's latest true title searched over each variant's listings, the decision pass on (Clef, not
    // flash: decision 0069). Nothing is written to the live D1 or Vectorize.
    const cwp: CwpResult[] = [];
    if (process.env.RESUME_CWP === '1') {
      if (!ai) throw new Error('RESUME_CWP needs the cloud credentials: the plane\'s Clef, pivot and hirer models run on Workers AI');
      const escoSql = home(process.env.ESCO_SQL ?? '~/Development/esco/import/cofferdam-import');
      const usSql = home(process.env.US_SQL ?? '~/Development/us-layer-data/cofferdam-import');
      const v3Dir = home(process.env.V3_DIR ?? '~/Development/esco/import/registry-embeddinggemma-2');
      const skillsPer = Number(process.env.RESUME_CWP_SKILLS ?? 10);
      const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
      const titlesOf = (r: Reading | null) => [...new Set((r?.jobs ?? []).map((j) => norm(j.title ?? '').slice(0, 120)).filter(Boolean))].slice(0, 5);
      const skillsOf = (r: Reading | null) => (r?.skills ?? []).map(norm).filter((x) => x && x.length <= 120).slice(0, skillsPer);
      const labelReading = (t: ResumeTruth): Reading => ({ jobs: t.jobs.map((j) => ({ ...j })), schools: [], certificates: [], skills: t.skills });
      const variants: { key: string; name: string; reading: (id: string) => Reading | null }[] = [{ key: 'labels', name: 'The labels (the ceiling)', reading: (id) => labelReading(truthOf.get(id)!) }];
      if (cloud.size) {
        if (cloudCacheReaders.length === 2) variants.push({ key: 'cloud', name: 'Cloud pipeline', reading: (id) => { const t = cloud.get(id)?.trace; return t ? (t.review?.reading ?? t.afterArbiter.reading) : null; } });
        variants.push({ key: 'reader-a', name: `${short(cloudCacheReaders[0]!)} alone`, reading: (id) => cloud.get(id)?.a.reading ?? null });
        if (cloudCacheReaders.length === 2) variants.push({ key: 'reader-b', name: `${short(cloudCacheReaders[1]!)} alone`, reading: (id) => cloud.get(id)?.b?.reading ?? null });
      }
      [...local.entries()].forEach(([label, byId], i) => variants.push({ key: `local-${i + 1}`, name: `${label} (on device)`, reading: (id) => byId.get(id)?.reading ?? null }));
      const only = (process.env.RESUME_CWP_ONLY ?? '').split(',').map((k) => k.trim()).filter(Boolean);
      if (only.length) variants.splice(0, variants.length, ...variants.filter((v) => only.includes(v.key)));
      const draftOf = (key: string, id: string, r: Reading | null): ListingDraft => ({ pseudonym: `${key}-${id}`, profileId: 'p1', region: 'us-tx', scope: 'onsite', tier: 1, lang: 'en', titles: titlesOf(r), skills: skillsOf(r), certificates: [], languages: ['en'] });
      const drafts = new Map<string, ListingDraft>();
      for (const v of variants) for (const r of sample) drafts.set(`${v.key}:${r.id}`, draftOf(v.key, r.id, v.reading(r.id)));
      const sentenceOf = new Map<string, string>();
      for (const r of sample) {
        const t = titlesOf(labelReading(truthOf.get(r.id)!))[0];
        if (t) sentenceOf.set(r.id, `We need an experienced ${t} for a project in Houston, Texas.`);
      }
      const claimsText = [...drafts.values()].flatMap((d) => [...d.titles, ...d.skills]);
      const listingTexts = [...drafts.values()].filter((d) => d.titles.length || d.skills.length).map((d) => listingText(d, []));
      const docs = embedAll([...listingTexts, ...claimsText], 'document');
      const queries = embedAll([...claimsText, ...sentenceOf.values()], 'query');
      const plans = new Map<string, HirePlan>();
      let planCost = 0;
      let labelTokens = new Map<string, string[]>();
      for (const [vi, v] of variants.entries()) {
        const t0 = Date.now();
        const replica = await loadReplica(escoSql, usSql);
        const index = ReplicaIndex.load(v3Dir);
        const seam = createInference({ WORK_EMBED_MODEL: EMBEDDINGGEMMA_2_GGUF }, { ai })!;
        const registry: RegistryDeps = { inference: seam, store: replica.store, index };
        const listings = new D1ListingStore(replica.db.d1);
        serialBatches(replica.db.d1);
        const jobsIndex = memoryIndex();
        const recallDeps = { inference: seam, index: jobsIndex, listings, store: replica.store };
        // The hirer's plans once, on the first replica: a plan reads the registry and never writes to it.
        if (vi === 0) {
          const hire: HireDeps = { registry, recall: recallDeps };
          await parallel(sample, parallelN, async (r) => {
            const sentence = sentenceOf.get(r.id);
            if (!sentence) return;
            const vector = queries.get(norm(sentence));
            const planned = await planHire(hire, { sentence, lang: 'en', regions: ['us-tx'], ...(vector ? { vector } : {}) });
            planCost += planned.calls.reduce((s, c) => s + callCostMicroUsd(c), 0);
            if (planned.ok) plans.set(r.id, planned.plan);
          });
        }
        const publish: PublishDeps = { inference: seam, registry, listings, index: jobsIndex };
        const tokensOf = new Map<string, string[]>();
        const listingOf = new Map<string, string>();
        const heldBy = new Map<string, string[]>();
        let cost = 0;
        await parallel(sample, parallelN, async (r) => {
          const d = drafts.get(`${v.key}:${r.id}`)!;
          if (!d.titles.length && !d.skills.length) return;
          const claims = new Map<string, ClaimVectors>();
          const add = (kind: 'pos' | 'skill', texts: string[]) => {
            for (const t of texts) {
              const q = queries.get(norm(t));
              const doc = docs.get(norm(t));
              if (q && doc) claims.set(claimKey(kind, t), { query: q, document: doc });
            }
          };
          add('pos', d.titles);
          add('skill', d.skills);
          const out = await publishListing(publish, d, { listing: docs.get(norm(listingText(d, []))), claims });
          cost += out.calls.reduce((s, c) => s + callCostMicroUsd(c), 0);
          if (out.ok) {
            tokensOf.set(r.id, out.tokens.filter((t) => t.startsWith('pos:')).sort());
            listingOf.set(r.id, out.listingId);
            heldBy.set(out.listingId, out.tokens);
          }
        });
        if (vi === 0) labelTokens = tokensOf;
        const res: CwpResult = { variant: v.name, resumes: sample.length, published: tokensOf.size, same: 0, compared: 0, kept: 0, labelTokens: 0, searched: 0, found: 0, first: 0, top5: 0, tier1: 0, missUnpublished: 0, missRemote: 0, missOther: 0, missRelated: 0, missRequired: 0, missRank: 0, missFloor: 0, missCut: 0, decideFailed: 0, costMicroUsd: cost, searchMs: [], decideCalls: [], searchCostMicroUsd: 0, replay: {}, decisions: [] };
        const listingVector = (id: string) => (listingOf.has(id) ? docs.get(norm(listingText(drafts.get(`${v.key}:${id}`)!, []))) : undefined);
        for (const r of sample) {
          const mine = tokensOf.get(r.id);
          const truth = labelTokens.get(r.id);
          if (truth) {
            res.labelTokens += truth.length;
            res.kept += truth.filter((t) => mine?.includes(t)).length;
            if (mine) {
              res.compared++;
              if (mine.join() === truth.join()) res.same++;
            }
          }
          const plan = plans.get(r.id);
          if (!plan) continue;
          res.searched++;
          const tSearch = Date.now();
          const found = await recall(recallDeps, plan.intent);
          res.searchMs.push(Date.now() - tSearch);
          res.decideCalls.push(found.calls.filter((c) => c.op === 'work-decide').length);
          const searchCost = found.calls.reduce((s, c) => s + callCostMicroUsd(c), 0);
          res.searchCostMicroUsd += searchCost;
          res.costMicroUsd += searchCost;
          if (found.ok) {
            const considered = [...found.finalists, ...(found.dropped ?? [])];
            res.decideFailed += considered.filter((f) => f.fit && f.fit.choice === null).length;
            res.decisions.push({ mode: plan.intent.mode, considered: consideredOf(considered, plan.intent, (id) => heldBy.get(id) ?? [], listingOf.get(r.id)) });
          }
          const at = found.ok ? found.finalists.findIndex((f) => f.listingId === listingOf.get(r.id)) : -1;
          if (at >= 0) {
            res.found++;
            if (at === 0) res.first++;
            if (at < 5) res.top5++;
            if (found.ok && found.finalists[at]!.gateTier === 1) res.tier1++;
            continue;
          }
          // The first cause of a miss: no listing, the plan's scope, what the decision pass did with it when it saw it, a token the
          // plan requires that the listing lacks, else the vector's 50, the cosine floor or the cut to fifty. A token hit holding every
          // required token passes the gate at any cosine, so only the pass drops one.
          const ownId = listingOf.get(r.id);
          const left = found.ok ? (found.dropped ?? []).find((f) => f.listingId === ownId) : undefined;
          const q = plan.intent.vector;
          const mineVec = listingVector(r.id);
          const rank = q && mineVec ? sample.filter((o) => { const ov = listingVector(o.id); return ov && dot(ov, q) > dot(mineVec, q); }).length : Infinity;
          if (!ownId) res.missUnpublished++;
          else if (plan.scope === 'remote') res.missRemote++;
          else if (left) {
            if ((left.fit?.pOther ?? 0) >= OTHER_FLOOR) res.missOther++;
            else res.missRelated++;
          } else if (plan.intent.allOf.some((t) => !(heldBy.get(ownId) ?? []).includes(t))) res.missRequired++;
          else if (rank >= 50) res.missRank++;
          else if (q && mineVec && dot(mineVec, q) < TIER2_FLOOR) res.missFloor++;
          else res.missCut++;
        }
        res.replay = Object.fromEntries(Object.entries(DECISION_RULES).map(([name, rule]) => [name, replayRule(res.decisions, rule)]));
        cwp.push(res);
        process.stdout.write(`work profiles, ${v.name}: ${res.published} published, ${res.found} of ${res.searched} found (${res.first} first), ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
      }
      process.stdout.write(`hirer plans: ${plans.size} of ${sentenceOf.size}, $${(planCost / 1e6).toFixed(4)}\n`);
    }

    // The report: counts only.
    const date = new Date().toISOString().slice(0, 10);
    const lines: string[] = [];
    const say = (l = '') => lines.push(l);
    say(`# Real-resume benchmark, ${date}`);
    say();
    say(
      `Generated by \`test/workResume.eval.test.ts\` (RESUME_EVAL=1; workspace decision 0021, the founder's exception of 2026-10-28) on ${sample.length} resumes of Kaggle's public LiveCareer dataset, seed ${seed}, outside every repository; ${excluded} of ${records.length} resumes carry an email or a phone number and are never sampled. Pages as the phone sends them (JPEG, long side 1,600 px). Each field is scored against the labels in the resume's own HTML: right (counting those the worker would also be asked about), or wrong, and a wrong field nobody would ask about is silent. Readings made with the parse prompt tagged \`${PROMPT_TAG}\`. Months: a job's length, a current job running to the resume's latest date, right within one month. Certificates: the keywords the certifications section names (OSHA, CDL, forklift, …). Counts only; no resume's text, title or date is in this file. ${Math.round((Date.now() - started) / 60_000)} min in all.`,
    );
    say();
    say('## All resumes');
    say();
    for (const l of summaryRows(paths, () => true)) say(l);
    say();
    for (const group of ['trades', 'engineering', 'IT']) {
      say(`## ${group}`);
      say();
      for (const l of summaryRows(paths, (r) => GROUPS[r.category] === group)) say(l);
      say();
    }
    // The pipeline's section only when two cloud readers made one.
    const pipelineTraces = [...cloud.values()].map((c) => c.trace).filter((t): t is PipelineTrace => !!t);
    if (pipelineTraces.length) {
      const traces = pipelineTraces;
      const disputes = traces.flatMap((t) => t.disputes);
      const byClef = traces.reduce((s, t) => s + t.settledByClef, 0);
      const byArbiter = traces.reduce((s, t) => s + t.settledByArbiter, 0);
      say('## The cloud pipeline');
      say();
      say(`- Disputes between the two readers: ${disputes.length} on ${traces.length} resumes (${disputes.filter((d) => d.kind === 'presence').length} items only one reader read).`);
      say(`- Settled by clef-flash at ${floor}: ${byClef}; by DeepSeek at high effort, on the rest: ${byArbiter}${traces.some((t) => t.arbiterFailure) ? ` (${traces.filter((t) => t.arbiterFailure).length} arbiter calls failed)` : ''}.`);
      say(`- Questions left for the worker after the arbiter: ${traces.reduce((s, t) => s + t.afterArbiter.open.length, 0)} (${(traces.reduce((s, t) => s + t.afterArbiter.open.length, 0) / Math.max(1, traces.length)).toFixed(1)} per resume).`);
      say(`- Resumes whose text was cut for Clef (over ${CLEF_STATE_MAX_CHARS} characters): ${traces.filter((t) => t.clefTruncated).length}.`);
      if (traces.some((t) => t.review)) {
        const rv = traces.map((t) => t.review!).filter(Boolean);
        say(`- The full check changed ${rv.reduce((s, x) => s + x.corrections, 0)} fields and added ${rv.reduce((s, x) => s + x.added, 0)} jobs on ${rv.length} resumes${rv.some((x) => x.failure) ? ` (${rv.filter((x) => x.failure).length} calls failed)` : ''}.`);
      }
      const failures = [...cloud.values()].flatMap((c) => [c.a, c.b]).filter((x): x is CachedReading => !!x && !x.ok);
      if (failures.length) say(`- Failed cloud reads: ${failures.length}.`);
      say();
    }
    if (cwp.length) {
      say('## Work profiles and the hirer\'s search');
      say();
      say(`Each variant's job titles (up to five, latest first) and skills (up to ${process.env.RESUME_CWP_SKILLS ?? 10}) published as a listing on a fresh replica of the registry (ESCO, the US layer, the certificate seed; the phone's EmbeddingGemma 2 vectors; clef-flash in the band), and a hirer's sentence written from the resume's latest true title ("We need an experienced … for a project in Houston, Texas.") searched over each variant's listings with one plan per resume and the decision pass on: Clef (not flash) classifying each finalist against the job (decision 0069). The labels' own listings are the ceiling.`);
      say();
      say('| Variant | Listings | Same occupations as the labels | Labels\' occupations kept | Found | First | Top 5 | Tier 1 | Missed: no listing | Missed: remote | Missed: Clef, other work | Missed: Clef, a token miss not promoted | Missed: a required token it lacks | Missed: past the vector\'s 50 | Missed: under the cosine floor | Missed: not among the gate\'s fifty | Decisions failed | Search s, median / p90 | Clef calls a search | Cost a search | Cost |');
      say('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
      for (const c of cwp) {
        say(`| ${c.variant} | ${c.published}/${c.resumes} | ${c.compared ? `${c.same}/${c.compared} (${pct(c.same, c.compared)})` : '–'} | ${pct(c.kept, c.labelTokens)} | ${c.found}/${c.searched} (${pct(c.found, c.searched)}) | ${c.first} | ${c.top5} | ${c.tier1} | ${c.missUnpublished} | ${c.missRemote} | ${c.missOther} | ${c.missRelated} | ${c.missRequired} | ${c.missRank} | ${c.missFloor} | ${c.missCut} | ${c.decideFailed} | ${quantile(c.searchMs, 0.5)} / ${quantile(c.searchMs, 0.9)} | ${median(c.decideCalls)} | $${(c.searchCostMicroUsd / Math.max(1, c.searchMs.length) / 1e6).toFixed(4)} | $${(c.costMicroUsd / 1e6).toFixed(4)} |`);
      }
      say();
      say('### The decision rule, replayed');
      say();
      say(`Every finalist the decision pass considered in the searches above (kept or left out: the gate's tier 1 and the vector-strong misses, with Clef's probabilities) replayed under other rules, with no new model call. A cell: the resume's own listing found, first, in the top five; then the finalists kept and the Clef calls made per search. The second row is the rule as built.`);
      say();
      say(`| Rule | ${cwp.map((c) => c.variant).join(' | ')} |`);
      say(`|---|${cwp.map(() => '---|').join('')}`);
      for (const name of Object.keys(DECISION_RULES)) {
        say(`| ${name} | ${cwp.map((c) => { const x = c.replay[name]!; const per = (n: number) => (n / Math.max(1, c.decisions.length)).toFixed(1); return `${x.found} / ${x.first} / ${x.top5} · ${per(x.kept)} kept · ${per(x.asked)} calls`; }).join(' | ')} |`);
      }
      say();
    }
    say('Cells: the share right, and in brackets the share wrong with no question to the worker. Questions per resume: the fields a resume would still ask its worker about.');
    say();
    const n = sample.length;
    const reportPath = (() => {
      for (let i = 1; ; i++) {
        const p = join(__dirname, 'work-eval', `resumes-${date}-n${n}${i === 1 ? '' : `-${i}`}.md`);
        if (!existsSync(p)) return p;
      }
    })();
    writeFileSync(reportPath, lines.join('\n'));
    mkdirSync(join(out, 'reports'), { recursive: true });
    writeFileSync(join(out, 'reports', `resumes-${date}-n${n}.json`), JSON.stringify({ date, seed, plan, sample: sample.map((r) => r.id), paths: Object.fromEntries(paths), cwp }, null, 1) + '\n');
    process.stdout.write(`report: ${reportPath}\n`);
    expect(sample.length).toBeGreaterThan(0);
  }, 12 * 3_600_000);
});
