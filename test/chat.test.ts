// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createChatRoutes, type ChatRouteDeps } from '../src/routes/chat.js';
import { actionTool, decideRoute, routerQuestions } from '../src/services/chat/router.js';
import {
  CLARIFY_TEXT,
  mentionsOtherCurrency,
  REFUSE_TEXT,
  parseChatRequest,
  runChat,
  type AiRun,
  type ChatEvent,
} from '../src/services/chat/run.js';

const ACCOUNT = '0x' + 'ab'.repeat(20);

function clef(action: string, actionP: number, depth = 'short', depthP = 0.9, harmful = 0.01, injection = 0.01) {
  return {
    answers: {
      action: { type: 'choice', choice: action, probabilities: { [action]: actionP } },
      depth: { type: 'choice', choice: depth, probabilities: { [depth]: depthP } },
      harmful: { type: 'noul', noul: harmful },
      injection: { type: 'noul', noul: injection },
    },
  };
}

function sse(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const t of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<ChatEvent[]> {
  const text = await new Response(stream).text();
  return text.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')) as ChatEvent);
}

function fakeAi(responses: Record<string, unknown>, calls: Array<[string, Record<string, unknown>]> = []): AiRun {
  return async (model, input) => {
    calls.push([model, input]);
    const r = responses[model];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? (r as () => unknown)() : r;
  };
}

const user = (text: string) => [{ role: 'user' as const, text }];

describe('decideRoute', () => {
  it('proposes an action only above the action floor', () => {
    expect(decideRoute(clef('send', 0.97).answers)).toMatchObject({ route: 'action', action: 'send' });
    expect(decideRoute(clef('send', 0.4).answers).route).toBe('clarify');
    expect(decideRoute(clef('none', 0.8).answers).route).toBe('answer');
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

  it('builds tools only for actions with fields', () => {
    expect(actionTool('send')?.function.parameters.properties).toHaveProperty('recipient');
    expect(actionTool('looking_for')).toBeNull();
    expect(Object.keys(routerQuestions().action.criteria)).toContain('none');
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
});

describe('runChat', () => {
  it('fills an action from the tool call, keeping only declared fields', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const ai = fakeAi(
      {
        '@cf/cloudflare/clef-flash': clef('send', 0.97),
        '@cf/google/gemma-4-26b-a4b-it': {
          choices: [{ message: { tool_calls: [{ function: { arguments: '{"amount":20,"recipient":"@ana","memo":"x"}' } }] } }],
        },
      },
      calls,
    );
    const events = await collect(runChat({ ai, messages: user('send 20 to @ana') }));
    expect(events[0]).toMatchObject({ type: 'route', route: 'action', action: 'send' });
    expect(events).toContainEqual({ type: 'action', request: { id: 'send', amount: 20, recipient: 'ana' } });
    expect(events[events.length - 1]).toEqual({ type: 'done' });
    expect(calls[0]![1]).toMatchObject({ model: 'clef-flash' });
    expect(calls[1]![1]).toMatchObject({ tool_choice: 'required', chat_template_kwargs: { enable_thinking: false } });
  });

  it('opens a field-less action without calling the action model', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const ai = fakeAi({ '@cf/cloudflare/clef-flash': clef('looking_for', 0.93) }, calls);
    const events = await collect(runChat({ ai, messages: user('I want to start looking for work') }));
    expect(events).toContainEqual({ type: 'action', request: { id: 'looking_for' } });
    expect(calls).toHaveLength(1);
  });

  it('streams a short answer from the everyday model with thinking off', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const ai = fakeAi(
      { '@cf/cloudflare/clef-flash': clef('none', 0.8), '@cf/google/gemma-4-26b-a4b-it': () => sse(['Hel', 'lo']) },
      calls,
    );
    const events = await collect(runChat({ ai, messages: user('hi') }));
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Hello');
    expect(calls[1]![1]).toMatchObject({ stream: true, chat_template_kwargs: { enable_thinking: false } });
  });

  it('refuses, asks when unsure, and answers on the everyday model when the router fails', async () => {
    const refuse = await collect(runChat({ ai: fakeAi({ '@cf/cloudflare/clef-flash': clef('none', 0.8, 'short', 0.6, 0.94) }), messages: user('x') }));
    expect(refuse).toContainEqual({ type: 'text', delta: REFUSE_TEXT });
    const ask = await collect(runChat({ ai: fakeAi({ '@cf/cloudflare/clef-flash': clef('send', 0.3) }), messages: user('x') }));
    expect(ask).toContainEqual({ type: 'text', delta: CLARIFY_TEXT });
    const fallback = await collect(
      runChat({
        ai: fakeAi({ '@cf/cloudflare/clef-flash': new Error('down'), '@cf/google/gemma-4-26b-a4b-it': { choices: [{ message: { content: 'Hi!' } }] } }),
        messages: user('hello'),
      }),
    );
    expect(fallback).toContainEqual({ type: 'text', delta: 'Hi!' });
  });

  it('ends with an error event when the answering model fails', async () => {
    const ai = fakeAi({ '@cf/cloudflare/clef-flash': clef('none', 0.8), '@cf/google/gemma-4-26b-a4b-it': new Error('boom') });
    const events = await collect(runChat({ ai, messages: user('hi') }));
    expect(events[events.length - 1]!.type).toBe('error');
  });
});

describe('POST /v1/chat gate', () => {
  function app(env: Record<string, unknown>, deps: Partial<ChatRouteDeps> = {}) {
    const h = new Hono();
    const routes = createChatRoutes({
      attestationMaxAgeMs: 3_600_000,
      now: () => Date.now(),
      authorityCheck: async () => ({ status: 'not_found' }),
      ai: () => fakeAi({ '@cf/cloudflare/clef-flash': clef('none', 0.8), '@cf/google/gemma-4-26b-a4b-it': { response: 'ok' } }),
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

  it('streams in development without a token, and answers 503 without Workers AI', async () => {
    const res = await app({ ENVIRONMENT: 'development' })({ account: ACCOUNT, messages: user('hi') });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(await res.text()).toContain('"type":"done"');
    const none = await app({ ENVIRONMENT: 'development' }, { ai: () => null })({ account: ACCOUNT, messages: user('hi') });
    expect(none.status).toBe(503);
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
});
