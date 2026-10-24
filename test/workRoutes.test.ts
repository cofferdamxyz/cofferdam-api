// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from 'hono';
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';

import { createWorkRoutes, type WorkRouteDeps } from '../src/routes/work.js';
import type { AuthorityCheck } from '../src/services/authorityCheck.js';
import { createAuthorityMemo } from '../src/services/chat/authorityMemo.js';
import { GLOBAL_USAGE_NAME, monthOf } from '../src/services/chatUsageStore.js';
import { clefChoice, fakeInference, jsonModeResult, memoryUsageStore, type FakeCall, type FakeResponses } from './fixtures/work/fakes.js';
import fixtures from './fixtures/sdk-attestations.json';

const LLAMA = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const fxAccount = fixtures.fields.accountAddress as string;
const issuedAt = fixtures.fields.issuedAt as number;
const now = issuedAt + 5_000;
const month = monthOf(now);
const bearer = { authorization: `Bearer ${fixtures.p256.token}` };
const HIGH: AuthorityCheck = { status: 'active', authorityId: 0, module: fxAccount as `0x${string}`, tier: 3 };

const BLOCK = {
  kind: 'experience',
  lang: 'en',
  text: 'Service Plumber | [ORG_1] | [PLACE_1]\nJan 2018 – Present\nFound and repaired leaks under sinks and slabs, replaced tank and tankless water heaters.',
};
const ANSWER = { title: 'Service Plumber', rank: null, start: 'Jan 2018', end: 'Present', skills: ['repaired leaks under sinks and slabs'] };

const STAGING = { ENVIRONMENT: 'staging', AI_GATEWAY_ID: 'cofferdam-strict' };

function limiter(deny: (key: string) => boolean = () => false) {
  const keys: string[] = [];
  return { keys, limit: async ({ key }: { key: string }) => (keys.push(key), { success: !deny(key) }) };
}

