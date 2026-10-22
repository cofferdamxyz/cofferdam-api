// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { DatabaseSync } from 'node:sqlite';

import { Hono } from 'hono';
import type { Address } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';

import { createChatRoutes, type ChatRouteDeps } from '../src/routes/chat.js';
import type { AuthorityCheck } from '../src/services/authorityCheck.js';
import { createAuthorityMemo } from '../src/services/chat/authorityMemo.js';
import { FIXED_TEXT, headerLanguage, runChat, type ChatEvent, type ChatInference, type ChatTurnUsage } from '../src/services/chat/run.js';
import {
  capEstimate,
  GLOBAL_USAGE_NAME,
  migrateUsageTables,
  monthOf,
  monthResetsAt,
  parseUsdMicro,
  readUsage,
  recordUsage,
  usageDelta,
  type ChatModelUsage,
  type ChatMonthUsage,
  type ChatUsageDelta,
  type ChatUsageStore,
  type UsageSql,
} from '../src/services/chatUsageStore.js';
import { clearUnpricedModels, MODEL_PRICES, modelCostMicroUsd, OPS, type InferenceOp } from '../src/services/inference/index.js';
import fixtures from './fixtures/sdk-attestations.json';

const GEMMA = '@cf/google/gemma-4-26b-a4b-it';
const CLEF = '@cf/cloudflare/clef-flash';
const GLM = '@cf/zai-org/glm-5.3-flash';

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
  const recorded: { account: Address | 'global'; month: string; delta: ChatUsageDelta }[] = [];
  const reads: string[] = [];
  const globalReads: string[] = [];
  // Totals only: the split per model is the SQL's, tested on its own below.
  const add = (key: string, month: string, delta: ChatUsageDelta) => {
    const r = rows.get(key) ?? { month, turns: 0, tokensIn: 0, tokensOut: 0, routerCalls: 0, estimatedMicroUsd: 0, lastTurnAt: 0, models: [] };
      rows.set(key, {
        month,
        turns: r.turns + delta.turns,
        tokensIn: r.tokensIn + delta.tokensIn,
        tokensOut: r.tokensOut + delta.tokensOut,
        routerCalls: r.routerCalls + delta.routerCalls,
        estimatedMicroUsd: r.estimatedMicroUsd + delta.estimatedMicroUsd,
        lastTurnAt: Math.max(r.lastTurnAt, delta.at),
        models: r.models,
      });
  };
  const store: ChatUsageStore = {
    async record(account, month, delta) {
      recorded.push({ account, month, delta });
      add(`${account.toLowerCase()}:${month}`, month, delta);
    },
    async read(account, month) {
      reads.push(month);
      return rows.get(`${account.toLowerCase()}:${month}`) ?? null;
    },
    async recordGlobal(month, delta) {
      recorded.push({ account: 'global', month, delta });
      add(`${GLOBAL_USAGE_NAME}:${month}`, month, delta);
    },
    async readGlobal(month) {
      globalReads.push(month);
      return rows.get(`${GLOBAL_USAGE_NAME}:${month}`) ?? null;
    },
  };
  return { store, recorded, reads, globalReads };
}

