// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The XMTP backend's HTTPS push (libxmtp apps/backend/src/push/channel/http.rs,
 * backend-8.0.0-rc2): a Standard Webhooks request whose signature is
 * `v1,` + base64(HMAC-SHA256(signingKey, id + "." + timestamp + "." + body)),
 * with the raw 32-byte key the phone registered (no `whsec_` prefix), and a
 * JSON body of exactly {topic, sequence_id, recipient_id}.
 *
 * The relay keeps no replay list (it stores nothing). A replayed or retried
 * webhook can only repeat a generic alert for the same message, and the APNs
 * collapse id / FCM collapse key is derived from (topic, sequence_id), so the
 * phone shows it once.
 */

import { equalBytes, fromB64, utf8 } from './b64.js';

export const TIMESTAMP_TOLERANCE_S = 300;
export const MAX_BODY_BYTES = 4096;

export interface PushHint {
  /** The backend wire topic: 0x00 + 16-byte group id, or 0x01 + 32-byte installation key. */
  topic: Uint8Array;
  /** Decimal text; never a JS number. */
  sequenceId: string;
}

export type VerifyResult = { ok: true; hint: PushHint } | { ok: false; reason: string };

export async function verifyWebhook(
  headers: Headers,
  body: Uint8Array,
  signingKey: Uint8Array,
  nowS: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  const id = headers.get('webhook-id');
  const ts = headers.get('webhook-timestamp');
  const sigHeader = headers.get('webhook-signature');
  if (!id || !ts || !sigHeader) return { ok: false, reason: 'headers' };
  if (!/^\d{1,12}$/.test(ts) || Math.abs(nowS - Number(ts)) > TIMESTAMP_TOLERANCE_S) {
    return { ok: false, reason: 'timestamp' };
  }
  const key = await crypto.subtle.importKey('raw', signingKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = new Uint8Array([...utf8.encode(`${id}.${ts}.`), ...body]);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, signed));
  // The header may carry several space-separated signatures (key rotation).
  const match = sigHeader.split(' ').some((entry) => {
    const [version, value] = entry.split(',', 2);
    if (version !== 'v1' || !value) return false;
    const got = fromB64(value);
    return got !== null && equalBytes(got, expected);
  });
  if (!match) return { ok: false, reason: 'signature' };
  return parseHint(body);
}

export function parseHint(body: Uint8Array): VerifyResult {
  let j: unknown;
  try {
    j = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { ok: false, reason: 'json' };
  }
  if (typeof j !== 'object' || j === null) return { ok: false, reason: 'json' };
  const { topic, sequence_id } = j as Record<string, unknown>;
  if (typeof topic !== 'string' || typeof sequence_id !== 'string') return { ok: false, reason: 'fields' };
  if (!/^[1-9]\d{0,19}$/.test(sequence_id) || BigInt(sequence_id) > 18446744073709551615n) {
    return { ok: false, reason: 'sequence_id' };
  }
  const t = fromB64(topic);
  const isGroup = t !== null && t[0] === 0 && t.length === 17;
  const isWelcome = t !== null && t[0] === 1 && t.length === 33;
  if (!isGroup && !isWelcome) return { ok: false, reason: 'topic' };
  return { ok: true, hint: { topic: t, sequenceId: sequence_id } };
}
