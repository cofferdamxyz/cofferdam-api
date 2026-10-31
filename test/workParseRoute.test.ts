// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /v1/work/parse` (workspace decision 0021, ruled 2026-10-28): the route over `services/work/parse.ts` on the
 * synthetic pt-BR CV of `test/fixtures/work/parse/`, its text stripped as the phone strips it, offline.
 *
 * Then the zero-retention test decision 0021 (h) asks for: the whole plane (`src/index.ts`, its middleware and error
 * handler included) serves a parse, a failed one and a refused one with every binding, the console, `fetch` and the
 * Cache API recorded, and the test fails on any write or log line that carries the request's text or the answer.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Hono } from 'hono';
import { getAddress } from 'viem';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkRoutes, type WorkRouteDeps } from '../src/routes/work.js';
import type { AuthorityCheck } from '../src/services/authorityCheck.js';
import { createAuthorityMemo } from '../src/services/chat/authorityMemo.js';
import { monthOf } from '../src/services/chatUsageStore.js';
import { clearPinCache, createInference, InferenceTimeout, modelCostMicroUsd, OPS } from '../src/services/inference/index.js';
import { estimatedUsage } from '../src/services/work/fields.js';
import {
  MAX_PARSE_TEXT,
  PARSE_BUDGET_MS,
  PARSE_MAX_TOKENS,
  PARSE_RETRY_MIN_MS,
  parseCv,
  parseRequest,
  readParse,
  readParseBody,
  withoutPlaceholders,
} from '../src/services/work/parse.js';
import { fakeInference, memoryUsageStore, type FakeCall, type FakeResponses } from './fixtures/work/fakes.js';
import fixtures from './fixtures/sdk-attestations.json';
import { BIRTH_DATE_PLACEHOLDER, emailPlaceholder, NAME_PLACEHOLDER, stripIdentity } from './work-eval/identityStrip.js';
import type { ParseTruth } from './work-eval/parseScore.js';

// src/index.ts exports the Durable Object classes, which extend the runtime's base class.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const DEEPSEEK = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
const fxAccount = fixtures.fields.accountAddress as string;
const issuedAt = fixtures.fields.issuedAt as number;
const now = issuedAt + 5_000;
const month = monthOf(now);
const bearer = { authorization: `Bearer ${fixtures.p256.token}` };
const HIGH: AuthorityCheck = { status: 'active', authorityId: 0, module: fxAccount as `0x${string}`, tier: 3 };
const STAGING = { ENVIRONMENT: 'staging', AI_GATEWAY_ID: 'cofferdam-strict', AI_GATEWAY_DOCUMENTS_ID: 'cofferdam-documents' };

interface FixtureCv {
  id: string;
  ocr: string[];
  truth: ParseTruth;
}

const CVS = (JSON.parse(readFileSync(join(__dirname, 'fixtures/work/parse/cvs.json'), 'utf8')) as { cvs: FixtureCv[] }).cvs;
const PT = CVS.find((cv) => cv.id === 'cv-pt')!;

/** The pt-BR CV's text as the phone sends it for an account bound to no passport: its email stripped, its name kept. */
const STRIPPED = stripIdentity(PT.ocr.join('\n'), null);
const TEXT = STRIPPED.text;

/** What a perfect reader answers for a truth, in the schema's own fields. */
function answerFor(t: ParseTruth): Record<string, unknown> {
  return {
    name: t.identity.name,
    email: t.identity.email,
    phone: t.identity.phone,
    location: t.identity.location,
    headline_title: t.headline.title,
    years_experience: t.headline.years,
    experience: t.experience.map((e) => ({ title: e.title, employer: e.employer, location: null, start: e.start, end: e.current ? 'atual' : e.end, current: e.current, skills: [] })),
    education: t.education,
    skills: t.skills,
    certificates: t.certificates.map((c) => ({ name: c.name, expires: c.expires })),
    languages: t.languages.map((l) => ({ name: { pt: 'Português', en: 'Inglês', es: 'Espanhol' }[l.code], level: l.level })),
  };
}

