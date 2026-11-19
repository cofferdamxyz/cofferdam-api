// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The keys of the identity map's first tables (0083 R10; workspace decision
 * 0086, rules 4 and 5), from the secret `HANDLES_MAP_KEY` (32 bytes as 64 hex
 * characters, the founder's `wrangler secret put HANDLES_MAP_KEY`; no session
 * reads it). Two keys are derived with HKDF-SHA-256 under fixed labels:
 * - the tag key, HMAC-SHA-256 of an account (the identity map's row key) and of
 *   a passkey (the per-install tag the limits count), so no table names either;
 * - the seal key, AES-256-GCM over what a watched address's registration carries
 *   (R, h, the view tag and the meta-address), 12-byte random nonce first.
 *
 * Rotating the secret strands every identity's map row (a claim would mint a new
 * identity for the same account) and every sealed registration: it is a
 * production-cut step, never a routine one.
 */

const LABEL_TAG = 'cofferdam-handles-map-tag-v1';
const LABEL_SEAL = 'cofferdam-handles-map-seal-v1';

export interface MapKeys {
  /** Lower-case hex HMAC-SHA-256 of `domain:value`. */
  tag(domain: 'account' | 'install', value: string): Promise<string>;
  seal(plain: Uint8Array): Promise<Uint8Array>;
  open(sealed: Uint8Array): Promise<Uint8Array>;
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

/** The keys of `HANDLES_MAP_KEY`, or null when it is unset or not 64 hex characters. */
export async function mapKeysOf(secret: string | undefined): Promise<MapKeys | null> {
  const raw = secret?.trim();
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) return null;
  const ikm = Uint8Array.from(raw.match(/../g)!, (b) => parseInt(b, 16));
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  const hkdf = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(info) });
  const tagKey = await crypto.subtle.deriveKey(hkdf(LABEL_TAG), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
  const sealKey = await crypto.subtle.deriveKey(hkdf(LABEL_SEAL), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return {
    async tag(domain, value) {
      return hex(await crypto.subtle.sign('HMAC', tagKey, enc.encode(`${domain}:${value.toLowerCase()}`)));
    },
    async seal(plain) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sealKey, plain));
      const out = new Uint8Array(12 + ct.length);
      out.set(iv);
      out.set(ct, 12);
      return out;
    },
    async open(sealed) {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(0, 12) }, sealKey, sealed.slice(12));
      return new Uint8Array(pt);
    },
  };
}
