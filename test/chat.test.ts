// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createChatRoutes, parseFloor, type ChatRouteDeps } from '../src/routes/chat.js';
import type { AuthorityCheck } from '../src/services/authorityCheck.js';
import { createAuthorityMemo } from '../src/services/chat/authorityMemo.js';
import { actionTool, decideRoute, routerQuestions } from '../src/services/chat/router.js';
import {
  CHOOSE_TEXT,
  CLARIFY_TEXT,
  keepsAmount,
  mentionsOtherCurrency,
  REFUSE_TEXT,
  parseChatRequest,
  routerState,
  runChat,
  type ChatEvent,
  type ChatInference,
} from '../src/services/chat/run.js';
import { OPS, type InferenceCall, type InferenceOp } from '../src/services/inference/index.js';
import fixtures from './fixtures/sdk-attestations.json';

const ACCOUNT = '0x' + 'ab'.repeat(20);

function clef(
  action: string,
  actionP: number,
  depth = 'short',
  depthP = 0.9,
  harmful = 0.01,
  injection = 0.01,
  others: Record<string, number> = {},
  reasoning?: number,
) {
  return {
    answers: {
      action: { type: 'choice', choice: action, probabilities: { ...others, [action]: actionP } },
      depth: { type: 'choice', choice: depth, probabilities: { [depth]: depthP } },
      harmful: { type: 'noul', noul: harmful },
      injection: { type: 'noul', noul: injection },
      ...(reasoning === undefined ? {} : { reasoning: { type: 'score', score: reasoning } }),
    },
  };
}

