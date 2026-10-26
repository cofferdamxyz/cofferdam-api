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
 *     the intent names some, at least one of the occupation or skill tokens
 *     the task needs (`anyOf`). Instant keeps only those (tier 1); Curated
 *     also keeps vector-strong misses as tier 2, labelled, so a
 *     canonicalization miss never silently excludes a fit worker.
 *  4. One D1 read for the gated top: each required certificate is confirmed
 *     against the exact token list, never the filter (E10: a false positive
 *     must never award licensed work, so a missing certificate drops the
 *     candidate in either mode); a listing without a record is dropped, as is
 *     every listing of the pseudonym the caller excludes (a hirer's own); and
 *     one listing per pseudonym is kept, the best-scoring (Work Profiles).
 *
 * No generative call runs here (E4): one embedding of the query, index
 * reads, bit probes and one D1 read. The decision pass over the finalists
 * (S8, Clef `score`) comes after and is not built.
 */

import type { Inference } from '../inference/index.js';
import { bloomHas, bloomProbe } from './bloom.js';
import type { ExecutorOptions } from './executor.js';
import { withCalls, type WorkCall } from './fields.js';
import { namespaceOf, REGION, type ListingStore, type Scope } from './listings.js';
import { embedTexts, type IndexMatch, type VectorIndex } from './registry.js';

/** Results Vectorize returns per query when metadata comes back (decision 0019; re-check at build time). */
export const RECALL_TOP_K = 50;
/** The finalist cap (E1): what the D1 read and, later, Clef's decision pass see. */
export const FINALIST_CAP = 50;
/** A token miss counts as Curated tier 2 only at or above this cosine. */
export const TIER2_FLOOR = 0.5;
/** On-site regions an intent may name: its own and the neighbours its radius reaches. */
export const MAX_REGIONS = 8;
/** Remote work is queried in these countries' remote namespaces (the launch markets) unless `WORK_REMOTE_COUNTRIES` says otherwise. */
export const DEFAULT_REMOTE_COUNTRIES = ['us', 'br', 'mx'];

export type HireMode = 'instant' | 'curated';

export interface RecallIntent {
  scope: Scope;
  /** On-site: the hirer's coarse region first, then its neighbours. Remote: unused. */
  regions: string[];
  /** What the query embeds: the task as the hirer wrote it, and the English names of what it needs. */
  queryText: string;
  /** The client's query vector for the hirer's sentence, when it sent one: searched with in place of `queryText`'s. */
  vector?: number[];
  /** Every one must be held: `cert:` (confirmed exactly) and `lang:` tokens. */
  allOf: string[];
  /** At least one must be held, when any: the occupation and skill tokens the task needs. */
  anyOf: string[];
  mode: HireMode;
}

export interface Finalist {
  listingId: string;
  score: number;
  /** 1: passed the gate; 2: Curated only, vector-strong but a token miss, shown labelled. */
  gateTier: 1 | 2;
  /** The worker's personhood tier, from the listing. */
  personhood: number;
  /** The intent's tokens the listing holds, by its exact list. */
  matched: string[];
  namespace: string;
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
  now?: () => number;
  log?: ExecutorOptions['log'];
}

export type RecallOutcome =
  | { ok: true; finalists: Finalist[]; namespaces: string[]; recalled: number; gated: number; calls: WorkCall[] }
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

  // S7: the Bloom gate on the merged set, before any D1 read.
  const allOf = intent.allOf.map(bloomProbe);
  const anyOf = intent.anyOf.map(bloomProbe);
  const gated: Gated[] = [];
  for (const m of merged) {
    const bloom = typeof m.metadata?.bloom === 'string' ? m.metadata.bloom : '';
    const passes = allOf.every((p) => bloomHas(bloom, p)) && (!anyOf.length || anyOf.some((p) => bloomHas(bloom, p)));
    if (passes) gated.push({ match: m, gateTier: 1 });
    else if (intent.mode === 'curated' && m.score >= TIER2_FLOOR) gated.push({ match: m, gateTier: 2 });
  }
  gated.sort((a, b) => a.gateTier - b.gateTier || b.match.score - a.match.score);
  const top = gated.slice(0, FINALIST_CAP);

  // One D1 read: the exact certificate confirm, then one listing per pseudonym.
  const records = await deps.listings.get(top.map((g) => g.match.id));
  const certificates = intent.allOf.filter((t) => t.startsWith('cert:'));
  const wanted = [...intent.allOf, ...intent.anyOf];
  const seen = new Set<string>();
  const finalists: Finalist[] = [];
  for (const g of top) {
    const r = records.get(g.match.id);
    if (!r || r.pseudonym === deps.excludePseudonym) continue;
    const held = new Set(r.tokens);
    if (!certificates.every((c) => held.has(c))) continue;
    if (seen.has(r.pseudonym)) continue;
    seen.add(r.pseudonym);
    finalists.push({
      listingId: r.listingId,
      score: g.match.score,
      gateTier: g.gateTier,
      personhood: r.tier,
      matched: wanted.filter((t) => held.has(t)),
      namespace: g.match.namespace,
    });
  }
  return { ok: true, finalists, namespaces, recalled: merged.length, gated: gated.length, calls };
}
