// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Recall and the gate (S6 and S7; workspace `docs/product/engine.md`, Recall
 * and the Bloom gate, E1 to E3, E10; decision 0019).
 *
 *  1. The intent names its namespaces: on-site work queries the hirer's
 *     coarse region and the neighbours the phone names when the radius
 *     crosses a border; remote work queries every launch country's remote
 *     namespace.
 *  2. One query per namespace, in parallel, each at Vectorize's 50 with
 *     metadata, merged by score in the Worker: K is up to 50 × namespaces.
 *  3. The Bloom gate on the merged set, before any D1 read: a candidate must
 *     hold every required token (`allOf`: certificates, languages) and, when
 *     the intent names some, at least one of the occupation, unit-group or
 *     skill tokens the task needs (`anyOf`): tier 1. A vector-strong miss
 *     (`tier2FloorFor`) is tier 2: Curated shows it labelled, so a
 *     canonicalization miss never silently excludes a fit worker, and with
 *     the decision pass an Instant search sends it to Clef too, when it holds
 *     every required token, since only Clef's fit can make it tier 1 there.
 *     The floor follows the pinned embedding model (`tier2FloorFor`).
 *     Before the cut to `FINALIST_CAP`, tier 1 orders an occupation hit before
 *     a unit-group hit before a skill hit alone, then by cosine (decision
 *     0069; on real vacancies an occupation hit was right 85% of the time, a
 *     skill hit alone 19%); a hit on an occupation kept under Clef's floor
 *     ranks as a skill hit.
 *  4. One D1 read for the gated top: each required certificate is confirmed
 *     against the exact token list, never the filter (E10: a false positive
 *     must never award licensed work, so a missing certificate drops the
 *     candidate in either mode); a listing without a record is dropped, as is
 *     every listing of the pseudonym the caller excludes (a hirer's own).
 *  5. The decision pass (S8, workspace decision 0069), when the deps carry
 *     the registry's store: Clef (not flash) reads the job (the task, the
 *     needs that passed Clef's floor, the certificates the gate confirmed)
 *     and each finalist's profile by its tokens' English names, the job's
 *     needed skills and certificates first, and chooses fit, related or
 *     other. Other work
 *     (OTHER_FLOOR) drops a finalist, token hit or not; a fit (FIT_FLOOR)
 *     promotes a miss that holds every required token to tier 1; otherwise
 *     the gate's tier stands, as it does when a call fails or answers
 *     nothing. Within a tier the finalists rank by one weighted sum: P(fit),
 *     half of P(related), a fifth of the share of the job's needed skills
 *     they hold and cosine (tuned on prompts across ISCO groups and on real
 *     resumes, 2026-10-28: snapped profiles are thin, so Clef calls a right
 *     worker related more often than a fit, and cosine places the named
 *     occupation first more often than Clef's probabilities do).
 *  6. One listing per pseudonym (Work Profiles): the best by tier and rank
 *     after the pass, so a profile Clef drops gives way to the same worker's
 *     next one; without the pass, the first in the gate's order (tier, kind
 *     of hit, cosine).
 *
 * No generative call runs here (E4): one embedding of the query, index
 * reads, bit probes, one D1 read of the listings, one registry read of their
 * tokens' names and Clef's classifications, which write no text.
 */

import type { Inference } from '../inference/index.js';
import { bloomHas, bloomProbe } from './bloom.js';
import { clefInput, FIT_FLOOR, FIT_KEYS, fitQuestions, fitState, OTHER_FLOOR, readChoice, type FitKey, type FitProfile } from './clef.js';
import { failureCode, type ExecutorOptions } from './executor.js';
import { estimatedUsage, usageOrEstimate, withCalls, type WorkCall } from './fields.js';
import { namespaceOf, REGION, type ListingRecord, type ListingStore, type Scope } from './listings.js';
import { EMBEDDINGGEMMA_2_GGUF, embedTexts, type IndexMatch, type RegistryStore, type VectorIndex } from './registry.js';

/** Results Vectorize returns per query when metadata comes back (decision 0019; re-check at build time). */
export const RECALL_TOP_K = 50;
/** The finalist cap (E1): what the D1 read and Clef's decision pass see. */
export const FINALIST_CAP = 50;
/** A token miss is tier 2 only at or above this cosine: bge-m3's floor, and the default for a model not listed below. */
export const TIER2_FLOOR = 0.5;
/**
 * The tier-2 floor on each embedding model's own scale, as τ follows the pinned model: EmbeddingGemma 2's 0.65 was measured
 * on its scale (2026-10-27) and adopted by the founder with the v3 switch (decision 0069, 2026-10-28): a fifth fewer Clef
 * calls on real resumes for nothing lost.
 */
export const TIER2_FLOOR_BY_MODEL: Readonly<Record<string, number>> = { '@cf/baai/bge-m3': TIER2_FLOOR, [EMBEDDINGGEMMA_2_GGUF]: 0.65 };
export function tier2FloorFor(model: string): number {
  return TIER2_FLOOR_BY_MODEL[model] ?? TIER2_FLOOR;
}
/** On-site regions an intent may name: its own and the neighbours its radius reaches. */
export const MAX_REGIONS = 8;
/** Remote work is queried in these countries' remote namespaces (the launch markets) unless `WORK_REMOTE_COUNTRIES` says otherwise. */
export const DEFAULT_REMOTE_COUNTRIES = ['us', 'br', 'mx'];

export type HireMode = 'instant' | 'curated';
/** Clef calls at once in the decision pass. */
export const DECIDE_CONCURRENCY = 8;
/**
 * Within a tier: P(fit), plus these weights on P(related), on the share of needed skills held and on cosine. Cosine weighs 1,
 * adopted by the founder on 2026-10-28 from the real-resume replay (decision 0069): the named title first 35 times in 99
 * against 30 at 0.1, the prompts across ISCO groups unchanged.
 */
export const RELATED_WEIGHT = 0.5;
export const SKILL_WEIGHT = 0.2;
export const COSINE_WEIGHT = 1;

export interface RecallIntent {
  scope: Scope;
  /** On-site: the hirer's coarse region first, then its neighbours. Remote: unused. */
  regions: string[];
  /** What the query embeds: the task as the hirer wrote it, and the English names of the needs over Clef's floor. */
  queryText: string;
  /** The client's query vector for the hirer's sentence, when it sent one: searched with in place of `queryText`'s. */
  vector?: number[];
  /** The decision pass's job (S8): the task as the plan read it, and the English names of the needs that passed Clef's floor. */
  task?: string;
  needLabels?: string[];
  /** An occupation kept under Clef's floor (decision 0069): it and its unit group are in `anyOf` to widen the gate, and a hit on them ranks as a skill's does at the cut. */
  keptOccupation?: string;
  /** Every one must be held: `cert:` (confirmed exactly) and `lang:` tokens. */
  allOf: string[];
  /** At least one must be held, when any: the occupations, their ISCO-08 unit groups and the skills the task needs, and a kept occupation. */
  anyOf: string[];
  mode: HireMode;
}

export interface Finalist {
  listingId: string;
  score: number;
  /** 1: passed the gate, or a miss Clef's fit promoted; 2: a vector-strong token miss, shown labelled when the hirer curates. */
  gateTier: 1 | 2;
  /** The worker's personhood tier, from the listing. */
  personhood: number;
  /** The intent's tokens the listing holds, by its exact list. */
  matched: string[];
  namespace: string;
  /**
   * Clef's decision (S8), when the pass ran: its choice (null when the call failed), P(fit), P(related), P(other), the job's
   * needed skills the listing holds, and whether the fit promoted a token miss to tier 1.
   */
  fit?: { choice: FitKey | null; pFit: number; pRelated: number; pOther: number; skillsHeld: number; promoted: boolean };
}

export interface RecallDeps {
  inference: Inference;
  /** `jobs-listings-v1`. */
  index: VectorIndex;
  listings: ListingStore;
  remoteCountries?: string[];
  namespacePrefix?: string;
  /** A pseudonym none of whose listings may be a finalist: the hirer's own, since one account is both sides. */
  excludePseudonym?: string;
  /** The registry's store, for its tokens' English names: with it the decision pass runs (S8, decision 0069); without it recall stops at the gate. */
  store?: RegistryStore;
  now?: () => number;
  log?: ExecutorOptions['log'];
}

export type RecallOutcome =
  | {
      ok: true;
      finalists: Finalist[];
      namespaces: string[];
      recalled: number;
      gated: number;
      decided?: number;
      /** The finalists the decision pass left out (other work; tier 2 in an Instant search), for evaluations: a route answers counts only. */
      dropped?: Finalist[];
      calls: WorkCall[];
    }
  | { ok: false; error: 'bad_intent' | 'embedding_failed'; calls: WorkCall[] };

/** `WORK_REMOTE_COUNTRIES` (comma-separated ISO codes), or the launch markets. */
export function parseRemoteCountries(raw: string | undefined): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => /^[a-z]{2}$/.test(c));
  return list.length ? [...new Set(list)] : DEFAULT_REMOTE_COUNTRIES;
}

