// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The listing projection and its publish (S4; workspace `docs/product/engine.md`,
 * Pipeline, Recall and the Bloom gate; decision 0019). Turning Looking for
 * work on publishes a listing: the phone sends the storefront part of the
 * Cofferdam CV the worker approved (titles, skills, certificates as claimed,
 * the fluent languages), a coarse region, the scope and the personhood tier;
 * the plane snaps the claims to registry tokens, embeds the listing with
 * `bge-m3` into `jobs-listings-v1` in the namespace of its region and scope,
 * and keeps the exact token list in D1. Turning it off deletes both.
 *
 * Location is a coarse region only (`us-tx`, `br-sp`, `mx`): no position,
 * cell or radius reaches the plane, and the vector's metadata carries the
 * region, the scope, the tier, the Bloom filter and the model, nothing else.
 * The namespace is `<region>:onsite` for on-site work and `<country>:remote`
 * for remote work. A listing is keyed by the account's Work pseudonym and a
 * profile id, so one account can hold several (Work Profiles).
 */

import type { Inference } from '../inference/index.js';
import { scanText, type BlockLang } from './blocks.js';
import { bloomOf } from './bloom.js';
import type { ExecutorOptions } from './executor.js';
import type { WorkCall } from './fields.js';
import { embedTexts, snap, type RegistryDeps, type TokenKind, type VectorIndex } from './registry.js';

export const SCOPES = ['onsite', 'remote'] as const;
export type Scope = (typeof SCOPES)[number];

/** ISO 3166-1 alpha-2, optionally with a subdivision: `us`, `us-tx`, `br-sp`, `mx-nle`. */
export const REGION = /^[a-z]{2}(-[a-z0-9]{1,3})?$/;

export function countryOf(region: string): string {
  return region.slice(0, 2);
}

/** The listing's namespace: on-site work by region, remote work by country (decision 0019). */
export function namespaceOf(region: string, scope: Scope, prefix = ''): string {
  return scope === 'remote' ? `${prefix}${countryOf(region)}:remote` : `${prefix}${region}:onsite`;
}

/** The metadata schema of a `jobs-listings-v1` vector. */
export const LISTING_METADATA_VERSION = 1;

export interface ListingDraft {
  /** The account's Work pseudonym: opaque here, derived by the publishing route. */
  pseudonym: string;
  /** The Work Profile this listing publishes. */
  profileId: string;
  region: string;
  scope: Scope;
  /** Personhood: 0 unbound, 1 bound, 2 bound with verified experience. */
  tier: 0 | 1 | 2;
  /** The language the claims are written in. */
  lang: BlockLang;
  titles: string[];
  skills: string[];
  certificates: string[];
  /** ISO 639-1 codes of the languages the worker speaks fluently. */
  languages: string[];
}

export interface ListingRecord {
  listingId: string;
  pseudonym: string;
  profileId: string;
  region: string;
  scope: Scope;
  namespace: string;
  tier: number;
  /** The exact token list (E3, E10). */
  tokens: string[];
  embedModel: string;
  publishedAt: number;
  updatedAt: number;
}

export interface ListingStore {
  put(record: ListingRecord): Promise<void>;
  /** The records named, one read. */
  get(listingIds: string[]): Promise<Map<string, ListingRecord>>;
  delete(listingId: string): Promise<void>;
}

interface ListingRow {
  listing_id: string;
  pseudonym: string;
  profile_id: string;
  region: string;
  scope: Scope;
  namespace: string;
  tier: number;
  tokens: string;
  embed_model: string;
  published_at: number;
  updated_at: number;
}

export class D1ListingStore implements ListingStore {
  constructor(private readonly db: D1Database) {}

