// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The transparency answer (workspace decisions 0021 (h) and 0037; the plane
 * doc, Inference seam): `GET /v1/privacy/ai` reads the plane's AI Gateways
 * back from Cloudflare's API with a read-only token and says, from the live
 * settings and not from a policy page, whether any of them can store what a
 * user sends: logs, cache, Logpush or an OpenTelemetry exporter; and whether
 * each accepts only requests authorized in the account. It also
 * names the plane's deployed version and Cloudflare's own commitments for
 * Workers AI. Public, cached five minutes in the isolate and at the edge;
 * nothing of the request is read beyond the path.
 *
 * Without the read token and the account id (secrets) the route answers
 * `503 transparency_unprovisioned`; when Cloudflare's API cannot be read,
 * `502 transparency_unavailable`, with the status only.
 */

import { Hono } from 'hono';

import type { Env } from '../env.js';

const API = 'https://api.cloudflare.com/client/v4';
const CACHE_MS = 300_000;
export const WORKERS_AI_DATA_USAGE = 'https://developers.cloudflare.com/workers-ai/platform/data-usage/';
export const AI_GATEWAY_LOGGING = 'https://developers.cloudflare.com/ai-gateway/observability/logging/';

export interface GatewayFacts {
  id: string;
  /** What travels through it, in the user's words. */
  carries: string;
  collectsLogs: boolean;
  cacheTtlSeconds: number;
  logpush: boolean;
  otelExporters: number;
  dlp: { enabled: boolean; action: string | null; profiles: number };
  /** True when the gateway refuses a request that no account authorization covers; the plane's binding calls are pre-authenticated in the account. */
  authenticated: boolean;
  /** True when any setting could keep a request or an answer. */
  canStore: boolean;
}

export interface TransparencyAnswer {
  ok: true;
  checkedAt: string;
  plane: { version: string | null; environment: string; logs: string };
  gateways: GatewayFacts[];
  noGatewayCanStore: boolean;
  commitments: {
    workersAi: { retainsInputsOrOutputs: false; trainsOnCustomerContent: false; source: string };
    gatewayLogsAndCache: { source: string };
  };
}

type TransparencyEnv = Pick<Env, 'AI_GATEWAY_ID' | 'AI_GATEWAY_DOCUMENTS_ID' | 'AI_GATEWAY_READ_TOKEN' | 'AI_GATEWAY_ACCOUNT_ID' | 'CF_VERSION_METADATA' | 'ENVIRONMENT'>;
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface LiveGateway {
  id?: unknown;
  collect_logs?: unknown;
  cache_ttl?: unknown;
  logpush?: unknown;
  otel?: unknown;
  authentication?: unknown;
  dlp?: { enabled?: unknown; action?: unknown; profiles?: unknown; policies?: { action?: unknown; profiles?: unknown }[] } | null;
}

/** The gateways the plane is configured to use, with what each carries. */
export function configuredGateways(env: Pick<Env, 'AI_GATEWAY_ID' | 'AI_GATEWAY_DOCUMENTS_ID'>): { id: string; carries: string }[] {
  const out: { id: string; carries: string }[] = [];
  if (env.AI_GATEWAY_ID) out.push({ id: env.AI_GATEWAY_ID, carries: 'text you type in the app, after your phone has removed personal details' });
  if (env.AI_GATEWAY_DOCUMENTS_ID && env.AI_GATEWAY_DOCUMENTS_ID !== env.AI_GATEWAY_ID) out.push({ id: env.AI_GATEWAY_DOCUMENTS_ID, carries: 'a document you chose to send for reading, such as your CV' });
  return out;
}