/** DeepSeek's answer as Workers AI returns it under the OpenAI JSON-schema wrapper. */
const asChat = (o: unknown, usage = { prompt_tokens: 1200, completion_tokens: 400 }) => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(o) } }], usage });

/** DeepSeek copies the strip's placeholder into the email, as it did on 98 of 100 stripped resumes (decision 0021, 2026-10-30). */
const ANSWER: Record<string, unknown> = { ...answerFor(PT.truth), email: '[EMAIL_1]' };

function route(env: Record<string, unknown>, deps: Partial<WorkRouteDeps> = {}, responses: FakeResponses = {}, calls: FakeCall[] = []) {
  const h = new Hono();
  h.route(
    '/v1/work',
    createWorkRoutes({
      attestationMaxAgeMs: 3_600_000,
      now: () => now,
      authorityCheck: async () => HIGH,
      authorityMemo: createAuthorityMemo({ edge: null }),
      inference: () => fakeInference({ 'work-parse': asChat(ANSWER), ...responses }, calls),
      ...deps,
    }),
  );
  return (body: unknown, headers: Record<string, string> = bearer) =>
    h.request('/v1/work/parse', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, env as never);
}

/** A response function that answers `answers` in turn, then the last one again. */
function inTurn(...answers: unknown[]) {
  let n = 0;
  return () => {
    const a = answers[Math.min(n++, answers.length - 1)];
    if (a instanceof Error) throw a;
    return a;
  };
}

describe('the phone strips the synthetic CV before it leaves', () => {
  it('removes its email, keeps its name for an account bound to no passport, and the route takes the result', () => {
    expect(STRIPPED.removed.map((r) => [r.kind, r.placeholder])).toEqual([['email', '[EMAIL_1]']]);
    expect(TEXT).not.toContain('@');
    expect(TEXT).toContain('Rafael Exemplo');
    expect(readParseBody({ account: fxAccount, text: TEXT })).toEqual({ ok: true, text: TEXT });
  });
});

