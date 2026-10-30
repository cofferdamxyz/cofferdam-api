// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The founder's job-profile flow on real vacancies (opt-in:
 * JOB_PROFILE_EVAL=1), from the Mac. The ads come from a saved run of the
 * jobs benchmark (JOBS_RUN, `test/workJobs.eval.test.ts`), with the drafts
 * today's pipeline made of them. Each ad is read by the pinned
 * `work-job-profile` model (`services/work/jobProfile.ts`) into a job profile,
 * over the Workers AI REST API, and set against today's texts. Both arms embed
 * with EmbeddingGemma 2's LiteRT-LM file on the Mac (JOBS_LITERT_FILE), as the
 * phone does:
 * - **today:** the listing text of today's draft (the extractor's titles,
 *   skills and certificates), and as the hirer the title with the excerpt of
 *   the requirements;
 * - **profile:** the profile's text, as the listing and as the hirer.
 *
 * It measures the fast lane, vectors only: each ad, as the hirer, ranks the
 * other ads by cosine, in its own region and across all three markets.
 * Relevance is by ISCO-08 unit group, under two references, so neither arm
 * grades itself alone. Both are snapped on the v2 replica of the registry
 * (`test/work-eval/replica.ts`, never minting):
 * - **today's title**, as production snaps a worker's title (its language and
 *   its market);
 * - **the profile's occupation**, in English.
 *
 * Each reference favours its own arm, so a judge settles it without one:
 * Clef (not flash, `work-decide`) reads each pair of ads in either arm's
 * first five, in their own languages, and says whether they hire for the
 * same occupation. Its answers are cached beside the run.
 *
 * Writes `test/work-eval/jobs-profile-<date>-n<N>-<effort>.md`, with numbers
 * and the ads' titles only. The readings are cached as JSON beside the run
 * (JOB_PROFILE_CACHE), with the model's answers and the request they
 * answered: a rerun reads no ad twice for the same request, and reads every
 * cached answer again through the current reader.
 *
 *   cd cofferdam-api && JOB_PROFILE_EVAL=1 JOBS_RUN=~/Development/jobs-bench/runs/2026-10-27-n300-seed69.json \
 *     JOBS_DIR=~/Development/jobs-bench/raw/2026-10-27 \
 *     ESCO_SQL=~/Development/esco/import/cofferdam-import US_SQL=~/Development/us-layer-data/cofferdam-import \
 *     VECTORS_DIR=~/Development/esco/import/registry-embeddinggemma-2-litert \
 *     JOBS_LITERT_FILE=~/models/embeddinggemma-2-litert/embeddinggemma-2-text-270m.litertlm \
 *     direnv exec .. yarn vitest run test/workJobProfile.eval.test.ts
 *
 * JOB_PROFILE_SHORT=1 runs the second test instead: short requests, where a
 * title has little context. It reads the hiring set's requests for a worker
 * (`test/chat-eval/hire-prompts.json`) and the locale fixture's 39 strings as
 * vacancy headlines ("Se solicita velador", in the string's market), once
 * with reasoning off and once at low effort. Each English occupation is
 * snapped on the v2 replica against the fixture's expected tokens, into
 * `test/work-eval/jobs-profile-short-<date>.md` (ESCO_SQL, US_SQL,
 * VECTORS_DIR and JOBS_LITERT_FILE as above; no JOBS_RUN).
 *
 * JOB_PROFILE_TITLE=0 reads each ad's description alone, without its title;
 * by default the profile reads both, as a hirer pastes a vacancy, and the
 * report's name gains `-description` when the title is left out.
 *
 * JOB_PROFILE_EFFORT sets the reading's reasoning (`none`, the default, as
 * production reads a vacancy, `low`, `medium` or `high`), and names the cache
 * and the report;
 * JOB_PROFILE_N reads the first N ads only; JOB_PROFILE_PARALLEL (3) is how
 * many readings run at once, since DeepSeek on Workers AI refuses bursts.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInference, type Inference } from '../src/services/inference/index.js';
import { clefInput, readNoul } from '../src/services/work/clef.js';
import { usageOrEstimate, type WorkCall } from '../src/services/work/fields.js';
import { jobProfileRequest, MAX_JOB_TEXT, profileText, readJobProfile, type JobProfile, type ProfileDrop, type ProfileEffort } from '../src/services/work/jobProfile.js';
import { resultObject } from '../src/services/work/parse.js';
import { EMBEDDINGGEMMA_2_LITERT, snap, tauFor, type RegistryDeps } from '../src/services/work/registry.js';
import { createRestAi, RestAiError } from './chat-eval/restAi.js';
import hirePrompts from './chat-eval/hire-prompts.json';
import localeCases from './fixtures/work/locale-cases.json';
import { deidentify } from './work-eval/jobAds.js';
import { embedAll, loadReplica, ReplicaIndex } from './work-eval/replica.js';

const LIVE = process.env.JOB_PROFILE_EVAL === '1';
const SHORT = process.env.JOB_PROFILE_SHORT === '1';
const home = (p: string) => p.replace(/^~(?=\/|$)/, homedir());
const env = (k: string) => (process.env[k] ? home(process.env[k]) : '');
const MODEL = EMBEDDINGGEMMA_2_LITERT;
/** DeepSeek V4.1 Flash's price per million tokens, input and output (`services/inference` MODEL_PRICES). */
const PRICE = { input: 0.3, output: 1.2 };

