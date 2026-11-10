// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  aiOptions,
  clearPinCache,
  createInference,
  DOCUMENT_OPS,
  gatewayFor,
  InferenceTimeout,
  OPS,
  resolveModel,
  type AiBinding,
  type InferenceEnv,
  type InferenceOp,
} from '../src/services/inference/index.js';
import { CLIENT_EMBED_MODELS, EMBED_DIMS_BY_MODEL, EMBEDDINGGEMMA_2_LITERT } from '../src/services/work/registry.js';

function kv(values: Record<string, string>, reads: string[] = []): KVNamespace {
  return {
    async get(key: string) {
      reads.push(key);
      const v = values[key];
      if (v === '__throw__') throw new Error('kv down');
      return v ?? null;
    },
  } as unknown as KVNamespace;
}

interface AiCall {
  model: string;
  input: Record<string, unknown>;
  options: Record<string, unknown>;
}

function fakeAi(answer: (call: AiCall) => unknown, calls: AiCall[] = []): AiBinding {
  return {
    run: (async (model: string, input: Record<string, unknown>, options: Record<string, unknown>) => {
      const call = { model, input, options };
      calls.push(call);
      return answer(call);
    }) as unknown as AiBinding['run'],
  };
}

beforeEach(() => clearPinCache());

describe('resolveModel', () => {
  it('reads the KV pin, then the variable, then the default', async () => {
    expect(await resolveModel({}, 'chat-answer')).toBe(OPS['chat-answer'].model);
    expect(await resolveModel({ CHAT_ANSWER_MODEL: '@cf/x/env' }, 'chat-answer')).toBe('@cf/x/env');
    clearPinCache();
    const env: InferenceEnv = { CHAT_ANSWER_MODEL: '@cf/x/env', AI_PINS: kv({ 'model:chat-answer': ' @cf/x/kv ' }) };
    expect(await resolveModel(env, 'chat-answer')).toBe('@cf/x/kv');
  });

  it('keeps a pin for a minute, and falls back when KV fails', async () => {
    const reads: string[] = [];
    const env: InferenceEnv = { AI_PINS: kv({ 'model:chat-router': '@cf/cloudflare/clef' }, reads) };
    expect(await resolveModel(env, 'chat-router', 0)).toBe('@cf/cloudflare/clef');
    expect(await resolveModel(env, 'chat-router', 59_000)).toBe('@cf/cloudflare/clef');
    expect(reads).toHaveLength(1);
    await resolveModel(env, 'chat-router', 61_000);
    expect(reads).toHaveLength(2);

    clearPinCache();
    const broken: InferenceEnv = { CHAT_ROUTER_MODEL: '@cf/x/env', AI_PINS: kv({ 'model:chat-router': '__throw__' }) };
    expect(await resolveModel(broken, 'chat-router')).toBe('@cf/x/env');
  });
});

describe('aiOptions', () => {
  it('tags every call with its op and keeps no gateway log', () => {
    const signal = new AbortController().signal;
    expect(aiOptions({}, 'chat-router', signal)).toEqual({ tags: ['cofferdam-api', 'op:chat-router'], signal });
    expect(aiOptions({ AI_GATEWAY_ID: 'cofferdam-strict' }, 'chat-long', signal)).toMatchObject({
      tags: ['cofferdam-api', 'op:chat-long'],
      gateway: { id: 'cofferdam-strict', skipCache: true, collectLog: false, metadata: { op: 'chat-long' } },
    });
  });

  it('sends a document op through the documents gateway when set, and every op through a gateway that keeps no log and no cache', () => {
    const signal = new AbortController().signal;
    const env = { AI_GATEWAY_ID: 'cofferdam-strict', AI_GATEWAY_DOCUMENTS_ID: 'cofferdam-documents' };
    expect(gatewayFor(env, 'work-parse')).toBe('cofferdam-documents');
    expect(gatewayFor(env, 'chat-answer')).toBe('cofferdam-strict');
    expect(gatewayFor({ AI_GATEWAY_ID: 'cofferdam-strict' }, 'work-parse')).toBe('cofferdam-strict');
    expect(gatewayFor({}, 'work-parse')).toBeNull();
    expect(DOCUMENT_OPS.has('work-parse')).toBe(true);
    // A Vault document's reading carries the document's own number, which the strict gateway's DLP would block.
    expect(DOCUMENT_OPS.has('work-document')).toBe(true);
    expect(gatewayFor(env, 'work-document')).toBe('cofferdam-documents');
    expect(DOCUMENT_OPS.has('work-extract')).toBe(false);
    for (const op of Object.keys(OPS) as InferenceOp[]) {
      const options = aiOptions(env, op, signal) as { gateway: { id: string; skipCache: boolean; collectLog: boolean; metadata: Record<string, unknown> } };
      expect(options.gateway.id).toBe(DOCUMENT_OPS.has(op) ? 'cofferdam-documents' : 'cofferdam-strict');
      expect(options.gateway.skipCache).toBe(true);
      expect(options.gateway.collectLog).toBe(false);
      // The metadata names the op only: never an account, a pseudonym or any text.
      expect(Object.keys(options.gateway.metadata)).toEqual(['op']);
    }
  });

  it('uses only characters Workers AI allows in tags', () => {
    for (const op of Object.keys(OPS)) expect(`op:${op}`).toMatch(/^[A-Za-z0-9:\-./@]{1,50}$/);
  });
});