/** The namespaces an intent queries (decision 0019). */
export function namespacesFor(intent: RecallIntent, remoteCountries: string[] = DEFAULT_REMOTE_COUNTRIES, prefix = ''): string[] | null {
  if (intent.scope === 'remote') return remoteCountries.map((c) => namespaceOf(c, 'remote', prefix));
  const regions = [...new Set(intent.regions)];
  if (!regions.length || regions.length > MAX_REGIONS || regions.some((r) => !REGION.test(r))) return null;
  return regions.map((r) => namespaceOf(r, 'onsite', prefix));
}

interface Gated {
  match: IndexMatch & { namespace: string };
  gateTier: 1 | 2;
  /** Within tier 1, the kind of hit: 3 an occupation, 2 its unit group alone, 1 a skill alone; 0 for a miss. */
  hit: number;
}

/** S6 and S7 for one intent: see the module comment. An index or store failure throws a `WorkCallsError` carrying the embedding call. */
export async function recall(deps: RecallDeps, intent: RecallIntent): Promise<RecallOutcome> {
  const namespaces = namespacesFor(intent, deps.remoteCountries, deps.namespacePrefix);
  if (!namespaces || !intent.queryText.trim()) return { ok: false, error: 'bad_intent', calls: [] };
  return withCalls((calls) => recallWith(deps, intent, namespaces, calls));
}