describe('POST /v1/work/parse', () => {
  it("reads the CV's text into the identity and `claimed` of a cofferdam.cv.v1, in one work-parse call", async () => {
    const calls: FakeCall[] = [];
    const res = await route(STAGING, {}, {}, calls)({ account: fxAccount, text: TEXT });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['ok', 'schema', 'identity', 'claimed', 'dropped', 'provenance']);
    expect(body).toMatchObject({
      ok: true,
      schema: 'cofferdam.cv.v1',
      identity: { name: 'Rafael Exemplo', email: null, phone: null, location: 'Macaé, RJ' },
      claimed: {
        headline: { title: { raw: 'Eletricista Offshore', rank: null }, years: 8 },
        experience: [
          { title: { raw: 'Eletricista de Manutenção', rank: null }, employer: 'Oceânica Serviços Marítimos', location: null, start: '2021', end: null, current: true, skills: [] },
          { title: { raw: 'Eletricista Montador', rank: null }, employer: 'Atlântico Engenharia', start: '2017', end: '2021', current: false },
        ],
        education: [{ qualification: 'Técnico em Eletrotécnica', institution: 'SENAI Macaé', end: '2016' }],
        certificates: expect.arrayContaining([{ raw: 'NR-10 Básico e SEP', expires: '2027-03' }]),
      },
      provenance: { executor: 'cloud', models: [DEEPSEEK], parsedAt: new Date(now).toISOString() },
    });
    // The placeholder DeepSeek copied is not an email: the phone fills it from what its strip removed.
    expect(body.dropped).toEqual([{ path: 'email', reason: 'placeholder' }]);
    // The claimed section is readParse's, the reader the phone runs on Cofferdam Local's answer.
    expect(body.claimed).toEqual(JSON.parse(JSON.stringify(readParse(asChat(ANSWER), now).claimed)));
    // One call, the measured text path byte for byte: the CV's text as the phone sent it, and no image part.
    expect(calls.map((c) => c.op)).toEqual(['work-parse']);
    expect(calls[0]!.input).toEqual(parseRequest(DEEPSEEK, { kind: 'text', text: TEXT }, { maxTokens: PARSE_MAX_TOKENS }));
    // Only the answer's cap differs from the benchmarks' request, so the measured prompt is the one sent.
    expect({ ...calls[0]!.input, max_tokens: 0 }).toEqual({ ...parseRequest(DEEPSEEK, { kind: 'text', text: TEXT }), max_tokens: 0 });
    const user = (calls[0]!.input.messages as { role: string; content: unknown }[])[1]!;
    expect(user).toEqual({ role: 'user', content: `The CV, as OCR lines:\n\n${TEXT}` });
    expect(JSON.stringify(calls[0]!.input)).not.toContain('image_url');
  });

  it('takes the text only: another key, a missing, blank or non-string text, never echoed; too long names the limit', async () => {
    const calls: FakeCall[] = [];
    const post = route(STAGING, {}, {}, calls);
    const page = { mime: 'image/jpeg', base64: '/9j/4AAQSkZJRg' };
    for (const body of [
      { account: fxAccount, text: TEXT, pages: [page] },
      { account: fxAccount, text: TEXT, kind: 'image' },
      { account: fxAccount, pages: [page] },
      { account: fxAccount },
      { account: fxAccount, text: ' \n\t ' },
      { account: fxAccount, text: [TEXT] },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      const answer = await res.text();
      expect(JSON.parse(answer)).toMatchObject({ ok: false, error: 'bad_request' });
      expect(answer).not.toContain('Rafael');
    }
    const long = await post({ account: fxAccount, text: `${TEXT}\n${'x'.repeat(MAX_PARSE_TEXT)}` });
    expect(long.status).toBe(413);
    expect(await long.json()).toEqual({ ok: false, error: 'text_too_long', max: MAX_PARSE_TEXT });
    expect(calls).toEqual([]);
    expect((await post({ account: fxAccount, text: 'x'.repeat(MAX_PARSE_TEXT) })).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('runs only behind both gateways outside development, and needs neither in development', async () => {
    const calls: FakeCall[] = [];
    const noDocuments = await route({ ENVIRONMENT: 'staging', AI_GATEWAY_ID: 'cofferdam-strict' }, {}, {}, calls)({ account: fxAccount, text: TEXT });
    expect(noDocuments.status).toBe(503);
    expect(await noDocuments.json()).toMatchObject({ ok: false, error: 'documents_gateway_required' });
    const noStrict = await route({ ENVIRONMENT: 'staging', AI_GATEWAY_DOCUMENTS_ID: 'cofferdam-documents' }, {}, {}, calls)({ account: fxAccount, text: TEXT });
    expect(noStrict.status).toBe(503);
    expect(await noStrict.json()).toMatchObject({ ok: false, error: 'strict_gateway_required' });
    expect(calls).toEqual([]);
    expect((await route({ ENVIRONMENT: 'development' })({ account: fxAccount, text: TEXT }, {})).status).toBe(200);
  });

  it('requires a session pinned to the account and a High authority on it', async () => {
    expect(await (await route(STAGING)({ account: fxAccount, text: TEXT }, {})).json()).toMatchObject({ error: 'attestation_required' });
    expect((await route(STAGING, { authorityCheck: async () => ({ ...HIGH, tier: 1 }) })({ account: fxAccount, text: TEXT })).status).toBe(401);
    expect((await route(STAGING)({ account: '0x' + '12'.repeat(20), text: TEXT })).status).toBe(401);
  });

  it('refuses past the account’s cap before any model call', async () => {
    const calls: FakeCall[] = [];
    const full = new Map([[`${fxAccount.toLowerCase()}:${month}`, { month, turns: 0, tokensIn: 0, tokensOut: 0, routerCalls: 0, estimatedMicroUsd: 60_000, lastTurnAt: 0, models: [] }]]);
    const res = await route({ ...STAGING, CHAT_MONTHLY_USD_CAP: '0.06' }, { usageStore: () => memoryUsageStore(full).store }, {}, calls)({ account: fxAccount, text: TEXT });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'fair_use_cap' });
    expect(calls).toEqual([]);
  });

  it('retries an answer out of shape once, and meters both calls to the account and the plane, with numbers only', async () => {
    const calls: FakeCall[] = [];
    const { store, recorded } = memoryUsageStore();
    const shapeless = asChat('Here is the CV you sent.', { prompt_tokens: 1200, completion_tokens: 30 });
    const res = await route(STAGING, { usageStore: () => store }, { 'work-parse': inTurn(shapeless, asChat(ANSWER)) }, calls)({ account: fxAccount, text: TEXT });
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.op)).toEqual(['work-parse', 'work-parse']);
    await new Promise((r) => setTimeout(r, 0));
    const cost = modelCostMicroUsd(DEEPSEEK, 1200, 30) + modelCostMicroUsd(DEEPSEEK, 1200, 400);
    expect(recorded.map((r) => r.account)).toEqual([getAddress(fxAccount), 'global']);
    for (const r of recorded) expect(r.delta).toEqual({ turns: 0, tokensIn: 2400, tokensOut: 430, routerCalls: 0, estimatedMicroUsd: cost, model: DEEPSEEK, modelMicroUsd: cost, at: now });
  });

  it('answers 502 parse_failed with its reason, meters what failed, and never retries a timeout', async () => {
    const twice = memoryUsageStore();
    const calls: FakeCall[] = [];
    const down = await route(STAGING, { usageStore: () => twice.store }, { 'work-parse': new Error('upstream down') }, calls)({ account: fxAccount, text: TEXT });
    expect(down.status).toBe(502);
    expect(await down.json()).toEqual({ ok: false, error: 'parse_failed', reason: 'call_failed' });
    expect(calls).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 0));
    const thrown = estimatedUsage(parseRequest(DEEPSEEK, { kind: 'text', text: TEXT }, { maxTokens: PARSE_MAX_TOKENS })).tokensIn;
    expect(twice.recorded.map((r) => [r.account, r.delta.tokensIn])).toEqual([
      [getAddress(fxAccount), 2 * thrown],
      ['global', 2 * thrown],
    ]);

    const late: FakeCall[] = [];
    const timeout = await route(STAGING, {}, { 'work-parse': new InferenceTimeout('work-parse', OPS['work-parse'].timeoutMs) }, late)({ account: fxAccount, text: TEXT });
    expect(await timeout.json()).toEqual({ ok: false, error: 'parse_failed', reason: 'timeout' });
    expect(late).toHaveLength(1);

    const shapeless: FakeCall[] = [];
    const shape = await route(STAGING, {}, { 'work-parse': asChat(['not', 'an', 'object']) }, shapeless)({ account: fxAccount, text: TEXT });
    expect(await shape.json()).toEqual({ ok: false, error: 'parse_failed', reason: 'shape' });
    expect(shapeless).toHaveLength(2);

    expect((await route(STAGING, {}, { 'work-parse': inTurn(new Error('blip'), asChat(ANSWER)) })({ account: fxAccount, text: TEXT })).status).toBe(200);
  });

  it('answers 503 without Workers AI', async () => {
    expect((await route(STAGING, { inference: () => null })({ account: fxAccount, text: TEXT })).status).toBe(503);
  });
});

