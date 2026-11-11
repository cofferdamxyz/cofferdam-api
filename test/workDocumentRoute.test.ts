// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `POST /v1/work/document` (workspace decision 0081, item 3; runbook `docs/runbooks/vault-build.md`, step 3): a Vault
 * document's text read into the generic document schema on `work-document`, offline, on a synthetic certificate whose
 * holder's name the phone has already stripped.
 *
 * The schema and the system prompt are pinned by SHA-256: the app's `reading.test.ts` pins the same two hashes, so a
 * change here is a change of what the phone asks, made on both sides in the same pass.
 *
 * Then the zero-retention test of `workParseRoute.test.ts` (decision 0021 (h)) for this route: the whole plane serves a
 * reading, a failed one and a refused one with every binding, the console, `fetch` and the Cache API recorded, and the
 * test fails on any write or log line that carries the request's text or the answer.
 */

import { createHash } from 'node:crypto';

import { Hono } from 'hono';
import { getAddress } from 'viem';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkRoutes, type WorkRouteDeps } from '../src/routes/work.js';
import type { AuthorityCheck } from '../src/services/authorityCheck.js';
import { createAuthorityMemo } from '../src/services/chat/authorityMemo.js';
import { monthOf } from '../src/services/chatUsageStore.js';
import { clearPinCache, createInference, DOCUMENT_OPS, gatewayFor, InferenceTimeout, modelCostMicroUsd, OPS } from '../src/services/inference/index.js';
import {
  DOCUMENT_BUDGET_MS,
  DOCUMENT_JSON_SCHEMA,
  DOCUMENT_MAX_TOKENS,
  DOCUMENT_RETRY_MIN_MS,
  DOCUMENT_SCHEMA,
  DOCUMENT_SYSTEM,
  documentRequest,
  parseDocument,
  readDocument,
  readDocumentBody,
} from '../src/services/work/document.js';
import { estimatedUsage } from '../src/services/work/fields.js';
import { MAX_PARSE_TEXT } from '../src/services/work/parse.js';
import { fakeInference, memoryUsageStore, type FakeCall, type FakeResponses } from './fixtures/work/fakes.js';
import fixtures from './fixtures/sdk-attestations.json';

// src/index.ts exports the Durable Object classes, which extend the runtime's base class.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const DEEPSEEK = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
const fxAccount = fixtures.fields.accountAddress as string;
const issuedAt = fixtures.fields.issuedAt as number;
const now = issuedAt + 5_000;
const month = monthOf(now);
const bearer = { authorization: `Bearer ${fixtures.p256.token}` };
const HIGH: AuthorityCheck = { status: 'active', authorityId: 0, module: fxAccount as `0x${string}`, tier: 3 };
const STAGING = { ENVIRONMENT: 'staging', AI_GATEWAY_ID: 'cofferdam-strict', AI_GATEWAY_DOCUMENTS_ID: 'cofferdam-documents' };

/** A synthetic pt-BR certificate as the phone sends it for a bound account: the holder's name already a placeholder. */
const TEXT = [
  'SENAI — Serviço Nacional de Aprendizagem Industrial',
  'CERTIFICADO DE CONCLUSÃO',
  'Certificamos que [PERSON_1] concluiu com aproveitamento o curso',
  'NR-10 Segurança em Instalações e Serviços em Eletricidade — Básico',
  'Carga horária: 40 horas',
  'Concluído em 15/03/2025. Válido até 15/03/2027.',
  'Certificado nº SN-2025-004417',
  'Conforme a Norma Regulamentadora NR-10 do Ministério do Trabalho',
].join('\n');

/** What a perfect reader answers for the certificate, in the schema's key order. */
const ANSWER = {
  document_type: 'certificate',
  title: 'NR-10 Segurança em Instalações e Serviços em Eletricidade — Básico',
  issuer: 'SENAI',
  hours: 40,
  completed_on: '2025-03-15',
  valid_until: '2027-03-15',
  document_number: 'SN-2025-004417',
  standard: 'NR-10',
  holder_present: true,
};

/** DeepSeek's answer as Workers AI returns it under the OpenAI JSON-schema wrapper. */
const asChat = (o: unknown, usage = { prompt_tokens: 400, completion_tokens: 90 }) => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(o) } }], usage });

