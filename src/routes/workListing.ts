// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * /v1/work/listing — Looking for work, on and off, per Work Profile (S4;
 * workspace `docs/product/work-wallet.md`, Listing lifecycle; decisions 0019
 * and 0060).
 *
 *   PUT    /v1/work/listing  { account, profileId, region, scope, tier, lang, titles, skills, certificates, languages }
 *                            → { ok, listingId, profileId, namespace, tier, tokens }
 *   DELETE /v1/work/listing  { account, profileId }  → { ok, listingId, profileId }
 *
 *   Authorization: DPoP csa1:… + DPoP: <proof>   (a fast or slow session, decision 0055)
 *   (or Authorization: Bearer csa1:…, a v1 token, while CSA1_V1_ACCEPTED allows it)
 *
 * A PUT's body is the storefront `ListingDraft` of `services/work/listings.ts`
 * without the pseudonym: what the worker approved of the Cofferdam CV for that
 * profile, a coarse region (`us-tx`, `br-sp`, `mx`), the scope and the
 * personhood tier. The plane derives the account's Work pseudonym itself
 * (`services/work/pseudonym.ts`, under `WORK_PSEUDONYM_KEY`), so a caller can
 * neither choose one nor reach another account's listings, and the account is
 * never stored beside a listing, logged with one or answered with one. Turning
 * a profile on publishes (or republishes) its listing into `jobs-listings-v1`
 * in the namespace of its region and scope, with its exact tokens in D1;
 * turning it off deletes both. An account holds at most three profiles' listings
 * (decision 0060): a fourth answers `409 profile_limit` before any model runs.
 *
 * PUT runs the Work gate in full (`routes/workGate.ts`: the global brake, the
 * strict gateway, the draft check, the per-IP ceiling, the chat's gate, the
 * per-account bucket and the caps), then needs the stores (`503
 * work_db_unprovisioned`, `token_registry_unprovisioned`,
 * `jobs_listings_unprovisioned`) and the key (`503 pseudonym_key_unprovisioned`).
 * DELETE runs no model, so it skips the strict gateway and the caps, and it
 * counts on rate-limit keys of its own (`work-off:`): no budget and no other
 * Work traffic keeps a worker from taking a listing down.
 *
 * The tier is the phone's claim, and the plane publishes no more of it than
 * it can read: 1 or 2 needs `NullifierRegistry.isAccountBound` on Base, and 2
 * (bound, with verified experience) needs attestation records the plane does
 * not hold yet. So a bound account publishes at most 1 and an unbound one 0,
 * and the answer names the tier published; Base unreadable is `503
 * binding_check_unavailable`, never a guess.
 */

import { Hono } from 'hono';
import type { Address } from 'viem';

import { getBaseSepoliaClient } from '../chain/client.js';
import { SEPOLIA_DEPLOYMENTS } from '../chain/deployments.js';
import type { Env } from '../env.js';
import { WorkCallsError } from '../services/work/fields.js';
import { checkDraft, publishListing, unpublishListing, type DraftRefusal, type ListingDraft, type PublishOutcome } from '../services/work/listings.js';
import { pseudonymKey, workPseudonym } from '../services/work/pseudonym.js';
import { parseTau } from '../services/work/registry.js';
import { allStores, envWorkStores, listingStores, UNPROVISIONED, type WorkStores } from '../services/work/stores.js';
import { createWorkGate, defaultWorkRouteDeps, WORK_KEYS, WORK_OFF_KEYS, workLog, type WorkRouteDeps } from './workGate.js';

export interface ListingRouteDeps extends WorkRouteDeps {
  /** The Work stores (default: from the env's bindings). */
  stores?(env: Env): WorkStores;
  /** `NullifierRegistry.isAccountBound(account)` on Base; throws when Base cannot be read. */
  accountBound?(env: Env, account: Address): Promise<boolean>;
}