/** The same answers with the language question answered. */
function inLanguage(answers: ReturnType<typeof clef>, language: string) {
  return { answers: { ...answers.answers, language: { type: 'choice', choice: language, probabilities: { [language]: 0.97 } } } };
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

async function collect(stream: ReadableStream<Uint8Array>): Promise<ChatEvent[]> {
  const text = await new Response(stream).text();
  return text.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')) as ChatEvent);
}

interface Call {
  op: InferenceOp;
  input: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** A fake seam keyed by op: a value, an Error to throw, or a function producing either. */
function fakeInference(
  responses: Partial<Record<InferenceOp, unknown>>,
  calls: Call[] = [],
  models: Partial<Record<InferenceOp, string>> = {},
): ChatInference {
  return {
    async model(op) {
      return models[op] ?? OPS[op].model;
    },
    async run(op, input, call: InferenceCall = {}) {
      calls.push({ op, input, signal: call.signal, timeoutMs: call.timeoutMs });
      const r = responses[op];
      const v = typeof r === 'function' ? await (r as () => unknown)() : r;
      if (v instanceof Error) throw v;
      return v;
    },
  };
}

const later = <T>(ms: number, v: T) => () => new Promise<T>((r) => setTimeout(() => r(v), ms));
const user = (text: string) => [{ role: 'user' as const, text }];
const texts = (events: ChatEvent[]) =>
  events
    .filter((e) => e.type === 'text')
    .map((e) => (e as { delta: string }).delta)
    .join('');

describe('decideRoute', () => {
  it('proposes an action only above the action floor', () => {
    expect(decideRoute(clef('send', 0.97).answers)).toMatchObject({ route: 'action', action: 'send' });
    expect(decideRoute(clef('send', 0.4).answers).route).toBe('clarify');
    expect(decideRoute(clef('none', 0.8).answers).route).toBe('answer');
  });

  it('offers the likeliest screens below the floor, never more than three', () => {
    const near = decideRoute(clef('send', 0.54, 'short', 0.85, 0.16, 0.02, { message: 0.28, none: 0.06, add_money: 0.05 }).answers);
    expect(near).toMatchObject({ route: 'clarify', candidates: ['send', 'message'] });
    const wide = decideRoute(clef('send', 0.3, 'short', 0.8, 0.01, 0.01, { message: 0.25, add_money: 0.2, import_cv: 0.16, none: 0.09 }).answers);
    expect(wide.candidates).toEqual(['send', 'message', 'add_money']);
    expect(decideRoute(clef('send', 0.12, 'short', 0.8, 0.01, 0.01, { message: 0.1, unknown_screen: 0.5 }).answers).candidates).toEqual([]);
  });

  it('picks the answer tier by depth, and refuses unsafe turns', () => {
    expect(decideRoute(clef('none', 0.8, 'short', 0.9).answers).route).toBe('answer');
    expect(decideRoute(clef('none', 0.8, 'long', 0.96).answers).route).toBe('answer_long');
    expect(decideRoute(clef('none', 0.8, 'long', 0.4).answers).route).toBe('answer');
    expect(decideRoute(clef('none', 0.8, 'short', 0.9, 0.94).answers).route).toBe('refuse');
    expect(decideRoute(clef('none', 0.8, 'short', 0.9, 0.01, 0.95).answers).route).toBe('refuse');
    expect(decideRoute(clef('send', 0.97, 'short', 0.9, 0.9).answers).route).toBe('refuse');
    expect(decideRoute(undefined).route).toBe('answer');
  });

  it('reads the reasoning score, 0 when Clef did not say', () => {
    expect(decideRoute(clef('none', 0.8).answers).reasoning).toBe(0);
    // Clef scores the legend's position, 0 to 3; the decision reads 0 to 1.
    expect(decideRoute(clef('none', 0.8, 'long', 0.9, 0.01, 0.01, {}, 2.46).answers).reasoning).toBe(0.82);
    expect(decideRoute(clef('send', 0.97, 'short', 0.9, 0.01, 0.01, {}, 0.1065).answers).reasoning).toBe(0.036);
    expect(decideRoute(clef('send', 0.97, 'short', 0.9, 0.01, 0.01, {}, 7).answers).reasoning).toBe(1);
    expect(Object.keys(routerQuestions())).toContain('reasoning');
  });

  it('builds tools only for actions with fields', () => {
    expect(actionTool('send')?.function.parameters.properties).toHaveProperty('recipient');
    expect(actionTool('looking_for')).toBeNull();
    expect(Object.keys(routerQuestions().action.criteria)).toContain('none');
  });
});

describe('routerState', () => {
  it('cuts earlier turns and keeps the latest message whole', () => {
    const long = 'x'.repeat(1_000);
    const state = routerState([
      { role: 'user', text: 'explain escrow' },
      { role: 'assistant', text: long },
      { role: 'user', text: `send 20 dollars to @ana ${'y'.repeat(500)}` },
    ]);
    const lines = state.split('\n');
    expect(lines[1]!.length).toBeLessThan(320);
    expect(lines[1]).toMatch(/…$/);
    expect(lines[2]).toBe(`Latest user message: send 20 dollars to @ana ${'y'.repeat(500)}`);
  });
});

describe('parseChatRequest', () => {
  it('accepts a conversation that ends with the user and refuses the rest', () => {
    expect(parseChatRequest({ account: ACCOUNT, messages: user('hi') }).messages).toHaveLength(1);
    expect(() => parseChatRequest({ account: 'x', messages: user('hi') })).toThrow(/account/);
    expect(() => parseChatRequest({ account: ACCOUNT, messages: [{ role: 'assistant', text: 'hi' }] })).toThrow(/last message/);
    expect(() => parseChatRequest({ account: ACCOUNT, messages: [{ role: 'system', text: 'x' }] })).toThrow(/role/);
    expect(() => parseChatRequest({ account: ACCOUNT, messages: user('x'.repeat(4_001)) })).toThrow(/too long/);
  });

  it('reads the tier, Ordinary when absent', () => {
    expect(parseChatRequest({ account: ACCOUNT, messages: user('hi') }).tier).toBe('ordinary');
    expect(parseChatRequest({ account: ACCOUNT, messages: user('hi'), tier: 'thinking' }).tier).toBe('thinking');
    expect(() => parseChatRequest({ account: ACCOUNT, messages: user('hi'), tier: 'turbo' })).toThrow(/tier/);
    expect(parseFloor('0.6')).toBe(0.6);
    expect(parseFloor(undefined)).toBeNull();
    expect(parseFloor('1.5')).toBeNull();
  });
});

describe('runChat', () => {
  it('fills an action from the tool call, keeping only declared fields, and drops the early answer', async () => {
    const calls: Call[] = [];
    const inference = fakeInference(
      {
        'chat-router': clef('send', 0.97),
        'chat-answer': () => sse(['never shown']),
        'chat-action': {
          choices: [{ message: { tool_calls: [{ function: { arguments: '{"amount":20,"recipient":"@ana","memo":"x"}' } }] } }],
        },
      },
      calls,
    );
    const events = await collect(runChat({ inference, messages: user('send 20 to @ana') }));
    expect(events[0]).toMatchObject({ type: 'route', route: 'action', action: 'send' });
    expect(events).toContainEqual({ type: 'action', request: { id: 'send', amount: 20, recipient: 'ana' } });
    expect(texts(events)).not.toContain('never shown');
    expect(events[events.length - 1]).toEqual({ type: 'done' });
    expect(calls.map((c) => c.op)).toEqual(['chat-answer', 'chat-router', 'chat-action']);
    expect(calls[1]!.input).toMatchObject({ model: 'clef-flash' });
    expect(calls[2]!.input).toMatchObject({ tool_choice: 'required', chat_template_kwargs: { enable_thinking: false } });
    expect(calls[0]!.signal?.aborted).toBe(true);
  });

  it('opens a field-less action without calling the action model', async () => {
    const calls: Call[] = [];
    const inference = fakeInference({ 'chat-router': clef('looking_for', 0.93), 'chat-answer': () => sse(['x']) }, calls);
    const events = await collect(runChat({ inference, messages: user('I want to start looking for work') }));
    expect(events).toContainEqual({ type: 'action', request: { id: 'looking_for' } });
    expect(calls.map((c) => c.op)).toEqual(['chat-answer', 'chat-router']);
  });

  it('streams the early everyday answer once the router clears it, thinking off', async () => {
    const calls: Call[] = [];
    const logs: Record<string, unknown>[] = [];
    const inference = fakeInference(
      { 'chat-router': later(20, clef('none', 0.8)), 'chat-answer': () => sse(['Hel', 'lo'], { prompt_tokens: 120, completion_tokens: 2 }) },
      calls,
    );
    const events = await collect(runChat({ inference, messages: user('hi'), log: (f) => logs.push(f) }));
    expect(events[0]).toMatchObject({ type: 'route', route: 'answer' });
    expect(texts(events)).toBe('Hello');
    expect(calls[0]!.input).toMatchObject({ stream: true, chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'low' });
    expect(calls[0]!.signal?.aborted).toBe(false);
    expect(logs.find((l) => l.event === 'chat_turn')).toMatchObject({ route: 'answer', early: 'used', tokens_in: 120, tokens_out: 2 });
  });

  it('never lets the early answer out before the router refuses', async () => {
    const inference = fakeInference({
      'chat-router': later(20, clef('none', 0.8, 'short', 0.6, 0.94)),
      'chat-answer': () => sse(['Here is how to fake a passport']),
    });
    const events = await collect(runChat({ inference, messages: user('x') }));
    expect(events[0]).toMatchObject({ type: 'route', route: 'refuse' });
    expect(texts(events)).toBe(REFUSE_TEXT);
  });

  it('offers choices below the action floor, prefilling only the likeliest, a bare amount included', async () => {
    const calls: Call[] = [];
    const inference = fakeInference(
      {
        'chat-router': inLanguage(clef('send', 0.54, 'short', 0.85, 0.16, 0.02, { message: 0.28, none: 0.06 }), 'pt'),
        'chat-answer': () => sse(['x']),
        'chat-action': { choices: [{ message: { tool_calls: [{ function: { arguments: '{"amount":20,"recipient":"joao"}' } }] } }] },
      },
      calls,
    );
    const events = await collect(runChat({ inference, messages: user('manda 20 pro joao') }));
    expect(events[0]).toMatchObject({ type: 'route', route: 'clarify' });
    expect(events).toContainEqual({ type: 'choices', requests: [{ id: 'send', amount: 20, recipient: 'joao' }, { id: 'message' }] });
    expect(texts(events)).toContain('Toque em uma');
    expect(calls.filter((c) => c.op === 'chat-action')).toHaveLength(1);
  });

  it('starts the answer only after the router when the early answer is off', async () => {
    const calls: Call[] = [];
    const inference = fakeInference({ 'chat-router': clef('none', 0.8), 'chat-answer': () => sse(['Hi']) }, calls);
    const events = await collect(runChat({ inference, messages: user('hi'), early: false }));
    expect(texts(events)).toBe('Hi');
    expect(calls.map((c) => c.op)).toEqual(['chat-router', 'chat-answer']);
    const refused = fakeInference({ 'chat-router': clef('none', 0.8, 'short', 0.6, 0.94) }, (calls.length = 0, calls));
    await collect(runChat({ inference: refused, messages: user('x'), early: false }));
    expect(calls.map((c) => c.op)).toEqual(['chat-router']);
  });

  it('asks in general when no screen is likely enough to offer', async () => {
    const inference = fakeInference({ 'chat-router': clef('send', 0.12, 'short', 0.8, 0.01, 0.01, { none: 0.11 }), 'chat-answer': () => sse(['x']) });
    const events = await collect(runChat({ inference, messages: user('x') }));
    expect(texts(events)).toBe(CLARIFY_TEXT);
    expect(CHOOSE_TEXT).not.toBe(CLARIFY_TEXT);
    expect(events.some((e) => e.type === 'choices')).toBe(false);
  });

  it('serves long turns from the early answer when both run on the same model', async () => {
    const calls: Call[] = [];
    const inference = fakeInference(
      { 'chat-router': clef('none', 0.76, 'long', 0.96), 'chat-answer': () => sse(['Step 1.']), 'chat-long': () => sse(['never']) },
      calls,
    );
    const events = await collect(runChat({ inference, messages: user('explain escrow step by step') }));
    expect(texts(events)).toBe('Step 1.');
    expect(calls.map((c) => c.op)).toEqual(['chat-answer', 'chat-router']);
    expect(calls[0]!.input).toMatchObject({ max_completion_tokens: 1_200, reasoning_effort: 'low' });
  });

  it('answers long turns on a pinned larger model and drops the early answer', async () => {
    const calls: Call[] = [];
    const inference = fakeInference(
      { 'chat-router': clef('none', 0.76, 'long', 0.96), 'chat-answer': () => sse(['short']), 'chat-long': () => sse(['Step 1.']) },
      calls,
      { 'chat-long': '@cf/zai-org/glm-5.3-flash' },
    );
    const events = await collect(runChat({ inference, messages: user('explain escrow step by step') }));
    expect(texts(events)).toBe('Step 1.');
    expect(calls[0]!.input).toMatchObject({ max_completion_tokens: 400 });
    expect(calls.find((c) => c.op === 'chat-long')!.input).toMatchObject({ max_completion_tokens: 1_200, reasoning_effort: 'low' });
    expect(calls[0]!.signal?.aborted).toBe(true);
  });

  it('retries the router once, then declines the turn without a model answer', async () => {
    const calls: Call[] = [];
    const logs: Record<string, unknown>[] = [];
    const inference = fakeInference({ 'chat-router': new Error('down'), 'chat-answer': () => sse(['Hi!']) }, calls);
    const events = await collect(runChat({ inference, messages: user('hello'), fallbackLanguage: 'pt', log: (f) => logs.push(f) }));
    expect(calls.filter((c) => c.op === 'chat-router')).toHaveLength(2);
    // The first attempt waits less than the op's window; the retry waits the full one.
    expect(calls.filter((c) => c.op === 'chat-router').map((c) => c.timeoutMs)).toEqual([3_000, undefined]);
    expect(texts(events)).toBe('');
    expect(events[events.length - 1]).toEqual({ type: 'error', message: 'O assistente está fora do ar agora. Tente de novo daqui a pouco.' });
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(logs.filter((l) => l.event === 'chat_router_failed')).toHaveLength(2);
    expect(logs.some((l) => l.event === 'chat_router_unavailable')).toBe(true);

    // One failure, then an answer: the turn goes on as usual.
    let tries = 0;
    const flaky = fakeInference({
      'chat-router': () => (++tries === 1 ? new Error('blip') : clef('none', 0.8)),
      'chat-answer': () => sse(['Hi!']),
    });
    const ok = await collect(runChat({ inference: flaky, messages: user('hello') }));
    expect(texts(ok)).toBe('Hi!');
    expect(tries).toBe(2);
  });

  it('answers on the reasoning model in the Thinking tier, with no early answer and low effort', async () => {
    const calls: Call[] = [];
    const logs: Record<string, unknown>[] = [];
    const inference = fakeInference(
      {
        'chat-router': clef('none', 0.8, 'short', 0.9, 0.01, 0.01, {}, 0.9),
        'chat-answer': () => sse(['never']),
        'chat-reasoning': () => sse(['Deep ', 'answer'], { prompt_tokens: 220, completion_tokens: 60 }),
      },
      calls,
    );
    const events = await collect(runChat({ inference, messages: user('why is the sky blue?'), tier: 'thinking', log: (f) => logs.push(f) }));
    expect(events[0]).toMatchObject({ type: 'route', route: 'answer', tier: 'thinking', effort: 'low', reasoning: 0.3 });
    expect(texts(events)).toBe('Deep answer');
    expect(calls.map((c) => c.op)).toEqual(['chat-router', 'chat-reasoning']);
    expect(calls[1]!.input).toMatchObject({ stream: true, reasoning_effort: 'low', max_completion_tokens: 1_600 });
    expect(calls[1]!.input).not.toHaveProperty('chat_template_kwargs');
    expect(logs.find((l) => l.event === 'chat_turn')).toMatchObject({ tier: 'thinking', effort: 'low', reasoning: 0.3, tokens_in: 220, tokens_out: 60 });
  });

  it('runs at high effort above the floor, and fills action fields on the action model in either tier', async () => {
    const calls: Call[] = [];
    const inference = fakeInference(
      {
        'chat-router': clef('none', 0.8, 'long', 0.9, 0.01, 0.01, {}, 2.55),
        'chat-reasoning': () => sse(['Step 1.']),
      },
      calls,
    );
    const events = await collect(runChat({ inference, messages: user('plan my rotation'), tier: 'thinking', highFloor: 0.6 }));
    expect(events[0]).toMatchObject({ type: 'route', route: 'answer_long', tier: 'thinking', effort: 'high' });
    expect(calls[1]!.input).toMatchObject({ reasoning_effort: 'high' });

    const action: Call[] = [];
    const fields = fakeInference(
      {
        'chat-router': clef('add_money', 0.95, 'short', 0.9, 0.01, 0.01, {}, 0.3),
        'chat-action': { choices: [{ message: { tool_calls: [{ function: { arguments: '{"amount":50}' } }] } }] },
      },
      action,
    );
    const evs = await collect(runChat({ inference: fields, messages: user('add 50 dollars'), tier: 'thinking' }));
    expect(evs[0]).toMatchObject({ type: 'route', route: 'action', action: 'add_money', tier: 'thinking' });
    expect(evs[0]).not.toHaveProperty('effort');
    expect(action.map((c) => c.op)).toEqual(['chat-router', 'chat-action']);
    expect(evs).toContainEqual({ type: 'action', request: { id: 'add_money', amount: 50 } });
  });

  it('keeps the Ordinary tier as it was: the early answer, thinking off', async () => {
    const calls: Call[] = [];
    const inference = fakeInference({ 'chat-router': clef('none', 0.8), 'chat-answer': () => sse(['Hi']) }, calls);
    const events = await collect(runChat({ inference, messages: user('hi'), tier: 'ordinary' }));
    expect(events[0]).toMatchObject({ type: 'route', tier: 'ordinary', reasoning: 0 });
    expect(events[0]).not.toHaveProperty('effort');
    expect(calls.map((c) => c.op)).toEqual(['chat-answer', 'chat-router']);
  });

  it('ends with an error event when the answering model fails', async () => {
    const inference = fakeInference({ 'chat-router': clef('none', 0.8), 'chat-answer': new Error('boom') });
    const events = await collect(runChat({ inference, messages: user('hi') }));
    expect(events[events.length - 1]!.type).toBe('error');
  });
});

describe('POST /v1/chat gate', () => {
  const fxAccount = fixtures.fields.accountAddress as string;
  const issuedAt = fixtures.fields.issuedAt as number;
  const bearer = { authorization: `Bearer ${fixtures.p256.token}` };
  const HIGH: AuthorityCheck = { status: 'active', authorityId: 0, module: ACCOUNT as `0x${string}`, tier: 3 };

  function limiter(deny: (key: string) => boolean = () => false) {
    const keys: string[] = [];
    return { keys, limit: async ({ key }: { key: string }) => (keys.push(key), { success: !deny(key) }) };
  }

  function app(env: Record<string, unknown>, deps: Partial<ChatRouteDeps> = {}) {
    const h = new Hono();
    const routes = createChatRoutes({
      attestationMaxAgeMs: 3_600_000,
      now: () => issuedAt + 5_000,
      authorityCheck: async () => ({ status: 'not_found' }),
      authorityMemo: createAuthorityMemo({ edge: null }),
      inference: () => fakeInference({ 'chat-router': clef('none', 0.8), 'chat-answer': { response: 'ok' } }),
      ...deps,
    });
    h.route('/v1/chat', routes);
    return (body: unknown, headers: Record<string, string> = {}) =>
      h.request('/v1/chat', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, env as never);
  }

  it('requires a session attestation outside development', async () => {
    const res = await app({ ENVIRONMENT: 'staging' })({ account: ACCOUNT, messages: user('hi') });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'attestation_required' });
  });

  it('rejects a malformed token and a bad body', async () => {
    const send = app({ ENVIRONMENT: 'staging' });
    expect((await send({ account: ACCOUNT, messages: user('hi') }, { authorization: 'Bearer csa1:nope' })).status).toBe(401);
    expect((await send({ account: 'x', messages: user('hi') })).status).toBe(400);
  });

  it('counts the per-account bucket only after the gate passes', async () => {
    const rl = limiter();
    const res = await app({ ENVIRONMENT: 'staging', CHAT_RL: rl })({ account: fxAccount, messages: user('hi') }, bearer);
    expect(res.status).toBe(401);
    expect(rl.keys).toEqual(['chat:global']);

    const ok = await app({ ENVIRONMENT: 'staging', CHAT_RL: rl }, { authorityCheck: async () => HIGH })(
      { account: fxAccount, messages: user('hi') },
      bearer,
    );
    expect(ok.status).toBe(200);
    expect(rl.keys).toEqual(['chat:global', 'chat:global', `chat:${fxAccount.toLowerCase()}`]);
  });

  it('turns a busy network away before the gate', async () => {
    const ip = limiter(() => true);
    const res = await app({ ENVIRONMENT: 'staging', CHAT_IP_RL: ip })(
      { account: fxAccount, messages: user('hi') },
      { ...bearer, 'cf-connecting-ip': '203.0.113.7' },
    );
    expect(res.status).toBe(429);
    expect(ip.keys).toEqual(['chat-ip:203.0.113.7']);
  });

  it('reads Base once per five minutes for a passed check, and every time for a failed one', async () => {
    let now = issuedAt + 5_000;
    let reads = 0;
    const memo = createAuthorityMemo({ edge: null, now: () => now });
    const send = app(
      { ENVIRONMENT: 'staging' },
      { now: () => now, authorityMemo: memo, authorityCheck: async () => (reads++, HIGH) },
    );
    expect((await send({ account: fxAccount, messages: user('hi') }, bearer)).status).toBe(200);
    expect((await send({ account: fxAccount, messages: user('hi') }, bearer)).status).toBe(200);
    expect(reads).toBe(1);
    now += 5 * 60_000 + 1;
    expect((await send({ account: fxAccount, messages: user('hi') }, bearer)).status).toBe(200);
    expect(reads).toBe(2);

    let misses = 0;
    const strict = app({ ENVIRONMENT: 'staging' }, { authorityMemo: createAuthorityMemo({ edge: null }), authorityCheck: async () => (misses++, { status: 'not_found' }) });
    await strict({ account: fxAccount, messages: user('hi') }, bearer);
    await strict({ account: fxAccount, messages: user('hi') }, bearer);
    expect(misses).toBe(2);
  });

  it('streams in development without a token, and answers 503 without Workers AI', async () => {
    const res = await app({ ENVIRONMENT: 'development' })({ account: ACCOUNT, messages: user('hi') });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(await res.text()).toContain('"type":"done"');
    const none = await app({ ENVIRONMENT: 'development' }, { inference: () => null })({ account: ACCOUNT, messages: user('hi') });
    expect(none.status).toBe(503);
  });
});

