// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from 'hono';
import { getAddress } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkListingRoutes, publishedTier, type ListingRouteDeps } from '../src/routes/workListing.js';
import type { AuthorityCheck } from '../src/services/authorityCheck.js';
import { createAuthorityMemo } from '../src/services/chat/authorityMemo.js';
import { GLOBAL_USAGE_NAME, monthOf } from '../src/services/chatUsageStore.js';
import { listingIdOf } from '../src/services/work/listings.js';
import { pseudonymKey, workPseudonym } from '../src/services/work/pseudonym.js';
import type { WorkStores } from '../src/services/work/stores.js';
import { memoryUsageStore, type FakeCall, type FakeResponses } from './fixtures/work/fakes.js';
import { keywordEmbed, workWorld } from './fixtures/work/world.js';
import fixtures from './fixtures/sdk-attestations.json';

const fxAccount = fixtures.fields.accountAddress as string;
const issuedAt = fixtures.fields.issuedAt as number;
const now = issuedAt + 5_000;
const month = monthOf(now);
const bearer = { authorization: `Bearer ${fixtures.p256.token}` };
const HIGH: AuthorityCheck = { status: 'active', authorityId: 0, module: fxAccount as `0x${string}`, tier: 3 };
const KEY = 'synthetic-work-pseudonym-key-for-tests-0001';
const STAGING = { ENVIRONMENT: 'staging', AI_GATEWAY_ID: 'cofferdam-strict', WORK_PSEUDONYM_KEY: KEY };
const BGE_M3 = '@cf/baai/bge-m3';

/** The storefront draft as the phone sends it: no pseudonym. */
const DRAFT = {
  profileId: 'main',
  region: 'us-tx',
  scope: 'onsite',
  tier: 1,
  lang: 'en',
  titles: ['Service Plumber'],
  skills: ['Leak detection'],
  certificates: ['Texas Journeyman Plumber License'],
  languages: ['en', 'es'],
};

function limiter(deny: (key: string) => boolean = () => false) {
  const keys: string[] = [];
  return { keys, limit: async ({ key }: { key: string }) => (keys.push(key), { success: !deny(key) }) };
}

async function app(env: Record<string, unknown> = STAGING, deps: Partial<ListingRouteDeps> = {}, responses: FakeResponses = {}) {
  const calls: FakeCall[] = [];
  const w = await workWorld(responses, calls);
  const checks = { authority: 0, binding: 0 };
  const h = new Hono();
  h.route(
    '/v1/work',
    createWorkListingRoutes({
      attestationMaxAgeMs: 3_600_000,
      now: () => now,
      authorityCheck: async () => (checks.authority++, HIGH),
      authorityMemo: createAuthorityMemo({ edge: null }),
      inference: () => w.inference,
      stores: () => w.stores,
      accountBound: async () => (checks.binding++, true),
      ...deps,
    }),
  );
  const send =
    (method: 'PUT' | 'DELETE') =>
    (body: unknown, headers: Record<string, string> = bearer) =>
      h.request('/v1/work/listing', { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, env as never);
  return { ...w, calls, checks, put: send('PUT'), del: send('DELETE') };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the Work pseudonym', () => {
  it('is an HMAC of the account under the plane key: stable, casing-blind, and unrelated without the key', async () => {
    const p = await workPseudonym(KEY, fxAccount);
    expect(p).toMatch(/^P[A-Za-z0-9_-]{43}$/);
    expect(await workPseudonym(KEY, fxAccount.toUpperCase().replace('0X', '0x'))).toBe(p);
    expect(await workPseudonym(`${KEY}-other`, fxAccount)).not.toBe(p);
    expect(await workPseudonym(KEY, '0x' + '12'.repeat(20))).not.toBe(p);
    expect(p.toLowerCase()).not.toContain(fxAccount.slice(2).toLowerCase());
  });

  it('takes only a key of 32 characters or more', () => {
    expect(pseudonymKey(undefined)).toBeNull();
    expect(pseudonymKey('short')).toBeNull();
    expect(pseudonymKey(KEY)).toBe(KEY);
  });

  it('publishes no more personhood than Base shows', () => {
    expect(publishedTier(0, true)).toBe(0);
    expect(publishedTier(1, true)).toBe(1);
    expect(publishedTier(2, true)).toBe(1);
    expect(publishedTier(1, false)).toBe(0);
    expect(publishedTier(2, false)).toBe(0);
  });
});