describe('parseCv', () => {
  it('keeps the retry within the budget, and runs none with too little of it left', async () => {
    let t = 0;
    const timeouts: (number | undefined)[] = [];
    const slow = (ms: number, answer: unknown) => (_input: Record<string, unknown>, call: { timeoutMs?: number }) => {
      timeouts.push(call.timeoutMs);
      t += ms;
      return answer;
    };
    let first = true;
    const retried = await parseCv(
      fakeInference({ 'work-parse': (i: Record<string, unknown>, c: { timeoutMs?: number }) => (first ? ((first = false), slow(30_000, asChat('no'))(i, c)) : slow(5_000, asChat(ANSWER))(i, c)) }),
      TEXT,
      { now: () => t },
    );
    expect(retried.ok).toBe(true);
    expect(timeouts).toEqual([OPS['work-parse'].timeoutMs, PARSE_BUDGET_MS - 30_000]);
    expect(retried.calls.map((c) => [c.ok, c.ms])).toEqual([
      [false, 30_000],
      [true, 5_000],
    ]);

    t = 0;
    timeouts.length = 0;
    const spent = await parseCv(fakeInference({ 'work-parse': slow(PARSE_BUDGET_MS - PARSE_RETRY_MIN_MS + 1, asChat('no')) }), TEXT, { now: () => t });
    expect(spent).toMatchObject({ ok: false, reason: 'shape' });
    expect(timeouts).toHaveLength(1);
  });

  it('does not retry an answer cut at its cap, which a retry would cut again', async () => {
    const calls: FakeCall[] = [];
    const lines: Record<string, unknown>[] = [];
    const cut = { choices: [{ message: { content: '{"name": "Rafael Exemplo", "experience": [{"title": "Eletri' }, finish_reason: 'length' }], usage: { prompt_tokens: 1200, completion_tokens: PARSE_MAX_TOKENS } };
    const out = await parseCv(fakeInference({ 'work-parse': cut }, calls), TEXT, { log: (f) => lines.push(f) });
    expect(out).toMatchObject({ ok: false, reason: 'shape' });
    expect(calls).toHaveLength(1);
    expect(lines).toEqual([{ event: 'work_parse_failed', op: 'work-parse', model: DEEPSEEK, attempt: 1, reason: 'cut' }]);
  });

  it('logs a failed attempt by its code, never by its message', async () => {
    const lines: Record<string, unknown>[] = [];
    const err = new Error(`provider echo: ${TEXT}`);
    const out = await parseCv(fakeInference({ 'work-parse': err }), TEXT, { log: (f) => lines.push(f) });
    expect(out).toMatchObject({ ok: false, reason: 'call_failed' });
    expect(lines).toEqual([
      { event: 'work_parse_failed', op: 'work-parse', model: DEEPSEEK, attempt: 1, reason: 'Error' },
      { event: 'work_parse_failed', op: 'work-parse', model: DEEPSEEK, attempt: 2, reason: 'Error' },
    ]);
  });
});

