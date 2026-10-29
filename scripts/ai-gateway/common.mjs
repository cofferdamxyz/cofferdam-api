// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared by apply.mjs and verify.mjs: the account and token from the
 * environment (never printed), the Cloudflare API calls, the spec, and the
 * invariants a gateway must hold so that it cannot store user content.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SPEC_PATH = join(here, '..', '..', 'infra', 'ai-gateways.json');
const API = 'https://api.cloudflare.com/client/v4';

/** The account id and a token with AI Gateway Edit (and Zero Trust DLP Read for the profiles); `AI_GATEWAY_API_TOKEN` first, else the deploy token. */
export function credentials() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.AI_GATEWAY_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID and AI_GATEWAY_API_TOKEN (or CLOUDFLARE_API_TOKEN) must be set; run under `direnv exec ..`');
  return { account, token };
}

export function readSpec() {
  return JSON.parse(readFileSync(SPEC_PATH, 'utf8'));
}

/** One API call; the token never reaches the output, a failure names the status and the API's error codes only. */
export async function api(creds, method, path, body) {
  const res = await fetch(`${API}/accounts/${creds.account}${path}`, {
    method,
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok || !json?.success) {
    const codes = (json?.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ');
    return { ok: false, status: res.status, codes: codes || text.slice(0, 200), result: null };
  }
  return { ok: true, status: res.status, codes: '', result: json.result };
}

export async function getGateway(creds, id) {
  const r = await api(creds, 'GET', `/ai-gateway/gateways/${encodeURIComponent(id)}`);
  if (!r.ok && r.status === 404) return null;
  if (!r.ok) throw new Error(`reading gateway ${id}: HTTP ${r.status} ${r.codes}`);
  return r.result;
}

/** The DLP profiles of the account (Cloudflare One), name to id; empty when the token cannot read them. */
export async function dlpProfiles(creds) {
  const r = await api(creds, 'GET', '/dlp/profiles');
  if (!r.ok) return { ok: false, status: r.status, codes: r.codes, byName: new Map() };
  const byName = new Map();
  for (const p of r.result ?? []) if (p?.name && p?.id) byName.set(p.name, p.id);
  return { ok: true, status: r.status, codes: '', byName };
}

/**
 * What a gateway must hold so that no user content can be stored in it, and
 * what it must hold by its class. Returns the violations, empty when it holds.
 */
export function violations(spec, live) {
  const out = [];
  const want = (field, expected, actual) => {
    if (actual !== expected) out.push(`${field}: ${JSON.stringify(actual)} (must be ${JSON.stringify(expected)})`);
  };
  want('collect_logs', false, live.collect_logs);
  want('cache_ttl', 0, live.cache_ttl);
  if (live.logpush === true) out.push('logpush: true (must be off)');
  if (Array.isArray(live.otel) && live.otel.length) out.push(`otel: ${live.otel.length} exporter(s) (must be none)`);
  if (spec.dlp?.enabled) {
    if (live.dlp?.enabled !== true) out.push(`dlp.enabled: ${JSON.stringify(live.dlp?.enabled)} (must be true)`);
    const action = live.dlp?.action ?? live.dlp?.policies?.[0]?.action;
    if (action !== 'BLOCK') out.push(`dlp.action: ${JSON.stringify(action)} (must be "BLOCK")`);
    const profiles = live.dlp?.profiles ?? live.dlp?.policies?.flatMap((p) => p.profiles ?? []) ?? [];
    if (!profiles.length) out.push('dlp.profiles: none (the strict gateway blocks on at least one profile)');
  } else if (live.dlp?.enabled === true) {
    out.push('dlp.enabled: true (the documents gateway carries the CV itself; DLP would refuse it)');
  }
  return out;
}

/** The fields the proof shows, in a fixed order. */
export function summary(live) {
  return {
    id: live.id,
    collect_logs: live.collect_logs,
    cache_ttl: live.cache_ttl,
    logpush: live.logpush ?? false,
    otel: Array.isArray(live.otel) ? live.otel.length : 0,
    dlp: live.dlp?.enabled ? `${live.dlp.action ?? live.dlp.policies?.[0]?.action ?? '?'} on ${(live.dlp.profiles ?? live.dlp.policies?.flatMap((p) => p.profiles ?? []) ?? []).length} profile(s)` : 'off',
    rate_limit: live.rate_limiting_limit ? `${live.rate_limiting_limit}/${live.rate_limiting_interval}s ${live.rate_limiting_technique ?? ''}`.trim() : 'none',
    authentication: live.authentication ?? false,
    modified_at: live.modified_at ?? null,
  };
}

export function table(rows) {
  const keys = Object.keys(rows[0] ?? {});
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(keys), line(keys.map(() => '---')), ...rows.map((r) => line(keys.map((k) => String(r[k] ?? ''))))].join('\n');
}
