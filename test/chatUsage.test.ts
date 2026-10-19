// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from 'hono';
import type { Address } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';

import { createChatRoutes, type ChatRouteDeps } from '../src/routes/chat.js';
import type { AuthorityCheck } from '../src/services/authorityCheck.js';
import { createAuthorityMemo } from '../src/services/chat/authorityMemo.js';
import { FIXED_TEXT, headerLanguage, runChat, type ChatEvent, type ChatInference, type ChatTurnUsage } from '../src/services/chat/run.js';
import {
  capTokens,
  monthOf,
  monthResetsAt,
  parseTokenCap,
  usageDelta,
  type ChatMonthUsage,
  type ChatUsageDelta,
  type ChatUsageStore,
} from '../src/services/chatUsageStore.js';
import { clearUnpricedModels, MODEL_PRICES, modelCostMicroUsd, OPS, type InferenceOp } from '../src/services/inference/index.js';
import fixtures from './fixtures/sdk-attestations.json';

const GEMMA = '@cf/google/gemma-4-26b-a4b-it';
const CLEF = '@cf/cloudflare/clef-flash';

function clef(action: string, actionP: number, opts: { harmful?: number; language?: [string, number] } = {}) {
  const answers: Record<string, unknown> = {
    action: { type: 'choice', choice: action, probabilities: { [action]: actionP } },
    depth: { type: 'choice', choice: 'short', probabilities: { short: 0.9 } },
    harmful: { type: 'noul', noul: opts.harmful ?? 0.01 },
    injection: { type: 'noul', noul: 0.01 },
  };
  if (opts.language) {
    const [l, p] = opts.language;
    answers.language = { type: 'choice', choice: l, probabilities: { [l]: p } };
  }
  return { answers };
}