  async put(r: ListingRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO listings (listing_id, pseudonym, profile_id, region, scope, namespace, tier, tokens, embed_model, published_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (listing_id) DO UPDATE SET
           region = excluded.region, scope = excluded.scope, namespace = excluded.namespace, tier = excluded.tier,
           tokens = excluded.tokens, embed_model = excluded.embed_model, updated_at = excluded.updated_at`,
      )
      .bind(r.listingId, r.pseudonym, r.profileId, r.region, r.scope, r.namespace, r.tier, JSON.stringify(r.tokens), r.embedModel, r.publishedAt, r.updatedAt)
      .run();
  }

  async get(listingIds: string[]): Promise<Map<string, ListingRecord>> {
    const out = new Map<string, ListingRecord>();
    const ids = [...new Set(listingIds)];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const { results } = await this.db
        .prepare(`SELECT * FROM listings WHERE listing_id IN (${chunk.map(() => '?').join(', ')})`)
        .bind(...chunk)
        .all<ListingRow>();
      for (const r of results) {
        let tokens: string[] = [];
        try {
          const parsed: unknown = JSON.parse(r.tokens);
          if (Array.isArray(parsed)) tokens = parsed.filter((t): t is string => typeof t === 'string');
        } catch {
          // An unreadable token list holds nothing: the certificate confirm fails closed.
        }
        out.set(r.listing_id, {
          listingId: r.listing_id,
          pseudonym: r.pseudonym,
          profileId: r.profile_id,
          region: r.region,
          scope: r.scope,
          namespace: r.namespace,
          tier: r.tier,
          tokens,
          embedModel: r.embed_model,
          publishedAt: r.published_at,
          updatedAt: r.updated_at,
        });
      }
    }
    return out;
  }

  async delete(listingId: string): Promise<void> {
    await this.db.prepare('DELETE FROM listings WHERE listing_id = ?').bind(listingId).run();
  }
}

/** A listing's id, which is its vector's id: stable for (pseudonym, profile), 44 characters. */
export async function listingIdOf(pseudonym: string, profileId: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`listing\u0000${pseudonym}\u0000${profileId}`)));
  let b64 = '';
  for (const b of bytes) b64 += String.fromCharCode(b);
  return `L${btoa(b64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

// ── The draft ───────────────────────────────────────────────────────────────

export const DRAFT_LIMITS = { titles: 5, skills: 30, certificates: 20, languages: 8, chars: 120 } as const;

export type DraftRefusal = 'bad_shape' | 'bad_region' | 'bad_scope' | 'bad_tier' | 'too_many' | 'too_long' | 'refused_pattern' | 'no_claims';

/** Check a draft before anything is snapped or embedded; every string passes the same tripwire as a block. */
export function checkDraft(d: ListingDraft): DraftRefusal | null {
  const lists = [d.titles, d.skills, d.certificates, d.languages];
  if (typeof d.pseudonym !== 'string' || !d.pseudonym || !/^[a-z0-9-]{1,32}$/.test(d.profileId) || lists.some((l) => !Array.isArray(l))) return 'bad_shape';
  if (!REGION.test(d.region)) return 'bad_region';
  if (!(SCOPES as readonly string[]).includes(d.scope)) return 'bad_scope';
  if (![0, 1, 2].includes(d.tier)) return 'bad_tier';
  if (
    d.titles.length > DRAFT_LIMITS.titles ||
    d.skills.length > DRAFT_LIMITS.skills ||
    d.certificates.length > DRAFT_LIMITS.certificates ||
    d.languages.length > DRAFT_LIMITS.languages
  )
    return 'too_many';
  const strings = [...d.titles, ...d.skills, ...d.certificates];
  if (strings.some((s) => typeof s !== 'string' || s.length > DRAFT_LIMITS.chars)) return 'too_long';
  if (d.languages.some((l) => typeof l !== 'string' || !/^[a-z]{2}$/.test(l))) return 'bad_shape';
  if (strings.some((s) => scanText(s))) return 'refused_pattern';
  if (!d.titles.length && !d.skills.length) return 'no_claims';
  return null;
}

/** What the listing's vector embeds: the claims as written, then the registry's English names for them. */
export function listingText(d: ListingDraft, english: string[]): string {
  const parts = [d.titles.join('; '), d.skills.join('; '), d.certificates.join('; ')].filter(Boolean);
  const pivots = [...new Set(english)].filter(Boolean);
  return `${parts.join('. ')}${pivots.length ? ` (${pivots.join('; ')})` : ''}`;
}

export interface PublishDeps {
  inference: Inference;
  /** The registry the claims snap to (its store, its index, its τ). */
  registry: RegistryDeps;
  listings: ListingStore;
  /** `jobs-listings-v1`. */
  index: VectorIndex;
  now?: () => number;
  /** Prefixes every namespace (the live check uses its own, never production's). */
  namespacePrefix?: string;
  log?: ExecutorOptions['log'];
}

export type PublishOutcome =
  | { ok: true; listingId: string; namespace: string; tokens: string[]; calls: WorkCall[] }
  | { ok: false; error: 'draft_refused'; reason: DraftRefusal; calls: WorkCall[] }
  | { ok: false; error: 'embedding_failed'; calls: WorkCall[] };

/** Publish (or republish) a listing; the claims snap with minting allowed, certificates never mint. */
export async function publishListing(deps: PublishDeps, draft: ListingDraft): Promise<PublishOutcome> {
  const now = deps.now ?? Date.now;
  const refused = checkDraft(draft);
  if (refused) return { ok: false, error: 'draft_refused', reason: refused, calls: [] };
  const calls: WorkCall[] = [];
  const tokens = new Set<string>();
  const english: string[] = [];
  const claims: [TokenKind, string[]][] = [
    ['pos', draft.titles],
    ['skill', draft.skills],
    ['cert', draft.certificates],
  ];
  for (const [kind, raws] of claims) {
    for (const raw of raws) {
      const s = await snap(deps.registry, { kind, raw, lang: draft.lang });
      calls.push(...s.calls);
      if (s.token) {
        tokens.add(s.token);
        if (s.labelEn) english.push(s.labelEn);
      }
    }
  }
  for (const code of draft.languages) tokens.add(`lang:${code}`);
  const list = [...tokens].sort();

  const embedding = await embedTexts(deps.inference, [listingText(draft, english)], { now, log: deps.log });
  calls.push(embedding.call);
  if (!embedding.ok) return { ok: false, error: 'embedding_failed', calls };

  const listingId = await listingIdOf(draft.pseudonym, draft.profileId);
  const namespace = namespaceOf(draft.region, draft.scope, deps.namespacePrefix);
  const at = now();
  const before = (await deps.listings.get([listingId])).get(listingId);
  if (before && before.namespace !== namespace) await deps.index.deleteByIds([listingId]);
  await deps.index.upsert([
    {
      id: listingId,
      values: embedding.vectors[0]!,
      namespace,
      metadata: { v: LISTING_METADATA_VERSION, region: draft.region, scope: draft.scope, tier: draft.tier, bloom: bloomOf(list), model: embedding.call.model },
    },
  ]);
  await deps.listings.put({
    listingId,
    pseudonym: draft.pseudonym,
    profileId: draft.profileId,
    region: draft.region,
    scope: draft.scope,
    namespace,
    tier: draft.tier,
    tokens: list,
    embedModel: embedding.call.model,
    publishedAt: before?.publishedAt ?? at,
    updatedAt: at,
  });
  return { ok: true, listingId, namespace, tokens: list, calls };
}

/** Looking for work off: the vector and the record go. */
export async function unpublishListing(deps: Pick<PublishDeps, 'index' | 'listings'>, pseudonym: string, profileId: string): Promise<string> {
  const listingId = await listingIdOf(pseudonym, profileId);
  await deps.index.deleteByIds([listingId]);
  await deps.listings.delete(listingId);
  return listingId;
}
