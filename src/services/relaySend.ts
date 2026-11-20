// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Submitting the relayer's signed `handleOps` transaction, with retries.
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
 * attempt now reports through `onAttemptError`. A report that throws never
 * changes the outcome: from 2026-10-16 to 10-30 the relay's log line threw on
 * the op's bigint nonce, and every refused send answered that error instead.
 *
 * A transient error waits before the resend (`RETRY_DELAYS_MS`): on 2026-11-19
 * the public Base Sepolia node answered "Too Many Requests" to a device revoke
 * twice within 0.13 s, and the relay gave up. When every attempt was refused as
 * rate-limited, the node took nothing, and `SendRefusedError.rateLimited` says
 * so, so the caller can answer "nothing was sent" instead of "may have been".
 */

import { keccak256, type Hex } from 'viem';

export type SendErrorClass = 'already_known' | 'nonce' | 'transient' | 'fatal';

const ALREADY_KNOWN = /already known|known transaction|already imported|already exists/i;
const NONCE_OR_FEE = /nonce too low|nonce too high|nonce has already been used|replacement transaction underpriced|transaction underpriced/i;
const RATE_LIMITED = /rate.?limit|too many requests|\b429\b/i;
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
  /** Total attempts (default 3: the send and two retries). */
  attempts?: number;
  onAttemptError?: (attempt: number, cls: SendErrorClass, message: string) => void;
  /** Waits before a resend after a transient error; injected by the tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** The wait before the resend that follows attempt n (1-based) after a transient error; a nonce clash re-signs at once. */
export const RETRY_DELAYS_MS = [1_000, 2_500] as const;

/** The send failed for good. `rateLimited`: every attempt was refused as rate-limited, so the node took nothing. */
export class SendRefusedError extends Error {
  constructor(
    message: string,
    readonly rateLimited: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SendRefusedError';
  }
}

/** Whether a node answer is a rate limit (a transient error that also means the transaction was not taken). */
export function isRateLimited(message: string): boolean {
  return RATE_LIMITED.test(message);
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function messageOf(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { details?: unknown; shortMessage?: unknown; message?: unknown };
    for (const v of [e.details, e.shortMessage, e.message]) if (typeof v === 'string' && v) return v;
  }
  return String(err);
}

/** Send a signed transaction, retrying per the classes above; resolves with its hash. */
export async function sendWithRetry(opts: SendWithRetryOptions): Promise<Hex> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const sleep = opts.sleep ?? realSleep;
  let raw = await opts.sign(false);
  let allRateLimited = true;
  for (let attempt = 1; ; attempt++) {
    try {
      return await opts.send(raw);
    } catch (err) {
      const message = messageOf(err);
      const cls = classifySendError(message);
      try {
        opts.onAttemptError?.(attempt, cls, message);
      } catch {
        // The report is only a log: it never changes what the relay does.
      }
      if (cls === 'already_known') return keccak256(raw);
      allRateLimited &&= isRateLimited(message);
      if (cls === 'fatal' || attempt >= attempts) throw new SendRefusedError(message, allRateLimited, { cause: err });
      if (cls === 'nonce') raw = await opts.sign(true);
      else await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1]!);
    }
  }
}
