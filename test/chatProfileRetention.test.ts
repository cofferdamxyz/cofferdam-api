// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A chat turn that carries the saved Work Profile's facts (workspace decision 0076) leaves nothing on the plane: the
 * whole plane (`src/index.ts`, its middleware and error handler included) serves `POST /v1/chat` with every binding,
 * the console, `fetch` and the Cache API recorded, and the test fails on any write or log line that carries a piece of
 * the facts, the question or the answer, and on any store touched beyond the rate limits and the meter. The facts reach
 * the answer model's system message and never the router's input. Made-up facts only.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { monthOf } from '../src/services/chatUsageStore.js';
import { answerSystem } from '../src/services/chat/run.js';
import { clearPinCache } from '../src/services/inference/index.js';

// src/index.ts exports the Durable Object classes, which extend the runtime's base class.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const ACCOUNT = '0x00000000000000000000000000000000000c0ffe';
const PROFILE = [
  "The user's Work Profile (their CV, as they reviewed and approved it), the parts this question needs:",
  'Jobs, most recent first:',
  '- Quixotic Harpoon Rigger at Zelda Vortex Marine Ltda, from 2017 to 2021 (about 4 years).',
  'Today is 2026-10-31.',
].join('\n');
const QUESTION = 'How long have I worked at Zelda Vortex Marine?';
const ANSWER = 'You worked at Zelda Vortex Marine for about four years, Canary-Answer-K9P2.';
const SECRETS = ['Quixotic Harpoon Rigger', 'Zelda Vortex Marine', 'Canary-Answer-K9P2', QUESTION];

interface BindingCall {
  binding: string;
  method: string;
  args: unknown[];
}

function recorder(name: string, sink: BindingCall[], impl: Record<string, (...args: never[]) => unknown> = {}): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        return (...args: unknown[]) => {
          sink.push({ binding: name, method: prop, args });
          return (impl[prop] as ((...a: unknown[]) => unknown) | undefined)?.(...args);
        };
      },
    },
  );
}