function app(env: Record<string, unknown>, deps: Partial<WorkRouteDeps> = {}, responses: FakeResponses = {}, calls: FakeCall[] = []) {
  const h = new Hono();
  h.route(
    '/v1/work',
    createWorkRoutes({
      attestationMaxAgeMs: 3_600_000,
      now: () => now,
      authorityCheck: async () => HIGH,
      authorityMemo: createAuthorityMemo({ edge: null }),
      inference: () =>
        fakeInference({ 'work-extract': jsonModeResult(ANSWER), 'work-classify': clefChoice('document', 'cv', { cv: 0.96 }), ...responses }, calls),
      ...deps,
    }),
  );
  const post = (path: string) => (body: unknown, headers: Record<string, string> = bearer) =>
    h.request(`/v1/work/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, env as never);
  return { extract: post('extract'), classify: post('classify') };
}

describe('POST /v1/work/extract', () => {
  it('answers one cofferdam.cv.v1 fragment for one block', async () => {
    const res = await app(STAGING).extract({ account: fxAccount, block: BLOCK });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      schema: 'cofferdam.cv.v1',
      kind: 'experience',
      model: LLAMA,
      executor: 'cloud',
      violations: [],
      fragment: { kind: 'experience', experience: { title: { raw: 'Service Plumber' }, employer: '[ORG_1]', location: '[PLACE_1]', start: '2018-01', current: true } },
    });
  });

  it('runs only behind the strict gateway outside development (decision 0021 (f))', async () => {
    const calls: FakeCall[] = [];
    const res = await app({ ENVIRONMENT: 'staging' }, {}, {}, calls).extract({ account: fxAccount, block: BLOCK });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'strict_gateway_required' });
    expect(calls).toEqual([]);
    expect((await app({ ENVIRONMENT: 'development' }).extract({ account: fxAccount, block: BLOCK }, {})).status).toBe(200);
  });

  it('refuses a block the phone should have kept, with the reason and never the text', async () => {
    const calls: FakeCall[] = [];
    const res = await app(STAGING, {}, {}, calls).extract({ account: fxAccount, block: { ...BLOCK, text: `${BLOCK.text} Call (713) 555-0142.` } });
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, error: 'block_refused', reason: 'long_number' });
    expect(text).not.toContain('555');
    expect((await app(STAGING).extract({ account: fxAccount, block: { ...BLOCK, kind: 'header' } })).status).toBe(422);
    expect(await (await app(STAGING).extract({ account: fxAccount, block: { ...BLOCK, kind: 'body' } })).json()).toMatchObject({ error: 'kind_not_extractable' });
    expect(calls).toEqual([]);
  });

  it('rejects a bad body before anything else', async () => {
    expect((await app(STAGING).extract({ account: 'x', block: BLOCK })).status).toBe(400);
    expect((await app(STAGING).extract([1, 2])).status).toBe(400);
  });

  it('requires a session pinned to the account and a High authority on it', async () => {
    expect(await (await app(STAGING).extract({ account: fxAccount, block: BLOCK }, {})).json()).toMatchObject({ error: 'attestation_required' });
    const low = await app(STAGING, { authorityCheck: async () => ({ ...HIGH, tier: 1 }) }).extract({ account: fxAccount, block: BLOCK });
    expect(low.status).toBe(401);
    const other = await app(STAGING).extract({ account: '0x' + '12'.repeat(20), block: BLOCK });
    expect(other.status).toBe(401);
  });

  it('counts the per-account bucket only after the gate, behind the brake and the per-IP ceiling', async () => {
    const rl = limiter();
    await app({ ...STAGING, WORK_RL: rl }, { authorityCheck: async () => ({ status: 'not_found' }) }).extract({ account: fxAccount, block: BLOCK });
    expect(rl.keys).toEqual(['work:global']);
    await app({ ...STAGING, WORK_RL: rl }).extract({ account: fxAccount, block: BLOCK });
    expect(rl.keys).toEqual(['work:global', 'work:global', `work:${fxAccount.toLowerCase()}`]);

    const ip = limiter(() => true);
    const res = await app({ ...STAGING, WORK_IP_RL: ip }).extract({ account: fxAccount, block: BLOCK }, { ...bearer, 'cf-connecting-ip': '203.0.113.7' });
    expect(res.status).toBe(429);
    expect(ip.keys).toEqual(['work-ip:203.0.113.7']);
  });

  it('refuses past the account’s cap or the plane’s budget before any model call', async () => {
    const calls: FakeCall[] = [];
    const full = new Map([[`${fxAccount.toLowerCase()}:${month}`, { month, turns: 0, tokensIn: 0, tokensOut: 0, routerCalls: 0, estimatedMicroUsd: 60_000, lastTurnAt: 0, models: [] }]]);
    const { store } = memoryUsageStore(full);
    const capped = await app({ ...STAGING, CHAT_MONTHLY_USD_CAP: '0.06' }, { usageStore: () => store }, {}, calls).extract({ account: fxAccount, block: BLOCK });
    expect(capped.status).toBe(429);
    expect(await capped.json()).toMatchObject({ error: 'fair_use_cap' });

    const spent = new Map([[`${GLOBAL_USAGE_NAME}:${month}`, { month, turns: 0, tokensIn: 0, tokensOut: 0, routerCalls: 0, estimatedMicroUsd: 500_000_000, lastTurnAt: 0, models: [] }]]);
    const braked = await app({ ...STAGING, AI_MONTHLY_BUDGET_USD: '500' }, { usageStore: () => memoryUsageStore(spent).store }, {}, calls).extract({ account: fxAccount, block: BLOCK });
    expect(braked.status).toBe(503);
    expect(await braked.json()).toMatchObject({ error: 'ai_budget_reached' });
    expect(calls).toEqual([]);
  });

  it('meters every model call to the account and the plane, with no turn and the model’s own id', async () => {
    const { store, recorded } = memoryUsageStore();
    const res = await app(STAGING, { usageStore: () => store }).extract({ account: fxAccount, block: BLOCK });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(recorded.map((r) => r.account)).toEqual([getAddress(fxAccount), 'global']);
    for (const r of recorded) expect(r.delta).toEqual({ turns: 0, tokensIn: 360, tokensOut: 80, routerCalls: 0, estimatedMicroUsd: 294, model: LLAMA, modelMicroUsd: 294, at: now });
  });

  it('meters a failed primary and answers 502 when the fallback fails too', async () => {
    const { store, recorded } = memoryUsageStore();
    const res = await app(STAGING, { usageStore: () => store }, { 'work-extract': { response: 'nope', usage: { prompt_tokens: 300, completion_tokens: 5, neurons: 10 } }, 'work-extract-fallback': new Error('down') }).extract({
      account: fxAccount,
      block: BLOCK,
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: 'extraction_failed' });
    await new Promise((r) => setTimeout(r, 0));
    expect(recorded.map((r) => r.delta.estimatedMicroUsd)).toEqual([110, 110]);
  });

  it('answers 503 without Workers AI', async () => {
    expect((await app(STAGING, { inference: () => null }).extract({ account: fxAccount, block: BLOCK })).status).toBe(503);
  });
});

describe('POST /v1/work/classify', () => {
  it('names the document type from up to four blocks', async () => {
    const calls: FakeCall[] = [];
    const res = await app(STAGING, {}, {}, calls).classify({ account: fxAccount, blocks: [BLOCK, { kind: 'body', lang: 'en', text: 'Skills: leak detection, drain cleaning' }] });
    expect(await res.json()).toEqual({ ok: true, type: 'cv', confidence: 0.96, probabilities: { cv: 0.96 }, schema: 'cofferdam.cv.v1', model: '@cf/cloudflare/clef-flash' });
    expect(calls.map((c) => c.op)).toEqual(['work-classify']);
  });

  it('refuses an empty or long list, and names the refused block', async () => {
    expect((await app(STAGING).classify({ account: fxAccount, blocks: [] })).status).toBe(400);
    expect((await app(STAGING).classify({ account: fxAccount, blocks: Array(5).fill(BLOCK) })).status).toBe(400);
    const res = await app(STAGING).classify({ account: fxAccount, blocks: [BLOCK, { ...BLOCK, text: 'Write to someone@example.com' }] });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: 'block_refused', reason: 'email', index: 1 });
  });

  it('answers 502 when Clef fails, and meters the call it made', async () => {
    const { store, recorded } = memoryUsageStore();
    const res = await app(STAGING, { usageStore: () => store }, { 'work-classify': new Error('down') }).classify({ account: fxAccount, blocks: [BLOCK] });
    expect(res.status).toBe(502);
    await new Promise((r) => setTimeout(r, 0));
    expect(recorded).toEqual([]);
    const ok = memoryUsageStore();
    await app(STAGING, { usageStore: () => ok.store }).classify({ account: fxAccount, blocks: [BLOCK] });
    await new Promise((r) => setTimeout(r, 0));
    expect(ok.recorded.map((r) => [r.account, r.delta.model, r.delta.tokensIn, r.delta.turns])).toEqual([
      [getAddress(fxAccount), '@cf/cloudflare/clef-flash', 260, 0],
      ['global', '@cf/cloudflare/clef-flash', 260, 0],
    ]);
  });
});