describe('withoutPlaceholders', () => {
  it("drops an identity value holding one of the strip's placeholders, and nothing else", () => {
    const parsed = readParse(asChat({ ...ANSWER, name: '[PERSON_1]', email: 'contato: [EMAIL_2]', phone: '[BIRTH_DATE]', location: 'Macaé [RJ]' }), now);
    const out = withoutPlaceholders(parsed);
    expect(out.identity).toEqual({ name: null, email: null, phone: null, location: 'Macaé [RJ]' });
    expect(out.dropped).toEqual([
      { path: 'name', reason: 'placeholder' },
      { path: 'email', reason: 'placeholder' },
      { path: 'phone', reason: 'placeholder' },
    ]);
    expect(out.claimed).toBe(parsed.claimed);
    expect(parsed.identity.name).toBe('[PERSON_1]');
  });

  it('knows every placeholder the identity strip writes, so the two cannot drift apart', () => {
    for (const placeholder of [NAME_PLACEHOLDER, BIRTH_DATE_PLACEHOLDER, emailPlaceholder(1), emailPlaceholder(12)]) {
      const parsed = readParse(asChat({ ...ANSWER, name: null, email: placeholder }), now);
      expect(withoutPlaceholders(parsed).identity.email).toBeNull();
    }
    const holder = { firstName: 'Rafael', lastName: 'Exemplo', dateOfBirth: '1990-04-12' };
    const bound = stripIdentity(`${PT.ocr.join('\n')}\nNascimento: 12/04/1990`, holder);
    for (const r of bound.removed) {
      const parsed = readParse(asChat({ ...ANSWER, name: r.placeholder, email: null }), now);
      expect(withoutPlaceholders(parsed).identity.name).toBeNull();
    }
    expect(new Set(bound.removed.map((r) => r.kind))).toEqual(new Set(['name', 'birthDate', 'email']));
  });
});

