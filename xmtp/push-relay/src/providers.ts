// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * APNs (token auth, HTTP/2 provider API) and FCM HTTP v1 senders.
 *
 * APNs from a Worker: Apple's provider API is HTTP/2 only. Deployed Workers
 * reach it, because Cloudflare's outbound proxy speaks HTTP/2 to the origin;
 * local `wrangler dev` (workerd) does not speak HTTP/2 and fails (workerd issue
 * #4841, confirmed by the runtime's maintainer). So: test APNs on the deployed
 * relay; locally, use an Android phone or `platform: 'ios-fcm'`.
 *
 * Both credentials are cached in the isolate's memory only (an APNs JWT for 40
 * minutes, Apple wants 20 to 60; a Google access token until a minute before
 * expiry). Nothing is written anywhere.
 */

import { fromB64, toB64Url, utf8 } from './b64.js';
import type { SealedHint } from './hint.js';
import type { DeliveryRecord } from './seal.js';

export type Outcome = 'delivered' | 'gone' | 'retry' | 'rejected';
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ProviderConfig {
  /** PKCS#8 PEM of the .p8 key (secret). */
  APNS_KEY_P8?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  /** The app's bundle id, the apns-topic. */
  APNS_BUNDLE_ID?: string;
  /** Full service-account JSON (secret). */
  FCM_SERVICE_ACCOUNT?: string;
}

/** The text Apple shows if the extension cannot decrypt in time. */
export const GENERIC_ALERT = { title: 'Cofferdam', body: 'New message' } as const;
const PUSH_TTL_S = 24 * 3600;

function pemBody(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = fromB64(b64);
  if (!der) throw new Error('bad PEM');
  return der;
}

async function signJwt(
  header: Record<string, string>,
  claims: Record<string, unknown>,
  key: CryptoKey,
  algo: string | SubtleCryptoSignAlgorithm,
): Promise<string> {
  const enc = (o: unknown) => toB64Url(utf8.encode(JSON.stringify(o)));
  const input = `${enc(header)}.${enc(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign(algo, key, utf8.encode(input)));
  return `${input}.${toB64Url(sig)}`;
}

// ── APNs ──────────────────────────────────────────────────────────────────────

let apnsJwt: { token: string; at: number; kid: string } | null = null;

export async function apnsAuth(cfg: ProviderConfig, nowS: number): Promise<string> {
  if (!cfg.APNS_KEY_P8 || !cfg.APNS_KEY_ID || !cfg.APNS_TEAM_ID) throw new Error('apns_unconfigured');
  if (apnsJwt && apnsJwt.kid === cfg.APNS_KEY_ID && nowS - apnsJwt.at < 40 * 60) return apnsJwt.token;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemBody(cfg.APNS_KEY_P8),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const token = await signJwt(
    { alg: 'ES256', kid: cfg.APNS_KEY_ID },
    { iss: cfg.APNS_TEAM_ID, iat: nowS },
    key,
    { name: 'ECDSA', hash: 'SHA-256' },
  );
  apnsJwt = { token, at: nowS, kid: cfg.APNS_KEY_ID };
  return token;
}

export function apnsPayload(hint: SealedHint): string {
  return JSON.stringify({ aps: { alert: GENERIC_ALERT, 'mutable-content': 1, sound: 'default' }, c: hint.c });
}

export async function sendApns(
  record: DeliveryRecord,
  hint: SealedHint,
  cfg: ProviderConfig,
  fetcher: FetchLike,
  nowS: number,
): Promise<Outcome> {
  if (!cfg.APNS_BUNDLE_ID) return 'retry';
  let auth: string;
  try {
    auth = await apnsAuth(cfg, nowS);
  } catch {
    return 'retry';
  }
  const host = record.apnsEnv === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const res = await fetcher(`https://${host}/3/device/${record.token}`, {
    method: 'POST',
    headers: {
      authorization: `bearer ${auth}`,
      'apns-topic': cfg.APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(nowS + PUSH_TTL_S),
      'apns-collapse-id': hint.collapseId,
      'content-type': 'application/json',
    },
    body: apnsPayload(hint),
  });
  if (res.ok) return 'delivered';
  let reason = '';
  try {
    reason = ((await res.json()) as { reason?: string }).reason ?? '';
  } catch {
    /* empty body */
  }
  return classifyApns(res.status, reason);
}