/** A vacancy as the saved run recorded it: today's draft, its region and language, and its sentence as the hirer. */
interface RunVacancy {
  pseudonym: string;
  id: string;
  country: 'usa' | 'brazil' | 'mexico';
  lang: 'en' | 'pt' | 'es';
  region: string;
  titles: string[];
  skills: string[];
  certificates: string[];
  sentence: string;
}

interface Reading {
  ok: boolean;
  profile: JobProfile | null;
  dropped: ProfileDrop[];
  /** The model's answer, so a changed reader reads it again; absent from readings cached before it was kept. */
  answer?: Record<string, unknown> | null;
  /** The request it answered, the ad as a placeholder, with what it read (`requestVersion`); absent before it was kept. */
  version?: string;
  ms: number;
  tokensIn: number;
  tokensOut: number;
  tries: number;
  /** Why each failed try failed: Workers AI's status, a thrown error's name, or `out_of_shape`. */
  failures?: string[];
}

/** A request as a version: the request with the ad as a placeholder, and what of the ad it read, hashed. */
function requestVersion(req: Record<string, unknown>, recipe: string): string {
  return createHash('sha256').update(JSON.stringify({ req, recipe })).digest('hex').slice(0, 12);
}

/** The version readings cached on 2026-10-30 before the recipe was kept: the request with its user message blanked. */
function blankedVersion(req: Record<string, unknown>): string {
  const messages = (req.messages as { role: string; content: string }[]).map((m) => (m.role === 'user' ? { role: 'user' } : m));
  return createHash('sha256').update(JSON.stringify({ ...req, messages })).digest('hex').slice(0, 12);
}

/** The ad in a request version's sample, where every request carries its own. */
const AD_PLACEHOLDER = '<the ad>';

/** Today's listing text: `listingText` of the draft, with no English names added. */
const todayListing = (v: RunVacancy) => [v.titles.join('; '), v.skills.join('; '), v.certificates.join('; ')].filter(Boolean).join('. ');
const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

async function parallel<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
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