function route(env: Record<string, unknown>, deps: Partial<WorkRouteDeps> = {}, responses: FakeResponses = {}, calls: FakeCall[] = []) {
  const h = new Hono();
  h.route(
    '/v1/work',
    createWorkRoutes({
      attestationMaxAgeMs: 3_600_000,
      now: () => now,
      authorityCheck: async () => HIGH,
      authorityMemo: createAuthorityMemo({ edge: null }),
      inference: () => fakeInference({ 'work-document': asChat(ANSWER), ...responses }, calls),
      ...deps,
    }),
  );
  return (body: unknown, headers: Record<string, string> = bearer) =>
    h.request('/v1/work/document', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, env as never);
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

/** The console lines a block writes, parsed when they are JSON. */
async function logged(run: () => unknown): Promise<Record<string, unknown>[]> {
  const lines: Record<string, unknown>[] = [];
  // Swapped by hand, not with vi.spyOn: a spy would be restored again by the zero-retention block's restoreAllMocks,
  // taking back the console wrapper that block installs.
  const original = console.log;
  console.log = (line: unknown) => {
    try {
      lines.push(JSON.parse(String(line)) as Record<string, unknown>);
    } catch {
      // Hono's request logger and other plain lines are not the route's.
    }
  };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines;
}

describe('the document reading the phone and the plane share', () => {
  it('pins the schema and the system prompt by SHA-256, the hashes the app pins (reading.test.ts)', () => {
    expect(sha256(JSON.stringify(DOCUMENT_JSON_SCHEMA))).toBe('817ec91e26f1c3dc24798059bf935045b7e90539f14b23ee7058aa00fbc8f317');
    expect(sha256(DOCUMENT_SYSTEM)).toBe('ccf70409f88da2a1be0ff534bbd2f7e3c02ceb8c680cc4f57b58b1ecfb08defa');
    expect(DOCUMENT_JSON_SCHEMA.properties.document_type.enum).toEqual(['cv', 'certificate', 'licence', 'passport', 'other']);
    expect(DOCUMENT_JSON_SCHEMA.required).toEqual(Object.keys(DOCUMENT_JSON_SCHEMA.properties));
    expect(DOCUMENT_MAX_TOKENS).toBe(512);
  });

  it('routes work-document through the documents gateway, never the strict one, whose DLP would block a document number', () => {
    expect(DOCUMENT_OPS.has('work-document')).toBe(true);
    expect(gatewayFor(STAGING, 'work-document')).toBe('cofferdam-documents');
    expect(OPS['work-document']).toEqual({ model: DEEPSEEK, envVar: 'WORK_DOCUMENT_MODEL', timeoutMs: 30_000 });
  });

  it('asks with the text as the only user content, no prefix, strict JSON schema, temperature 0 and thinking off', () => {
    expect(documentRequest(DEEPSEEK, TEXT)).toEqual({
      messages: [
        { role: 'system', content: DOCUMENT_SYSTEM },
        { role: 'user', content: TEXT },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'cofferdam_document', schema: DOCUMENT_JSON_SCHEMA, strict: true } },
      temperature: 0,
      max_tokens: DOCUMENT_MAX_TOKENS,
      reasoning_effort: 'none',
    });
  });

  it("reads an answer of the schema's shape, in its key order, and refuses any other whole", () => {
    expect(readDocument(asChat(ANSWER))).toEqual(ANSWER);
    expect(Object.keys(readDocument(asChat({ ...ANSWER, holder_present: false, document_type: 'passport' })))).toEqual(DOCUMENT_JSON_SCHEMA.required);
    const reordered = Object.fromEntries(Object.entries(ANSWER).reverse());
    expect(Object.keys(readDocument(asChat(reordered)))).toEqual(DOCUMENT_JSON_SCHEMA.required);
    const { standard: _standard, ...missing } = ANSWER;
    for (const bad of [
      { ...ANSWER, document_type: 'pasport' },
      { ...ANSWER, document_type: 'id' },
      { ...ANSWER, holder_name: 'Rafael Exemplo' },
      missing,
      { ...ANSWER, hours: 40.5 },
      { ...ANSWER, hours: '40' },
      { ...ANSWER, holder_present: 'yes' },
      { ...ANSWER, title: ['NR-10'] },
      ['not', 'an', 'object'],
    ]) {
      expect(() => readDocument(asChat(bad))).toThrow(/out of shape/);
    }
    expect(() => readDocument(asChat('Here is the document.'))).toThrow(/no JSON object/);
  });
});

