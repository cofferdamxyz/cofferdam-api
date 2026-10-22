// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Submitting the relayer's signed `handleOps` transaction with one retry.
 *
 * The relay signs once and resends the same raw transaction on a transient
 * node error: an identical signed transaction can land at most once, so a
 * resend never double-submits. A nonce or fee clash (another relayer
 * transaction took the nonce, or the node wants a higher fee) re-signs with a
 * fresh nonce and fee. "Already known" means the first send reached the node:
 * that is success, with the hash of the signed bytes. Anything else is final.
 *
 * Pure apart from the injected `sign` and `send`, so the tests drive it with
 * fakes. On 2026-10-16 a relay attempt failed after simulation passed and the
 * user's second try succeeded; the node's reason was not logged, so every
 * attempt now reports through `onAttemptError`.
 */

import { keccak256, type Hex } from 'viem';

export type SendErrorClass = 'already_known' | 'nonce' | 'transient' | 'fatal';

const ALREADY_KNOWN = /already known|known transaction|already imported|already exists/i;
const NONCE_OR_FEE = /nonce too low|nonce too high|nonce has already been used|replacement transaction underpriced|transaction underpriced/i;
const TRANSIENT =
  /rate.?limit|too many requests|\b429\b|\b50[0234]\b|timeout|timed out|fetch failed|network error|econnreset|socket hang up|http request failed|temporarily unavailable|service unavailable|header not found|internal error/i;

/** What a failed `eth_sendRawTransaction` means for the retry. */
export function classifySendError(message: string): SendErrorClass {
  if (ALREADY_KNOWN.test(message)) return 'already_known';
  if (NONCE_OR_FEE.test(message)) return 'nonce';
  if (TRANSIENT.test(message)) return 'transient';
  return 'fatal';
}

export interface SendWithRetryOptions {
  /** Prepare and sign the transaction; `fresh` re-reads nonce and fees. */
  sign: (fresh: boolean) => Promise<Hex>;
  /** `eth_sendRawTransaction`; resolves with the node's hash. */
  send: (raw: Hex) => Promise<Hex>;
  /** Total attempts (default 2: the send and one retry). */
  attempts?: number;
  onAttemptError?: (attempt: number, cls: SendErrorClass, message: string) => void;
}

function messageOf(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { details?: unknown; shortMessage?: unknown; message?: unknown };
    for (const v of [e.details, e.shortMessage, e.message]) if (typeof v === 'string' && v) return v;
  }
  return String(err);
}

/** Send a signed transaction, retrying once per the classes above; resolves with its hash. */
export async function sendWithRetry(opts: SendWithRetryOptions): Promise<Hex> {
  const attempts = Math.max(1, opts.attempts ?? 2);
  let raw = await opts.sign(false);
  for (let attempt = 1; ; attempt++) {
    try {
      return await opts.send(raw);
    } catch (err) {
      const message = messageOf(err);
      const cls = classifySendError(message);
      opts.onAttemptError?.(attempt, cls, message);
      if (cls === 'already_known') return keccak256(raw);
      if (cls === 'fatal' || attempt >= attempts) throw new Error(message, { cause: err });
      if (cls === 'nonce') raw = await opts.sign(true);
    }
  }
}
