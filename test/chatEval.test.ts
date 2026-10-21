// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The chat evaluation's offline checks (always run): the prompt file is valid
 * and covers what decision 0037 asks for, the REST adapter behaves like the
 * Workers AI binding for `runChat`, and the scoring reads a turn correctly.
 * No network: fetch is a fake.
 */

import { describe, expect, it } from 'vitest';

import { CHAT_ACTIONS } from '../src/services/chat/router.js';
import { runChat, type ChatEvent } from '../src/services/chat/run.js';
import { createInference } from '../src/services/inference/index.js';
import prompts from './chat-eval/prompts.json';
import { createRestAi, RestAiError, type RecordedCall } from './chat-eval/restAi.js';
import {
  callCost,
  fieldMatches,
  guessLanguage,
  reportMarkdown,
  scoreTurn,
  summarize,
  sweepThresholds,
  validatePrompts,
  type EvalPrompt,
} from './chat-eval/score.js';

const set = prompts as EvalPrompt[];
const ROUTER = '@cf/cloudflare/clef-flash';
const GEMMA = '@cf/google/gemma-4-26b-a4b-it';
const TOKEN = 'test-token-not-a-secret';

describe('the prompt set', () => {
  it('parses and every entry is valid', () => {
    expect(validatePrompts(set)).toEqual([]);
    expect(set.length).toBeGreaterThanOrEqual(60);
    expect(set.length).toBeLessThanOrEqual(100);
  });

  it('every action id and candidate exists in CHAT_ACTIONS', () => {
    const ids = new Set(CHAT_ACTIONS.map((a) => a.id));
    for (const p of set) {
      if (p.expect.action !== null) expect(ids.has(p.expect.action), p.id).toBe(true);
      for (const c of p.expect.candidates ?? []) expect(ids.has(c), p.id).toBe(true);
    }
  });

  it('ids are unique and every entry has a language and a route', () => {
    expect(new Set(set.map((p) => p.id)).size).toBe(set.length);
    for (const p of set) {
      expect(['en', 'pt', 'es'], p.id).toContain(p.language);
      expect(['action', 'answer', 'answer_long', 'refuse', 'clarify'], p.id).toContain(p.expect.route);
    }
  });

  it('covers every action in all three languages, every route, and the mixed-language history case', () => {
    for (const a of CHAT_ACTIONS) {
      for (const lang of ['en', 'pt', 'es']) {
        expect(set.some((p) => p.expect.action === a.id && p.language === lang), `${a.id} in ${lang}`).toBe(true);
      }
    }
    for (const route of ['action', 'answer', 'answer_long', 'refuse', 'clarify']) {
      expect(set.filter((p) => p.expect.route === route).length, route).toBeGreaterThanOrEqual(4);
    }
    const mixed = set.filter((p) => p.history?.length && p.language !== 'en' && guessLanguage(p.history.map((m) => m.text).join(' ')) === 'en');
    expect(mixed.length).toBeGreaterThanOrEqual(10);
    expect(set.some((p) => p.text === 'Manda 20 pro joao' && p.history?.length)).toBe(true);
  });
});

// ── The adapter ──────────────────────────────────────────────────────────────

const enc = new TextEncoder();

