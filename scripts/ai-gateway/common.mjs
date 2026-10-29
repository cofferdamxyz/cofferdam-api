// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared by apply.mjs and verify.mjs: the account and token from the
 * environment (never printed), the Cloudflare API calls, the spec, and the
 * invariants a gateway must hold so that it cannot store user content and so
 * that its DLP detects what the spec names.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SPEC_PATH = join(here, '..', '..', 'infra', 'ai-gateways.json');
const API = 'https://api.cloudflare.com/client/v4';

/**
 * The account id and a token: AI Gateway Edit for apply (Read for verify), Zero
 * Trust Read for the DLP profiles and Zero Trust Edit to enable their
 * detectors; `AI_GATEWAY_API_TOKEN` first, else the deploy token. A token with
 * AI Gateway Run only cannot: Run sends requests through gateways and reads no
 * configuration.
 */
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

/** The DLP profiles of the account (Cloudflare One), name to id; empty when the token cannot read them (Zero Trust Read). */
export async function dlpProfiles(creds) {
  const r = await api(creds, 'GET', '/dlp/profiles');
  if (!r.ok) return { ok: false, status: r.status, codes: r.codes, byName: new Map() };
  const byName = new Map();
  for (const p of r.result ?? []) if (p?.name && p?.id) byName.set(p.name, p.id);
  return { ok: true, status: r.status, codes: '', byName };
}

/** One DLP profile with its detection entries; `ok: false` with the status and codes when it cannot be read. */
export async function dlpProfile(creds, id) {
  const r = await api(creds, 'GET', `/dlp/profiles/${encodeURIComponent(id)}`);
  return r.ok ? { ok: true, status: r.status, codes: '', profile: r.result } : { ok: false, status: r.status, codes: r.codes, profile: null };
}

/** Whether Cloudflare offers this entry on the account's plan (the "Text" variants and the labelled CVV were not, 2026-10-29). */
export function entryAvailable(entry) {
  return entry?.confidence?.available !== false;
}

/** The ids of the profiles a live gateway blocks on, in either API shape. */
export function gatewayProfileIds(live) {
  return live?.dlp?.profiles ?? live?.dlp?.policies?.flatMap((p) => p.profiles ?? []) ?? [];
}

/**
 * A profile's detectors against the entry names the spec wants on: the ones
 * on, the available ones wanted but off, the wanted ones the plan does not
 * offer, the names the profile does not hold, and the ids to enable.
 * Cloudflare ships a predefined profile with every entry off (2026-10-29), so
 * a profile on a gateway detects nothing until apply.mjs enables the spec's.
 */
export function detectors(profile, wantedNames = []) {
  const entries = profile?.entries ?? [];
  const byName = new Map(entries.map((e) => [e.name, e]));
  const on = entries.filter((e) => e.enabled === true).map((e) => e.name);
  const available = entries.filter(entryAvailable).map((e) => e.name);
  const off = [];
  const unavailable = [];
  const unknown = [];
  const wantIds = [];
  for (const n of wantedNames) {
    const e = byName.get(n);
    if (!e) unknown.push(n);
    else if (!entryAvailable(e)) unavailable.push(n);
    else {
      wantIds.push(e.id);
      if (e.enabled !== true) off.push(n);
    }
  }
  return { on, available, off, unavailable, unknown, wantIds };
}

/**
 * What a gateway must hold so that no user content can be stored in it, what
 * it must hold by its class, its authentication, and, with DLP wanted, that
 * each of its profiles detects what the spec names. `profilesById` is the
 * gateway's profiles read back (id to profile), or null when they could not be
 * read, which is itself a violation: detectors that cannot be shown on are not
 * shown on. Returns the violations, empty when everything holds.
 */
export function violations(spec, live, profilesById = null) {
  const out = [];
  const want = (field, expected, actual) => {
    if (actual !== expected) out.push(`${field}: ${JSON.stringify(actual)} (must be ${JSON.stringify(expected)})`);
  };
  want('collect_logs', false, live.collect_logs);
  want('cache_ttl', 0, live.cache_ttl);
  if (spec.authentication === true && live.authentication !== true) out.push('authentication: off (must be on: only a request authorized in the account may use the gateway; the binding is pre-authenticated)');
  if (live.logpush === true) out.push('logpush: true (must be off)');
  if (Array.isArray(live.otel) && live.otel.length) out.push(`otel: ${live.otel.length} exporter(s) (must be none)`);
  if (spec.dlp?.enabled) {
    if (live.dlp?.enabled !== true) out.push(`dlp.enabled: ${JSON.stringify(live.dlp?.enabled)} (must be true)`);
    const policy = Array.isArray(live.dlp?.policies) ? live.dlp.policies[0] : null;
    const action = policy?.action ?? live.dlp?.action;
    if (action !== 'BLOCK') out.push(`dlp.action: ${JSON.stringify(action)} (must be "BLOCK")`);
    if (!policy) out.push('dlp.policies: none (the legacy form stores no check side; apply.mjs writes the policies form)');
    else {
      if (policy.enabled !== true) out.push('dlp.policies[0].enabled: false (must be true)');
      const wantCheck = spec.dlp.check ?? ['REQUEST'];
      const check = Array.isArray(policy.check) ? policy.check : [];
      if (!wantCheck.every((c) => check.includes(c))) out.push(`dlp.check: ${JSON.stringify(check)} (must include ${JSON.stringify(wantCheck)})`);
    }
    const profiles = gatewayProfileIds(live);
    if (!profiles.length) out.push('dlp.profiles: none (the strict gateway blocks on at least one profile)');
    else if (!profilesById) out.push('dlp.detectors: the profiles could not be read (the token needs Zero Trust Read), so no detector is shown on');
    else {
      for (const id of profiles) {
        const p = profilesById.get(id);
        if (!p) {
          out.push(`dlp.detectors: profile ${id} could not be read`);
          continue;
        }
        const d = detectors(p, spec.dlp_profiles?.[p.name] ?? []);
        if (!d.on.length) out.push(`dlp.detectors: "${p.name}" has no enabled detector (Cloudflare ships every entry off; apply.mjs enables the spec's)`);
        else if (d.off.length) out.push(`dlp.detectors: "${p.name}" has ${d.off.length} of the spec's detectors off: ${d.off.join(', ')}`);
      }
    }
  } else if (live.dlp?.enabled === true) {
    out.push('dlp.enabled: true (the documents gateway carries the CV itself; DLP would refuse it)');
  }
  return out;
}

/** The fields the proof shows, in a fixed order; `detectors` counts enabled over available entries per profile. */
export function summary(live, profilesById = null) {
  const ids = gatewayProfileIds(live);
  let det = '-';
  if (live.dlp?.enabled) {
    det = profilesById
      ? ids
          .map((id) => {
            const d = detectors(profilesById.get(id));
            return profilesById.get(id) ? `${d.on.length}/${d.available.length}` : '?';
          })
          .join(' + ') + ' on'
      : '?';
  }
  return {
    id: live.id,
    collect_logs: live.collect_logs,
    cache_ttl: live.cache_ttl,
    logpush: live.logpush ?? false,
    otel: Array.isArray(live.otel) ? live.otel.length : 0,
    dlp: live.dlp?.enabled ? `${live.dlp.policies?.[0]?.action ?? live.dlp.action ?? '?'} on ${ids.length} profile(s)${Array.isArray(live.dlp.policies?.[0]?.check) ? `, check ${live.dlp.policies[0].check.join('+')}` : ', legacy form'}` : 'off',
    detectors: det,
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