describe('createAuthorityMemo', () => {
  const att = {
    accountAddress: '0x' + 'CD'.repeat(20),
    alg: 'webauthn',
    publicKey: { qx: '0x' + '11'.repeat(32), qy: '0x' + '22'.repeat(32) },
  } as unknown as Parameters<ReturnType<typeof createAuthorityMemo>['get']>[0];
  const HIGH: AuthorityCheck = { status: 'active', authorityId: 2, module: ACCOUNT as `0x${string}`, tier: 3 };

  function fakeCache() {
    const store = new Map<string, Response>();
    const cache = {
      async match(url: string) {
        return store.get(url)?.clone();
      },
      async put(url: string, res: Response) {
        store.set(url, res);
      },
    } as unknown as Cache;
    return { store, cache };
  }

  it('shares a passed check across isolates through the cache, under a hashed /v1/ key', async () => {
    let now = 1_000;
    const { store, cache } = fakeCache();
    await createAuthorityMemo({ edge: cache, now: () => now }).put(att, HIGH);
    const [url] = [...store.keys()];
    expect(url).toMatch(/^https:\/\/cofferdam\.xyz\/v1\/__cache\/chat-authority\/[0-9a-f]{64}$/);
    expect(url).not.toContain('11'.repeat(32));

    const other = createAuthorityMemo({ edge: cache, now: () => now });
    expect(await other.get(att)).toEqual(HIGH);
    now += 5 * 60_000 + 1;
    expect(await createAuthorityMemo({ edge: cache, now: () => now }).get(att)).toBeNull();
    expect(await other.get(att)).toBeNull();
  });
});

