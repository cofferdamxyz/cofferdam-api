// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The sealed delivery record (workspace decisions 0040, 0042).
 *
 * The phone asks the relay to seal {platform, device token, webhook signing key,
 * APNs environment} and registers the resulting URL with the XMTP backend as its
 * HTTPS push channel. The backend's `push_recipient.delivery` then holds only
 * `https://push.cofferdam.xyz/v1/d/<sealed>`: no token, no platform, nothing
 * that names a phone. Only the relay's key ring can open it.
 *
 * Wire format (base64url): 0x01 | kid (1 byte) | iv (12) | AES-256-GCM(JSON),
 * with AAD "cofferdam-push-seal-v1:<kid>". Rotation: add a key under a new kid,
 * point SEAL_KID_CURRENT at it; phones reseal on their next launch. Removing an
 * old kid makes its URLs answer 410, so the backend drops those recipients.
 */

import { fromB64, fromB64Url, fromUtf8, toB64, toB64Url, utf8 } from './b64.js';

export const SEAL_VERSION = 1;
export type Platform = 'ios' | 'android' | 'ios-fcm';
export type ApnsEnvironment = 'production' | 'sandbox';

export interface DeliveryRecord {
  /** ios: APNs token; android: FCM token; ios-fcm: an FCM token on iOS (fallback). */
  platform: Platform;
  token: string;
  /** The 32-byte key the phone gave the backend for Standard Webhooks signing. */
  signingKey: Uint8Array;
  /** APNs host for `ios` (development builds use the sandbox). */
  apnsEnv: ApnsEnvironment;
}

/** Keep the whole URL under the backend's 2,048-character `delivery` limit. */
export const MAX_TOKEN_LENGTH = 1024;
const SIGNING_KEY_BYTES = 32;

export type KeyRing = Map<number, CryptoKey>;

/** SEAL_KEYS is JSON: {"<kid 0-255>": "<base64 of 32 random bytes>"}. */
export async function loadKeyRing(json: string | undefined): Promise<KeyRing> {
  const ring: KeyRing = new Map();
  if (!json) return ring;
  const parsed = JSON.parse(json) as Record<string, string>;
  for (const [kidText, keyB64] of Object.entries(parsed)) {
    const kid = Number(kidText);
    const raw = fromB64(keyB64);
    if (!Number.isInteger(kid) || kid < 0 || kid > 255 || !raw || raw.length !== 32) {
      throw new Error(`SEAL_KEYS: bad entry ${kidText}`);
    }
    ring.set(kid, await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']));
  }
  return ring;
}

const aad = (kid: number) => utf8.encode(`cofferdam-push-seal-v1:${kid}`);

/** Validate what the phone sent; returns a reason on failure. */
export function checkRecord(r: DeliveryRecord): string | null {
  if (r.platform !== 'ios' && r.platform !== 'android' && r.platform !== 'ios-fcm') return 'platform';
  if (typeof r.token !== 'string' || r.token.length < 8 || r.token.length > MAX_TOKEN_LENGTH) return 'token';
  if (!/^[A-Za-z0-9_:.\-]+$/.test(r.token)) return 'token';
  if (r.platform === 'ios' && !/^[0-9a-fA-F]{64,200}$/.test(r.token)) return 'token';
  if (!(r.signingKey instanceof Uint8Array) || r.signingKey.length !== SIGNING_KEY_BYTES) return 'signingKey';
  if (r.apnsEnv !== 'production' && r.apnsEnv !== 'sandbox') return 'apnsEnv';
  return null;
}

export async function seal(record: DeliveryRecord, ring: KeyRing, kid: number): Promise<string> {
  const key = ring.get(kid);
  if (!key) throw new Error(`no seal key ${kid}`);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = utf8.encode(
    JSON.stringify({ p: record.platform, t: record.token, k: toB64(record.signingKey), e: record.apnsEnv }),
  );
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(kid) }, key, body));
  const out = new Uint8Array(2 + iv.length + ct.length);
  out[0] = SEAL_VERSION;
  out[1] = kid;
  out.set(iv, 2);
  out.set(ct, 14);
  return toB64Url(out);
}

/** null when the blob is malformed, of another version, under an unknown key or tampered. */
export async function unseal(sealed: string, ring: KeyRing): Promise<DeliveryRecord | null> {
  const raw = fromB64Url(sealed);
  if (!raw || raw.length < 2 + 12 + 16 || raw[0] !== SEAL_VERSION) return null;
  const kid = raw[1]!;
  const key = ring.get(kid);
  if (!key) return null;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.subarray(2, 14), additionalData: aad(kid) },
      key,
      raw.subarray(14),
    );
    const j = JSON.parse(fromUtf8.decode(pt)) as { p: Platform; t: string; k: string; e: ApnsEnvironment };
    const signingKey = fromB64(j.k);
    if (!signingKey) return null;
    const record: DeliveryRecord = { platform: j.p, token: j.t, signingKey, apnsEnv: j.e };
    return checkRecord(record) === null ? record : null;
  } catch {
    return null;
  }
}