describe('POST /v1/work/document', () => {
  it("reads the document's text into a cofferdam.document.v1, in one work-document call", async () => {
    const calls: FakeCall[] = [];
    const res = await route(STAGING, {}, {}, calls)({ account: fxAccount, text: TEXT });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['ok', 'schema', 'document', 'dropped', 'provenance']);
    expect(body).toEqual({
      ok: true,
      schema: DOCUMENT_SCHEMA,
      document: ANSWER,
      dropped: [],
      provenance: { executor: 'cloud', models: [DEEPSEEK], parsedAt: new Date(now).toISOString() },
    });
    expect(DOCUMENT_SCHEMA).toBe('cofferdam.document.v1');
    expect(calls.map((c) => c.op)).toEqual(['work-document']);
    expect(calls[0]!.input).toEqual(documentRequest(DEEPSEEK, TEXT));
    expect((calls[0]!.input.messages as { role: string; content: unknown }[])[1]).toEqual({ role: 'user', content: TEXT });
  });

  it('takes the text only: another key, a missing, blank or non-string text, never echoed; too long names the limit', async () => {
    const calls: FakeCall[] = [];
    const post = route(STAGING, {}, {}, calls);
    const page = { mime: 'image/jpeg', base64: '/9j/4AAQSkZJRg' };
    for (const body of [
      { account: fxAccount, text: TEXT, pages: [page] },
      { account: fxAccount, text: TEXT, kind: 'certificate' },
      { account: fxAccount, pages: [page] },
      { account: fxAccount },
      { account: fxAccount, text: ' \n\t ' },
      { account: fxAccount, text: [TEXT] },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      const answer = await res.text();
      expect(JSON.parse(answer)).toMatchObject({ ok: false, error: 'bad_request' });
      expect(answer).not.toContain('SN-2025');
    }
    const long = await post({ account: fxAccount, text: `${TEXT}\n${'x'.repeat(MAX_PARSE_TEXT)}` });
    expect(long.status).toBe(413);
    expect(await long.json()).toEqual({ ok: false, error: 'text_too_long', max: MAX_PARSE_TEXT });
    expect(calls).toEqual([]);
    expect((await post({ account: fxAccount, text: 'x'.repeat(MAX_PARSE_TEXT) })).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(readDocumentBody({ account: fxAccount, text: TEXT })).toEqual({ ok: true, text: TEXT });
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
    const calls: FakeCall[] = [];
    expect(await (await route(STAGING, {}, {}, calls)({ account: fxAccount, text: TEXT }, {})).json()).toMatchObject({ error: 'attestation_required' });
    expect((await route(STAGING, { authorityCheck: async () => ({ ...HIGH, tier: 1 }) }, {}, calls)({ account: fxAccount, text: TEXT })).status).toBe(401);
    expect((await route(STAGING, {}, {}, calls)({ account: '0x' + '12'.repeat(20), text: TEXT })).status).toBe(401);
    expect(calls).toEqual([]);
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
    const offEnum = asChat({ ...ANSWER, document_type: 'diploma' }, { prompt_tokens: 400, completion_tokens: 30 });
    const res = await route(STAGING, { usageStore: () => store }, { 'work-document': inTurn(offEnum, asChat(ANSWER)) }, calls)({ account: fxAccount, text: TEXT });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { document: unknown }).document).toEqual(ANSWER);
    expect(calls.map((c) => c.op)).toEqual(['work-document', 'work-document']);
    await new Promise((r) => setTimeout(r, 0));
    const cost = modelCostMicroUsd(DEEPSEEK, 400, 30) + modelCostMicroUsd(DEEPSEEK, 400, 90);
    expect(recorded.map((r) => r.account)).toEqual([getAddress(fxAccount), 'global']);
    for (const r of recorded) expect(r.delta).toEqual({ turns: 0, tokensIn: 800, tokensOut: 120, routerCalls: 0, estimatedMicroUsd: cost, model: DEEPSEEK, modelMicroUsd: cost, at: now });
  });

  it('answers 502 document_failed with its reason, meters what failed, and never retries a timeout', async () => {
    const twice = memoryUsageStore();
    const calls: FakeCall[] = [];
    const down = await route(STAGING, { usageStore: () => twice.store }, { 'work-document': new Error('upstream down') }, calls)({ account: fxAccount, text: TEXT });
    expect(down.status).toBe(502);
    expect(await down.json()).toEqual({ ok: false, error: 'document_failed', reason: 'call_failed' });
    expect(calls).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 0));
    const thrown = estimatedUsage(documentRequest(DEEPSEEK, TEXT)).tokensIn;
    expect(twice.recorded.map((r) => [r.account, r.delta.tokensIn])).toEqual([
      [getAddress(fxAccount), 2 * thrown],
      ['global', 2 * thrown],
    ]);

    const late: FakeCall[] = [];
    const timeout = await route(STAGING, {}, { 'work-document': new InferenceTimeout('work-document', OPS['work-document'].timeoutMs) }, late)({ account: fxAccount, text: TEXT });
    expect(timeout.status).toBe(502);
    expect(await timeout.json()).toEqual({ ok: false, error: 'document_failed', reason: 'timeout' });
    expect(late).toHaveLength(1);

    const shapeless: FakeCall[] = [];
    const shape = await route(STAGING, {}, { 'work-document': asChat({ ...ANSWER, holder_name: 'Rafael Exemplo' }) }, shapeless)({ account: fxAccount, text: TEXT });
    expect(await shape.json()).toEqual({ ok: false, error: 'document_failed', reason: 'shape' });
    expect(shapeless).toHaveLength(2);

    expect((await route(STAGING, {}, { 'work-document': inTurn(new Error('blip'), asChat(ANSWER)) })({ account: fxAccount, text: TEXT })).status).toBe(200);
  });

  it('logs one work_document line of sizes and a reason code, and nothing else', async () => {
    const ok = await logged(() => route(STAGING)({ account: fxAccount, text: TEXT }));
    const okLines = ok.filter((l) => l.event === 'work_document');
    expect(okLines).toEqual([{ event: 'work_document', chars: TEXT.length, tokens_in: 400, tokens_out: 90, dropped: 0, reason: null }]);

    const failed = await logged(() => route(STAGING, {}, { 'work-document': new Error(`provider echo: ${TEXT}`) })({ account: fxAccount, text: TEXT }));
    const line = failed.filter((l) => l.event === 'work_document');
    expect(line).toHaveLength(1);
    expect(Object.keys(line[0]!)).toEqual(['event', 'chars', 'tokens_in', 'tokens_out', 'dropped', 'reason']);
    expect(line[0]!.reason).toBe('call_failed');
    expect(failed.filter((l) => l.event === 'work_document_failed').map((l) => l.reason)).toEqual(['Error', 'Error']);
    expect(JSON.stringify(failed)).not.toContain('SN-2025');
    expect(JSON.stringify(failed)).not.toContain(fxAccount.toLowerCase().slice(2, 18));
  });

  it('answers 503 without Workers AI', async () => {
    expect((await route(STAGING, { inference: () => null })({ account: fxAccount, text: TEXT })).status).toBe(503);
  });
});