const IS_ACCOUNT_BOUND_ABI = [
  {
    type: 'function',
    name: 'isAccountBound',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
] as const;

async function readAccountBound(env: Env, account: Address): Promise<boolean> {
  const client = getBaseSepoliaClient(env.BASE_SEPOLIA_RPC_URL);
  return client.readContract({
    address: SEPOLIA_DEPLOYMENTS.NullifierRegistry.address,
    abi: IS_ACCOUNT_BOUND_ABI,
    functionName: 'isAccountBound',
    args: [account],
  });
}

/** A Work Profile's id (decision 0060), as `checkDraft` takes it. */
const PROFILE_ID = /^[a-z0-9-]{1,32}$/;

/** The tier the plane can stand behind: 1 for a claim on a bound account, else 0 (tier 2 waits on attestation records). */
export function publishedTier(claimed: number, bound: boolean): 0 | 1 {
  return claimed > 0 && bound ? 1 : 0;
}

type DraftBody = Omit<ListingDraft, 'pseudonym'>;

/**
 * The draft as the body sends it, checked as `publishListing` will check it.
 * Only the draft's own fields are read, so a body that names a pseudonym
 * changes nothing; `checkDraft` gets a stand-in, since the real one is
 * derived after the gate.
 */
function readDraft(b: Record<string, unknown>): DraftBody | DraftRefusal {
  const { profileId, region, scope, tier, lang, titles, skills, certificates, languages } = b;
  if (
    typeof profileId !== 'string' ||
    typeof region !== 'string' ||
    typeof scope !== 'string' ||
    typeof tier !== 'number' ||
    typeof lang !== 'string' ||
    ![titles, skills, certificates, languages].every((list) => Array.isArray(list))
  ) {
    return 'bad_shape';
  }
  const draft = { profileId, region, scope, tier, lang, titles, skills, certificates, languages } as DraftBody;
  return checkDraft({ ...draft, pseudonym: 'P' }) ?? draft;
}

/** A store or index failure, as a log reason: the error's name, never a value. */
function failureOf(err: unknown): string {
  const cause = err instanceof WorkCallsError ? err.cause : err;
  return cause instanceof Error ? cause.name : 'error';
}

export function createWorkListingRoutes(deps: ListingRouteDeps = defaultWorkRouteDeps) {
  const routes = new Hono<{ Bindings: Env }>();
  const gate = createWorkGate(deps, WORK_KEYS);
  const offGate = createWorkGate(deps, WORK_OFF_KEYS);
  const storesOf = (env: Env) => (deps.stores ?? envWorkStores)(env);

  routes.put('/listing', async (c) => {
    const admitted = await gate.admit<DraftBody>(c, (b) => {
      const draft = readDraft(b);
      if (typeof draft !== 'string') return draft;
      workLog({ event: 'work_listing_refused', reason: draft });
      return c.json({ ok: false, error: 'draft_refused', reason: draft }, 422);
    });
    if (admitted instanceof Response) return admitted;
    const { account, input, inference, store } = admitted;
    const stores = allStores(storesOf(c.env));
    if (typeof stores === 'string') return c.json({ ok: false, error: UNPROVISIONED[stores] }, 503);
    const key = pseudonymKey(c.env.WORK_PSEUDONYM_KEY);
    if (!key) return c.json({ ok: false, error: 'pseudonym_key_unprovisioned' }, 503);

    let tier: 0 | 1 = 0;
    if (input.tier > 0) {
      try {
        tier = publishedTier(input.tier, await (deps.accountBound ?? readAccountBound)(c.env, account));
      } catch (err) {
        workLog({ event: 'work_listing_binding_unreadable', reason: failureOf(err) });
        return c.json({ ok: false, error: 'binding_check_unavailable', message: 'the personhood binding could not be read on Base; retry shortly' }, 503);
      }
    }

    const t0 = deps.now();
    const now = () => deps.now();
    const registry = { inference, store: stores.registry, index: stores.tokenIndex, tau: parseTau(c.env.WORK_TAU_AUTO, c.env.WORK_TAU_LOW), now, log: workLog };
    const draft: ListingDraft = { ...input, tier, pseudonym: await workPseudonym(key, account) };
    let outcome: PublishOutcome;
    try {
      outcome = await publishListing({ inference, registry, listings: stores.listings, index: stores.listingIndex, now, log: workLog }, draft);
    } catch (err) {
      if (!(err instanceof WorkCallsError)) throw err;
      gate.meter(c, store, account, err.calls);
      workLog({ event: 'work_listing_failed', on: true, reason: failureOf(err), calls: err.calls.length });
      return c.json({ ok: false, error: 'work_store_unavailable' }, 503);
    }
    gate.meter(c, store, account, outcome.calls);
    if (!outcome.ok) {
      workLog({ event: 'work_listing_failed', on: true, reason: outcome.error, calls: outcome.calls.length });
      switch (outcome.error) {
        case 'draft_refused':
          return c.json({ ok: false, error: 'draft_refused', reason: outcome.reason }, 422);
        case 'profile_limit':
          return c.json({ ok: false, error: 'profile_limit', limit: outcome.limit }, 409);
        case 'embedding_failed':
          return c.json({ ok: false, error: 'embedding_failed' }, 502);
      }
    }
    workLog({ event: 'work_listing', on: true, scope: draft.scope, tier, tokens: outcome.tokens.length, calls: outcome.calls.length, ms: deps.now() - t0 });
    return c.json({ ok: true, listingId: outcome.listingId, profileId: draft.profileId, namespace: outcome.namespace, tier, tokens: outcome.tokens });
  });

  routes.delete('/listing', async (c) => {
    const admitted = await offGate.admitWithoutModels<string>(c, (b) => {
      if (typeof b.profileId === 'string' && PROFILE_ID.test(b.profileId)) return b.profileId;
      return c.json({ ok: false, error: 'bad_request', message: 'profileId must be 1 to 32 characters of a-z, 0-9 and -' }, 400);
    });
    if (admitted instanceof Response) return admitted;
    const { account, input: profileId } = admitted;
    const stores = listingStores(storesOf(c.env));
    if (typeof stores === 'string') return c.json({ ok: false, error: UNPROVISIONED[stores] }, 503);
    const key = pseudonymKey(c.env.WORK_PSEUDONYM_KEY);
    if (!key) return c.json({ ok: false, error: 'pseudonym_key_unprovisioned' }, 503);
    let listingId: string;
    try {
      listingId = await unpublishListing({ listings: stores.listings, index: stores.listingIndex }, await workPseudonym(key, account), profileId);
    } catch (err) {
      workLog({ event: 'work_listing_failed', on: false, reason: failureOf(err) });
      return c.json({ ok: false, error: 'work_store_unavailable' }, 503);
    }
    workLog({ event: 'work_listing', on: false });
    return c.json({ ok: true, listingId, profileId });
  });

  return routes;
}

export const workListingRoutes = createWorkListingRoutes();
