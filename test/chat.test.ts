// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createChatRoutes, parseFloor, type ChatRouteDeps } from '../src/routes/chat.js';
import type { AuthorityCheck } from '../src/services/authorityCheck.js';
import { createAuthorityMemo } from '../src/services/chat/authorityMemo.js';
import { actionTool, CHAT_ACTIONS, decideRoute, HIRE_OVER_PAYMENT, HIRE_QUESTION, JOB_QUESTION, jobQuestions, readJob, ROUTER_THRESHOLDS, routerQuestions } from '../src/services/chat/router.js';
import {
  CHOOSE_TEXT,
  CLARIFY_TEXT,
  FIXED_TEXT,
  answerSystem,
  CHAT_LIMITS,
  isStrictBlock,
  keepsAmount,
  mentionsOtherCurrency,
  REASONING_FIRST_TRY_MS,
  REFUSE_TEXT,
  parseChatRequest,
  PROFILE_RULE,
  profileClose,
  routerState,
  runChat,
  SYSTEM_PROMPT,
  thinkingOff,
  type ChatEvent,
  type ChatInference,
} from '../src/services/chat/run.js';
import { InferenceTimeout, OPS, type InferenceCall, type InferenceOp } from '../src/services/inference/index.js';
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

  it('opens the hirer’s flow from the hiring check, after the safety checks and before any other route', () => {
    const hired = (base: ReturnType<typeof clef>, hire: number) => ({ ...base.answers, hire: { type: 'noul', noul: hire } });
    const on = { hireFloor: 0.5 };
    // "Hi, I am looking for a plumber to fix my sink": the founder's example (2026-10-30).
    expect(decideRoute(hired(clef('looking_for', 0.7), 0.92), ROUTER_THRESHOLDS, CHAT_ACTIONS, on)).toMatchObject({ route: 'action', action: 'post_job', confidence: 0.92 });
    expect(decideRoute(hired(clef('none', 0.8), 0.5), ROUTER_THRESHOLDS, CHAT_ACTIONS, on)).toMatchObject({ route: 'action', action: 'post_job' });
    // Below the floor the turn routes as before; so does a missing answer.
    expect(decideRoute(hired(clef('none', 0.8), 0.49), ROUTER_THRESHOLDS, CHAT_ACTIONS, on).route).toBe('answer');
    expect(decideRoute(hired(clef('send', 0.97), 0.2), ROUTER_THRESHOLDS, CHAT_ACTIONS, on)).toMatchObject({ route: 'action', action: 'send' });
    expect(decideRoute(clef('none', 0.8).answers, ROUTER_THRESHOLDS, CHAT_ACTIONS, on).route).toBe('answer');
    // An unsafe request is refused, however much it asks for a worker.
    expect(decideRoute(hired(clef('none', 0.8, 'short', 0.9, 0.93), 0.95), ROUTER_THRESHOLDS, CHAT_ACTIONS, on).route).toBe('refuse');
    // Over a payment or a message the action question chose, at any probability, the check needs HIRE_OVER_PAYMENT:
    // paying a tradesperson is not hiring one ("Manda 100 pro eletricista @joao").
    expect(decideRoute(hired(clef('send', 0.92), 0.6), ROUTER_THRESHOLDS, CHAT_ACTIONS, on)).toMatchObject({ route: 'action', action: 'send' });
    expect(decideRoute(hired(clef('send', 0.4, 'short', 0.9, 0.01, 0.01, { message: 0.3 }), 0.56), ROUTER_THRESHOLDS, CHAT_ACTIONS, on)).toMatchObject({ route: 'clarify', candidates: ['send', 'message'] });
    expect(decideRoute(hired(clef('message', 0.36), 0.91), ROUTER_THRESHOLDS, CHAT_ACTIONS, on)).toMatchObject({ route: 'action', action: 'post_job' });
    expect(decideRoute(hired(clef('send', 0.92), HIRE_OVER_PAYMENT), ROUTER_THRESHOLDS, CHAT_ACTIONS, on)).toMatchObject({ route: 'action', action: 'post_job' });
    // Any other choice leaves the check at its own floor.
    expect(decideRoute(hired(clef('looking_for', 0.9), 0.6), ROUTER_THRESHOLDS, CHAT_ACTIONS, on)).toMatchObject({ route: 'action', action: 'post_job' });
    // The action question never opens or offers a hiring screen, even from an answer that names it.
    expect(decideRoute(clef('post_job', 0.99).answers).route).toBe('answer');
    expect(decideRoute(clef('send', 0.3, 'short', 0.9, 0.01, 0.01, { post_job: 0.5, message: 0.2 }).answers).candidates).toEqual(['send', 'message']);
    // Without a floor the check is off, whatever Clef says.
    expect(decideRoute(hired(clef('none', 0.8), 0.99)).route).toBe('answer');
    expect(decideRoute(hired(clef('none', 0.8), 0.99), ROUTER_THRESHOLDS, CHAT_ACTIONS, { hireFloor: null }).route).toBe('answer');
  });

  it("reads a hiring turn's job, the same as an earlier request or a new one, only when Clef is sure (one card per job)", () => {
    const answered = (job: string, p: number) => ({ job: { type: 'choice', choice: job, probabilities: { [job]: p, [job === 'same' ? 'new' : 'same']: 1 - p } } });
    expect(readJob(answered('same', 0.8))).toBe('same');
    expect(readJob(answered('new', 0.7))).toBe('new');
    expect(readJob(answered('new', 0.55))).toBeUndefined();
    expect(readJob(answered('other', 0.9))).toBeUndefined();
    expect(readJob(undefined)).toBeUndefined();
    expect(jobQuestions()).toEqual({ job: { type: 'choice', instructions: JOB_QUESTION, criteria: { same: expect.any(String), new: expect.any(String) } } });
    // Not in the router's own call: asked there, it moved the hiring check's answers.
    expect(routerQuestions(CHAT_ACTIONS, { hire: true })).not.toHaveProperty('job');
  });

  it('asks the hiring check only when it is on, and never offers post_job on the action question', () => {
    expect(routerQuestions()).not.toHaveProperty('hire');
    expect(routerQuestions(CHAT_ACTIONS, { hire: true })).toMatchObject({ hire: { type: 'noul', instructions: HIRE_QUESTION } });
    expect(routerQuestions(CHAT_ACTIONS, { hire: 'Another wording?' }).hire).toEqual({ type: 'noul', instructions: 'Another wording?' });
    for (const opts of [{}, { hire: true }]) {
      const criteria = routerQuestions(CHAT_ACTIONS, opts).action.criteria;
      expect(criteria).not.toHaveProperty('post_job');
      expect(criteria).toHaveProperty('looking_for');
    }
    expect(CHAT_ACTIONS.filter((a) => a.hiring).map((a) => a.id)).toEqual(['post_job']);
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

  it("reads the saved Work Profile's facts, trimmed, and refuses one that is not text or too long (workspace decision 0076)", () => {
    expect(parseChatRequest({ account: ACCOUNT, messages: user('hi') }).profile).toBeNull();
    expect(parseChatRequest({ account: ACCOUNT, messages: user('hi'), profile: '  Occupation: Electrician.  ' }).profile).toBe('Occupation: Electrician.');
    expect(parseChatRequest({ account: ACCOUNT, messages: user('hi'), profile: '   ' }).profile).toBeNull();
    expect(() => parseChatRequest({ account: ACCOUNT, messages: user('hi'), profile: { occupation: 'x' } })).toThrow(/profile must be text/);
    expect(() => parseChatRequest({ account: ACCOUNT, messages: user('hi'), profile: 'x'.repeat(CHAT_LIMITS.profileChars + 1) })).toThrow(/profile is too long/);
    expect(parseChatRequest({ account: ACCOUNT, messages: user('hi'), language: 'pt' }).language).toBe('pt');
    expect(parseChatRequest({ account: ACCOUNT, messages: user('hi') }).language).toBeNull();
    expect(() => parseChatRequest({ account: ACCOUNT, messages: user('hi'), language: 'fr' })).toThrow(/language must be/);
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

  it('opens Add to Vault, built 2026-11-10 (workspace decision 0081, step 3), as ready', async () => {
    const inference = fakeInference({ 'chat-router': clef('add_document', 0.95), 'chat-answer': () => sse(['x']) });
    const events = await collect(runChat({ inference, messages: user('how do I add my welding certificate?') }));
    expect(events).toContainEqual({ type: 'action', request: { id: 'add_document' } });
    expect(texts(events)).toMatch(/is ready/);
    expect(texts(events)).not.toMatch(/coming/);
  });

  it('opens the CV import, built in the chat since 2026-10-31, as ready', async () => {
    const inference = fakeInference({ 'chat-router': clef('import_cv', 0.95), 'chat-answer': () => sse(['x']) });
    const events = await collect(runChat({ inference, messages: user('how do I upload my CV?') }));
    expect(events).toContainEqual({ type: 'action', request: { id: 'import_cv' } });
    expect(texts(events)).toMatch(/Import your CV is ready/);
  });

  it('opens the hirer’s flow when the hiring check is on, says Find workers is ready, and asks nothing when it is off', async () => {
    const calls: Call[] = [];
    const answers = {
      answers: { ...clef('none', 0.8).answers, hire: { type: 'noul', noul: 0.94 }, job: { type: 'choice', choice: 'new', probabilities: { new: 0.9, same: 0.1 } } },
    };
    const inference = fakeInference({ 'chat-router': answers, 'chat-answer': () => sse(['x']) }, calls);
    const events = await collect(runChat({ inference, messages: user('Hi, I am looking for a plumber to fix my sink'), hireFloor: 0.5 }));
    expect(events).toContainEqual({ type: 'action', request: { id: 'post_job' } });
    // The route event names the job, for the app's one card per job: a first request is new, with no call to ask.
    expect(events.find((e) => e.type === 'route')).toMatchObject({ route: 'action', action: 'post_job', job: 'new' });
    expect(calls.filter((c) => c.op === 'chat-router')).toHaveLength(1);
    // After an earlier turn, one more call of its own asks whether it is the same job.
    const again: Call[] = [];
    const sameJob = { answers: { ...answers.answers, job: { type: 'choice', choice: 'same', probabilities: { same: 0.92, new: 0.08 } } } };
    const followUp = fakeInference({ 'chat-router': sameJob, 'chat-answer': () => sse(['x']) }, again);
    const history = [
      { role: 'user' as const, text: 'We are looking for a plumber to work at our sink tomorrow 2pm' },
      { role: 'assistant' as const, text: 'Find workers is ready. Check the details and confirm there.' },
      { role: 'user' as const, text: 'Try searching again' },
    ];
    const againEvents = await collect(runChat({ inference: followUp, messages: history, hireFloor: 0.5 }));
    expect(againEvents.find((e) => e.type === 'route')).toMatchObject({ action: 'post_job', job: 'same' });
    const routerCalls = again.filter((c) => c.op === 'chat-router');
    expect(routerCalls).toHaveLength(2);
    expect(routerCalls[1]!.input).toMatchObject({ questions: { job: { instructions: JOB_QUESTION } } });
    expect(texts(events)).toMatch(/Find workers is ready\. Check the details and confirm there\./);
    const router = calls.find((c) => c.op === 'chat-router')!;
    expect(router.input).toMatchObject({ questions: { hire: { instructions: HIRE_QUESTION } } });
    expect(calls.some((c) => c.op === 'chat-action')).toBe(false);

    const offCalls: Call[] = [];
    const off = fakeInference({ 'chat-router': answers, 'chat-answer': () => sse(['An answer']) }, offCalls);
    const offEvents = await collect(runChat({ inference: off, messages: user('Hi, I am looking for a plumber to fix my sink') }));
    expect(offEvents.some((e) => e.type === 'action')).toBe(false);
    expect(offCalls.find((c) => c.op === 'chat-router')!.input).not.toHaveProperty('questions.hire');
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
    expect(calls[1]!.timeoutMs).toBe(REASONING_FIRST_TRY_MS);
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

  it('retries the reasoning call once when the first attempt sends nothing in time', async () => {
    // A first attempt that fails within its window: the retry waits the op's full one.
    const calls: Call[] = [];
    const logs: Record<string, unknown>[] = [];
    let tries = 0;
    const inference = fakeInference(
      {
        'chat-router': clef('none', 0.8, 'short', 0.9, 0.01, 0.01, {}, 0.9),
        'chat-reasoning': () => (++tries === 1 ? new InferenceTimeout('chat-reasoning', 15_000) : sse(['Late ', 'answer'])),
      },
      calls,
    );
    const events = await collect(runChat({ inference, messages: user('why?'), tier: 'thinking', log: (f) => logs.push(f) }));
    expect(texts(events)).toBe('Late answer');
    expect(calls.filter((c) => c.op === 'chat-reasoning').map((c) => c.timeoutMs)).toEqual([REASONING_FIRST_TRY_MS, undefined]);
    expect(logs.find((l) => l.event === 'chat_reasoning_retry')).toMatchObject({ reason: 'chat-reasoning gave no answer within 15000 ms' });
    expect(logs.find((l) => l.event === 'chat_turn')).toMatchObject({ reasoning_retried: true });

    // A stream that starts and then sends nothing is cancelled and retried too.
    let cancelled = false;
    const silent = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    let attempts = 0;
    const stalled = fakeInference({
      'chat-router': clef('none', 0.8),
      'chat-reasoning': () => (++attempts === 1 ? silent : sse(['Second try'])),
    });
    const ok = await collect(runChat({ inference: stalled, messages: user('why?'), tier: 'thinking', reasoningFirstTryMs: 20 }));
    expect(texts(ok)).toBe('Second try');
    expect(cancelled).toBe(true);
    expect(attempts).toBe(2);

    // Two failures end the turn with the fixed error.
    const down = fakeInference({ 'chat-router': clef('none', 0.8), 'chat-reasoning': new InferenceTimeout('chat-reasoning', 45_000) });
    const failed = await collect(runChat({ inference: down, messages: user('why?'), tier: 'thinking' }));
    expect(failed[failed.length - 1]!.type).toBe('error');
  });

  it('tells the models that Portuguese is Brazilian and Spanish Mexican', () => {
    expect(SYSTEM_PROMPT).toContain('Portuguese means Brazilian Portuguese');
    expect(SYSTEM_PROMPT).toContain('Spanish means Mexican Spanish');
  });

  it('turns reasoning off the DeepSeek way when a DeepSeek model is pinned on an everyday op', async () => {
    const DS = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
    const calls: Call[] = [];
    const inference = fakeInference(
      {
        'chat-router': clef('send', 0.97),
        'chat-answer': () => sse(['never']),
        'chat-action': { choices: [{ message: { tool_calls: [{ function: { arguments: '{"amount":20}' } }] } }] },
      },
      calls,
      { 'chat-answer': DS, 'chat-action': DS },
    );
    await collect(runChat({ inference, messages: user('send 20 to ana') }));
    const early = calls.find((c) => c.op === 'chat-answer')!;
    expect(early.input).toMatchObject({ reasoning_effort: 'none' });
    expect(early.input).not.toHaveProperty('chat_template_kwargs');
    const fields = calls.find((c) => c.op === 'chat-action')!;
    expect(fields.input).toMatchObject({ reasoning_effort: 'none' });
    expect(fields.input).not.toHaveProperty('chat_template_kwargs');
    expect(thinkingOff('@cf/google/gemma-4-26b-a4b-it')).toEqual({ chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'low' });
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

/** The strict gateway's DLP block as the Workers AI binding threw it on 2026-10-29: an `InferenceUpstreamError` named `AiGatewayError`. */
function dlpBlock(): Error {
  const err = new Error('2030: Request content blocked due to DLP policy violations');
  err.name = 'AiGatewayError';
  return err;
}

describe("the saved Work Profile's facts (workspace decision 0076)", () => {
  const PROFILE = "The user's Work Profile (their CV, as they reviewed and approved it):\nOccupation: Eletricista Offshore.\n- Eletricista Montador at Atlântico Engenharia, from 2017 to 2021 (about 4 years).";

  it('follows the rules and product facts in the answer models\' system, after its rule, and nothing without one', () => {
    expect(answerSystem(PROFILE)).toBe(`${answerSystem()}\n\n${PROFILE_RULE}\n\n${PROFILE}\n\n${profileClose(null)}`);
    expect(answerSystem(PROFILE, 'en').endsWith(`${PROFILE}\n\nReply in English.`)).toBe(true);
    expect(answerSystem(PROFILE, 'pt').endsWith('Reply in Brazilian Portuguese.')).toBe(true);
    expect(answerSystem(null, 'en')).toBe(answerSystem());
    expect(answerSystem(null)).toBe(answerSystem());
  });

  it('reaches the everyday and Thinking answers, never the router or a log line', async () => {
    const calls: Call[] = [];
    const logs: Record<string, unknown>[] = [];
    const inference = fakeInference({ 'chat-router': later(20, clef('none', 0.8)), 'chat-answer': () => sse(['About 4 years.']) }, calls);
    const events = await collect(
      runChat({ inference, messages: user('How long did I work at Atlântico Engenharia?'), profile: PROFILE, language: 'en', log: (f) => logs.push(f) }),
    );
    expect(texts(events)).toBe('About 4 years.');
    const answer = calls.find((c) => c.op === 'chat-answer')!;
    expect((answer.input.messages as { role: string; content: string }[])[0]).toEqual({ role: 'system', content: answerSystem(PROFILE, 'en') });
    // The router reads the user's message, as always, but none of the profile: its occupation is in the profile alone.
    expect(JSON.stringify(calls.find((c) => c.op === 'chat-router')!.input)).not.toContain('Eletricista Offshore');
    expect(JSON.stringify(logs)).not.toContain('Eletricista Offshore');
    expect(JSON.stringify(logs)).not.toContain('Atlântico');

    const thinking: Call[] = [];
    const deep = fakeInference(
      { 'chat-router': clef('none', 0.8, 'short', 0.9, 0.01, 0.01, {}, 0.9), 'chat-reasoning': () => sse(['From 2017 to 2021.']) },
      thinking,
    );
    await collect(runChat({ inference: deep, messages: user('How long did I work at Atlântico Engenharia?'), tier: 'thinking', profile: PROFILE }));
    const reasoning = thinking.find((c) => c.op === 'chat-reasoning')!;
    expect((reasoning.input.messages as { content: string }[])[0]!.content).toBe(answerSystem(PROFILE));
  });

  it("answers a certificate question the phone sent facts for, where the router would open the Vault's search", async () => {
    const certificates = "The user's Work Profile (their CV, as they reviewed and approved it), the parts this question needs:\nCertificates: NR-35 Trabalho em Altura (valid until 2026-11).\nToday is 2026-10-31.";
    const calls: Call[] = [];
    const inference = fakeInference({ 'chat-router': later(20, clef('find_document', 0.93)), 'chat-answer': () => sse(['Your NR-35 is valid until November 2026.']) }, calls);
    const events = await collect(runChat({ inference, messages: user('When does my NR-35 expire?'), profile: certificates, language: 'en' }));
    expect(events[0]).toMatchObject({ type: 'route', route: 'answer' });
    expect(events.some((e) => e.type === 'action')).toBe(false);
    expect(texts(events)).toBe('Your NR-35 is valid until November 2026.');
    // Without facts the same question still opens the search: the Vault comes first once it can be searched.
    const plain = await collect(runChat({ inference: fakeInference({ 'chat-router': clef('find_document', 0.93), 'chat-answer': () => sse(['x']) }), messages: user('When does my NR-35 expire?') }));
    expect(plain).toContainEqual({ type: 'action', request: { id: 'find_document' } });
  });
});

describe('the strict gateway holding a turn back (decision 0021 (h))', () => {
  it('answers a router the gateway blocked with the notice and a fixed reply, once, unmetered and unlogged', async () => {
    const calls: Call[] = [];
    const logs: Record<string, unknown>[] = [];
    const turns: unknown[] = [];
    const inference = fakeInference({ 'chat-router': dlpBlock(), 'chat-answer': dlpBlock() }, calls);
    const events = await collect(
      runChat({ inference, messages: user('card 4111 1111 1111 1111'), log: (f) => logs.push(f), onTurn: (u) => turns.push(u) }),
    );
    expect(events).toEqual([
      { type: 'route', route: 'blocked', action: null, confidence: 0, tier: 'ordinary', reasoning: 0 },
      { type: 'notice', kind: 'strict_blocked' },
      { type: 'text', delta: FIXED_TEXT.en.strictBlocked },
      { type: 'done' },
    ]);
    // The same text would be held back again: no retry, and the early answer is dropped.
    expect(calls.filter((c) => c.op === 'chat-router')).toHaveLength(1);
    expect(calls.find((c) => c.op === 'chat-answer')!.signal?.aborted).toBe(true);
    expect(logs).toEqual([{ event: 'chat_strict_blocked', route: 'router' }]);
    expect(JSON.stringify(logs)).not.toContain('4111');
    expect(turns).toEqual([]);
  });

  it('says it in the request’s language, and keeps the Thinking tier the user chose', async () => {
    const inference = fakeInference({ 'chat-router': dlpBlock() });
    const events = await collect(runChat({ inference, messages: user('x'), tier: 'thinking', fallbackLanguage: 'es' }));
    expect(events[0]).toMatchObject({ type: 'route', route: 'blocked', tier: 'thinking' });
    expect(texts(events)).toBe(FIXED_TEXT.es.strictBlocked);
  });

  it('answers an answer the gateway blocked after the router passed, after its route', async () => {
    const logs: Record<string, unknown>[] = [];
    const inference = fakeInference({ 'chat-router': clef('none', 0.8), 'chat-answer': dlpBlock() });
    const events = await collect(runChat({ inference, messages: user('hi'), log: (f) => logs.push(f) }));
    expect(events.map((e) => e.type)).toEqual(['route', 'notice', 'text', 'done']);
    expect(events[0]).toMatchObject({ type: 'route', route: 'answer' });
    expect(texts(events)).toBe(FIXED_TEXT.en.strictBlocked);
    expect(logs).toEqual([{ event: 'chat_strict_blocked', route: 'answer' }]);
  });

  it('knows the block by the gateway error and its code, not by any failure', () => {
    expect(isStrictBlock(dlpBlock())).toBe(true);
    const missing = new Error('2001: Gateway not found');
    missing.name = 'AiGatewayError';
    expect(isStrictBlock(missing)).toBe(false);
    expect(isStrictBlock(new Error('2030: Request content blocked due to DLP policy violations'))).toBe(false);
    expect(isStrictBlock(new InferenceTimeout('chat-router', 3_000))).toBe(false);
    expect(isStrictBlock('2030: blocked')).toBe(false);
    for (const lang of ['en', 'pt', 'es'] as const) expect(FIXED_TEXT[lang].strictBlocked).toMatch(/Cofferdam Cloud/);
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