describe('parseDocument', () => {
  it('keeps the retry within the 40 s budget, and runs none with too little of it left', async () => {
    let t = 0;
    const timeouts: (number | undefined)[] = [];
    const slow = (ms: number, answer: unknown) => (_input: Record<string, unknown>, call: { timeoutMs?: number }) => {
      timeouts.push(call.timeoutMs);
      t += ms;
      return answer;
    };
    let first = true;
    const retried = await parseDocument(
      fakeInference({ 'work-document': (i: Record<string, unknown>, c: { timeoutMs?: number }) => (first ? ((first = false), slow(20_000, asChat('no'))(i, c)) : slow(3_000, asChat(ANSWER))(i, c)) }),
      TEXT,
      { now: () => t },
    );
    expect(retried.ok).toBe(true);
    expect(DOCUMENT_BUDGET_MS).toBe(40_000);
    expect(timeouts).toEqual([OPS['work-document'].timeoutMs, DOCUMENT_BUDGET_MS - 20_000]);
    expect(retried.calls.map((c) => [c.ok, c.ms])).toEqual([
      [false, 20_000],
      [true, 3_000],
    ]);

    t = 0;
    timeouts.length = 0;
    const spent = await parseDocument(fakeInference({ 'work-document': slow(DOCUMENT_BUDGET_MS - DOCUMENT_RETRY_MIN_MS + 1, asChat('no')) }), TEXT, { now: () => t });
    expect(spent).toMatchObject({ ok: false, reason: 'shape' });
    expect(timeouts).toHaveLength(1);
  });

  it('does not retry an answer cut at its cap, which a retry would cut again', async () => {
    const calls: FakeCall[] = [];
    const lines: Record<string, unknown>[] = [];
    const cut = { choices: [{ message: { content: '{"document_type": "certificate", "title": "NR-1' }, finish_reason: 'length' }], usage: { prompt_tokens: 400, completion_tokens: DOCUMENT_MAX_TOKENS } };
    const out = await parseDocument(fakeInference({ 'work-document': cut }, calls), TEXT, { log: (f) => lines.push(f) });
    expect(out).toMatchObject({ ok: false, reason: 'shape' });
    expect(calls).toHaveLength(1);
    expect(lines).toEqual([{ event: 'work_document_failed', op: 'work-document', model: DEEPSEEK, attempt: 1, reason: 'cut' }]);
  });

  it('logs a failed attempt by its code, never by its message', async () => {
    const lines: Record<string, unknown>[] = [];
    const out = await parseDocument(fakeInference({ 'work-document': new Error(`provider echo: ${TEXT}`) }), TEXT, { log: (f) => lines.push(f) });
    expect(out).toMatchObject({ ok: false, reason: 'call_failed' });
    expect(lines).toEqual([
      { event: 'work_document_failed', op: 'work-document', model: DEEPSEEK, attempt: 1, reason: 'Error' },
      { event: 'work_document_failed', op: 'work-document', model: DEEPSEEK, attempt: 2, reason: 'Error' },
    ]);
  });
});

