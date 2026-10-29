// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../src/env.js';
import { clearTransparencyCache, configuredGateways, gatewayFacts, privacyRoutes, readAiGateways, transparencyAnswer } from '../src/routes/privacy.js';

const strict = { id: 'cofferdam-strict', collect_logs: false, cache_ttl: 0, logpush: false, otel: [], authentication: true, dlp: { enabled: true, policies: [{ id: 'pol', enabled: true, action: 'BLOCK', check: ['REQUEST'], profiles: ['p1', 'p2'] }] } };
const documents = { id: 'cofferdam-documents', collect_logs: false, cache_ttl: 0, authentication: true, dlp: { enabled: false } };

function env(over: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'staging',
    AI_GATEWAY_ID: 'cofferdam-strict',
    AI_GATEWAY_DOCUMENTS_ID: 'cofferdam-documents',
    AI_GATEWAY_READ_TOKEN: 'read-token',
    AI_GATEWAY_ACCOUNT_ID: 'acct',
    CF_VERSION_METADATA: { id: 'v-123', tag: '', timestamp: '' } as WorkerVersionMetadata,
    ...over,
  } as unknown as Env;
}

/** Cloudflare's API as the route reads it: a gateway by id, or a status. */
function fakeApi(gateways: Record<string, unknown>, calls: { url: string; auth: string | null }[] = [], status = 200) {
  return async (input: string, init: RequestInit): Promise<Response> => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url: input, auth: headers.Authorization ?? null });
    if (status !== 200) return new Response('', { status });
    const id = decodeURIComponent(input.split('/').pop()!);
    const g = gateways[id];
    return g ? Response.json({ success: true, result: g }) : new Response('', { status: 404 });
  };
}

beforeEach(() => clearTransparencyCache());

describe('the transparency answer', () => {
  it('reads each configured gateway with the read token and says whether it can store', async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const read = await readAiGateways(env(), fakeApi({ 'cofferdam-strict': strict, 'cofferdam-documents': documents }, calls));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.cloudflare.com/client/v4/accounts/acct/ai-gateway/gateways/cofferdam-strict',
      'https://api.cloudflare.com/client/v4/accounts/acct/ai-gateway/gateways/cofferdam-documents',
    ]);
    expect(calls.every((c) => c.auth === 'Bearer read-token')).toBe(true);
    expect(read.facts.map((f) => f.canStore)).toEqual([false, false]);
    expect(read.facts.map((f) => f.authenticated)).toEqual([true, true]);
    expect(read.facts[0]!.dlp).toEqual({ enabled: true, action: 'BLOCK', profiles: 2, check: ['REQUEST'] });
    expect(read.facts[1]!.dlp).toEqual({ enabled: false, action: null, profiles: 0, check: null });
    const answer = transparencyAnswer(env(), read.facts, 0);
    expect(answer.noGatewayCanStore).toBe(true);
    expect(answer.plane.version).toBe('v-123');
    expect(answer.commitments.workersAi.retainsInputsOrOutputs).toBe(false);
  });

  it('calls a gateway that logs, caches, pushes or exports one that can store', () => {
    expect(gatewayFacts('g', 'x', { ...documents, collect_logs: true }).canStore).toBe(true);
    expect(gatewayFacts('g', 'x', { ...documents, cache_ttl: 60 }).canStore).toBe(true);
    expect(gatewayFacts('g', 'x', { ...documents, logpush: true }).canStore).toBe(true);
    expect(gatewayFacts('g', 'x', { ...documents, otel: [{ url: 'https://x' }] }).canStore).toBe(true);
    expect(gatewayFacts('g', 'x', documents).canStore).toBe(false);
  });

  it('reads the legacy DLP form, which states no check side', () => {
    expect(gatewayFacts('g', 'x', { ...documents, dlp: { enabled: true, action: 'BLOCK', profiles: ['p1'] } }).dlp).toEqual({ enabled: true, action: 'BLOCK', profiles: 1, check: null });
  });

  it('reads whether a gateway accepts only requests authorized in the account', () => {
    expect(gatewayFacts('g', 'x', documents).authenticated).toBe(true);
    expect(gatewayFacts('g', 'x', { ...documents, authentication: false }).authenticated).toBe(false);
    expect(gatewayFacts('g', 'x', { id: 'g' }).authenticated).toBe(false);
  });

  it('lists one gateway when both ids are the same, none when unset', () => {
    expect(configuredGateways({ AI_GATEWAY_ID: 'g', AI_GATEWAY_DOCUMENTS_ID: 'g' })).toHaveLength(1);
    expect(configuredGateways({})).toEqual([]);
  });

  it('is unprovisioned without the secrets or a gateway, and unavailable when the API refuses', async () => {
    expect(await readAiGateways(env({ AI_GATEWAY_READ_TOKEN: undefined }), fakeApi({}))).toEqual({ ok: false, error: 'unprovisioned' });
    expect(await readAiGateways(env({ AI_GATEWAY_ID: undefined, AI_GATEWAY_DOCUMENTS_ID: undefined }), fakeApi({}))).toEqual({ ok: false, error: 'unprovisioned' });
    expect(await readAiGateways(env(), fakeApi({}, [], 403))).toEqual({ ok: false, error: 'unavailable', status: 403 });
  });
});

describe('GET /v1/privacy/ai', () => {
  it('answers 503 without the secrets and never reads the request beyond its path', async () => {
    const res = await privacyRoutes.request('/ai', { method: 'GET' }, env({ AI_GATEWAY_READ_TOKEN: undefined }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'transparency_unprovisioned' });
  });

  it('serves the live facts with a five-minute cache', async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = fakeApi({ 'cofferdam-strict': strict, 'cofferdam-documents': documents }, calls) as unknown as typeof fetch;
    try {
      const res = await privacyRoutes.request('/ai', { method: 'GET' }, env());
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
      const body = (await res.json()) as { noGatewayCanStore: boolean; gateways: { id: string }[] };
      expect(body.noGatewayCanStore).toBe(true);
      expect(body.gateways.map((g) => g.id)).toEqual(['cofferdam-strict', 'cofferdam-documents']);
      const again = await privacyRoutes.request('/ai', { method: 'GET' }, env());
      expect(again.status).toBe(200);
      expect(calls).toHaveLength(2);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('answers 502 with the status only when Cloudflare cannot be read', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = fakeApi({}, [], 500) as unknown as typeof fetch;
    try {
      const res = await privacyRoutes.request('/ai', { method: 'GET' }, env());
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ ok: false, error: 'transparency_unavailable', status: 500 });
    } finally {
      globalThis.fetch = original;
    }
  });
});
