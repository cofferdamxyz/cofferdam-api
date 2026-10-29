// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from 'hono';
import { getAddress } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createJobsRoutes, type JobsRouteDeps } from '../src/routes/jobs.js';
import type { AuthorityCheck } from '../src/services/authorityCheck.js';
import { createAuthorityMemo } from '../src/services/chat/authorityMemo.js';
import { GLOBAL_USAGE_NAME, monthOf } from '../src/services/chatUsageStore.js';
import { listingIdOf, publishListing, type ListingDraft } from '../src/services/work/listings.js';
import { workPseudonym } from '../src/services/work/pseudonym.js';
import { memoryUsageStore, type FakeCall, type FakeResponses } from './fixtures/work/fakes.js';
import { clefSays, intentAnswer, workWorld } from './fixtures/work/world.js';
import fixtures from './fixtures/sdk-attestations.json';

const fxAccount = fixtures.fields.accountAddress as string;
const issuedAt = fixtures.fields.issuedAt as number;
const now = issuedAt + 5_000;
const month = monthOf(now);
const bearer = { authorization: `Bearer ${fixtures.p256.token}` };
const HIGH: AuthorityCheck = { status: 'active', authorityId: 0, module: fxAccount as `0x${string}`, tier: 3 };
const KEY = 'synthetic-work-pseudonym-key-for-tests-0001';
const STAGING = { ENVIRONMENT: 'staging', AI_GATEWAY_ID: 'cofferdam-strict', WORK_PSEUDONYM_KEY: KEY };
const CLEF_FLASH = '@cf/cloudflare/clef-flash';

const SINK = 'My kitchen sink is leaking under the cabinet, need someone today after 2pm. I’ll pay $120.';
const REQUEST = { account: fxAccount, sentence: SINK, lang: 'en', regions: ['us-tx'] };

const draft = (over: Partial<ListingDraft>): ListingDraft => ({
  pseudonym: 'p1',
  profileId: 'main',
  region: 'us-tx',
  scope: 'onsite',
  tier: 1,
  lang: 'en',
  titles: ['Service Plumber'],
  skills: ['Leak detection'],
  certificates: [],
  languages: ['en'],
  ...over,
});

function limiter(deny: (key: string) => boolean = () => false) {
  const keys: string[] = [];
  return { keys, limit: async ({ key }: { key: string }) => (keys.push(key), { success: !deny(key) }) };
}