// ── Zero retention (decision 0021 (h), for a Vault document) ────────────────

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

/** The bindings a document reading may touch, and how: everything else on the plane must stay untouched. */
const ALLOWED = new Set(['WORK_RL.limit', 'WORK_IP_RL.limit', 'AI_PINS.get', 'AI.run', 'CHAT_USAGE_DO.getByName', 'CHAT_USAGE_DO/*.read', 'CHAT_USAGE_DO/*.record']);
const allowedName = (c: BindingCall) => `${c.binding.replace(/^CHAT_USAGE_DO\/.*/, 'CHAT_USAGE_DO/*')}.${c.method}`;

/** Every binding the plane declares that holds data or reaches another service (`workParseRoute.test.ts`'s list, the Vault's bucket and limits included). */
const STORE_BINDINGS = ['WORK_DB', 'TOKEN_REGISTRY', 'JOBS_LISTINGS', 'LINKS', 'BIND_BUNDLES_DO', 'ACTIVITY_DO', 'POP_REPLAY_DO', 'ATTESTER', 'CHAT_RL', 'CHAT_IP_RL', 'VAULT', 'VAULT_GLOBAL_RL', 'VAULT_RL', 'VAULT_IP_RL'];

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

describe('zero retention (decision 0021 (h)): the plane keeps and logs nothing of a document reading', () => {
  /** A canary in the document that nothing but the model may receive. */
  const CANARY_TEXT = 'Registro do instrutor: Zelda Quixote-Marrow, matrícula QX7-4419-ZK';
  const SENT = `${TEXT}\n${CANARY_TEXT}`;
  /** The answer, with a canary of its own in its title and its number. */
  const REPLY = { ...ANSWER, title: 'Canary-Answer-K9P2-Vortex NR-10', document_number: 'CANARY-NUM-77X1-QQ' };
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
    const req = new Request('https://plane.test/v1/work/document', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
      body: JSON.stringify(body),
    });
    const res = await app.fetch(req, env as never, ctx as never);
    await Promise.all(pending);
    return res;
  }

  /** Fails on anything outside the model call that carries a piece of the document or of the answer, and on any store touched. */
  function expectNothingKept() {
    expect(lines.length).toBeGreaterThan(0);
    expect(leaked(lines.join('\n'), SECRETS)).toEqual([]);
    expect(fetches).toEqual([]);
    expect(calls.map(allowedName).filter((n) => !ALLOWED.has(n))).toEqual([]);
    const outsideTheModel = calls.filter((c) => !(c.binding === 'AI' && c.method === 'run'));
    expect(leaked(outsideTheModel.map((c) => shown(c.args)).join('\n'), SECRETS)).toEqual([]);
    for (const c of calls.filter((x) => x.binding === 'AI')) expect(leaked(shown(c.args[2]), SECRETS)).toEqual([]);
  }

  it('answers the reading to the phone, sends the text to the model through the documents gateway, and keeps nothing', async () => {
    const res = await serve({ account: fxAccount, text: SENT });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { document: Record<string, unknown> };
    expect(body.document).toEqual(REPLY);

    const run = calls.filter((c) => c.binding === 'AI');
    expect(run).toHaveLength(1);
    expect(run[0]!.args[0]).toBe(DEEPSEEK);
    expect(run[0]!.args[1]).toEqual(documentRequest(DEEPSEEK, SENT));
    expect(run[0]!.args[2]).toMatchObject({
      tags: ['cofferdam-api', 'op:work-document'],
      gateway: { id: 'cofferdam-documents', skipCache: true, collectLog: false, metadata: { op: 'work-document' } },
    });
    // The meter wrote its two rows, numbers and the model's id only (the plane's own clock names the month).
    const records = calls.filter((c) => c.method === 'record');
    expect(records.map((c) => c.binding)).toEqual([`CHAT_USAGE_DO/${fxAccount.toLowerCase()}`, 'CHAT_USAGE_DO/plane:global']);
    for (const r of records) expect(stringsIn(r.args)).toEqual([monthOf(Date.now()), DEEPSEEK]);
    const line = lines.filter((l) => l.includes('"event":"work_document"'));
    expect(line).toHaveLength(1);
    expect(Object.keys(JSON.parse(line[0]!) as object)).toEqual(['event', 'chars', 'tokens_in', 'tokens_out', 'dropped', 'reason']);
    expect(line[0]).not.toContain(fxAccount.toLowerCase().slice(2));
    expectNothingKept();
  });

  it('keeps and logs nothing when the model fails with the document in its error, or echoes it out of shape', async () => {
    answer = () => {
      throw new Error(`upstream refused the request: ${SENT}`, { cause: { body: SENT, reply: REPLY } });
    };
    const failed = await serve({ account: fxAccount, text: SENT });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ ok: false, error: 'document_failed', reason: 'call_failed' });
    expectNothingKept();

    calls.length = 0;
    lines.length = 0;
    pending.length = 0;
    answer = () => asChat(`I could not fill the schema. The document said: ${SENT}`);
    const echoed = await serve({ account: fxAccount, text: SENT });
    expect(await echoed.json()).toEqual({ ok: false, error: 'document_failed', reason: 'shape' });
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
    // The authority memo's Cache API: a remembered check is the one write this path may make, and it holds no document.
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
      '/v1/work/document',
      { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7', ...bearer }, body: JSON.stringify({ account: fxAccount, text: SENT }) },
      env as never,
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((c) => c.binding === 'authority-cache').map((c) => c.method)).toEqual(['match', 'put']);
    expect(calls.filter((c) => c.method === 'record')).toHaveLength(2);
    expect(calls.filter((c) => c.binding !== 'authority-cache').map(allowedName).filter((n) => !ALLOWED.has(n))).toEqual([]);
    expect(calls.filter((c) => c.binding === 'AI')[0]!.args[2]).toMatchObject({ gateway: { id: 'cofferdam-documents' } });
    expect(lines.some((l) => l.includes('"event":"work_document"'))).toBe(true);
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
