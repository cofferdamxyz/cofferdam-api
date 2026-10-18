// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What Apple and Google carry: the push hint encrypted for the one device
 * (decision 0042). The backend's own APNs and FCM channels put the topic in the
 * clear, which tells Apple or Google "this phone is in group X". Here the hint is
 * AES-256-GCM under a key both the phone and the relay derive from the webhook
 * signing key the phone generated:
 *
 *   hintKey = HKDF-SHA256(ikm = signingKey, salt = "", info = "cofferdam-push-hint-v1")
 *   c       = base64url(iv(12) | AES-GCM(hintKey, iv, {"t": <topic b64>, "s": "<sequence id>"}))
 *   collapse id = hex(HMAC-SHA256(hintKey, "collapse:" + topic b64 + ":" + seq))[0..32]
 *
 * The collapse id dedupes retries of one message without giving Apple a stable
 * per-conversation id. The phone (iOS Notification Service Extension, Android
 * data handler) derives hintKey from the signing key it keeps and opens `c`.
 */

import { toB64, toB64Url, toHex, utf8 } from './b64.js';
import type { PushHint } from './webhook.js';

export async function hintKeys(signingKey: Uint8Array): Promise<{ aes: CryptoKey; mac: CryptoKey }> {
  const ikm = await crypto.subtle.importKey('raw', signingKey, 'HKDF', false, ['deriveBits']);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8.encode('cofferdam-push-hint-v1') },
      ikm,
      256,
    ),
  );
  const [aes, mac] = await Promise.all([
    crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']),
    crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
  ]);
  return { aes, mac };
}

export interface SealedHint {
  /** base64url ciphertext the phone opens. */
  c: string;
  /** 32 hex chars, stable per (device, message). */
  collapseId: string;
}

export async function encryptHint(signingKey: Uint8Array, hint: PushHint): Promise<SealedHint> {
  const { aes, mac } = await hintKeys(signingKey);
  const topic = toB64(hint.topic);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, utf8.encode(JSON.stringify({ t: topic, s: hint.sequenceId }))),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  const tag = new Uint8Array(await crypto.subtle.sign('HMAC', mac, utf8.encode(`collapse:${topic}:${hint.sequenceId}`)));
  return { c: toB64Url(out), collapseId: toHex(tag).slice(0, 32) };
}
