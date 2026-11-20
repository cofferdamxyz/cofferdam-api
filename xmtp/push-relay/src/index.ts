// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * cofferdam-push-relay: the blind push relay (workspace decisions 0040, 0042).
 *
 *   POST /v1/seal        the phone's call: seal {platform, token, signingKey,
 *                        apnsEnv} into a delivery URL it registers with the XMTP
 *                        backend's HTTPS channel. It carries no session (none
 *                        exists here, by design) but must carry the app key
 *                        (`Authorization: Bearer <key>`, the backend's
 *                        `[auth.api_keys]` value every binary holds), and it
 *                        passes a per-IP and a global limit first.
 *   POST /v1/d/<sealed>  the backend's signed webhook: unseal, verify, encrypt
 *                        the hint for the device, send an APNs alert or an FCM
 *                        data message, answer the backend.
 *
 * It stores nothing (no KV, D1, R2, Durable Object or cache) and logs nothing
 * (no console calls, Workers Logs and Logpush off; test/xmtp/pushRelay.test.ts
 * fails on a console call in this directory). What it learns per request (a
 * token, an encrypted hint, a time) dies with the request.
 *
 * What this does not stop (workspace review of 2026-11-19, H1): the app key is in
 * every binary, so whoever extracts it can still seal a device token they hold
 * under a signing key of their own and sign webhooks for it. The limits bound
 * that: one bucket per device token however many URLs seal it, and the seal
 * limits. App Attest and Play Integrity on the seal call, once the app has them
 * (decision 0086's device attestation), close it.
 *
 * Answers to the backend (its http.rs classify): 200 delivered; 410 the token is
 * gone or the URL can never work again, so the backend deletes the recipient;
 * 503 retry later (ours or the provider's problem); 4xx anything else, which
 * drops this one delivery and keeps the recipient.
 */

import { fromB64, toHex, utf8 } from './b64.js';
import { encryptHint } from './hint.js';
import { sendApns, sendFcm, type FetchLike, type Outcome, type ProviderConfig } from './providers.js';
import { checkRecord, loadKeyRing, seal, unseal, type DeliveryRecord, type KeyRing } from './seal.js';
import { MAX_BODY_BYTES, verifyWebhook } from './webhook.js';

export interface Env extends ProviderConfig {
  /** Secret. {"<kid>": "<base64 32 bytes>"}. */
  SEAL_KEYS?: string;
  /** Var. The kid new seals use. */
  SEAL_KID_CURRENT?: string;
  /** Var. https://push.cofferdam.xyz */
  PUBLIC_BASE_URL?: string;
  /**
   * Per device token: every URL that seals one token shares a bucket (a hash of
   * the unsealed platform and token), so re-sealing a token never lifts the cap.
   */
  PUSH_RL?: RateLimit;
  /** Seals per caller, keyed by a hash of the connecting IP (never kept). */
  SEAL_IP_RL?: RateLimit;
  /** Seals across every caller: the brake on a farm of addresses. */
  SEAL_GLOBAL_RL?: RateLimit;
  /**
   * Secret. The app keys `/v1/seal` accepts, comma-separated: the same values as
   * the backend's `[auth.api_keys]`, so a key rotation adds the new one here too.
   * Unset, the relay seals nothing (503).
   */
  SEAL_APP_KEYS?: string;
}

const STATUS: Record<Outcome, number> = { delivered: 200, gone: 410, retry: 503, rejected: 422 };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const empty = (status: number) => new Response(null, { status });

let ringCache: { source: string; ring: KeyRing } | null = null;
async function keyRing(env: Env): Promise<KeyRing> {
  const source = env.SEAL_KEYS ?? '';
  if (ringCache?.source !== source) ringCache = { source, ring: await loadKeyRing(source) };
  return ringCache.ring;
}

async function readBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return null;
  const body = new Uint8Array(await request.arrayBuffer());
  return body.length > MAX_BODY_BYTES ? null : body;
}

const sha256Hex = async (text: string) =>
  toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(text))));