describe('PUT /v1/work/listing', () => {
  it('publishes the profile’s listing under the account’s pseudonym, never the account', async () => {
    const a = await app();
    const res = await a.put({ account: fxAccount, ...DRAFT });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & { tokens: string[] };
    const pseudonym = await workPseudonym(KEY, fxAccount);
    const listingId = await listingIdOf(pseudonym, 'main');
    expect(Object.keys(body).sort()).toEqual(['listingId', 'namespace', 'ok', 'profileId', 'tier', 'tokens']);
    expect(body).toMatchObject({ ok: true, listingId, profileId: 'main', namespace: 'us-tx:onsite', tier: 1 });
    expect(body.tokens).toEqual(expect.arrayContaining(['cert:plumber-license:us-tx', 'lang:en', 'lang:es', 'pos:plumber', 'skill:leak-repair']));
    const row = a.db.sqlite.prepare('SELECT * FROM listings').all() as Record<string, unknown>[];
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ listing_id: listingId, pseudonym, profile_id: 'main', region: 'us-tx', tier: 1 });
    const stored = JSON.stringify(row) + JSON.stringify([...a.listingIndex.vectors.values()]);
    expect(stored.toLowerCase()).not.toContain(fxAccount.slice(2).toLowerCase());
    const vector = a.listingIndex.vectors.get(listingId)!;
    expect(Object.keys(vector.metadata).sort()).toEqual(['bloom', 'model', 'region', 'scope', 'tier', 'v']);
    expect(JSON.stringify(body).toLowerCase()).not.toContain(fxAccount.slice(2).toLowerCase());
  });

  it('ignores a pseudonym in the body: the plane derives its own', async () => {
    const a = await app();
    const res = await a.put({ account: fxAccount, ...DRAFT, pseudonym: 'someone-else' });
    expect(res.status).toBe(200);
    const rows = a.db.sqlite.prepare('SELECT pseudonym FROM listings').all() as { pseudonym: string }[];
    expect(rows.map((r) => r.pseudonym)).toEqual([await workPseudonym(KEY, fxAccount)]);
  });

  it('publishes the tier Base shows, and refuses rather than guess when Base cannot be read', async () => {
    const unbound = await app(STAGING, { accountBound: async () => false });
    expect(await (await unbound.put({ account: fxAccount, ...DRAFT, tier: 2 })).json()).toMatchObject({ ok: true, tier: 0 });
    const bound = await app();
    expect(await (await bound.put({ account: fxAccount, ...DRAFT, tier: 2 })).json()).toMatchObject({ ok: true, tier: 1 });
    expect(bound.listingIndex.vectors.values().next().value!.metadata.tier).toBe(1);

    const claimsNone = await app();
    expect(await (await claimsNone.put({ account: fxAccount, ...DRAFT, tier: 0 })).json()).toMatchObject({ ok: true, tier: 0 });
    expect(claimsNone.checks.binding).toBe(0);

    const down = await app(STAGING, {
      accountBound: async () => {
        throw new Error('rpc down');
      },
    });
    const res = await down.put({ account: fxAccount, ...DRAFT });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'binding_check_unavailable' });
    expect(down.calls).toEqual([]);
    expect(down.listingIndex.vectors.size).toBe(0);
  });

  it('refuses a bad draft with its reason, before the gate and any model, and never echoes it', async () => {
    const a = await app();
    const cases: [Record<string, unknown>, string][] = [
      [{ region: '29.76,-95.37' }, 'bad_region'],
      [{ skills: ['Call (713) 555-0142'] }, 'refused_pattern'],
      [{ titles: [], skills: [] }, 'no_claims'],
      [{ profileId: undefined }, 'bad_shape'],
      [{ profileId: null }, 'bad_shape'],
      [{ tier: '1' }, 'bad_shape'],
      [{ certificates: undefined }, 'bad_shape'],
      [{ lang: 'fr' }, 'bad_lang'],
      [{ scope: 'hybrid' }, 'bad_scope'],
    ];
    for (const [over, reason] of cases) {
      const res = await a.put({ account: fxAccount, ...DRAFT, ...over });
      expect(res.status).toBe(422);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ ok: false, error: 'draft_refused', reason });
      expect(text).not.toContain('555');
    }
    expect((await a.put({ account: 'x', ...DRAFT })).status).toBe(400);
    expect((await a.put([1, 2])).status).toBe(400);
    expect(a.checks.authority).toBe(0);
    expect(a.calls).toEqual([]);
  });

  it('runs only behind the strict gateway outside development', async () => {
    const a = await app({ ENVIRONMENT: 'staging', WORK_PSEUDONYM_KEY: KEY });
    const res = await a.put({ account: fxAccount, ...DRAFT });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'strict_gateway_required' });
    expect(a.calls).toEqual([]);
    const dev = await app({ ENVIRONMENT: 'development', WORK_PSEUDONYM_KEY: KEY });
    expect((await dev.put({ account: fxAccount, ...DRAFT }, {})).status).toBe(200);
  });

  it('requires a session pinned to the account and a High authority on it', async () => {
    const a = await app();
    expect(await (await a.put({ account: fxAccount, ...DRAFT }, {})).json()).toMatchObject({ error: 'attestation_required' });
    const low = await app(STAGING, { authorityCheck: async () => ({ ...HIGH, tier: 1 }) });
    expect((await low.put({ account: fxAccount, ...DRAFT })).status).toBe(401);
    expect((await a.put({ account: '0x' + '12'.repeat(20), ...DRAFT })).status).toBe(401);
    expect(a.calls).toEqual([]);
  });

  it('counts the per-account bucket only after the gate, behind the brake and the per-IP ceiling', async () => {
    const rl = limiter();
    const refused = await app({ ...STAGING, WORK_RL: rl }, { authorityCheck: async () => ({ status: 'not_found' }) });
    await refused.put({ account: fxAccount, ...DRAFT });
    expect(rl.keys).toEqual(['work:global']);
    const a = await app({ ...STAGING, WORK_RL: rl });
    await a.put({ account: fxAccount, ...DRAFT });
    expect(rl.keys).toEqual(['work:global', 'work:global', `work:${fxAccount.toLowerCase()}`]);

    const ip = limiter(() => true);
    const busy = await app({ ...STAGING, WORK_IP_RL: ip });
    const res = await busy.put({ account: fxAccount, ...DRAFT }, { ...bearer, 'cf-connecting-ip': '203.0.113.7' });
    expect(res.status).toBe(429);
    expect(ip.keys).toEqual(['work-ip:203.0.113.7']);
  });

  it('refuses past the account’s cap or the plane’s budget before any model call', async () => {
    const full = new Map([[`${fxAccount.toLowerCase()}:${month}`, { month, turns: 0, tokensIn: 0, tokensOut: 0, routerCalls: 0, estimatedMicroUsd: 60_000, lastTurnAt: 0, models: [] }]]);
    const capped = await app({ ...STAGING, CHAT_MONTHLY_USD_CAP: '0.06' }, { usageStore: () => memoryUsageStore(full).store });
    const res = await capped.put({ account: fxAccount, ...DRAFT });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'fair_use_cap' });
    expect(capped.calls).toEqual([]);

    const spent = new Map([[`${GLOBAL_USAGE_NAME}:${month}`, { month, turns: 0, tokensIn: 0, tokensOut: 0, routerCalls: 0, estimatedMicroUsd: 500_000_000, lastTurnAt: 0, models: [] }]]);
    const braked = await app({ ...STAGING, AI_MONTHLY_BUDGET_USD: '500' }, { usageStore: () => memoryUsageStore(spent).store });
    const r = await braked.put({ account: fxAccount, ...DRAFT });
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: 'ai_budget_reached' });
    expect(braked.calls).toEqual([]);
  });

  it('answers 503 with the store that is not bound, or without the pseudonym key', async () => {
    const without = (missing: keyof WorkStores) => async () => {
      const w = await workWorld();
      return { ...w.stores, [missing]: null };
    };
    for (const [missing, error] of [
      ['registry', 'work_db_unprovisioned'],
      ['tokenIndex', 'token_registry_unprovisioned'],
      ['listingIndex', 'jobs_listings_unprovisioned'],
    ] as const) {
      const w = await without(missing)();
      const a = await app(STAGING, { stores: () => w });
      const res = await a.put({ account: fxAccount, ...DRAFT });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, error });
    }
    for (const key of [undefined, 'too-short']) {
      const a = await app({ ...STAGING, WORK_PSEUDONYM_KEY: key });
      const res = await a.put({ account: fxAccount, ...DRAFT });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, error: 'pseudonym_key_unprovisioned' });
      expect(a.calls).toEqual([]);
    }
    expect((await (await app(STAGING, { inference: () => null })).put({ account: fxAccount, ...DRAFT })).status).toBe(503);
  });

  it('meters every model call to the account and the plane, with no turn', async () => {
    const { store, recorded } = memoryUsageStore();
    const a = await app(STAGING, { usageStore: () => store });
    expect((await a.put({ account: fxAccount, ...DRAFT })).status).toBe(200);
    await settle();
    const embeds = a.calls.filter((c) => c.op === 'work-embed').length;
    expect(embeds).toBeGreaterThan(1);
    // Every embedding call is one model: one delta, the calls summed, to the account's row and the plane's.
    expect(recorded.map((r) => r.account)).toEqual([getAddress(fxAccount), 'global']);
    for (const r of recorded) expect(r.delta).toMatchObject({ turns: 0, routerCalls: 0, model: BGE_M3, at: now });
  });

  it('answers 502 when the listing cannot be embedded, and meters what ran', async () => {
    const { store, recorded } = memoryUsageStore();
    // The claims' snaps embed as usual; the listing's own text (its claims joined by ". ") fails.
    const flaky = (input: Record<string, unknown>) => {
      const texts = input.text as string[];
      if (texts.some((t) => t.includes('. '))) throw new Error('down');
      return keywordEmbed(input);
    };
    const a = await app(STAGING, { usageStore: () => store }, { 'work-embed': flaky });
    const res = await a.put({ account: fxAccount, ...DRAFT });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: 'embedding_failed' });
    expect(a.listingIndex.vectors.size).toBe(0);
    await settle();
    // The failed embedding is metered at its estimated input, inside the model's one delta.
    expect(a.calls.filter((c) => c.op === 'work-embed').length).toBeGreaterThan(1);
    expect(recorded.filter((r) => r.account === 'global').map((r) => r.delta.model)).toEqual([BGE_M3]);
  });

  it('meters the calls a store failure interrupted, and answers 503', async () => {
    const { store, recorded } = memoryUsageStore();
    const w = await workWorld();
    const broken = { ...w.stores, listingIndex: { ...w.stores.listingIndex!, upsert: async () => Promise.reject(new Error('vectorize down')) } };
    const a = await app(STAGING, { usageStore: () => store, stores: () => broken });
    const res = await a.put({ account: fxAccount, ...DRAFT });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'work_store_unavailable' });
    await settle();
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((r) => r.delta.turns === 0)).toBe(true);
  });

  it('holds three profiles per account: a fourth answers 409 before any model call', async () => {
    const a = await app();
    for (const profileId of ['main', 'mechanic', 'driver']) expect((await a.put({ account: fxAccount, ...DRAFT, profileId })).status).toBe(200);
    a.calls.length = 0;
    const res = await a.put({ account: fxAccount, ...DRAFT, profileId: 'cook' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'profile_limit', limit: 3 });
    expect(a.calls).toEqual([]);
    expect((await a.put({ account: fxAccount, ...DRAFT, profileId: 'driver', region: 'us-la' })).status).toBe(200);
    // Taking one down makes room again.
    expect((await a.del({ account: fxAccount, profileId: 'mechanic' })).status).toBe(200);
    expect((await a.put({ account: fxAccount, ...DRAFT, profileId: 'cook' })).status).toBe(200);
  });

  it('logs no account, pseudonym or claim', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
    const a = await app();
    expect((await a.put({ account: fxAccount, ...DRAFT })).status).toBe(200);
    await a.put({ account: fxAccount, ...DRAFT, skills: ['Call (713) 555-0142'] });
    await a.del({ account: fxAccount, profileId: 'main' });
    const pseudonym = await workPseudonym(KEY, fxAccount);
    const all = lines.join('\n');
    expect(all).toContain('work_listing');
    for (const secret of [fxAccount.slice(2).toLowerCase(), pseudonym.toLowerCase(), 'plumber', '555']) expect(all.toLowerCase()).not.toContain(secret);
  });
});