describe.skipIf(!LIVE)('the job profile on real vacancies (live, Workers AI, the Mac’s EmbeddingGemma 2)', () => {
  it('reads every ad into a profile, ranks the ads by each arm’s vectors and writes the report', async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const [runFile, jobsDir, escoSql, usSql, vectorsDir, litert] = ['JOBS_RUN', 'JOBS_DIR', 'ESCO_SQL', 'US_SQL', 'VECTORS_DIR', 'JOBS_LITERT_FILE'].map(env);
    if (!accountId || !token) throw new Error('JOB_PROFILE_EVAL needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    if (!runFile || !jobsDir || !escoSql || !usSql || !vectorsDir || !litert) throw new Error('JOB_PROFILE_EVAL needs JOBS_RUN, JOBS_DIR, ESCO_SQL, US_SQL, VECTORS_DIR and JOBS_LITERT_FILE');
    const started = Date.now();

    // The ads: the run's sample and today's drafts, with each ad's description from the raw pull.
    const run = JSON.parse(readFileSync(runFile, 'utf8')) as { seed: number; date: string; vacancies: RunVacancy[] };
    const limit = Number(process.env.JOB_PROFILE_N ?? 0);
    const sample = limit > 0 ? run.vacancies.slice(0, limit) : run.vacancies;
    const raw = new Map<string, { title: string; description: string }>();
    for (const f of ['usa.jsonl', 'brazil.jsonl', 'mexico.jsonl']) {
      for (const line of readFileSync(join(jobsDir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const r = JSON.parse(line) as { id: string; title?: string; description?: string };
        if (typeof r.description === 'string') raw.set(r.id, { title: r.title ?? '', description: r.description });
      }
    }
    const missing = sample.filter((v) => !raw.has(v.id));
    if (missing.length) throw new Error(`${missing.length} sampled ads are not in ${jobsDir}`);

    // 1. Each ad read into a profile, cached by ad.
    const ai = createRestAi({ accountId, token });
    const inference: Inference = createInference({ WORK_EMBED_MODEL: MODEL }, { ai })!;
    const profileModel = await inference.model('work-job-profile');
    const effort = (process.env.JOB_PROFILE_EFFORT ?? 'none') as ProfileEffort;
    if (!['none', 'low', 'medium', 'high'].includes(effort)) throw new Error(`JOB_PROFILE_EFFORT is none, low, medium or high, not ${effort}`);
    const cacheFile = env('JOB_PROFILE_CACHE') || runFile.replace(/\.json$/, `.profiles-${profileModel.split('/').pop()}-${effort}${process.env.JOB_PROFILE_TITLE !== '0' ? '-titled' : ''}.json`);
    const cache: Record<string, Reading> = existsSync(cacheFile) ? (JSON.parse(readFileSync(cacheFile, 'utf8')) as { readings: Record<string, Reading> }).readings : {};
    // What the profile reads of an ad: its title and its description, as a hirer pastes a vacancy (JOB_PROFILE_TITLE=0
    // reads the description alone, as the runs of 2026-10-30 before 21:00 did).
    const titled = process.env.JOB_PROFILE_TITLE !== '0';
    const recipe = titled ? 'title+description' : 'description';
    const textOf = (v: RunVacancy) => {
      const ad = raw.get(v.id)!;
      return deidentify(titled ? `${ad.title}\n\n${ad.description}` : ad.description).slice(0, MAX_JOB_TEXT);
    };
    // A cached reading counts only for the request made now and what it read. Readings cached before the recipe was
    // kept read descriptions alone, with the user message blanked in their version; those cached before any version
    // was kept were made without the temperature (reasoning off reads at temperature 0 since).
    const sampleRequest = jobProfileRequest(profileModel, AD_PLACEHOLDER, { lang: 'en', market: 'us-tx' }, effort);
    const version = requestVersion(sampleRequest, recipe);
    const { temperature: _temperature, ...withoutTemperature } = sampleRequest;
    const accepted = new Set([version, ...(titled ? [] : [blankedVersion(sampleRequest)])]);
    const legacyFresh = !titled && blankedVersion(withoutTemperature) === blankedVersion(sampleRequest);
    const fresh = (r: Reading | undefined) => !!r?.ok && (r.version ? accepted.has(r.version) : legacyFresh);
    const todo = sample.filter((v) => !fresh(cache[v.id]));
    let done = 0;
    await parallel(todo, Number(process.env.JOB_PROFILE_PARALLEL ?? 3), async (v) => {
      const text = textOf(v);
      const req = jobProfileRequest(profileModel, text, { lang: v.lang, market: v.region }, effort);
      const failures: string[] = [];
      let reading: Reading | null = null;
      // Workers AI answers a burst with 429s: back off 3, 6, 12, 24 and 30 seconds before giving the ad up.
      for (let tries = 1; tries <= 6 && !reading?.ok; tries++) {
        const t0 = Date.now();
        let result: unknown = null;
        try {
          result = await inference.run('work-job-profile', req);
        } catch (err) {
          failures.push(err instanceof RestAiError ? String(err.status) : err instanceof Error ? err.name : 'error');
        }
        const out = result == null ? null : readJobProfile(result, text, v.lang);
        if (result != null && !out) failures.push('out_of_shape');
        const usage = result == null ? { tokensIn: 0, tokensOut: 0 } : usageOrEstimate(result, req);
        reading = {
          ok: out != null,
          profile: out?.profile ?? null,
          dropped: out?.dropped ?? [],
          answer: result == null ? null : resultObject(result),
          version,
          ms: Date.now() - t0,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          tries,
          failures: [...failures],
        };
        if (!out && tries < 6) await new Promise((r) => setTimeout(r, Math.min(30_000, 3_000 * 2 ** (tries - 1))));
      }
      cache[v.id] = reading!;
      if (++done % 10 === 0 || done === todo.length) {
        writeFileSync(cacheFile, JSON.stringify({ model: profileModel, readings: cache }, null, 2) + '\n');
        process.stdout.write(`read ${done} of ${todo.length}, ${((Date.now() - started) / 1000).toFixed(0)} s\n`);
      }
    });
    writeFileSync(cacheFile, JSON.stringify({ model: profileModel, readings: cache }, null, 2) + '\n');
    // Every cached answer read again through the current reader: from the model's answer where the cache kept it,
    // else from the profile it kept, whose items the earlier reader had dropped stay dropped (a reading cached without
    // its answer may so undercount what the current reader keeps).
    let rechecked = 0;
    const recheckDrops: ProfileDrop[] = [];
    for (const v of sample) {
      const r = cache[v.id];
      if (!r?.ok || !r.profile) continue;
      const p = r.profile;
      const kept = { occupation: p.occupation ?? { en: '', source: '' }, skills: p.skills, certificates: p.certificates, languages: p.languages, experienceYears: p.experienceYears ?? { min: 0, source: '' }, scope: p.scope };
      const again = readJobProfile({ response: r.answer ?? kept }, textOf(v), v.lang);
      if (!again) continue;
      rechecked++;
      const before = new Set(r.dropped.map((d) => `${d.field}|${d.value}`));
      const added = again.dropped.filter((d) => !before.has(`${d.field}|${d.value}`));
      recheckDrops.push(...(r.answer ? added : again.dropped));
      cache[v.id] = { ...r, profile: again.profile, dropped: r.answer ? again.dropped : [...r.dropped, ...again.dropped] };
    }
    const readings = sample.map((v) => ({ v, r: cache[v.id]! }));
    const read = readings.filter((x) => x.r.ok && x.r.profile);

    // 2. The texts each arm embeds, and the titles the references snap, embedded once per role.
    const profileOf = (v: RunVacancy) => cache[v.id]?.profile ?? null;
    const todayTitle = (v: RunVacancy) => v.titles[0] ?? raw.get(v.id)!.title;
    const docTexts = [...sample.map(todayListing), ...read.map((x) => profileText(x.r.profile!)), ...sample.map(todayTitle), ...read.map((x) => x.r.profile!.occupation?.en ?? '')];
    const queryTexts = [...sample.map((v) => v.sentence), ...read.map((x) => profileText(x.r.profile!)), ...sample.map(todayTitle), ...read.map((x) => x.r.profile!.occupation?.en ?? '')];
    const docs = embedAll(docTexts, 'document', MODEL, litert);
    const queries = embedAll(queryTexts, 'query', MODEL, litert);

    // 3. The references: each ad's occupation snapped on the v2 replica, never minting.
    const replica = await loadReplica(escoSql, usSql);
    const index = ReplicaIndex.load(vectorsDir, MODEL);
    const registry: RegistryDeps = { inference, store: replica.store, index, tau: tauFor(MODEL) };
    const refCalls: WorkCall[] = [];
    let refFailed = 0;
    const backoff = (tries: number) => new Promise((r) => setTimeout(r, Math.min(30_000, 2_000 * 2 ** (tries - 1))));
    // A snap whose Clef or pivot call failed (Workers AI refuses bursts) is no token for a reason that is not the
    // registry's: it is snapped again, and one that still fails is counted.
    const snapTitle = async (raw0: string, lang: RunVacancy['lang'], market?: string) => {
      const t = norm(raw0);
      const q = queries.get(t);
      const d = docs.get(t);
      if (!t || !q || !d) return null;
      for (let tries = 1; tries <= 5; tries++) {
        try {
          const out = await snap(registry, { kind: 'pos', raw: t, lang, ...(market ? { market } : {}), mint: false, vectors: { query: q, document: d } });
          refCalls.push(...out.calls);
          if (out.calls.every((c) => c.ok)) return out.token;
        } catch {
          // The store and the index are local: only a hosted call fails here.
        }
        await backoff(tries);
      }
      refFailed++;
      return null;
    };
    const refs = await parallel(sample, 4, async (v) => {
      const p = profileOf(v);
      const [today, profile] = await Promise.all([snapTitle(todayTitle(v), v.lang, v.region), p?.occupation ? snapTitle(p.occupation.en, 'en') : Promise.resolve(null)]);
      return { today, profile };
    });
    const tokens = await replica.store.tokens([...new Set(refs.flatMap((r) => [r.today, r.profile]).filter((t): t is string => !!t))]);
    const iscoOf = (t: string | null) => {
      const c = t ? tokens.get(t)?.iscoCode : null;
      return c && /^\d{4}$/.test(c) ? c : null;
    };
    const reference = {
      today: sample.map((_, i) => iscoOf(refs[i]!.today)),
      profile: sample.map((_, i) => iscoOf(refs[i]!.profile)),
    } as const;

    // 4. The fast lane: each ad as the hirer against the other ads' listing vectors, by cosine.
    type Arm = 'today' | 'profile';
    const vecs = (arm: Arm, v: RunVacancy) => {
      if (arm === 'today') return { q: queries.get(norm(v.sentence)), d: docs.get(norm(todayListing(v))) };
      const p = profileOf(v);
      const t = p ? norm(profileText(p)) : '';
      return { q: t ? queries.get(t) : undefined, d: t ? docs.get(t) : undefined };
    };
    // Both arms over the same ads: those the profile read and both arms could embed.
    const both = sample.map((v, i) => ({ v, i })).filter(({ v }) => vecs('today', v).q && vecs('today', v).d && vecs('profile', v).q && vecs('profile', v).d);
    const rank = (arm: Arm, ref: readonly (string | null)[], pool: 'region' | 'all') => {
      let queriesN = 0;
      let p1 = 0;
      let p3 = 0;
      let p5 = 0;
      let rr = 0;
      let crossTop5 = 0;
      let near5 = 0;
      for (const { v, i } of both) {
        const unit = ref[i];
        if (!unit) continue;
        const others = both.filter((o) => o.i !== i && ref[o.i] && (pool === 'all' || o.v.region === v.region));
        if (!others.some((o) => ref[o.i] === unit)) continue;
        const q = vecs(arm, v).q!;
        const ranked = others.map((o) => ({ o, s: dot(q, vecs(arm, o.v).d!) })).sort((a, b) => b.s - a.s);
        const same = (k: number) => ranked.slice(0, k).filter((x) => ref[x.o.i] === unit).length;
        queriesN++;
        p1 += same(1);
        p3 += same(3) / 3;
        p5 += same(5) / 5;
        near5 += ranked.slice(0, 5).filter((x) => ref[x.o.i]!.slice(0, 3) === unit.slice(0, 3)).length / 5;
        const first = ranked.findIndex((x) => ref[x.o.i] === unit);
        rr += first >= 0 ? 1 / (first + 1) : 0;
        crossTop5 += ranked.slice(0, 5).filter((x) => ref[x.o.i] === unit && x.o.v.country !== v.country).length;
      }
      const f = (x: number) => (queriesN ? (x / queriesN).toFixed(3) : '—');
      return { queriesN, p1: f(p1), p3: f(p3), p5: f(p5), near5: f(near5), mrr: f(rr), crossTop5 };
    };

    // 4b. A judge for both arms, which needs no reference: Clef (not flash) reads two ads in their own words, each
    // its title and the excerpt of its requirements (the sentence the run asked as the hirer), and says whether they
    // hire for the same occupation. Every pair in either arm's first five is judged once, in id order, and cached.
    const judgeModel = await inference.model('work-decide');
    const judgeFile = runFile.replace(/\.json$/, `.judged-${judgeModel.split('/').pop()}.json`);
    const SAME = 'Do the two job ads hire for the same occupation, so that a worker suited to one is suited to the other, whatever the language, the place or the employer?';
    // The judge's answers hold for its model and its question only.
    const judgeCache = existsSync(judgeFile) ? (JSON.parse(readFileSync(judgeFile, 'utf8')) as { model: string; question: string; pairs: Record<string, number> }) : null;
    const judged: Record<string, number> = judgeCache && judgeCache.model === judgeModel && judgeCache.question === SAME ? judgeCache.pairs : {};
    const COUNTRY = { usa: 'the United States', brazil: 'Brazil', mexico: 'Mexico' } as const;
    const clip = (t: string, max: number) => (t.length <= max ? t : `${t.slice(0, max).replace(/\s+\S*$/, '')}…`);
    const pairKey = (a: RunVacancy, b: RunVacancy) => (a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);
    const topOf = (arm: Arm, v: RunVacancy, i: number, pool: 'region' | 'all', k: number) => {
      const q = vecs(arm, v).q!;
      return both
        .filter((o) => o.i !== i && (pool === 'all' || o.v.region === v.region))
        .map((o) => ({ o, s: dot(q, vecs(arm, o.v).d!) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, k)
        .map((x) => x.o);
    };
    const pairs = new Map<string, [RunVacancy, RunVacancy]>();
    for (const { v, i } of both) for (const arm of ['today', 'profile'] as const) for (const pool of ['region', 'all'] as const) for (const o of topOf(arm, v, i, pool, 5)) pairs.set(pairKey(v, o.v), v.id < o.v.id ? [v, o.v] : [o.v, v]);
    const toJudge = [...pairs].filter(([k]) => judged[k] == null);
    let judgedN = 0;
    let judgeFailed = 0;
    const saveJudged = () => writeFileSync(judgeFile, JSON.stringify({ model: judgeModel, question: SAME, pairs: judged }, null, 2) + '\n');
    await parallel(toJudge, 4, async ([key, [a, b]]) => {
      const state = `Job ad 1, from ${COUNTRY[a.country]}:\n${clip(a.sentence, 600)}\n\nJob ad 2, from ${COUNTRY[b.country]}:\n${clip(b.sentence, 600)}`;
      for (let tries = 1; tries <= 5; tries++) {
        try {
          const p = readNoul(await inference.run('work-decide', clefInput(judgeModel, state, { same: { type: 'noul', instructions: SAME } })), 'same');
          if (p != null) {
            judged[key] = p;
            break;
          }
        } catch {
          // A refused burst: try again after the backoff.
        }
        if (tries === 5) judgeFailed++;
        else await backoff(tries);
      }
      if (++judgedN % 100 === 0) {
        saveJudged();
        process.stdout.write(`judged ${judgedN} of ${toJudge.length}\n`);
      }
    });
    saveJudged();
    const judgedRank = (arm: Arm, pool: 'region' | 'all') => {
      let n = 0;
      let p1 = 0;
      let p3 = 0;
      let p5 = 0;
      let cross = 0;
      for (const { v, i } of both) {
        const top = topOf(arm, v, i, pool, 5);
        if (!top.length) continue;
        const same = top.map((o) => (judged[pairKey(v, o.v)] ?? 0) >= 0.5);
        const share = (k: number) => same.slice(0, k).filter(Boolean).length / Math.min(k, top.length);
        n++;
        p1 += share(1);
        p3 += share(3);
        p5 += share(5);
        cross += top.filter((o, j) => same[j] && o.v.country !== v.country).length;
      }
      const f = (x: number) => (n ? (x / n).toFixed(3) : '—');
      return { n, p1: f(p1), p3: f(p3), p5: f(p5), cross };
    };

    // 5. The report.
    const date = new Date().toISOString().slice(0, 10);
    const n = sample.length;
    const byMarket = (pick: (v: RunVacancy) => boolean) => (['usa', 'brazil', 'mexico'] as const).map((c) => `${c} ${sample.filter((v) => v.country === c && pick(v)).length}`).join(', ');
    const mean = (xs: number[]) => (xs.length ? (xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(1) : '—');
    const median = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return s.length ? s[Math.floor(s.length / 2)]! : 0;
    };
    const drops = read.flatMap((x) => x.r.dropped);
    const dropCount = (reason: ProfileDrop['reason']) => drops.filter((d) => d.reason === reason).length;
    const cost = read.reduce((s, x) => s + (x.r.tokensIn * PRICE.input + x.r.tokensOut * PRICE.output) / 1e6, 0);
    const refCost = refCalls.reduce((s, c) => s + (c.usage.tokensIn + c.usage.tokensOut), 0);
    const agree = sample.filter((_, i) => reference.today[i] && reference.profile[i] && reference.today[i] === reference.profile[i]).length;
    const placedBoth = sample.filter((_, i) => reference.today[i] && reference.profile[i]).length;
    const table = (ref: 'today' | 'profile') =>
      (['region', 'all'] as const).flatMap((pool) =>
        (['today', 'profile'] as const).map((arm) => {
          const m = rank(arm, reference[ref], pool);
          return `| ${pool === 'region' ? 'its region' : 'all three markets'} | ${arm === 'today' ? 'today' : 'the profile'} | ${m.queriesN} | ${m.p1} | ${m.p3} | ${m.p5} | ${m.near5} | ${m.mrr} | ${pool === 'all' ? m.crossTop5 : '—'} |`;
        }),
      );
    const examples = sample
      .map((v, i) => ({ v, i, p: profileOf(v) }))
      .filter((x) => x.v.country !== 'usa' && x.p)
      .filter((x, _i, all) => all.filter((y) => y.v.country === x.v.country).indexOf(x) < 8)
      .map(
        (x) =>
          `| ${x.v.country} | ${raw.get(x.v.id)!.title.replace(/\|/g, '/')} | ${todayTitle(x.v).replace(/\|/g, '/')} → ${refs[x.i]!.today ?? '—'} | ${x.p!.occupation?.en ?? '—'} → ${refs[x.i]!.profile ?? '—'} | ${x.p!.skills.length} skills, ${x.p!.certificates.map((c) => c.en).join('; ') || 'no certificate'} |`,
      );
    const md = [
      `# The job profile on real vacancies, ${date}`,
      '',
      `${n} job ads JobSpy pulled from Indeed (${byMarket(() => true)}): the sample of the saved run of ${run.date} (seed ${run.seed}), with the drafts today's pipeline made of them. Each ad, ${titled ? 'its title and its description' : 'its description alone (not its title, which today\'s arm reads)'}, de-identified as the benchmark does, was read by \`${profileModel}\` (\`work-job-profile\`, reasoning \`${effort}\`) into a job profile, over the Workers AI REST API from the Mac. Both arms embed with ${MODEL} on the Mac's CPU (the v2 generation, as the phone does). Today: the listing text of today's draft as the listing, the title and the requirements' excerpt as the hirer. The profile: its text (\`profileText\`) as both.`,
      '',
      '## The reading',
      '',
      `- Profiles read: ${read.length} of ${n}; ${readings.filter((x) => x.r.ok && x.r.tries === 1).length} on the first try and ${readings.filter((x) => x.r.ok && x.r.tries > 1).length} after a retry, ${process.env.JOB_PROFILE_PARALLEL ?? 3} readings at a time. Failed tries by cause: ${Object.entries(readings.flatMap((x) => x.r.failures ?? []).reduce<Record<string, number>>((m, f) => ({ ...m, [f]: (m[f] ?? 0) + 1 }), {})).map(([k, c]) => `${k} ×${c}`).join(', ') || 'none recorded'}${readings.some((x) => x.r.ok && x.r.tries > 1 && !x.r.failures) ? ' (readings cached before causes were kept are not counted)' : ''}.`,
      `- Read again through the current reader: ${rechecked} cached profiles, which dropped ${recheckDrops.length} more items (${['not_in_text', 'invalid', 'duplicate', 'over_cap'].map((r) => `${r} ${recheckDrops.filter((d) => d.reason === r).length}`).join(', ')}).`,
      `- Timing: median ${median(read.map((x) => x.r.ms))} ms an ad; $${cost.toFixed(4)} in all, $${(cost / Math.max(1, read.length)).toFixed(5)} an ad (${PRICE.input} and ${PRICE.output} dollars per million tokens in and out).`,
      `- Per profile: ${mean(read.map((x) => x.r.profile!.skills.length))} skills (${mean(read.map((x) => x.r.profile!.skills.filter((s) => s.required).length))} required), ${mean(read.map((x) => x.r.profile!.certificates.length))} certificates, ${mean(read.map((x) => x.r.profile!.languages.length))} languages; an occupation in ${read.filter((x) => x.r.profile!.occupation).length}, years of experience in ${read.filter((x) => x.r.profile!.experienceYears).length}, remote ${read.filter((x) => x.r.profile!.scope === 'remote').length}.`,
      `- Dropped by the reader: ${dropCount('not_in_text')} items whose source does not say them (not whole words of the ad, or years, a language or a certificate's codes their source does not hold), ${dropCount('invalid')} invalid, ${dropCount('duplicate')} duplicates, ${dropCount('over_cap')} over the cap.`,
      `- The text each arm embeds, in characters: today's listing ${median(sample.map((v) => todayListing(v).length))} and hirer ${median(sample.map((v) => v.sentence.length))} (medians), the profile's ${median(read.map((x) => profileText(x.r.profile!).length))}.`,
      '',
      '## The references',
      '',
      `Each ad's occupation, snapped on the v2 replica (ESCO and the US layer, never minting; ${refCalls.length} hosted calls, ${refCost} tokens; a snap whose hosted call failed was snapped again, and ${refFailed} still failed): today's title, as production snaps a worker's title (${byMarket((v) => !!reference.today[sample.indexOf(v)])} placed in an ISCO-08 unit group), and the profile's English occupation (${byMarket((v) => !!reference.profile[sample.indexOf(v)])}). Where both place the ad, they agree on its unit group for ${agree} of ${placedBoth}.`,
      '',
      '## The fast lane, judged',
      '',
      `Each ad as the hirer ranks the other ads by cosine, over the ${both.length} ads both arms embed, in its own region and across all three markets. A judge needs no reference: \`${judgeModel}\` (\`work-decide\`, Clef not flash) read each pair in either arm's first five, each ad as its title and the excerpt of its requirements in its own language, and answered "${SAME}" A result is the same occupation at 0.5 or above. ${pairs.size} pairs, ${judgeFailed} left unjudged after five tries (counted as not the same).`,
      '',
      '| Pool | Arm | Queries | P@1 | P@3 | P@5 | Same occupation from another country in the first five |',
      '|---|---|---|---|---|---|---|',
      ...(['region', 'all'] as const).flatMap((pool) =>
        (['today', 'profile'] as const).map((arm) => {
          const m = judgedRank(arm, pool);
          return `| ${pool === 'region' ? 'its region' : 'all three markets'} | ${arm === 'today' ? 'today' : 'the profile'} | ${m.n} | ${m.p1} | ${m.p3} | ${m.p5} | ${pool === 'all' ? m.cross : '—'} |`;
        }),
      ),
      '',
      '## The fast lane, by reference',
      '',
      `Each ad as the hirer ranks the other ads by cosine, over the ${both.length} ads both arms embed; a query counts when its reference places it and the pool holds another ad of its unit group. Precision at 1, 3 and 5 is the share of the first results in the same unit group, near the share in the same minor group (three digits); cross-market counts the same-unit-group results in the first five from another country.`,
      '',
      '**Relevance by today’s title:**',
      '',
      '| Pool | Arm | Queries | P@1 | P@3 | P@5 | Near@5 | MRR | Cross-market in the first five |',
      '|---|---|---|---|---|---|---|---|---|',
      ...table('today'),
      '',
      '**Relevance by the profile’s occupation:**',
      '',
      '| Pool | Arm | Queries | P@1 | P@3 | P@5 | Near@5 | MRR | Cross-market in the first five |',
      '|---|---|---|---|---|---|---|---|---|',
      ...table('profile'),
      '',
      '## Brazilian and Mexican ads',
      '',
      '| Market | The ad’s title | Today’s title → its snap | The profile’s occupation → its snap | The profile |',
      '|---|---|---|---|---|',
      ...examples,
      '',
      `Run in ${((Date.now() - started) / 60_000).toFixed(1)} minutes.`,
      '',
    ].join('\n');
    const file = join(__dirname, 'work-eval', `jobs-profile-${date}-n${n}-${effort}${titled ? '' : '-description'}.md`);
    writeFileSync(file, md);
    process.stdout.write(`${file}\n`);
    expect(read.length).toBeGreaterThan(0);
  }, 7_200_000);
});

/** A short request as a hirer would post it: a vacancy headline in the market's own words. */
const HEADLINE: Record<'en' | 'pt' | 'es', (title: string) => string> = { en: (t) => `Hiring: ${t}`, pt: (t) => `Contrata-se ${t}`, es: (t) => `Se solicita ${t}` };
/** A market for a request that names none, as the chat set's languages map to the launch markets. */
const MARKET_OF: Record<'en' | 'pt' | 'es', string> = { en: 'us-tx', pt: 'br-sp', es: 'mx-cmx' };

describe.skipIf(!SHORT)('the job profile on short requests, with reasoning off and at low effort (live, Workers AI)', () => {
  it('reads each short request both ways, snaps its occupation and writes the report', async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const [escoSql, usSql, vectorsDir, litert] = ['ESCO_SQL', 'US_SQL', 'VECTORS_DIR', 'JOBS_LITERT_FILE'].map(env);
    if (!accountId || !token) throw new Error('JOB_PROFILE_SHORT needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    if (!escoSql || !usSql || !vectorsDir || !litert) throw new Error('JOB_PROFILE_SHORT needs ESCO_SQL, US_SQL, VECTORS_DIR and JOBS_LITERT_FILE');
    const started = Date.now();
    const inference: Inference = createInference({ WORK_EMBED_MODEL: MODEL }, { ai: createRestAi({ accountId, token }) })!;
    const profileModel = await inference.model('work-job-profile');

    interface Short {
      id: string;
      text: string;
      lang: 'en' | 'pt' | 'es';
      market: string;
      /** The locale fixture's expected tokens; absent for the hiring set, which names none. */
      right?: string[];
      none?: boolean;
    }
    const requests: Short[] = [
      ...(hirePrompts as { id: string; language: 'en' | 'pt' | 'es'; text: string; expect: { action: string | null } }[])
        .filter((p) => p.expect.action === 'post_job')
        .map((p) => ({ id: p.id, text: p.text, lang: p.language, market: MARKET_OF[p.language] })),
      ...(localeCases.cases as { raw: string; lang: 'en' | 'pt' | 'es'; market: string; right?: string[]; none?: boolean }[]).map((c, i) => ({
        id: `locale-${i}`,
        text: HEADLINE[c.lang](c.raw),
        lang: c.lang,
        market: c.market,
        right: c.right ?? [],
        none: c.none ?? false,
      })),
    ];
    const efforts: ProfileEffort[] = ['none', 'low'];
    interface Read {
      occupation: string | null;
      skills: number;
      ms: number;
      tokensOut: number;
      failed: boolean;
    }
    const reads = new Map<string, Read>();
    const key = (r: Short, e: ProfileEffort) => `${r.id}|${e}`;
    await parallel(
      requests.flatMap((r) => efforts.map((e) => ({ r, e }))),
      3,
      async ({ r, e }) => {
        const req = jobProfileRequest(profileModel, r.text, { lang: r.lang, market: r.market }, e);
        for (let tries = 1; tries <= 6; tries++) {
          const t0 = Date.now();
          try {
            const result = await inference.run('work-job-profile', req);
            const out = readJobProfile(result, r.text, r.lang);
            if (out) {
              reads.set(key(r, e), { occupation: out.profile.occupation?.en ?? null, skills: out.profile.skills.length, ms: Date.now() - t0, tokensOut: usageOrEstimate(result, req).tokensOut, failed: false });
              return;
            }
          } catch {
            // A refused burst: try again after the backoff.
          }
          await new Promise((res) => setTimeout(res, Math.min(30_000, 3_000 * 2 ** (tries - 1))));
        }
        reads.set(key(r, e), { occupation: null, skills: 0, ms: 0, tokensOut: 0, failed: true });
      },
    );

    // Each English occupation snapped as a hirer's words are (English, never minting), with the phone's vectors.
    const occupations = [...new Set([...reads.values()].map((x) => x.occupation).filter((o): o is string => !!o).map(norm))];
    const docs = embedAll(occupations, 'document', MODEL, litert);
    const queries = embedAll(occupations, 'query', MODEL, litert);
    const replica = await loadReplica(escoSql, usSql);
    const index = ReplicaIndex.load(vectorsDir, MODEL);
    const registry: RegistryDeps = { inference, store: replica.store, index, tau: tauFor(MODEL) };
    const snapped = new Map<string, string | null>();
    const snapFailed = new Set<string>();
    await parallel(occupations, 4, async (o) => {
      for (let tries = 1; tries <= 5; tries++) {
        try {
          const out = await snap(registry, { kind: 'pos', raw: o, lang: 'en', mint: false, vectors: { query: queries.get(o)!, document: docs.get(o)! } });
          if (out.calls.every((c) => c.ok)) {
            snapped.set(o, out.token);
            return;
          }
        } catch {
          // The store and the index are local: only a hosted call fails here.
        }
        await new Promise((res) => setTimeout(res, Math.min(30_000, 2_000 * 2 ** (tries - 1))));
      }
      snapped.set(o, null);
      snapFailed.add(o);
    });
    const tokenOf = (x: Read | undefined) => (x?.occupation ? (snapped.get(norm(x.occupation)) ?? null) : null);
    /**
     * A locale string is right when its occupation snaps to an expected token, or, where the fixture allows none,
     * when an occupation was read and snapped to nothing. A reading with no occupation, a failed read and a failed
     * snap are counted apart, never as right.
     */
    const verdict = (r: Short, x: Read | undefined): 'right' | 'other' | 'no occupation' | 'failed read' | 'failed snap' | '' => {
      if (!r.right) return '';
      if (!x || x.failed) return 'failed read';
      if (!x.occupation) return 'no occupation';
      if (snapFailed.has(norm(x.occupation))) return 'failed snap';
      const t = tokenOf(x);
      return (t && r.right.includes(t)) || (!t && r.none) ? 'right' : 'other';
    };

    const locale = requests.filter((r) => r.right);
    const countOf = (e: ProfileEffort, v: ReturnType<typeof verdict>) => locale.filter((r) => verdict(r, reads.get(key(r, e))) === v).length;
    const tally = (e: ProfileEffort) =>
      `${countOf(e, 'right')} of ${locale.length} right, ${countOf(e, 'other')} wrong, ${countOf(e, 'no occupation')} with no occupation read (${locale.filter((r) => r.none && verdict(r, reads.get(key(r, e))) === 'no occupation').length} of them where the fixture allows none), ${countOf(e, 'failed read')} failed reads and ${countOf(e, 'failed snap')} failed snaps`;
    const median = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return s.length ? s[Math.floor(s.length / 2)]! : 0;
    };
    const stats = (e: ProfileEffort) => {
      const xs = requests.map((r) => reads.get(key(r, e))!).filter((x) => !x.failed);
      return `median ${median(xs.map((x) => x.ms))} ms and ${median(xs.map((x) => x.tokensOut))} output tokens, ${requests.length - xs.length} failed after six tries`;
    };
    const cell = (r: Short, e: ProfileEffort) => {
      const x = reads.get(key(r, e));
      if (!x || x.failed) return 'failed';
      const v = verdict(r, x);
      const mark = v === 'other' ? '**' : '';
      return `${mark}${x.occupation ?? 'no occupation'} → ${tokenOf(x) ?? '—'}${mark}${v === 'failed snap' ? ' (snap failed)' : ''}`;
    };
    const date = new Date().toISOString().slice(0, 10);
    const md = [
      `# The job profile on short requests, ${date}`,
      '',
      `${requests.length} short requests, each read by \`${profileModel}\` (\`work-job-profile\`) with reasoning off and at low effort, over the Workers AI REST API from the Mac: the ${requests.length - locale.length} requests for a worker of \`test/chat-eval/hire-prompts.json\` (in the market of their language: us-tx, br-sp, mx-cmx), and the ${locale.length} strings of \`test/fixtures/work/locale-cases.json\` as vacancy headlines in their own market ("Hiring: …", "Contrata-se …", "Se solicita …"). Each English occupation snapped on the v2 replica (ESCO and the US layer; English, never minting, with ${MODEL}'s vectors from the Mac), and a locale string is right when its occupation snaps to one of the fixture's expected tokens, or, where the fixture allows none, when an occupation was read and snapped to nothing. A reading that names no occupation is counted apart.`,
      '',
      `- **Reasoning off:** ${tally('none')}; ${stats('none')}.`,
      `- **Low effort:** ${tally('low')}; ${stats('low')}.`,
      '',
      '| Request | Expected | Reasoning off: occupation → token | Low effort: occupation → token |',
      '|---|---|---|---|',
      ...requests.map((r) => `| ${r.text.replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 90)} | ${r.right ? [...r.right.map((t) => t.split(':')[1]), ...(r.none ? ['none'] : [])].join(', ') : '—'} | ${cell(r, 'none')} | ${cell(r, 'low')} |`),
      '',
      `Run in ${((Date.now() - started) / 60_000).toFixed(1)} minutes.`,
      '',
    ].join('\n');
    const file = join(__dirname, 'work-eval', `jobs-profile-short-${date}.md`);
    writeFileSync(file, md);
    process.stdout.write(`${file}\n`);
    expect(reads.size).toBe(requests.length * efforts.length);
  }, 3_600_000);
});