function sseBody(deltas: string[], usage?: Record<string, number>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      // Split a line across two chunks, as the network does.
      const first = `data: ${JSON.stringify({ choices: [{ delta: { content: deltas[0] } }] })}\n\n`;
      c.enqueue(enc.encode(first.slice(0, 10)));
      c.enqueue(enc.encode(first.slice(10)));
      for (const d of deltas.slice(1)) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`));
      if (usage) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [], usage })}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
}

function clefAnswers(action: string, p: number, extra: Record<string, number> = {}, language = 'en') {
  return {
    action: { type: 'choice', choice: action, probabilities: { ...extra, [action]: p } },
    depth: { type: 'choice', choice: 'short', probabilities: { short: 0.9 } },
    harmful: { type: 'noul', noul: 0.01 },
    injection: { type: 'noul', noul: 0.01 },
    language: { type: 'choice', choice: language, probabilities: { [language]: 0.95 } },
  };
}

interface Seen {
  url: string;
  auth: string | null;
  body: Record<string, unknown>;
}

/** A fake Cloudflare API: Clef answers JSON, Gemma streams or calls the tool. */
function fakeFetch(answers: unknown, toolArgs: Record<string, unknown> = {}, seen: Seen[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    seen.push({ url, auth: new Headers(init.headers).get('authorization'), body });
    if (url.endsWith(ROUTER)) return Response.json({ success: true, errors: [], result: { answers } });
    if (body.stream === true) {
      return new Response(sseBody(['Olá! ', 'Como posso ajudar?'], { prompt_tokens: 300, completion_tokens: 12 }), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return Response.json({
      success: true,
      errors: [],
      result: {
        choices: [{ message: { tool_calls: [{ function: { name: 'open_send', arguments: JSON.stringify(toolArgs) } }] } }],
        usage: { prompt_tokens: 120, completion_tokens: 20 },
      },
    });
  }) as unknown as typeof fetch;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<ChatEvent[]> {
  const text = await new Response(stream).text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l.replace(/^data: /, '')) as ChatEvent);
}

describe('the REST adapter', () => {
  it('posts the input unchanged with the bearer token and returns the parsed result', async () => {
    const seen: Seen[] = [];
    const calls: RecordedCall[] = [];
    const ai = createRestAi({ accountId: 'acc', token: TOKEN, fetch: fakeFetch(clefAnswers('none', 0.9), {}, seen), onCall: (c) => calls.push(c) });
    const input = { model: 'clef-flash', state: 'Latest user message: hi', questions: { a: { type: 'noul', instructions: 'x' } } };
    const res = await ai.run(ROUTER as never, input as never, { tags: ['x'] } as never);
    expect(res).toEqual({ answers: clefAnswers('none', 0.9) });
    expect(seen[0]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/acc/ai/run/${ROUTER}`);
    expect(seen[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]!.body).toEqual(input);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: ROUTER, stream: false, status: 200, aborted: false });
  });

  it('throws on an error status without the token in the message', async () => {
    const ai = createRestAi({
      accountId: 'acc',
      token: TOKEN,
      fetch: (async () => Response.json({ success: false, errors: [{ message: 'Authentication error' }] }, { status: 401 })) as unknown as typeof fetch,
    });
    const err = await ai.run(GEMMA as never, { messages: [] } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestAiError);
    expect((err as Error).message).toContain('401');
    expect((err as Error).message).toContain('Authentication error');
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('turns a canned SSE body into the events runChat expects, and records the usage', async () => {
    const calls: RecordedCall[] = [];
    const ai = createRestAi({ accountId: 'acc', token: TOKEN, fetch: fakeFetch(clefAnswers('none', 0.9, {}, 'pt')), onCall: (c) => calls.push(c) });
    const inference = createInference({}, { ai })!;
    const evs = await collect(runChat({ inference, messages: [{ role: 'user', text: 'oi, tudo bem?' }] }));
    expect(evs[0]).toMatchObject({ type: 'route', route: 'answer', action: null });
    expect(evs.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta)).toEqual(['Olá! ', 'Como posso ajudar?']);
    expect(evs[evs.length - 1]).toEqual({ type: 'done' });
    const answer = calls.find((c) => c.model === GEMMA)!;
    expect(answer).toMatchObject({ stream: true, aborted: false, usage: { prompt_tokens: 300, completion_tokens: 12 } });
    expect(answer.outputChars).toBe('Olá! Como posso ajudar?'.length);
  });

  it('drives an action turn: the early answer is cancelled and the scored turn passes', async () => {
    const calls: RecordedCall[] = [];
    const log: Record<string, unknown>[] = [];
    const ai = createRestAi({
      accountId: 'acc',
      token: TOKEN,
      fetch: fakeFetch(clefAnswers('send', 0.8), { amount: 20, recipient: '@ana' }),
      onCall: (c) => calls.push(c),
    });
    const inference = createInference({}, { ai })!;
    const prompt = set.find((p) => p.id === 'send-en-dollars-handle')!;
    const evs = await collect(runChat({ inference, messages: [{ role: 'user', text: prompt.text }], log: (l) => log.push(l) }));
    expect(evs.find((e) => e.type === 'action')).toEqual({ type: 'action', request: { id: 'send', amount: 20, recipient: 'ana' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((c) => c.model === GEMMA && c.stream && c.aborted)).toBe(true);

    const result = scoreTurn(prompt, { events: evs as never, log, calls, totalMs: 10, routerModel: ROUTER });
    expect(result).toMatchObject({ route: 'action', action: 'send', routeOk: true, actionOk: true, softOk: true, routerLanguageOk: true });
    expect(result.fieldScores).toEqual({ amount: true, recipient: true });
    expect(result.clef).toEqual(clefAnswers('send', 0.8));
    expect(result.costUsd).toBeGreaterThan(0);
  });
});

// ── Scoring ──────────────────────────────────────────────────────────────────

describe('scoring', () => {
  it('matches fields: equal, absent, alternatives, and query by containment', () => {
    expect(fieldMatches('amount', 20, 20)).toBe(true);
    expect(fieldMatches('amount', 20, '20')).toBe(true);
    expect(fieldMatches('amount', null, undefined)).toBe(true);
    expect(fieldMatches('amount', null, 20)).toBe(false);
    expect(fieldMatches('recipient', 'joao', 'João')).toBe(true);
    expect(fieldMatches('recipient', 'ana', '@ana')).toBe(true);
    expect(fieldMatches('recipient', 'ana', 'anabel')).toBe(false);
    expect(fieldMatches('query', ['passaporte', 'passport'], 'my passport')).toBe(true);
    expect(fieldMatches('query', ['contrato'], 'invoice')).toBe(false);
  });

  it('guesses a reply language', () => {
    expect(guessLanguage('Hi! How can I help you with your payments today?')).toBe('en');
    expect(guessLanguage('Oi! Como posso ajudar você com seus pagamentos hoje?')).toBe('pt');
    expect(guessLanguage('¡Hola! ¿Cómo puedo ayudarte con tus pagos hoy?')).toBe('es');
    expect(guessLanguage('ok')).toBeNull();
  });

  it('prices calls, estimating Clef input from characters', () => {
    const clef = callCost({ model: ROUTER, stream: false, inputChars: 4_000, ms: 1, status: 200, aborted: false, outputChars: 0 });
    expect(clef).toMatchObject({ tokensIn: 1_000, tokensOut: 0, estimated: true });
    expect(clef.usd).toBeCloseTo(0.000038, 9);
    const gemma = callCost({ model: GEMMA, stream: true, inputChars: 1, ms: 1, status: 200, aborted: false, outputChars: 1, usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 } });
    expect(gemma).toMatchObject({ estimated: false });
    expect(gemma.usd).toBeCloseTo(0.4, 9);
    // Neurons, when reported, are the bill: cached input priced as cached, so below the catalogue rate.
    const billed = callCost({
      model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
      stream: true,
      inputChars: 1,
      ms: 1,
      status: 200,
      aborted: false,
      outputChars: 1,
      usage: { prompt_tokens: 1_060, completion_tokens: 100, neurons: 12, prompt_tokens_details: { cached_tokens: 960 } },
    });
    expect(billed).toMatchObject({ billed: true, cachedIn: 960, estimated: false });
    expect(billed.usd).toBeCloseTo(0.000132, 9);
    expect(callCost({ model: '@cf/x/unknown', stream: false, inputChars: 4, ms: 1, status: 200, aborted: false, outputChars: 0 }).usd).toBeNull();
  });

  it('scores no route when the router failed, and bills nothing for a refused call', () => {
    const prompt = set.find((p) => p.id === 'greet-en')!;
    const evs = [{ type: 'route', route: 'answer', action: null, confidence: 0 }, { type: 'text', delta: 'Hi there! How can I help?' }, { type: 'done' }];
    const calls: RecordedCall[] = [{ model: ROUTER, stream: false, inputChars: 2_000, ms: 5, status: 'network', aborted: false, outputChars: 0 }];
    const log = [{ event: 'chat_router_failed', reason: 'fetch failed' }, { event: 'chat_turn', language: 'en', ms: 300 }];
    const r = scoreTurn(prompt, { events: evs, log, calls, totalMs: 300, routerModel: ROUTER });
    expect(r).toMatchObject({ route: 'answer', routeOk: false, softOk: false, costUsd: 0 });
    expect(r.error).toContain('chat_router_failed');
  });

  it('sweeps the floors over recorded Clef answers and writes a report', () => {
    const prompt = set.find((p) => p.id === 'multi-pt-manda-joao')!;
    const answers = clefAnswers('send', 0.54, { message: 0.28 }, 'pt');
    const evs = [
      { type: 'route', route: 'clarify', action: null, confidence: 0.54 },
      { type: 'choices', requests: [{ id: 'send', amount: 20, recipient: 'joao' }, { id: 'message' }] },
      { type: 'text', delta: 'Você quis dizer uma destas?' },
      { type: 'done' },
    ];
    const calls: RecordedCall[] = [{ model: ROUTER, stream: false, inputChars: 2_800, ms: 400, status: 200, aborted: false, outputChars: 0, result: { answers } }];
    const r = scoreTurn(prompt, { events: evs, log: [{ event: 'chat_turn', language: 'pt', router: 400, ms: 900 }], calls, totalMs: 900, routerModel: ROUTER });
    expect(r).toMatchObject({ routeOk: false, softOk: true, fieldScores: { amount: true, recipient: true } });

    const rows = sweepThresholds([r], [0.5, 0.55], [0.15]);
    expect(rows.find((x) => x.action === 0.5)).toMatchObject({ routeOk: 1, clarifyForAction: 0 });
    expect(rows.find((x) => x.action === 0.55)).toMatchObject({ routeOk: 0, softOk: 1, clarifyForAction: 1 });

    const s = summarize([r]);
    expect(s.overall).toEqual({ n: 1, route: 0, action: 0, soft: 1 });
    const md = reportMarkdown([r], { date: '2026-10-20', models: { 'chat-router': ROUTER }, early: true, durationMs: 1_000 });
    expect(md).toContain('# Chat evaluation, 2026-10-20');
    expect(md).toContain('## Threshold sweep');
    expect(md).toContain('multi-pt-manda-joao');
  });
});