/** Constant-time over the digests, so a wrong key's length or prefix tells nothing. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** The seal gate: the app key, then the per-IP limit, then the global one. null lets the call through. */
async function sealGate(request: Request, env: Env): Promise<Response | null> {
  const keys = (env.SEAL_APP_KEYS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  if (keys.length === 0) return json(503, { error: 'unconfigured' });
  const m = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '');
  let known = false;
  for (const k of keys) if (m && (await sameSecret(m[1]!.trim(), k))) known = true;
  if (!known) return json(401, { error: 'app_key' });
  // Per IP first, so one address past its ceiling never spends the global budget.
  if (env.SEAL_IP_RL) {
    const ip = request.headers.get('cf-connecting-ip') ?? '';
    const key = `seal-ip:${(await sha256Hex(`cofferdam-push-seal-ip:${ip}`)).slice(0, 32)}`;
    if (!(await env.SEAL_IP_RL.limit({ key })).success) return json(429, { error: 'busy' });
  }
  if (env.SEAL_GLOBAL_RL && !(await env.SEAL_GLOBAL_RL.limit({ key: 'seal' })).success) {
    return json(429, { error: 'busy' });
  }
  return null;
}

export async function handleSeal(request: Request, env: Env): Promise<Response> {
  const refused = await sealGate(request, env);
  if (refused) return refused;
  const body = await readBody(request);
  if (!body) return json(413, { error: 'too_large' });
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  } catch {
    return json(400, { error: 'json' });
  }
  if (input.v !== 1) return json(400, { error: 'version' });
  const signingKey = typeof input.signingKey === 'string' ? fromB64(input.signingKey) : null;
  const record = {
    platform: input.platform,
    // An APNs token is hex, which APNs reads in any case: one case only, so no case variant seals into a bucket of its own.
    token: input.platform === 'ios' && typeof input.token === 'string' ? input.token.toLowerCase() : input.token,
    signingKey,
    apnsEnv: input.apnsEnv ?? 'production',
  } as DeliveryRecord;
  const bad = checkRecord(record);
  if (bad) return json(400, { error: bad });
  const kid = Number(env.SEAL_KID_CURRENT ?? '1');
  const ring = await keyRing(env);
  if (!ring.has(kid)) return json(503, { error: 'unconfigured' });
  const sealed = await seal(record, ring, kid);
  const base = (env.PUBLIC_BASE_URL ?? 'https://push.cofferdam.xyz').replace(/\/$/, '');
  return json(200, { url: `${base}/v1/d/${sealed}` });
}

export async function handleDelivery(
  request: Request,
  env: Env,
  sealed: string,
  fetcher: FetchLike,
  nowS = Math.floor(Date.now() / 1000),
): Promise<Response> {
  const body = await readBody(request);
  if (!body) return empty(413);
  const record = await unseal(sealed, await keyRing(env));
  // A URL no key can open will never work: let the backend delete the recipient.
  if (!record) return empty(410);
  const verified = await verifyWebhook(request.headers, body, record.signingKey, nowS);
  if (!verified.ok) return empty(401);
  if (env.PUSH_RL) {
    // The device token, not the URL: a fresh seal of one token lands in the same bucket. An FCM token is one bucket
    // whether it was sealed as `android` or `ios-fcm`.
    const provider = record.platform === 'ios' ? 'apns' : 'fcm';
    const token = provider === 'apns' ? record.token.toLowerCase() : record.token;
    const key = (await sha256Hex(`cofferdam-push-token:${provider}:${token}`)).slice(0, 32);
    const { success } = await env.PUSH_RL.limit({ key });
    if (!success) return empty(429);
  }
  const hint = await encryptHint(record.signingKey, verified.hint);
  const outcome =
    record.platform === 'ios'
      ? await sendApns(record, hint, env, fetcher, nowS)
      : await sendFcm(record, hint, env, fetcher, nowS);
  return empty(STATUS[outcome]);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST') return empty(405);
    if (url.pathname === '/v1/seal') return handleSeal(request, env);
    const m = /^\/v1\/d\/([A-Za-z0-9_-]{40,1900})$/.exec(url.pathname);
    if (m) {
      try {
        return await handleDelivery(request, env, m[1]!, (u, init) => fetch(u, init));
      } catch {
        return empty(503);
      }
    }
    return empty(404);
  },
} satisfies ExportedHandler<Env>;