export function classifyApns(status: number, reason: string): Outcome {
  if (status === 410) return 'gone';
  if (status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic')) return 'gone';
  if (status === 403 && reason === 'ExpiredProviderToken') {
    apnsJwt = null;
    return 'retry';
  }
  // 403 (our key), 429, 5xx: ours or theirs to fix; the backend retries, then keeps the recipient.
  if (status === 403 || status === 429 || status >= 500) return 'retry';
  return 'rejected';
}

// ── FCM HTTP v1 ───────────────────────────────────────────────────────────────

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

let fcmToken: { value: string; exp: number; email: string } | null = null;

async function fcmAuth(sa: ServiceAccount, fetcher: FetchLike, nowS: number): Promise<string | null> {
  if (fcmToken && fcmToken.email === sa.client_email && nowS < fcmToken.exp - 60) return fcmToken.value;
  const tokenUri = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemBody(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const assertion = await signJwt(
    { alg: 'RS256', typ: 'JWT' },
    {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: tokenUri,
      iat: nowS,
      exp: nowS + 3600,
    },
    key,
    { name: 'RSASSA-PKCS1-v1_5' },
  );
  const res = await fetcher(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}`,
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!j.access_token) return null;
  fcmToken = { value: j.access_token, exp: nowS + (j.expires_in ?? 3600), email: sa.client_email };
  return j.access_token;
}

export function fcmMessage(record: DeliveryRecord, hint: SealedHint): Record<string, unknown> {
  if (record.platform === 'ios-fcm') {
    // The iOS fallback: FCM forwards an APNs alert, so the extension still runs.
    return {
      token: record.token,
      apns: {
        headers: {
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-collapse-id': hint.collapseId,
        },
        payload: { aps: { alert: GENERIC_ALERT, 'mutable-content': 1, sound: 'default' }, c: hint.c },
      },
    };
  }
  // Android: a high-priority data message; the app's handler writes the notification.
  return {
    token: record.token,
    data: { c: hint.c },
    android: { priority: 'HIGH', collapse_key: hint.collapseId, ttl: `${PUSH_TTL_S}s` },
  };
}

export async function sendFcm(
  record: DeliveryRecord,
  hint: SealedHint,
  cfg: ProviderConfig,
  fetcher: FetchLike,
  nowS: number,
): Promise<Outcome> {
  if (!cfg.FCM_SERVICE_ACCOUNT) return 'retry';
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(cfg.FCM_SERVICE_ACCOUNT) as ServiceAccount;
  } catch {
    return 'retry';
  }
  const access = await fcmAuth(sa, fetcher, nowS).catch(() => null);
  if (!access) return 'retry';
  const res = await fetcher(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: fcmMessage(record, hint) }),
  });
  if (res.ok) return 'delivered';
  let code = '';
  try {
    const j = (await res.json()) as { error?: { status?: string; details?: { errorCode?: string }[] } };
    code = j.error?.details?.find((d) => d.errorCode)?.errorCode ?? j.error?.status ?? '';
  } catch {
    /* empty body */
  }
  return classifyFcm(res.status, code);
}

export function classifyFcm(status: number, code: string): Outcome {
  if (status === 404 || code === 'UNREGISTERED') return 'gone';
  if (status === 400 && code === 'INVALID_ARGUMENT') return 'gone';
  if (status === 401) fcmToken = null;
  if (status === 401 || status === 403 || status === 429 || status >= 500) return 'retry';
  return 'rejected';
}

/** Test seam: drop cached credentials. */
export function resetProviderCaches(): void {
  apnsJwt = null;
  fcmToken = null;
}