function shown(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack ?? ''}\n${v.cause === undefined ? '' : shown(v.cause)}`;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

const leaked = (sink: string) => SECRETS.filter((s) => sink.includes(s));

/** A Clef answer that routes the turn to an everyday answer. */
const ROUTER = {
  answers: {
    action: { type: 'choice', choice: 'none', probabilities: { none: 0.9 } },
    depth: { type: 'choice', choice: 'short', probabilities: { short: 0.9 } },
    harmful: { type: 'noul', noul: 0.01 },
    injection: { type: 'noul', noul: 0.01 },
  },
  usage: { input_tokens: 300 },
};

/** The answer model's stream, as Workers AI sends it. */
function answerStream(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
      c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 20 } })}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
}

const STORE_BINDINGS = ['WORK_DB', 'TOKEN_REGISTRY', 'JOBS_LISTINGS', 'LINKS', 'BIND_BUNDLES_DO', 'ACTIVITY_DO', 'POP_REPLAY_DO', 'ATTESTER', 'WORK_RL', 'WORK_IP_RL', 'VAULT', 'VAULT_GLOBAL_RL', 'VAULT_RL', 'VAULT_IP_RL'];
const ALLOWED = new Set(['CHAT_RL.limit', 'CHAT_IP_RL.limit', 'AI_PINS.get', 'AI.run', 'CHAT_USAGE_DO.getByName', 'CHAT_USAGE_DO/*.read', 'CHAT_USAGE_DO/*.record']);
const allowedName = (c: BindingCall) => `${c.binding.replace(/^CHAT_USAGE_DO\/.*/, 'CHAT_USAGE_DO/*')}.${c.method}`;
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

describe('a chat turn with Work Profile facts keeps nothing on the plane (workspace decision 0076)', () => {
  const sink = { lines: [] as string[] };
  const originals = new Map<(typeof CONSOLE_METHODS)[number], PropertyDescriptor | undefined>();
  let app: { fetch(req: Request, env: unknown, ctx: unknown): Response | Promise<Response> };
  let calls: BindingCall[];
  let fetches: string[];
  let pending: Promise<unknown>[];

  beforeAll(async () => {
    // The console is wrapped before the plane is imported: Hono's request logger keeps the console.log it finds then.
    for (const m of CONSOLE_METHODS) {
      originals.set(m, Object.getOwnPropertyDescriptor(console, m));
      console[m] = (...args: unknown[]) => void sink.lines.push(args.map(shown).join(' '));
    }
    app = (await import('../src/index.js')).default;
  });

  afterAll(() => {
    for (const [m, d] of originals) if (d) Object.defineProperty(console, m, d);
  });

  beforeEach(() => {
    clearPinCache();
    calls = [];
    sink.lines = [];
    fetches = [];
    pending = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      fetches.push(`${shown(input)} ${shown(init?.body ?? '')}`);
      return new Response('{}');
    });
    vi.stubGlobal('caches', { default: recorder('caches.default', calls), open: async (name: string) => recorder(`caches/${name}`, calls) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('gives the facts to the answer model only, answers the phone, and logs or keeps none of it', async () => {
    const env: Record<string, unknown> = {
      ENVIRONMENT: 'development',
      BASE_SEPOLIA_RPC_URL: 'http://127.0.0.1:9/never-read',
      AI_GATEWAY_ID: 'cofferdam-strict',
      AI_GATEWAY_DOCUMENTS_ID: 'cofferdam-documents',
      CHAT_MONTHLY_USD_CAP: '0.06',
      AI_MONTHLY_BUDGET_USD: '500',
      AI: recorder('AI', calls, {
        run: (_model: never, _input: never, options: never) =>
          ((options as { tags: string[] }).tags.includes('op:chat-router') ? ROUTER : answerStream(ANSWER)),
      }),
      AI_PINS: recorder('AI_PINS', calls, { get: async () => null }),
      CHAT_RL: recorder('CHAT_RL', calls, { limit: async () => ({ success: true }) }),
      CHAT_IP_RL: recorder('CHAT_IP_RL', calls, { limit: async () => ({ success: true }) }),
      CHAT_USAGE_DO: recorder('CHAT_USAGE_DO', calls, {
        getByName: (name: never) => recorder(`CHAT_USAGE_DO/${String(name)}`, calls, { read: async () => null, record: async () => undefined }),
      }),
      ...Object.fromEntries(STORE_BINDINGS.map((b) => [b, recorder(b, calls)])),
    };
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined, props: {} };
    const res = await app.fetch(
      new Request('https://plane.test/v1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept-language': 'en-US', 'cf-connecting-ip': '203.0.113.7' },
        body: JSON.stringify({ account: ACCOUNT, messages: [{ role: 'user', text: QUESTION }], profile: PROFILE, language: 'en' }),
      }),
      env as never,
      ctx as never,
    );
    expect(res.status).toBe(200);
    // The phone gets the answer: that is the turn.
    expect(await res.text()).toContain('Canary-Answer-K9P2');
    await Promise.all(pending);

    // The facts reach the answer model's system message, and never the router's input.
    const runs = calls.filter((c) => c.binding === 'AI');
    const tagged = (op: string) => runs.find((c) => (c.args[2] as { tags: string[] }).tags.includes(`op:${op}`))!;
    expect((tagged('chat-answer').args[1] as { messages: { content: string }[] }).messages[0]!.content).toBe(answerSystem(PROFILE, 'en'));
    expect(shown(tagged('chat-router').args[1])).not.toContain('Quixotic Harpoon Rigger');
    for (const r of runs) expect((r.args[2] as { gateway: { id: string } }).gateway.id).toBe('cofferdam-strict');

    // Nothing else: no log line, no write and no request carries the facts, the question or the answer.
    expect(sink.lines.length).toBeGreaterThan(0);
    expect(leaked(sink.lines.join('\n'))).toEqual([]);
    expect(fetches).toEqual([]);
    expect(calls.map(allowedName).filter((n) => !ALLOWED.has(n))).toEqual([]);
    expect(leaked(calls.filter((c) => c.binding !== 'AI').map((c) => shown(c.args)).join('\n'))).toEqual([]);
    const records = calls.filter((c) => c.method === 'record');
    expect(records).toHaveLength(2);
    for (const r of records) expect(JSON.stringify(r.args)).not.toMatch(/Zelda|Quixotic|Canary/);
    expect(records.every((r) => (r.args[0] as string) === monthOf(Date.now()))).toBe(true);
  });
});