describe('mentionsOtherCurrency', () => {
  it('drops amounts typed in another currency, keeps dollars', () => {
    expect(mentionsOtherCurrency('manda 15 reais pro @joao')).toBe(true);
    expect(mentionsOtherCurrency('manda R$ 15 pro @joao')).toBe(true);
    expect(mentionsOtherCurrency('send 20 euros to ana')).toBe(true);
    expect(mentionsOtherCurrency('send 20 dollars to @ana')).toBe(false);
    expect(mentionsOtherCurrency('send $20 to @ana')).toBe(false);
    expect(mentionsOtherCurrency('quiero añadir 30 dolares')).toBe(false);
    expect(mentionsOtherCurrency('add 50 to my account')).toBe(false);
  });

  it('prefills a bare amount in any language and drops one in another currency', () => {
    expect(keepsAmount('send 20 to ana')).toBe(true);
    expect(keepsAmount('manda 20 pro joao')).toBe(true);
    expect(keepsAmount('mándale 10 a camila')).toBe(true);
    expect(keepsAmount('manda 20 dólares pro joao')).toBe(true);
    expect(keepsAmount('Send 20 USDC para @Ana')).toBe(true);
    expect(keepsAmount('envía $20 a ana')).toBe(true);
    expect(keepsAmount('manda R$ 20 pro joao')).toBe(false);
    expect(keepsAmount('passa 50 conto pra @bia')).toBe(false);
    expect(keepsAmount('send 20 euros to ana')).toBe(false);
  });
});