/** One gateway's live settings read into facts. */
export function gatewayFacts(id: string, carries: string, live: LiveGateway): GatewayFacts {
  const collectsLogs = live.collect_logs === true;
  const cacheTtlSeconds = typeof live.cache_ttl === 'number' ? live.cache_ttl : 0;
  const logpush = live.logpush === true;
  const otelExporters = Array.isArray(live.otel) ? live.otel.length : 0;
  const dlpEnabled = live.dlp?.enabled === true;
  const action = typeof live.dlp?.action === 'string' ? live.dlp.action : typeof live.dlp?.policies?.[0]?.action === 'string' ? (live.dlp.policies[0]!.action as string) : null;
  const profiles = Array.isArray(live.dlp?.profiles) ? live.dlp.profiles.length : (live.dlp?.policies ?? []).reduce((n, p) => n + (Array.isArray(p.profiles) ? p.profiles.length : 0), 0);
  return {
    id,
    carries,
    collectsLogs,
    cacheTtlSeconds,
    logpush,
    otelExporters,
    dlp: { enabled: dlpEnabled, action: dlpEnabled ? action : null, profiles: dlpEnabled ? profiles : 0 },
    authenticated: live.authentication === true,
    canStore: collectsLogs || cacheTtlSeconds > 0 || logpush || otelExporters > 0,
  };
}

export type GatewayRead = { ok: true; facts: GatewayFacts[] } | { ok: false; error: 'unprovisioned' } | { ok: false; error: 'unavailable'; status: number };

/** Every configured gateway read back from Cloudflare's API with the read-only token. */
export async function readAiGateways(env: TransparencyEnv, fetchImpl: FetchLike = (input, init) => fetch(input, init)): Promise<GatewayRead> {
  const token = env.AI_GATEWAY_READ_TOKEN;
  const account = env.AI_GATEWAY_ACCOUNT_ID;
  const configured = configuredGateways(env);
  if (!token || !account || !configured.length) return { ok: false, error: 'unprovisioned' };
  const facts: GatewayFacts[] = [];
  for (const g of configured) {
    const res = await fetchImpl(`${API}/accounts/${encodeURIComponent(account)}/ai-gateway/gateways/${encodeURIComponent(g.id)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, error: 'unavailable', status: res.status };
    const body = (await res.json().catch(() => null)) as { success?: unknown; result?: LiveGateway } | null;
    if (!body?.success || !body.result) return { ok: false, error: 'unavailable', status: 502 };
    facts.push(gatewayFacts(g.id, g.carries, body.result));
  }
  return { ok: true, facts };
}

export function transparencyAnswer(env: TransparencyEnv, facts: GatewayFacts[], now = Date.now()): TransparencyAnswer {
  return {
    ok: true,
    checkedAt: new Date(now).toISOString(),
    plane: {
      version: env.CF_VERSION_METADATA?.id ?? null,
      environment: env.ENVIRONMENT,
      logs: 'the plane logs reason codes and sizes, never the text of a request or an answer',
    },
    gateways: facts,
    noGatewayCanStore: facts.every((f) => !f.canStore),
    commitments: {
      workersAi: { retainsInputsOrOutputs: false, trainsOnCustomerContent: false, source: WORKERS_AI_DATA_USAGE },
      gatewayLogsAndCache: { source: AI_GATEWAY_LOGGING },
    },
  };
}

let cached: { at: number; answer: TransparencyAnswer } | null = null;

/** Forget the cached answer (tests). */
export function clearTransparencyCache(): void {
  cached = null;
}

export const privacyRoutes = new Hono<{ Bindings: Env }>();

privacyRoutes.get('/ai', async (c) => {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(cached.answer);
  }
  const read = await readAiGateways(c.env);
  if (!read.ok) {
    if (read.error === 'unprovisioned') return c.json({ ok: false, error: 'transparency_unprovisioned' }, 503);
    return c.json({ ok: false, error: 'transparency_unavailable', status: read.status }, 502);
  }
  const answer = transparencyAnswer(c.env, read.facts, now);
  cached = { at: now, answer };
  c.header('Cache-Control', 'public, max-age=300');
  return c.json(answer);
});