async function app(env: Record<string, unknown> = STAGING, deps: Partial<JobsRouteDeps> = {}, responses: FakeResponses = {}) {
  const calls: FakeCall[] = [];
  const w = await workWorld({ 'work-intent': intentAnswer(), 'work-classify': clefSays(/plumber|leak/), ...responses }, calls);
  const checks = { authority: 0 };
  const h = new Hono();
  h.route(
    '/v1/jobs',
    createJobsRoutes({
      attestationMaxAgeMs: 3_600_000,
      now: () => now,
      authorityCheck: async () => (checks.authority++, HIGH),
      authorityMemo: createAuthorityMemo({ edge: null }),
      inference: () => w.inference,
      stores: () => w.stores,
      ...deps,
    }),
  );
  /** Publish a worker's listing straight through the service, then forget its calls. */
  const publish = async (d: ListingDraft) => {
    const out = await publishListing({ inference: w.inference, registry: { inference: w.inference, store: w.registry, index: w.tokenIndex }, listings: w.listings, index: w.listingIndex }, d);
    if (!out.ok) throw new Error(`not published: ${out.error}`);
    calls.length = 0;
    return out.listingId;
  };
  const post = (body: unknown, headers: Record<string, string> = bearer) =>
    h.request('/v1/jobs/intent', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, env as never);
  return { ...w, calls, checks, publish, post };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /v1/jobs/intent', () => {
  it('plans the sink job and finds the Texas plumber, pseudonymously', async () => {
    const a = await app();
    const plumber = await a.publish(draft({ pseudonym: 'p-plumber', certificates: ['Texas Journeyman Plumber License'] }));
    await a.publish(draft({ pseudonym: 'p-plumber', profileId: 'helper', titles: ["Plumber's Helper"], skills: ['leak repair'] }));
    await a.publish(draft({ pseudonym: 'p-electrician', titles: ['Journeyman Electrician'], skills: ['EV charger installation'] }));
    const res = await a.post(REQUEST);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.ok).toBe(true);
    expect(body.plan).toMatchObject({
      scope: 'onsite',
      mode: 'instant',
      certificate: null,
      language: null,
      allOf: [],
      regions: ['us-tx'],
      missing: [],
      fields: { task: 'kitchen sink is leaking under the cabinet', when: 'today after 2pm', budgetUsd: 120 },
    });
    expect([...body.plan.anyOf].sort()).toEqual(['pos:plumber', 'skill:leak-repair']);
    expect(body.plan.needs.map((n: { token: string }) => n.token).sort()).toEqual(['pos:plumber', 'skill:leak-repair']);
    expect(Object.keys(body.plan).sort()).toEqual(['allOf', 'anyOf', 'certificate', 'fields', 'language', 'missing', 'mode', 'needs', 'regions', 'scope', 'scopeP']);
    // One listing per pseudonym: the plumber counts once, their helper profile beside it never.
    expect(body.finalists).toEqual({ count: 1, byGateTier: { 1: 1, 2: 0 }, byPersonhood: { 0: 0, 1: 1, 2: 0 } });
    const ids = [plumber, await listingIdOf('p-plumber', 'helper')];
    for (const hidden of [...ids, 'p-plumber', 'p-electrician', 'us-tx:onsite', fxAccount.slice(2).toLowerCase()]) expect(text.toLowerCase()).not.toContain(hidden.toLowerCase());
  });

  it('runs the decision pass: a plumber Clef calls other work leaves the count', async () => {
    const other = { answers: { fit: { choice: 'other', probabilities: { other: 0.9, related: 0.05, fit: 0.05 } } }, usage: { input_tokens: 200 } };
    const a = await app(STAGING, {}, { 'work-decide': other });
    await a.publish(draft({ pseudonym: 'p-plumber' }));
    const body = (await (await a.post(REQUEST)).json()) as { finalists: { count: number } };
    expect(body.finalists.count).toBe(0);
    expect(a.calls.filter((c) => c.op === 'work-decide')).toHaveLength(1);
  });

  it('answers counts only before funding: nothing per finalist that two answers could join', async () => {
    const a = await app(STAGING, {}, { 'work-intent': intentAnswer(), 'work-classify': clefSays(/plumber|leak/) });
    for (const [pseudonym, tier] of [['p1', 1], ['p2', 1], ['p3', 0]] as const) await a.publish(draft({ pseudonym, tier }));
    await a.publish(draft({ pseudonym: 'p4', titles: ['Journeyman Electrician'], skills: ['EV charger installation'] }));
    const text = await (await a.post(REQUEST)).text();
    const body = JSON.parse(text) as { finalists: Record<string, unknown> };
    expect(body.finalists).toEqual({ count: 3, byGateTier: { 1: 3, 2: 0 }, byPersonhood: { 0: 1, 1: 2, 2: 0 } });
    // No score, token list, reference or id per finalist.
    expect(text).not.toMatch(/"score"|"matched"|"ref"|"listingId"|"gateTier"/);
  });

  it('never offers the hirer their own listing', async () => {
    const a = await app();
    // The hirer's own listing is unbound (0) and the other worker's bound (1), so the counts show whose is left.
    await a.publish(draft({ pseudonym: await workPseudonym(KEY, fxAccount), tier: 0 }));
    await a.publish(draft({ pseudonym: 'p-other' }));
    const body = (await (await a.post(REQUEST)).json()) as any;
    expect(body.finalists).toEqual({ count: 1, byGateTier: { 1: 1, 2: 0 }, byPersonhood: { 0: 0, 1: 1, 2: 0 } });
    // Without the key no listing can have been published under a pseudonym of this plane, so nothing is left out.
    const keyless = await app({ ...STAGING, WORK_PSEUDONYM_KEY: undefined });
    await keyless.publish(draft({ pseudonym: 'p-other' }));
    expect((await keyless.post(REQUEST)).status).toBe(200);
  });

  it('checks the sentence, its language and its regions before the gate and any model, and never echoes it', async () => {
    const a = await app();
    const cases: [Record<string, unknown>, number, Record<string, unknown>][] = [
      [{ sentence: `${SINK} Call me at (713) 555-0142.` }, 422, { error: 'text_refused', reason: 'long_number' }],
      [{ sentence: `${SINK} Write to someone@example.com` }, 422, { error: 'text_refused', reason: 'email' }],
      [{ sentence: '   ' }, 422, { error: 'text_refused', reason: 'empty' }],
      [{ sentence: 42 }, 422, { error: 'text_refused', reason: 'empty' }],
      [{ sentence: 'x'.repeat(1_001) }, 422, { error: 'text_refused', reason: 'too_long' }],
      [{ lang: 'fr' }, 400, { error: 'bad_request', reason: 'lang' }],
      [{ regions: ['29.76,-95.37'] }, 400, { error: 'bad_request', reason: 'regions' }],
      [{ regions: [] }, 400, { error: 'bad_request', reason: 'regions' }],
      [{ regions: 'us-tx' }, 400, { error: 'bad_request', reason: 'regions' }],
    ];
    for (const [over, status, expected] of cases) {
      const res = await a.post({ ...REQUEST, ...over });
      expect(res.status).toBe(status);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ ok: false, ...expected });
      expect(text).not.toMatch(/555|example\.com|sink/);
    }
    expect((await a.post({ ...REQUEST, account: 'x' })).status).toBe(400);
    expect(a.checks.authority).toBe(0);
    expect(a.calls).toEqual([]);
  });

  it('refuses a harmful request after one Clef call, and meters it', async () => {
    const { store, recorded } = memoryUsageStore();
    const a = await app(STAGING, { usageStore: () => store }, { 'work-classify': clefSays(/plumber/, 'onsite', { harmful: 0.91 }) });
    const res = await a.post(REQUEST);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: 'refused', reason: 'harmful' });
    expect(a.calls.map((c) => c.op)).toEqual(['work-classify']);
    await settle();
    expect(recorded.map((r) => [r.account, r.delta.model, r.delta.tokensIn, r.delta.turns])).toEqual([
      [getAddress(fxAccount), CLEF_FLASH, 300, 0],
      ['global', CLEF_FLASH, 300, 0],
    ]);
  });

  it('refuses a budget under the $50 floor, and answers 502 when Clef cannot read the request', async () => {
    const low = await app(STAGING, {}, { 'work-intent': intentAnswer({ budget: 30 }) });
    const res = await low.post(REQUEST);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: 'below_minimum', minimumUsd: 50 });

    const { store, recorded } = memoryUsageStore();
    const down = await app(STAGING, { usageStore: () => store }, { 'work-classify': new Error('down') });
    const r = await down.post(REQUEST);
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ ok: false, error: 'classification_failed' });
    await settle();
    // The call that threw is metered at its estimated input.
    expect(recorded).toHaveLength(2);
    expect(recorded.every((x) => x.delta.tokensIn > 50 && x.delta.model === CLEF_FLASH)).toBe(true);
  });

  it('asks for what is missing and goes Curated for a named licence', async () => {
    const open = await app(STAGING, {}, { 'work-intent': intentAnswer({ budget: null, when: null }) });
    const asked = (await (await open.post({ ...REQUEST, sentence: 'My kitchen sink is leaking under the cabinet.' })).json()) as any;
    expect(asked.plan.missing).toEqual(['budget', 'when']);
    const licensed = await app(STAGING, {}, { 'work-intent': intentAnswer({ credential: 'licensed plumber' }), 'work-classify': clefSays(/plumber/) });
    await licensed.publish(draft({ pseudonym: 'p-plumber', certificates: ['Texas Journeyman Plumber License'] }));
    await licensed.publish(draft({ pseudonym: 'p-unlicensed' }));
    const body = (await (await licensed.post({ ...REQUEST, sentence: `${SINK} Must be a licensed plumber.` })).json()) as any;
    expect(body.plan).toMatchObject({ mode: 'curated', certificate: 'cert:plumber-license:us-tx', allOf: ['cert:plumber-license:us-tx'] });
    // The certificate is confirmed on the exact list: the unlicensed plumber is no finalist.
    // Curated with a required licence: the unlicensed plumber is not even a tier-2 finalist.
    expect(body.finalists).toMatchObject({ count: 1, byGateTier: { 1: 1, 2: 0 } });
  });

  it('meters the calls a store failure interrupted, the plan’s included, and answers 503', async () => {
    const { store, recorded } = memoryUsageStore();
    const w = await workWorld();
    const broken = { ...w.stores, listings: { ...w.stores.listings!, get: async () => Promise.reject(new Error('d1 down')) } };
    const a = await app(STAGING, { usageStore: () => store, stores: () => broken });
    const res = await a.post(REQUEST);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'work_store_unavailable' });
    await settle();
    const ops = new Set(recorded.map((r) => r.delta.model));
    expect(ops.has(CLEF_FLASH)).toBe(true);
    expect(ops.has('@cf/baai/bge-m3')).toBe(true);
    expect(recorded.length).toBe(a.calls.length * 2);
  });

  it('runs only behind the strict gateway outside development, and counts its own keys after the gate', async () => {
    const closed = await app({ ENVIRONMENT: 'staging' });
    const res = await closed.post(REQUEST);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'strict_gateway_required' });
    expect(closed.calls).toEqual([]);
    expect((await (await app({ ENVIRONMENT: 'development' })).post(REQUEST, {})).status).toBe(200);

    const rl = limiter();
    const refused = await app({ ...STAGING, WORK_RL: rl }, { authorityCheck: async () => ({ status: 'not_found' }) });
    expect((await refused.post(REQUEST)).status).toBe(401);
    expect(rl.keys).toEqual(['jobs:global']);
    await (await app({ ...STAGING, WORK_RL: rl })).post(REQUEST);
    expect(rl.keys).toEqual(['jobs:global', 'jobs:global', `jobs:${fxAccount.toLowerCase()}`]);
    const ip = limiter(() => true);
    const busy = await app({ ...STAGING, WORK_IP_RL: ip });
    expect((await busy.post(REQUEST, { ...bearer, 'cf-connecting-ip': '203.0.113.7' })).status).toBe(429);
    expect(ip.keys).toEqual(['jobs-ip:203.0.113.7']);
  });

  it('requires a High session on the account, and refuses past the caps before any model call', async () => {
    const a = await app();
    expect(await (await a.post(REQUEST, {})).json()).toMatchObject({ error: 'attestation_required' });
    expect((await a.post({ ...REQUEST, account: '0x' + '12'.repeat(20) })).status).toBe(401);
    const full = new Map([[`${fxAccount.toLowerCase()}:${month}`, { month, turns: 0, tokensIn: 0, tokensOut: 0, routerCalls: 0, estimatedMicroUsd: 60_000, lastTurnAt: 0, models: [] }]]);
    const capped = await app({ ...STAGING, CHAT_MONTHLY_USD_CAP: '0.06' }, { usageStore: () => memoryUsageStore(full).store });
    expect(await (await capped.post(REQUEST)).json()).toMatchObject({ error: 'fair_use_cap' });
    const spent = new Map([[`${GLOBAL_USAGE_NAME}:${month}`, { month, turns: 0, tokensIn: 0, tokensOut: 0, routerCalls: 0, estimatedMicroUsd: 500_000_000, lastTurnAt: 0, models: [] }]]);
    const braked = await app({ ...STAGING, AI_MONTHLY_BUDGET_USD: '500' }, { usageStore: () => memoryUsageStore(spent).store });
    expect(await (await braked.post(REQUEST)).json()).toMatchObject({ error: 'ai_budget_reached' });
    expect([...a.calls, ...capped.calls, ...braked.calls]).toEqual([]);
  });

  it('answers 503 with the store that is not bound', async () => {
    const w = await workWorld();
    for (const [missing, error] of [
      ['listings', 'work_db_unprovisioned'],
      ['tokenIndex', 'token_registry_unprovisioned'],
      ['listingIndex', 'jobs_listings_unprovisioned'],
    ] as const) {
      const a = await app(STAGING, { stores: () => ({ ...w.stores, [missing]: null }) });
      const res = await a.post(REQUEST);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, error });
      expect(a.calls).toEqual([]);
    }
  });

  it('logs no sentence, account or token', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
    const a = await app();
    await a.publish(draft({ pseudonym: 'p-plumber' }));
    expect((await a.post(REQUEST)).status).toBe(200);
    await a.post({ ...REQUEST, sentence: `${SINK} Call me at (713) 555-0142.` });
    const all = lines.join('\n').toLowerCase();
    expect(all).toContain('jobs_intent');
    for (const secret of ['sink', 'cabinet', '555', 'plumber', 'p-plumber', fxAccount.slice(2).toLowerCase()]) expect(all).not.toContain(secret);
  });
});