describe('DELETE /v1/work/listing', () => {
  it('takes the profile’s listing down, record and vector, and answers the same when nothing was up', async () => {
    const a = await app();
    const up = (await (await a.put({ account: fxAccount, ...DRAFT })).json()) as { listingId: string };
    await a.put({ account: fxAccount, ...DRAFT, profileId: 'helper', titles: ["Plumber's Helper"] });
    expect(a.listingIndex.vectors.size).toBe(2);
    const res = await a.del({ account: fxAccount, profileId: 'main' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, listingId: up.listingId, profileId: 'main' });
    expect(a.listingIndex.vectors.has(up.listingId)).toBe(false);
    expect((a.db.sqlite.prepare('SELECT profile_id FROM listings').all() as { profile_id: string }[]).map((r) => r.profile_id)).toEqual(['helper']);
    expect((await a.del({ account: fxAccount, profileId: 'main' })).status).toBe(200);
  });

  it('reaches only the gated account’s listings', async () => {
    const a = await app(STAGING, { authorityCheck: async () => HIGH });
    await a.put({ account: fxAccount, ...DRAFT });
    // Another account's session cannot name this account, and its own pseudonym holds nothing.
    expect((await a.del({ account: '0x' + '12'.repeat(20), profileId: 'main' })).status).toBe(401);
    expect(a.listingIndex.vectors.size).toBe(1);
  });

  it('runs no model, so neither the strict gateway nor a cap keeps a worker from taking a listing down', async () => {
    const spent = new Map([[`${GLOBAL_USAGE_NAME}:${month}`, { month, turns: 0, tokensIn: 0, tokensOut: 0, routerCalls: 0, estimatedMicroUsd: 500_000_000, lastTurnAt: 0, models: [] }]]);
    const a = await app({ ENVIRONMENT: 'staging', WORK_PSEUDONYM_KEY: KEY, AI_MONTHLY_BUDGET_USD: '500', CHAT_MONTHLY_USD_CAP: '0' }, { usageStore: () => memoryUsageStore(spent).store, inference: () => null });
    const res = await a.del({ account: fxAccount, profileId: 'main' });
    expect(res.status).toBe(200);
    expect(a.calls).toEqual([]);
  });

  it('keeps the gate, the brake and the bucket on keys of its own, and needs only the records and their index', async () => {
    const rl = limiter();
    const a = await app({ ...STAGING, WORK_RL: rl });
    expect((await a.del({ account: fxAccount, profileId: 'main' }, {})).status).toBe(401);
    expect(rl.keys).toEqual(['work-off:global']);
    await a.del({ account: fxAccount, profileId: 'main' }, { ...bearer, 'cf-connecting-ip': '203.0.113.7' });
    expect(rl.keys).toEqual(['work-off:global', 'work-off:global', `work-off:${fxAccount.toLowerCase()}`]);
    // Other Work traffic using up its own keys never blocks a withdrawal.
    const busy = await app({ ...STAGING, WORK_RL: limiter((k) => k.startsWith('work:')), WORK_IP_RL: limiter((k) => k.startsWith('work-ip:')) });
    expect((await busy.del({ account: fxAccount, profileId: 'main' }, { ...bearer, 'cf-connecting-ip': '203.0.113.7' })).status).toBe(200);
    expect((await busy.put({ account: fxAccount, ...DRAFT }, { ...bearer, 'cf-connecting-ip': '203.0.113.7' })).status).toBe(429);
    expect((await a.del({ account: fxAccount, profileId: 'Main Profile' })).status).toBe(400);
    expect((await a.del({ account: fxAccount })).status).toBe(400);
    const w = await workWorld();
    const noRegistryIndex = await app(STAGING, { stores: () => ({ ...w.stores, tokenIndex: null }) });
    expect((await noRegistryIndex.del({ account: fxAccount, profileId: 'main' })).status).toBe(200);
    const noListings = await app(STAGING, { stores: () => ({ ...w.stores, listingIndex: null }) });
    expect(await (await noListings.del({ account: fxAccount, profileId: 'main' })).json()).toEqual({ ok: false, error: 'jobs_listings_unprovisioned' });
    const noKey = await app({ ...STAGING, WORK_PSEUDONYM_KEY: undefined });
    expect(await (await noKey.del({ account: fxAccount, profileId: 'main' })).json()).toEqual({ ok: false, error: 'pseudonym_key_unprovisioned' });
  });
});