async function recallWith(deps: RecallDeps, intent: RecallIntent, namespaces: string[], calls: WorkCall[]): Promise<RecallOutcome> {
  let vector: number[];
  if (intent.vector) vector = intent.vector;
  else {
    const embedding = await embedTexts(deps.inference, [intent.queryText], { role: 'query', now: deps.now, log: deps.log });
    calls.push(embedding.call);
    if (!embedding.ok) return { ok: false, error: 'embedding_failed', calls };
    vector = embedding.vectors[0]!;
  }

  // S6: one query per namespace, in parallel, merged by score.
  const answers = await Promise.all(
    namespaces.map(async (namespace) => (await deps.index.query(vector, { topK: RECALL_TOP_K, namespace })).map((m) => ({ ...m, namespace }))),
  );
  const merged = answers.flat().sort((a, b) => b.score - a.score);

  // S7: the Bloom gate on the merged set, before any D1 read; the tier-2 floor on the pinned embedding model's scale.
  const tier2Floor = tier2FloorFor(await deps.inference.model('work-embed'));
  const allOf = intent.allOf.map(bloomProbe);
  const anyOf = intent.anyOf.map(bloomProbe);
  // The kind of hit orders tier 1 before the cut; a kept occupation's hits rank as a skill's (decision 0069).
  const probesOf = (prefix: string) => (intent.keptOccupation ? [] : intent.anyOf.filter((t) => t.startsWith(prefix)).map(bloomProbe));
  const occupationProbes = probesOf('pos:');
  const groupProbes = probesOf('isco:');
  const gated: Gated[] = [];
  for (const m of merged) {
    const bloom = typeof m.metadata?.bloom === 'string' ? m.metadata.bloom : '';
    const has = (p: ReturnType<typeof bloomProbe>) => bloomHas(bloom, p);
    const meetsAll = allOf.every(has);
    if (meetsAll && (!anyOf.length || anyOf.some(has))) {
      gated.push({ match: m, gateTier: 1, hit: occupationProbes.some(has) ? 3 : groupProbes.some(has) ? 2 : 1 });
    } else if (m.score >= tier2Floor && (intent.mode === 'curated' || (deps.store && meetsAll))) {
      // A vector-strong miss: labelled when the hirer curates; in an Instant search only Clef's fit could make it tier 1, which
      // a miss without every required token can never reach (decision 0069).
      gated.push({ match: m, gateTier: 2, hit: 0 });
    }
  }
  gated.sort((a, b) => a.gateTier - b.gateTier || b.hit - a.hit || b.match.score - a.match.score);
  const top = gated.slice(0, FINALIST_CAP);

  // One D1 read: the exact certificate confirm and the excluded pseudonym.
  const records = await deps.listings.get(top.map((g) => g.match.id));
  const certificates = intent.allOf.filter((t) => t.startsWith('cert:'));
  const wanted = [...intent.allOf, ...intent.anyOf];
  const candidates: Finalist[] = [];
  for (const g of top) {
    const r = records.get(g.match.id);
    if (!r || r.pseudonym === deps.excludePseudonym) continue;
    const held = new Set(r.tokens);
    if (!certificates.every((c) => held.has(c))) continue;
    candidates.push({
      listingId: r.listingId,
      score: g.match.score,
      gateTier: g.gateTier,
      personhood: r.tier,
      matched: wanted.filter((t) => held.has(t)),
      namespace: g.match.namespace,
    });
  }
  // One listing per pseudonym, the first of a list already in order (Work Profiles).
  const onePerPseudonym = (list: Finalist[]) => {
    const seen = new Set<string>();
    return list.filter((f) => {
      const pseudonym = records.get(f.listingId)!.pseudonym;
      if (seen.has(pseudonym)) return false;
      seen.add(pseudonym);
      return true;
    });
  };
  if (!deps.store || !candidates.length) return { ok: true, finalists: onePerPseudonym(candidates), namespaces, recalled: merged.length, gated: gated.length, calls };

  // S8: Clef classifies each candidate against the job; the gate's tier stands where a call fails. Then one listing per
  // pseudonym, so a profile Clef drops gives way to the same worker's next one.
  const decided = await decide(deps, deps.store, intent, candidates, records, calls);
  const keeps = (d: (typeof decided)[number]) => d.keep && (intent.mode === 'curated' || d.finalist.gateTier === 1);
  const kept = decided
    .filter(keeps)
    .map((d) => d.finalist)
    .sort((a, b) => a.gateTier - b.gateTier || rank(b, intent) - rank(a, intent));
  const dropped = decided.filter((d) => !keeps(d)).map((d) => d.finalist);
  return {
    ok: true,
    finalists: onePerPseudonym(kept),
    namespaces,
    recalled: merged.length,
    gated: gated.length,
    decided: decided.filter((d) => d.finalist.fit?.choice).length,
    dropped,
    calls,
  };
}