describe('createInference', () => {
  it('is null without Workers AI', () => {
    expect(createInference({})).toBeNull();
  });

  it('runs the pinned model with the op options', async () => {
    const calls: AiCall[] = [];
    const inference = createInference({ CHAT_ACTION_MODEL: '@cf/x/act' }, { ai: fakeAi(() => ({ ok: true }), calls) })!;
    expect(await inference.run('chat-action', { messages: [] })).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ model: '@cf/x/act', input: { messages: [] }, options: { tags: ['cofferdam-api', 'op:chat-action'] } });
    expect(await inference.model('chat-action')).toBe('@cf/x/act');
  });

  it('times out a call that never answers and aborts it', async () => {
    const calls: AiCall[] = [];
    const ai = fakeAi(() => new Promise(() => {}), calls);
    const inference = createInference({}, { ai })!;
    const original = OPS['chat-router'].timeoutMs;
    OPS['chat-router'].timeoutMs = 20;
    try {
      await expect(inference.run('chat-router', {})).rejects.toBeInstanceOf(InferenceTimeout);
      expect((calls[0]!.options.signal as AbortSignal).aborted).toBe(true);
    } finally {
      OPS['chat-router'].timeoutMs = original;
    }
  });

  it('lets a call override the op timeout', async () => {
    const calls: AiCall[] = [];
    const inference = createInference({}, { ai: fakeAi(() => new Promise(() => {}), calls) })!;
    const t = Date.now();
    await expect(inference.run('chat-router', {}, { timeoutMs: 20 })).rejects.toMatchObject({ ms: 20 });
    expect(Date.now() - t).toBeLessThan(2_000);
  });

  it("passes the caller's cancel through, after the call has answered too", async () => {
    const calls: AiCall[] = [];
    const inference = createInference({}, { ai: fakeAi(() => 'stream', calls) })!;
    const ctl = new AbortController();
    await inference.run('chat-answer', {}, { signal: ctl.signal });
    const signal = calls[0]!.options.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    ctl.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe("the v2 generation's pin (workspace decision 0068)", () => {
  it("names one model in wrangler.jsonc's var and the seam's default, the LiteRT-LM file the v2 indexes hold, at 768", () => {
    const text = readFileSync(join(__dirname, '..', 'wrangler.jsonc'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,(\s*[}\]])/g, '$1');
    const config = JSON.parse(text) as { vars: Record<string, string>; vectorize: { binding: string; index_name: string }[] };
    expect(config.vars.WORK_EMBED_MODEL).toBe(EMBEDDINGGEMMA_2_LITERT);
    expect(OPS['work-embed'].model).toBe(EMBEDDINGGEMMA_2_LITERT);
    expect(CLIENT_EMBED_MODELS.has(EMBEDDINGGEMMA_2_LITERT)).toBe(true);
    expect(EMBED_DIMS_BY_MODEL[EMBEDDINGGEMMA_2_LITERT]).toBe(768);
    expect(Object.fromEntries(config.vectorize.map((v) => [v.binding, v.index_name]))).toEqual({ TOKEN_REGISTRY: 'token-registry-v2', JOBS_LISTINGS: 'jobs-listings-v2' });
  });
});

describe('the seam is the only way to Workers AI', () => {
  it('no source file outside services/inference touches env.AI', () => {
    const root = join(__dirname, '..', 'src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) files.push(path);
      }
    };
    walk(root);
    const offenders = files
      .filter((f) => !relative(root, f).startsWith(join('services', 'inference')))
      .filter((f) => /\benv\.AI\b(?!_)|\bAI\.run\(/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(root, f))).toEqual([]);
  });
});