function sse(chunks: string[], usage?: Record<string, number>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const t of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`));
      if (usage) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [], usage })}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
}

function fakeInference(responses: Partial<Record<InferenceOp, unknown>>, calls: InferenceOp[] = []): ChatInference {
  return {
    async model(op) {
      return OPS[op].model;
    },
    async run(op) {
      calls.push(op);
      const r = responses[op];
      const v = typeof r === 'function' ? await (r as () => unknown)() : r;
      if (v instanceof Error) throw v;
      return v;
    },
  };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<ChatEvent[]> {
  const text = await new Response(stream).text();
  return text.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')) as ChatEvent);
}

const user = (text: string) => [{ role: 'user' as const, text }];
const texts = (events: ChatEvent[]) =>
  events
    .filter((e) => e.type === 'text')
    .map((e) => (e as { delta: string }).delta)
    .join('');

/** An in-memory meter that records every call. */
function fakeStore(initial: Record<string, ChatMonthUsage> = {}) {
  const rows = new Map(Object.entries(initial));
  const recorded: { account: Address; month: string; delta: ChatUsageDelta }[] = [];
  const reads: string[] = [];
  const store: ChatUsageStore = {
    async record(account, month, delta) {
      recorded.push({ account, month, delta });
      const key = `${account.toLowerCase()}:${month}`;
      const r = rows.get(key) ?? { month, turns: 0, tokensIn: 0, tokensOut: 0, routerCalls: 0, estimatedMicroUsd: 0, lastTurnAt: 0 };
      rows.set(key, {
        month,
        turns: r.turns + delta.turns,
        tokensIn: r.tokensIn + delta.tokensIn,
        tokensOut: r.tokensOut + delta.tokensOut,
        routerCalls: r.routerCalls + delta.routerCalls,
        estimatedMicroUsd: r.estimatedMicroUsd + delta.estimatedMicroUsd,
        lastTurnAt: Math.max(r.lastTurnAt, delta.at),
      });
    },
    async read(account, month) {
      reads.push(month);
      return rows.get(`${account.toLowerCase()}:${month}`) ?? null;
    },
  };
  return { store, recorded, reads };
}

describe('MODEL_PRICES', () => {
  beforeEach(() => clearUnpricedModels());

  it('prices the chat models per million tokens, in whole micro-dollars', () => {
    expect(MODEL_PRICES[GEMMA]).toEqual({ input: 0.1, output: 0.3 });
    expect(MODEL_PRICES[CLEF]).toEqual({ input: 0.038, output: 0 });
    expect(MODEL_PRICES['@cf/zai-org/glm-5.3-flash']).toEqual({ input: 0.15, output: 0.5 });
    expect(MODEL_PRICES['@cf/zai-org/glm-4.7-flash']).toEqual({ input: 0.0605, output: 0.4 });
    expect(MODEL_PRICES['@cf/meta/llama-3.3-70b-instruct-fp8-fast']).toEqual({ input: 0.293, output: 2.253 });
    expect(modelCostMicroUsd(GEMMA, 1_000, 200)).toBe(160);
    expect(modelCostMicroUsd(CLEF, 400, 0)).toBe(15);
    expect(modelCostMicroUsd(GEMMA, 1_000_000, 1_000_000)).toBe(400_000);
    // Every default chat model has a price.
    for (const op of Object.values(OPS)) expect(MODEL_PRICES[op.model]).toBeDefined();
  });

  it('prices an unknown model at zero and logs it once', () => {
    const logs: Record<string, unknown>[] = [];
    expect(modelCostMicroUsd('@cf/acme/new-model', 1_000, 1_000, (f) => logs.push(f))).toBe(0);
    expect(modelCostMicroUsd('@cf/acme/new-model', 5_000, 0, (f) => logs.push(f))).toBe(0);
    expect(logs).toEqual([{ event: 'chat_price_unknown', model: '@cf/acme/new-model' }]);
  });
});

describe('usage arithmetic', () => {
  it('adds the routed model and the estimated router input to one turn', () => {
    const usage: ChatTurnUsage = {
      route: 'answer',
      model: GEMMA,
      tokensIn: 1_000,
      tokensOut: 200,
      router: { model: CLEF, called: true, tokensIn: 400, estimated: true },
    };
    expect(usageDelta(usage, 42)).toEqual({ turns: 1, tokensIn: 1_000, tokensOut: 200, routerCalls: 1, estimatedMicroUsd: 175, at: 42 });
    const fixed = usageDelta({ ...usage, route: 'refuse', model: null, tokensIn: null, tokensOut: null }, 42);
    expect(fixed).toMatchObject({ turns: 1, tokensIn: 0, tokensOut: 0, estimatedMicroUsd: 15 });
    const noRouter = usageDelta({ ...usage, router: { ...usage.router, called: false } }, 42);
    expect(noRouter).toMatchObject({ routerCalls: 0, estimatedMicroUsd: 160 });
  });

  it('reads months, resets and the cap in UTC', () => {
    const t = Date.UTC(2026, 9, 31, 23, 59);
    expect(monthOf(t)).toBe('2026-10');
    expect(monthResetsAt(t).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(monthResetsAt(Date.UTC(2026, 11, 5)).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(parseTokenCap(undefined)).toBeNull();
    expect(parseTokenCap('')).toBeNull();
    expect(parseTokenCap('0')).toBeNull();
    expect(parseTokenCap('1.5')).toBeNull();
    expect(parseTokenCap('2000000')).toBe(2_000_000);
    expect(capTokens(null)).toBe(0);
    expect(capTokens({ tokensIn: 10, tokensOut: 5 })).toBe(15);
  });
});

describe('runChat onTurn', () => {
  it('fires once after done with the answer model, its tokens and the router estimate', async () => {
    const seen: ChatTurnUsage[] = [];
    let doneBefore = false;
    const inference = fakeInference({
      'chat-router': clef('none', 0.8),
      'chat-answer': () => sse(['Hi'], { prompt_tokens: 120, completion_tokens: 2 }),
    });
    const stream = runChat({ inference, messages: user('hello there'), onTurn: (u) => seen.push(u) });
    const events = await collect(stream);
    doneBefore = events.some((e) => e.type === 'done');
    expect(doneBefore).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      route: 'answer',
      model: GEMMA,
      tokensIn: 120,
      tokensOut: 2,
      router: { model: CLEF, called: true, tokensIn: Math.ceil('Latest user message: hello there'.length / 4), estimated: true },
    });
  });

  it('reports the action model and its usage on an action, and no model on a refusal', async () => {
    const seen: ChatTurnUsage[] = [];
    await collect(
      runChat({
        inference: fakeInference({
          'chat-router': clef('send', 0.97),
          'chat-answer': () => sse(['x']),
          'chat-action': {
            choices: [{ message: { tool_calls: [{ function: { arguments: '{"amount":20}' } }] } }],
            usage: { prompt_tokens: 300, completion_tokens: 20 },
          },
        }),
        messages: user('send 20 dollars to @ana'),
        onTurn: (u) => seen.push(u),
      }),
    );
    expect(seen[0]).toMatchObject({ route: 'action', model: GEMMA, tokensIn: 300, tokensOut: 20 });

    await collect(
      runChat({
        inference: fakeInference({ 'chat-router': clef('none', 0.8, { harmful: 0.94 }), 'chat-answer': () => sse(['x']) }),
        messages: user('x'),
        onTurn: (u) => seen.push(u),
      }),
    );
    expect(seen[1]).toMatchObject({ route: 'refuse', model: null, tokensIn: null, tokensOut: null });
  });

  it('does not fire on a failed turn', async () => {
    const seen: ChatTurnUsage[] = [];
    const events = await collect(
      runChat({
        inference: fakeInference({ 'chat-router': clef('none', 0.8), 'chat-answer': new Error('boom') }),
        messages: user('hi'),
        onTurn: (u) => seen.push(u),
      }),
    );
    expect(events[events.length - 1]!.type).toBe('error');
    expect(seen).toEqual([]);
  });
});

describe('Accept-Language fallback', () => {
  it('reads the preferred of en, pt and es, and returns only pt or es', () => {
    expect(headerLanguage('pt-BR,pt;q=0.9,en-US;q=0.8')).toBe('pt');
    expect(headerLanguage('es-419')).toBe('es');
    expect(headerLanguage('en-US,pt;q=0.9')).toBeNull();
    expect(headerLanguage('fr-FR,es;q=0.5,pt;q=0.4')).toBe('es');
    expect(headerLanguage('en;q=0.2,pt;q=0.8')).toBe('pt');
    expect(headerLanguage('pt;q=0')).toBeNull();
    expect(headerLanguage('de')).toBeNull();
    expect(headerLanguage(undefined)).toBeNull();
  });

  it('uses the header for the fixed replies only when the router is unsure of the language', async () => {
    const run = async (answers: unknown) =>
      texts(
        await collect(
          runChat({
            inference: fakeInference({ 'chat-router': answers, 'chat-answer': () => sse(['x']) }),
            messages: user('x'),
            fallbackLanguage: 'pt',
          }),
        ),
      );
    expect(await run(clef('none', 0.8, { harmful: 0.94 }))).toBe(FIXED_TEXT.pt.refuse);
    expect(await run(clef('none', 0.8, { harmful: 0.94, language: ['en', 0.55] }))).toBe(FIXED_TEXT.pt.refuse);
    expect(await run(clef('none', 0.8, { harmful: 0.94, language: ['en', 0.97] }))).toBe(FIXED_TEXT.en.refuse);
    expect(await run(clef('none', 0.8, { harmful: 0.94, language: ['es', 0.9] }))).toBe(FIXED_TEXT.es.refuse);
  });
});

describe('the chat meter on the routes', () => {
  const fxAccount = fixtures.fields.accountAddress as string;
  const issuedAt = fixtures.fields.issuedAt as number;
  const bearer = { authorization: `Bearer ${fixtures.p256.token}` };
  const HIGH: AuthorityCheck = { status: 'active', authorityId: 0, module: fxAccount as `0x${string}`, tier: 3 };
  const now = issuedAt + 5_000;
  const month = monthOf(now);

  function limiter(deny: (key: string) => boolean = () => false) {
    const keys: string[] = [];
    return { keys, limit: async ({ key }: { key: string }) => (keys.push(key), { success: !deny(key) }) };
  }

  function app(env: Record<string, unknown>, deps: Partial<ChatRouteDeps> = {}, calls: InferenceOp[] = []) {
    const h = new Hono();
    h.route(
      '/v1/chat',
      createChatRoutes({
        attestationMaxAgeMs: 3_600_000,
        now: () => now,
        authorityCheck: async () => HIGH,
        authorityMemo: createAuthorityMemo({ edge: null }),
        inference: () =>
          fakeInference({ 'chat-router': clef('none', 0.8), 'chat-answer': () => sse(['ok'], { prompt_tokens: 100, completion_tokens: 10 }) }, calls),
        ...deps,
      }),
    );
    return {
      chat: (headers: Record<string, string> = {}, text = 'hi') =>
        h.request(
          '/v1/chat',
          { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ account: fxAccount, messages: user(text) }) },
          env as never,
        ),
      usage: (headers: Record<string, string> = {}, account = fxAccount) =>
        h.request(`/v1/chat/usage?account=${account}`, { headers }, env as never),
    };
  }

  it('records a finished turn in the account’s month', async () => {
    const { store, recorded } = fakeStore();
    const res = await app({ ENVIRONMENT: 'staging' }, { usageStore: () => store }).chat(bearer);
    expect(await res.text()).toContain('"type":"done"');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.account.toLowerCase()).toBe(fxAccount.toLowerCase());
    expect(recorded[0]!.month).toBe(month);
    expect(recorded[0]!.delta).toMatchObject({ turns: 1, tokensIn: 100, tokensOut: 10, routerCalls: 1, at: now });
    expect(recorded[0]!.delta.estimatedMicroUsd).toBeGreaterThan(0);
  });

  it('refuses past the cap before any model call, and reads nothing without a cap', async () => {
    const key = `${fxAccount.toLowerCase()}:${month}`;
    const full = { month, turns: 90, tokensIn: 900, tokensOut: 100, routerCalls: 90, estimatedMicroUsd: 1_000, lastTurnAt: now };
    const calls: InferenceOp[] = [];
    const { store } = fakeStore({ [key]: full });
    const res = await app({ ENVIRONMENT: 'staging', CHAT_MONTHLY_TOKEN_CAP: '1000' }, { usageStore: () => store }, calls).chat(bearer);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: 'fair_use_cap', resetsAt: monthResetsAt(now).toISOString() });
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(calls).toEqual([]);

    const under = await app({ ENVIRONMENT: 'staging', CHAT_MONTHLY_TOKEN_CAP: '1001' }, { usageStore: () => store }).chat(bearer);
    expect(under.status).toBe(200);

    const { store: open, reads } = fakeStore({ [key]: full });
    expect((await app({ ENVIRONMENT: 'staging' }, { usageStore: () => open }).chat(bearer)).status).toBe(200);
    expect(reads).toEqual([]);
  });

  it('checks the cap only after the gate', async () => {
    const { store, reads } = fakeStore();
    const res = await app(
      { ENVIRONMENT: 'staging', CHAT_MONTHLY_TOKEN_CAP: '10' },
      { usageStore: () => store, authorityCheck: async () => ({ status: 'not_found' }) },
    ).chat(bearer);
    expect(res.status).toBe(401);
    expect(reads).toEqual([]);
  });

  it('gates GET /usage like the chat, and answers the month', async () => {
    const key = `${fxAccount.toLowerCase()}:${month}`;
    const { store } = fakeStore({
      [key]: { month, turns: 3, tokensIn: 400, tokensOut: 50, routerCalls: 3, estimatedMicroUsd: 2_500, lastTurnAt: now },
    });
    const staging = app({ ENVIRONMENT: 'staging', CHAT_MONTHLY_TOKEN_CAP: '1000' }, { usageStore: () => store });
    const missing = await staging.usage();
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: 'attestation_required' });
    expect((await staging.usage({ authorization: 'Bearer csa1:nope' })).status).toBe(401);
    expect((await staging.usage(bearer, '0x123')).status).toBe(400);

    const ok = await staging.usage(bearer);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      ok: true,
      month,
      turns: 3,
      tokensIn: 400,
      tokensOut: 50,
      estimatedUsd: 0.0025,
      cap: { tokens: 1000, remaining: 550 },
    });

    const uncapped = await app({ ENVIRONMENT: 'staging' }, { usageStore: () => fakeStore().store }).usage(bearer);
    expect(await uncapped.json()).toMatchObject({ turns: 0, estimatedUsd: 0, cap: null });

    const refused = app({ ENVIRONMENT: 'staging' }, { usageStore: () => store, authorityCheck: async () => ({ status: 'not_found' }) });
    expect((await refused.usage(bearer)).status).toBe(401);

    expect((await app({ ENVIRONMENT: 'staging' }, { usageStore: () => null }).usage(bearer)).status).toBe(503);
  });

  it('turns a busy network away before the usage gate, and never spends a chat turn', async () => {
    const ip = limiter(() => true);
    const busy = await app({ ENVIRONMENT: 'staging', CHAT_IP_RL: ip }, { usageStore: () => fakeStore().store }).usage({
      ...bearer,
      'cf-connecting-ip': '203.0.113.7',
    });
    expect(busy.status).toBe(429);
    expect(ip.keys).toEqual(['chat-ip:203.0.113.7']);

    const rl = limiter();
    await app({ ENVIRONMENT: 'staging', CHAT_RL: rl }, { usageStore: () => fakeStore().store }).usage(bearer);
    expect(rl.keys).toEqual([`chat-usage:${fxAccount.toLowerCase()}`]);
  });

  it('answers in the Accept-Language when the router is unsure of the language', async () => {
    const res = await app(
      { ENVIRONMENT: 'staging' },
      { inference: () => fakeInference({ 'chat-router': clef('none', 0.8, { harmful: 0.94 }), 'chat-answer': () => sse(['x']) }) },
    ).chat({ ...bearer, 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8' });
    const events = (await res.text()).split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')) as ChatEvent);
    expect(texts(events)).toBe(FIXED_TEXT.pt.refuse);
  });
});