// ── Zero retention (decision 0021 (h)) ──────────────────────────────────────

interface BindingCall {
  binding: string;
  method: string;
  args: unknown[];
}

/** A binding that records every method called on it and answers from `impl`, else undefined. */
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

/** A console argument as a log line would carry it, an error's name, message, stack and cause included. */
function shown(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack ?? ''}\n${v.cause === undefined ? '' : shown(v.cause)}`;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** The pieces of `secrets` found in `sink`: a secret whole, or any 16-character window of a longer one. */
function leaked(sink: string, secrets: readonly string[], window = 16): string[] {
  const found: string[] = [];
  for (const s of secrets) {
    if (s.length <= window) {
      if (sink.includes(s)) found.push(s);
      continue;
    }
    for (let i = 0; i + window <= s.length; i++) {
      if (sink.includes(s.slice(i, i + window))) {
        found.push(s.slice(i, i + window));
        break;
      }
    }
  }
  return found;
}

/** Every string in a value, at any depth. */
function stringsIn(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(stringsIn);
  if (v && typeof v === 'object') return Object.values(v).flatMap(stringsIn);
  return [];
}

/** The bindings a parse may touch, and how: everything else on the plane must stay untouched. */
const ALLOWED = new Set(['WORK_RL.limit', 'WORK_IP_RL.limit', 'AI_PINS.get', 'AI.run', 'CHAT_USAGE_DO.getByName', 'CHAT_USAGE_DO/*.read', 'CHAT_USAGE_DO/*.record']);
const allowedName = (c: BindingCall) => `${c.binding.replace(/^CHAT_USAGE_DO\/.*/, 'CHAT_USAGE_DO/*')}.${c.method}`;

/** Every binding the plane declares that holds data or reaches another service. */
const STORE_BINDINGS = ['WORK_DB', 'TOKEN_REGISTRY', 'JOBS_LISTINGS', 'LINKS', 'BIND_BUNDLES_DO', 'ACTIVITY_DO', 'POP_REPLAY_DO', 'ATTESTER', 'CHAT_RL', 'CHAT_IP_RL'];

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

describe('zero retention (decision 0021 (h)): the plane keeps and logs nothing of a parse', () => {
  /** A canary in the CV that nothing but the model may receive. */
  const CANARY_TEXT = 'Referência pessoal: Zelda Quixote-Marrow, ramal QX7-4419-ZK';
  const SENT = `${TEXT}\n${CANARY_TEXT}`;
  /** The answer, with a canary of its own in a skill. */
  const REPLY = { ...ANSWER, skills: [...(ANSWER.skills as string[]), 'Canary-Answer-K9P2-Vortex'] };
  const SECRETS = [SENT, ...SENT.split('\n').filter((l) => l.length >= 8), ...stringsIn(REPLY).filter((s) => s.length >= 8)];

  /** Every console line the plane writes, whichever reference to the console it keeps. */
  const sink = { lines: [] as string[] };
  const originals = new Map<(typeof CONSOLE_METHODS)[number], PropertyDescriptor | undefined>();
  let app: { fetch(req: Request, env: unknown, ctx: unknown): Response | Promise<Response> };

  let calls: BindingCall[];
  let lines: string[];
  let fetches: string[];
  let pending: Promise<unknown>[];
  let answer: (input: unknown) => unknown;

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
    lines = sink.lines = [];
    fetches = [];
    pending = [];
    answer = () => asChat(REPLY);
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

  async function serve(body: unknown): Promise<Response> {
    const env: Record<string, unknown> = {
      ENVIRONMENT: 'development',
      BASE_SEPOLIA_RPC_URL: 'http://127.0.0.1:9/never-read',
      AI_GATEWAY_ID: 'cofferdam-strict',
      AI_GATEWAY_DOCUMENTS_ID: 'cofferdam-documents',
      CHAT_MONTHLY_USD_CAP: '0.06',
      AI_MONTHLY_BUDGET_USD: '500',
      AI: recorder('AI', calls, { run: (_model: never, input: never) => answer(input) }),
      AI_PINS: recorder('AI_PINS', calls, { get: async () => null }),
      WORK_RL: recorder('WORK_RL', calls, { limit: async () => ({ success: true }) }),
      WORK_IP_RL: recorder('WORK_IP_RL', calls, { limit: async () => ({ success: true }) }),
      CHAT_USAGE_DO: recorder('CHAT_USAGE_DO', calls, {
        getByName: (name: never) => recorder(`CHAT_USAGE_DO/${String(name)}`, calls, { read: async () => null, record: async () => undefined }),
      }),
      ...Object.fromEntries(STORE_BINDINGS.map((b) => [b, recorder(b, calls)])),
    };
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined, props: {} };
    const req = new Request('https://plane.test/v1/work/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
      body: JSON.stringify(body),
    });
    const res = await app.fetch(req, env as never, ctx as never);
    await Promise.all(pending);
    return res;
  }

  /** Fails on anything outside the model call that carries a piece of the CV or of the answer, and on any store touched. */
  function expectNothingKept() {
    expect(lines.length).toBeGreaterThan(0);
    expect(leaked(lines.join('\n'), SECRETS)).toEqual([]);
    expect(fetches).toEqual([]);
    expect(calls.map(allowedName).filter((n) => !ALLOWED.has(n))).toEqual([]);
    const outsideTheModel = calls.filter((c) => !(c.binding === 'AI' && c.method === 'run'));
    expect(leaked(outsideTheModel.map((c) => shown(c.args)).join('\n'), SECRETS)).toEqual([]);
    for (const c of calls.filter((x) => x.binding === 'AI')) expect(leaked(shown(c.args[2]), SECRETS)).toEqual([]);
  }

  it('answers the parse to the phone, sends the CV to the model through the documents gateway, and keeps nothing', async () => {
    const res = await serve({ account: fxAccount, text: SENT });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { claimed: { skills: { raw: string }[] }; identity: Record<string, unknown> };
    expect(body.identity.name).toBe('Rafael Exemplo');
    expect(body.claimed.skills.map((s) => s.raw)).toContain('Canary-Answer-K9P2-Vortex');

    const run = calls.filter((c) => c.binding === 'AI');
    expect(run).toHaveLength(1);
    expect(run[0]!.args[0]).toBe(DEEPSEEK);
    expect(run[0]!.args[1]).toEqual(parseRequest(DEEPSEEK, { kind: 'text', text: SENT }, { maxTokens: PARSE_MAX_TOKENS }));
    expect(run[0]!.args[2]).toMatchObject({
      tags: ['cofferdam-api', 'op:work-parse'],
      gateway: { id: 'cofferdam-documents', skipCache: true, collectLog: false, metadata: { op: 'work-parse' } },
    });
    // The meter wrote its two rows, numbers and the model's id only (the plane's own clock names the month).
    const records = calls.filter((c) => c.method === 'record');
    expect(records.map((c) => c.binding)).toEqual([`CHAT_USAGE_DO/${fxAccount.toLowerCase()}`, 'CHAT_USAGE_DO/plane:global']);
    for (const r of records) expect(stringsIn(r.args)).toEqual([monthOf(Date.now()), DEEPSEEK]);
    expect(lines.some((l) => l.includes('"event":"work_parse"'))).toBe(true);
    expectNothingKept();
  });

  it('keeps and logs nothing when the model fails with the CV in its error, or echoes it out of shape', async () => {
    answer = () => {
      throw new Error(`upstream refused the request: ${SENT}`, { cause: { body: SENT, reply: REPLY } });
    };
    const failed = await serve({ account: fxAccount, text: SENT });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ ok: false, error: 'parse_failed', reason: 'call_failed' });
    expectNothingKept();

    calls.length = 0;
    lines.length = 0;
    pending.length = 0;
    answer = () => asChat(`I could not fill the schema. The CV said: ${SENT}`);
    const echoed = await serve({ account: fxAccount, text: SENT });
    expect(await echoed.json()).toEqual({ ok: false, error: 'parse_failed', reason: 'shape' });
    expect(calls.filter((c) => c.binding === 'AI')).toHaveLength(2);
    expectNothingKept();
  });

  it('keeps and logs nothing on the authenticated path either (outside development, a session and a remembered authority)', async () => {
    const env: Record<string, unknown> = {
      ...STAGING,
      CHAT_MONTHLY_USD_CAP: '0.06',
      AI_MONTHLY_BUDGET_USD: '500',
      AI: recorder('AI', calls, { run: (_model: never, input: never) => answer(input) }),
      AI_PINS: recorder('AI_PINS', calls, { get: async () => null }),
      WORK_RL: recorder('WORK_RL', calls, { limit: async () => ({ success: true }) }),
      WORK_IP_RL: recorder('WORK_IP_RL', calls, { limit: async () => ({ success: true }) }),
      CHAT_USAGE_DO: recorder('CHAT_USAGE_DO', calls, {
        getByName: (name: never) => recorder(`CHAT_USAGE_DO/${String(name)}`, calls, { read: async () => null, record: async () => undefined }),
      }),
      ...Object.fromEntries(STORE_BINDINGS.map((b) => [b, recorder(b, calls)])),
    };
    // The authority memo's Cache API: a remembered check is the one write this path may make, and it holds no CV.
    const edge = recorder('authority-cache', calls, { match: async () => undefined, put: async () => undefined });
    const h = new Hono();
    h.route(
      '/v1/work',
      createWorkRoutes({
        attestationMaxAgeMs: 3_600_000,
        now: () => now,
        authorityCheck: async () => HIGH,
        authorityMemo: createAuthorityMemo({ edge: edge as Cache, now: () => now }),
        inference: (e) => createInference(e),
      }),
    );
    const res = await h.request(
      '/v1/work/parse',
      { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', ...bearer }, body: JSON.stringify({ account: fxAccount, text: SENT }) },
      env as never,
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.binding === 'authority-cache').map((c) => c.method)).toEqual(['match', 'put']);
    expect(calls.filter((c) => c.method === 'record')).toHaveLength(2);
    expect(calls.filter((c) => c.binding !== 'authority-cache').map(allowedName).filter((n) => !ALLOWED.has(n))).toEqual([]);
    expect(lines.some((l) => l.includes('"event":"work_parse"'))).toBe(true);
    expect(leaked(lines.join('\n'), SECRETS)).toEqual([]);
    expect(fetches).toEqual([]);
    const outsideTheModel = calls.filter((c) => !(c.binding === 'AI' && c.method === 'run'));
    expect(leaked(outsideTheModel.map((c) => shown(c.args)).join('\n'), SECRETS)).toEqual([]);
  });

  it('keeps and logs nothing of a request it refuses', async () => {
    const res = await serve({ account: fxAccount, text: `${SENT}\n${'x'.repeat(MAX_PARSE_TEXT)}` });
    expect(res.status).toBe(413);
    expect(leaked(await res.text(), SECRETS)).toEqual([]);
    expect(calls.filter((c) => c.binding === 'AI')).toEqual([]);
    expectNothingKept();
  });
});