/** Within a tier, one weighted sum: P(fit), half of P(related), a fifth of the share of the job's needed skills held, and cosine. */
function rank(f: Finalist, intent: RecallIntent): number {
  const needed = intent.anyOf.filter((t) => t.startsWith('skill:')).length;
  return (f.fit?.pFit ?? 0) + RELATED_WEIGHT * (f.fit?.pRelated ?? 0) + SKILL_WEIGHT * ((f.fit?.skillsHeld ?? 0) / Math.max(1, needed)) + COSINE_WEIGHT * f.score;
}

/**
 * A listing's tokens as the decision pass's profile, by English names. The state cuts each list short and the stored list is
 * sorted, so the job's needed skills and certificates the listing holds go first: Clef never misses what made the hit or what
 * the gate confirmed.
 */
export function fitProfileOf(tokens: readonly string[], needed: ReadonlySet<string>, name: (token: string) => string): FitProfile {
  const neededFirst = (prefix: string) => {
    const of = tokens.filter((t) => t.startsWith(prefix));
    return [...of.filter((t) => needed.has(t)), ...of.filter((t) => !needed.has(t))].map(name);
  };
  return { occupations: neededFirst('pos:'), skills: neededFirst('skill:'), certificates: neededFirst('cert:') };
}

/** The decision pass: one Clef `choice` per finalist, a few at a time. */
async function decide(
  deps: RecallDeps,
  store: RegistryStore,
  intent: RecallIntent,
  finalists: Finalist[],
  records: Map<string, ListingRecord>,
  calls: WorkCall[],
): Promise<{ finalist: Finalist; keep: boolean }[]> {
  const now = deps.now ?? Date.now;
  const tokensOf = (f: Finalist) => records.get(f.listingId)?.tokens ?? [];
  // The certificates the job names are the gate's own tokens, which every candidate holds (confirmed exactly above): Clef reads
  // them for context and never judges one (E10).
  const jobCertificates = intent.allOf.filter((t) => t.startsWith('cert:'));
  const named = await store.tokens([...new Set([...jobCertificates, ...finalists.flatMap((f) => tokensOf(f).filter((t) => /^(pos|skill|cert):/.test(t)))])]);
  // A token the registry no longer names reads as its own words (`pos:pipe-fitter` as "pipe fitter").
  const name = (t: string) => named.get(t)?.labelEn ?? t.replace(/^[a-z]+:/, '').replace(/[-/]/g, ' ');
  const job = { task: intent.task ?? intent.queryText, needs: intent.needLabels ?? [], certificates: jobCertificates.map(name) };
  const neededSkills = intent.anyOf.filter((t) => t.startsWith('skill:'));
  const needed = new Set([...neededSkills, ...jobCertificates]);
  const model = await deps.inference.model('work-decide');
  const out = new Array<{ finalist: Finalist; keep: boolean }>(finalists.length);
  let next = 0;
  const worker = async () => {
    while (next < finalists.length) {
      const i = next++;
      const f = finalists[i]!;
      const tokens = tokensOf(f);
      const profile = fitProfileOf(tokens, needed, name);
      const skillsHeld = neededSkills.filter((t) => tokens.includes(t)).length;
      // A promotion needs every hard requirement held exactly: a language or a certificate is never Clef's to judge (E10).
      const meetsAllOf = intent.allOf.every((t) => tokens.includes(t));
      const body = clefInput(model, fitState(job, profile), fitQuestions());
      const t0 = now();
      let reading: ReturnType<typeof readChoice<FitKey>> | null = null;
      try {
        const answer = await deps.inference.run('work-decide', body);
        const call: WorkCall = { op: 'work-decide', model, ok: true, ms: now() - t0, usage: { ...usageOrEstimate(answer, body), neurons: null } };
        calls.push(call);
        reading = readChoice(answer, 'fit', FIT_KEYS, 0);
        if (!reading.choice) {
          // An answer with no choice in it counts as a failed call, as the plan's do.
          call.ok = false;
          deps.log?.({ event: 'work_decide_failed', model, reason: 'no_answer' });
        }
      } catch (err) {
        calls.push({ op: 'work-decide', model, ok: false, ms: now() - t0, usage: estimatedUsage(body) });
        deps.log?.({ event: 'work_decide_failed', model, reason: failureCode(err) });
      }
      if (!reading?.choice) {
        out[i] = { finalist: { ...f, fit: { choice: null, pFit: 0, pRelated: 0, pOther: 0, skillsHeld, promoted: false } }, keep: true };
        continue;
      }
      const pFit = reading.probabilities.fit ?? 0;
      const pRelated = reading.probabilities.related ?? 0;
      const pOther = reading.probabilities.other ?? 0;
      const gateTier: 1 | 2 = pFit >= FIT_FLOOR && meetsAllOf ? 1 : f.gateTier;
      const fit = { choice: reading.choice, pFit, pRelated, pOther, skillsHeld, promoted: gateTier < f.gateTier };
      out[i] = { finalist: { ...f, gateTier, fit }, keep: pOther < OTHER_FLOOR };
    }
  };
  await Promise.all(Array.from({ length: Math.min(DECIDE_CONCURRENCY, finalists.length) }, worker));
  return out;
}