describe('MODEL_PRICES', () => {
  beforeEach(() => clearUnpricedModels());

  it('prices the chat models per million tokens, in whole micro-dollars', () => {
    expect(MODEL_PRICES[GEMMA]).toEqual({ input: 0.1, output: 0.3 });
    expect(MODEL_PRICES[CLEF]).toEqual({ input: 0.038, output: 0 });
    expect(MODEL_PRICES['@cf/deepseek-ai/deepseek-v4.1-flash-1017']).toEqual({ input: 0.3, output: 1.2 });
    expect(MODEL_PRICES['@cf/zai-org/glm-5.3']).toEqual({ input: 1.4, output: 4.4 });
    expect(MODEL_PRICES['@cf/zai-org/glm-5.3-flash']).toEqual({ input: 0.15, output: 0.5 });
    expect(MODEL_PRICES['@cf/zai-org/glm-4.7-flash']).toEqual({ input: 0.06, output: 0.4 });
    expect(MODEL_PRICES['@cf/meta/llama-3.3-70b-instruct-fp8-fast']).toEqual({ input: 0.293, output: 2.253 });
    expect(modelCostMicroUsd(GEMMA, 1_000, 200)).toBe(160);
    expect(modelCostMicroUsd(CLEF, 400, 0)).toBe(15);
    expect(modelCostMicroUsd(GEMMA, 1_000_000, 1_000_000)).toBe(400_000);
    // A Thinking turn as measured on 2026-10-21, 1,070 tokens in and 280 out on DeepSeek V4.1 Flash: about $0.0007.
    expect(modelCostMicroUsd('@cf/deepseek-ai/deepseek-v4.1-flash-1017', 1_070, 280)).toBe(657);
    // The same turn on glm-5.3, the Thinking tier's model until 2026-10-21: about $0.0027.
    expect(modelCostMicroUsd('@cf/zai-org/glm-5.3', 1_070, 280)).toBe(2_730);
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
    expect(usageDelta(usage, 42)).toEqual({
      turns: 1,
      tokensIn: 1_000,
      tokensOut: 200,
      routerCalls: 1,
      estimatedMicroUsd: 175,
      model: GEMMA,
      modelMicroUsd: 160,
      at: 42,
    });
    const fixed = usageDelta({ ...usage, route: 'refuse', model: null, tokensIn: null, tokensOut: null }, 42);
    expect(fixed).toMatchObject({ turns: 1, tokensIn: 0, tokensOut: 0, estimatedMicroUsd: 15, model: null, modelMicroUsd: 0 });
    const noRouter = usageDelta({ ...usage, router: { ...usage.router, called: false } }, 42);
    expect(noRouter).toMatchObject({ routerCalls: 0, estimatedMicroUsd: 160, model: GEMMA, modelMicroUsd: 160 });
    // A model that reports no usage still served the turn, at no cost.
    const silent = usageDelta({ ...usage, tokensIn: null, tokensOut: null }, 42);
    expect(silent).toMatchObject({ tokensIn: 0, tokensOut: 0, estimatedMicroUsd: 15, model: GEMMA, modelMicroUsd: 0 });
  });

  it('reads months, resets and the cap in UTC', () => {
    const t = Date.UTC(2026, 9, 31, 23, 59);
    expect(monthOf(t)).toBe('2026-10');
    expect(monthResetsAt(t).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(monthResetsAt(Date.UTC(2026, 11, 5)).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(parseUsdMicro(undefined)).toBeNull();
    expect(parseUsdMicro('')).toBeNull();
    expect(parseUsdMicro('0')).toBeNull();
    expect(parseUsdMicro('-5')).toBeNull();
    expect(parseUsdMicro('abc')).toBeNull();
    expect(parseUsdMicro('500')).toBe(500_000_000);
    expect(parseUsdMicro('0.06')).toBe(60_000);
  });

  it('turns what is left of a dollar cap into turns, at the typical cost and then the account’s own', () => {
    const t = Date.UTC(2026, 9, 21, 12); // 11 days left, counting the 21st
    const row = (turns: number, micro: number): ChatMonthUsage => ({
      month: '2026-10',
      turns,
      tokensIn: 0,
      tokensOut: 0,
      routerCalls: turns,
      estimatedMicroUsd: micro,
      lastTurnAt: t,
      models: [],
    });
    expect(capEstimate(5_000_000, null, t)).toEqual({
      usd: 5,
      remainingUsd: 5,
      turnsLeft: 25_000,
      turnsPerDay: 2_272,
      resetsAt: '2026-11-01T00:00:00.000Z',
    });
    // Nine turns: still the typical cost.
    expect(capEstimate(60_000, row(9, 9_000), t)).toMatchObject({ remainingUsd: 0.051, turnsLeft: 255, turnsPerDay: 23 });
    // Twenty turns at 500 each: the account's own average.
    expect(capEstimate(60_000, row(20, 10_000), t)).toMatchObject({ remainingUsd: 0.05, turnsLeft: 100, turnsPerDay: 9 });
    expect(capEstimate(60_000, row(200, 90_000), t)).toMatchObject({ remainingUsd: 0, turnsLeft: 0, turnsPerDay: 0 });
  });
});

/** `node:sqlite` behind the slice of `ctx.storage.sql` the meter uses. */
function sqlite(): UsageSql {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
}

describe('the meter’s SQL, on node:sqlite', () => {
  const OCT = '2026-10';
  const turn = (over: Partial<ChatUsageDelta> = {}): ChatUsageDelta => ({
    turns: 1,
    tokensIn: 1_000,
    tokensOut: 200,
    routerCalls: 1,
    estimatedMicroUsd: 175,
    model: GEMMA,
    modelMicroUsd: 160,
    at: 1,
    ...over,
  });
  const sum = (models: ChatModelUsage[], key: 'tokensIn' | 'tokensOut' | 'turns' | 'estimatedMicroUsd') =>
    models.reduce((n, m) => n + m[key], 0);

  function meter() {
    const sql = sqlite();
    migrateUsageTables(sql);
    return sql;
  }

  it('splits the month per model next to the totals, with the router left out', () => {
    const sql = meter();
    recordUsage(sql, OCT, turn({ at: 10 }));
    recordUsage(sql, OCT, turn({ tokensIn: 500, tokensOut: 100, estimatedMicroUsd: 95, modelMicroUsd: 80, at: 20 }));
    // A refusal: fixed text, so the router only.
    recordUsage(sql, OCT, turn({ tokensIn: 0, tokensOut: 0, estimatedMicroUsd: 15, model: null, modelMicroUsd: 0, at: 30 }));
    recordUsage(sql, OCT, turn({ tokensIn: 2_000, tokensOut: 1_200, estimatedMicroUsd: 915, model: GLM, modelMicroUsd: 900, at: 25 }));

    const month = readUsage(sql, OCT)!;
    expect(month).toEqual({
      month: OCT,
      turns: 4,
      tokensIn: 3_500,
      tokensOut: 1_500,
      routerCalls: 4,
      estimatedMicroUsd: 1_200,
      lastTurnAt: 30,
      models: [
        { model: GEMMA, turns: 2, tokensIn: 1_500, tokensOut: 300, estimatedMicroUsd: 240 },
        { model: GLM, turns: 1, tokensIn: 2_000, tokensOut: 1_200, estimatedMicroUsd: 900 },
      ],
    });
    // The models' tokens are the totals'; their cost is the total less the router's four calls; the refusal is in no model.
    expect(sum(month.models, 'tokensIn')).toBe(month.tokensIn);
    expect(sum(month.models, 'tokensOut')).toBe(month.tokensOut);
    expect(month.estimatedMicroUsd - sum(month.models, 'estimatedMicroUsd')).toBe(4 * 15);
    expect(sum(month.models, 'turns')).toBe(3);
  });

  it('puts the most-used model first: by turns, then tokens, then id', () => {
    const sql = meter();
    const LLAMA = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
    const GLM47 = '@cf/zai-org/glm-4.7-flash';
    const OTHER = '@cf/acme/other-model';
    recordUsage(sql, OCT, turn({ model: GEMMA, tokensIn: 90, tokensOut: 10 }));
    recordUsage(sql, OCT, turn({ model: GLM47, tokensIn: 400, tokensOut: 100 }));
    recordUsage(sql, OCT, turn({ model: LLAMA, tokensIn: 10, tokensOut: 0 }));
    recordUsage(sql, OCT, turn({ model: LLAMA, tokensIn: 10, tokensOut: 0 }));
    recordUsage(sql, OCT, turn({ model: OTHER, tokensIn: 250, tokensOut: 250 }));
    expect(readUsage(sql, OCT)!.models.map((m) => m.model)).toEqual([LLAMA, OTHER, GLM47, GEMMA]);
  });

  it('keeps months apart, and an object from before the split starts its models empty', () => {
    const sql = sqlite();
    migrateUsageTables(sql);
    // An object from before 2026-10-20 had the totals table only.
    sql.exec('DROP TABLE month_models');
    recordUsage(sql, OCT, turn({ model: null, modelMicroUsd: 0, at: 5 }));
    migrateUsageTables(sql);
    expect(readUsage(sql, OCT)).toMatchObject({ turns: 1, tokensIn: 1_000, models: [] });

    recordUsage(sql, OCT, turn({ at: 6 }));
    recordUsage(sql, '2026-11', turn({ model: GLM, at: 7 }));
    expect(readUsage(sql, OCT)).toMatchObject({ turns: 2, tokensIn: 2_000, models: [{ model: GEMMA, turns: 1, tokensIn: 1_000 }] });
    expect(readUsage(sql, '2026-11')).toMatchObject({ turns: 1, models: [{ model: GLM, turns: 1 }] });
    expect(readUsage(sql, '2026-12')).toBeNull();
  });

  it('refuses a bad month, counts a turn without a usable model in the totals only, and never stores a bad number', () => {
    const sql = meter();
    expect(() => recordUsage(sql, '2026-13', turn())).toThrow('invalid month');
    expect(readUsage(sql, '2026-13')).toBeNull();

    recordUsage(sql, OCT, turn({ model: '' }));
    recordUsage(sql, OCT, turn({ model: `@cf/${'x'.repeat(125)}` }));
    // A caller from before the split sends no model fields at all.
    const { model: _model, modelMicroUsd: _share, ...older } = turn();
    recordUsage(sql, OCT, older as ChatUsageDelta);
    expect(readUsage(sql, OCT)).toMatchObject({ turns: 3, estimatedMicroUsd: 525, models: [] });

    // A model's share is cut to its turn; negative and missing counts are zero.
    recordUsage(sql, OCT, turn({ estimatedMicroUsd: 100, modelMicroUsd: 500, tokensIn: -5, tokensOut: Number.NaN }));
    expect(readUsage(sql, OCT)!.models).toEqual([{ model: GEMMA, turns: 1, tokensIn: 0, tokensOut: 0, estimatedMicroUsd: 100 }]);
  });
});

describe('runChat onTurn', () => {
  it('fires once after done with the answer model, its tokens and the router estimate', async () => {
    const seen: ChatTurnUsage[] = [];
    const inference = fakeInference({
      'chat-router': clef('none', 0.8),
      'chat-answer': () => sse(['Hi'], { prompt_tokens: 120, completion_tokens: 2 }),
    });
    const stream = runChat({ inference, messages: user('hello there'), onTurn: (u) => seen.push(u) });
    const events = await collect(stream);
    const doneBefore = events.some((e) => e.type === 'done');
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
    expect(recorded).toHaveLength(2);
    expect(recorded[1]).toEqual({ ...recorded[0], account: 'global' });
    expect(recorded[0]!.account.toLowerCase()).toBe(fxAccount.toLowerCase());
    expect(recorded[0]!.month).toBe(month);
    expect(recorded[0]!.delta).toMatchObject({ turns: 1, tokensIn: 100, tokensOut: 10, routerCalls: 1, at: now });
    expect(recorded[0]!.delta.estimatedMicroUsd).toBeGreaterThan(0);
    // The answer model and its own share, priced without the router.
    expect(recorded[0]!.delta).toMatchObject({ model: GEMMA, modelMicroUsd: modelCostMicroUsd(GEMMA, 100, 10) });
    expect(recorded[0]!.delta.modelMicroUsd).toBeLessThanOrEqual(recorded[0]!.delta.estimatedMicroUsd);
  });

  it('refuses past the cap before any model call, and reads nothing without a cap', async () => {
    const key = `${fxAccount.toLowerCase()}:${month}`;
    const full = { month, turns: 90, tokensIn: 900, tokensOut: 100, routerCalls: 90, estimatedMicroUsd: 1_000, lastTurnAt: now, models: [] };
    const calls: InferenceOp[] = [];
    const { store } = fakeStore({ [key]: full });
    const res = await app({ ENVIRONMENT: 'staging', CHAT_MONTHLY_USD_CAP: '0.001' }, { usageStore: () => store }, calls).chat(bearer);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: 'fair_use_cap', resetsAt: monthResetsAt(now).toISOString() });
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(calls).toEqual([]);

    const under = await app({ ENVIRONMENT: 'staging', CHAT_MONTHLY_USD_CAP: '0.001001' }, { usageStore: () => store }).chat(bearer);
    expect(under.status).toBe(200);

    const { store: open, reads } = fakeStore({ [key]: full });
    expect((await app({ ENVIRONMENT: 'staging' }, { usageStore: () => open }).chat(bearer)).status).toBe(200);
    expect(reads).toEqual([]);
  });

  it('stops every account once the plane-wide month is over budget, before any model call', async () => {
    const globalKey = `${GLOBAL_USAGE_NAME}:${month}`;
    const spent = (micro: number) => ({
      month,
      turns: 1,
      tokensIn: 0,
      tokensOut: 0,
      routerCalls: 0,
      estimatedMicroUsd: micro,
      lastTurnAt: now,
      models: [],
    });
    const calls: InferenceOp[] = [];
    const { store } = fakeStore({ [globalKey]: spent(500_000_000) });
    const res = await app({ ENVIRONMENT: 'staging', AI_MONTHLY_BUDGET_USD: '500' }, { usageStore: () => store }, calls).chat(bearer);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'ai_budget_reached', resetsAt: monthResetsAt(now).toISOString() });
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(calls).toEqual([]);

    const { store: under } = fakeStore({ [globalKey]: spent(499_999_999) });
    expect((await app({ ENVIRONMENT: 'staging', AI_MONTHLY_BUDGET_USD: '500' }, { usageStore: () => under }).chat(bearer)).status).toBe(200);
  });

  it('reads the plane-wide spend at most once per window per isolate', async () => {
    const { store, globalReads } = fakeStore();
    const send = app({ ENVIRONMENT: 'staging', AI_MONTHLY_BUDGET_USD: '500' }, { usageStore: () => store });
    for (let i = 0; i < 3; i++) await (await send.chat(bearer)).text();
    expect(globalReads).toEqual([month]);
  });

  it('checks the cap only after the gate', async () => {
    const { store, reads } = fakeStore();
    const res = await app(
      { ENVIRONMENT: 'staging', CHAT_MONTHLY_USD_CAP: '0.00001' },
      { usageStore: () => store, authorityCheck: async () => ({ status: 'not_found' }) },
    ).chat(bearer);
    expect(res.status).toBe(401);
    expect(reads).toEqual([]);
  });

  it('gates GET /usage like the chat, and answers the month', async () => {
    const key = `${fxAccount.toLowerCase()}:${month}`;
    const models: ChatModelUsage[] = [
      { model: GEMMA, turns: 2, tokensIn: 300, tokensOut: 40, estimatedMicroUsd: 2_000 },
      { model: GLM, turns: 1, tokensIn: 100, tokensOut: 10, estimatedMicroUsd: 450 },
    ];
    const row: ChatMonthUsage = { month, turns: 3, tokensIn: 400, tokensOut: 50, routerCalls: 3, estimatedMicroUsd: 2_500, lastTurnAt: now, models };
    const { store } = fakeStore({ [key]: row });
    const staging = app({ ENVIRONMENT: 'staging', CHAT_MONTHLY_USD_CAP: '0.01' }, { usageStore: () => store });
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
      // In dollars, in the store's order; the router's 0.00005 is in the total only.
      models: [
        { model: GEMMA, turns: 2, tokensIn: 300, tokensOut: 40, estimatedUsd: 0.002 },
        { model: GLM, turns: 1, tokensIn: 100, tokensOut: 10, estimatedUsd: 0.00045 },
      ],
      cap: capEstimate(10_000, row, now),
    });

    expect(await (await staging.usage(bearer)).json()).toMatchObject({
      cap: { usd: 0.01, remainingUsd: 0.0075, turnsLeft: 37 },
    });

    const uncapped = await app({ ENVIRONMENT: 'staging' }, { usageStore: () => fakeStore().store }).usage(bearer);
    expect(await uncapped.json()).toMatchObject({ turns: 0, estimatedUsd: 0, models: [], cap: null });

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
