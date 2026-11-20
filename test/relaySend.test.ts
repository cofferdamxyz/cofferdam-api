// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { keccak256, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { classifySendError, isRateLimited, RETRY_DELAYS_MS, SendRefusedError, sendWithRetry } from '../src/services/relaySend.js';

const RAW1 = '0x02f86d0101' as Hex;
const RAW2 = '0x02f86d0202' as Hex;

function harness(failures: string[]) {
  const signs: boolean[] = [];
  const sent: Hex[] = [];
  const logged: string[] = [];
  const waits: number[] = [];
  const opts = {
    sleep: async (ms: number) => {
      waits.push(ms);
    },
    sign: async (fresh: boolean) => {
      signs.push(fresh);
      return fresh ? RAW2 : RAW1;
    },
    send: async (raw: Hex) => {
      sent.push(raw);
      const f = failures.shift();
      if (f) throw Object.assign(new Error('HTTP request failed.'), { details: f });
      return keccak256(raw);
    },
    onAttemptError: (attempt: number, cls: string) => logged.push(`${attempt}:${cls}`),
  };
  return { opts, signs, sent, logged, waits };
}

describe('classifySendError', () => {
  it('sorts node answers into the retry classes', () => {
    expect(classifySendError('already known')).toBe('already_known');
    expect(classifySendError('nonce too low: next nonce 13, tx nonce 12')).toBe('nonce');
    expect(classifySendError('replacement transaction underpriced')).toBe('nonce');
    expect(classifySendError('429 Too Many Requests')).toBe('transient');
    expect(classifySendError('The request took too long to respond. timeout')).toBe('transient');
    expect(classifySendError('insufficient funds for gas * price + value')).toBe('fatal');
    expect(classifySendError('exceeds block gas limit')).toBe('fatal');
  });

  it('knows a rate limit from other transient errors', () => {
    expect(isRateLimited('Too Many Requests')).toBe(true);
    expect(isRateLimited('HTTP 429')).toBe(true);
    expect(isRateLimited('rate limit exceeded')).toBe(true);
    expect(isRateLimited('503 Service Unavailable')).toBe(false);
    expect(isRateLimited('timeout')).toBe(false);
  });
});

describe('sendWithRetry', () => {
  it('sends once when the node accepts', async () => {
    const h = harness([]);
    expect(await sendWithRetry(h.opts)).toBe(keccak256(RAW1));
    expect(h.sent).toEqual([RAW1]);
  });

  it('resends the same signed bytes after a transient error', async () => {
    const h = harness(['503 Service Unavailable']);
    expect(await sendWithRetry(h.opts)).toBe(keccak256(RAW1));
    expect(h.sent).toEqual([RAW1, RAW1]);
    expect(h.signs).toEqual([false]);
    expect(h.logged).toEqual(['1:transient']);
    expect(h.waits).toEqual([RETRY_DELAYS_MS[0]]);
  });

  it('waits longer before each transient resend, and not before a re-sign', async () => {
    const backoff = harness(['429 Too Many Requests', '429 Too Many Requests']);
    expect(await sendWithRetry(backoff.opts)).toBe(keccak256(RAW1));
    expect(backoff.sent).toEqual([RAW1, RAW1, RAW1]);
    expect(backoff.waits).toEqual([...RETRY_DELAYS_MS]);
    const nonce = harness(['nonce too low']);
    await sendWithRetry(nonce.opts);
    expect(nonce.waits).toEqual([]);
  });

  it('says the node took nothing only when every attempt was refused as rate-limited', async () => {
    const limited = harness(['429 Too Many Requests', 'Too Many Requests', 'rate limit exceeded']);
    const err = await sendWithRetry(limited.opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendRefusedError);
    expect((err as SendRefusedError).rateLimited).toBe(true);
    // A timeout may have reached the node: the send is not known to be untaken.
    const mixed = harness(['timeout', '429 Too Many Requests', '429 Too Many Requests']);
    const mixedErr = (await sendWithRetry(mixed.opts).catch((e: unknown) => e)) as SendRefusedError;
    expect(mixedErr.rateLimited).toBe(false);
    const fatal = harness(['insufficient funds for gas']);
    expect(((await sendWithRetry(fatal.opts).catch((e: unknown) => e)) as SendRefusedError).rateLimited).toBe(false);
  });

  it('re-signs with a fresh nonce after a nonce clash', async () => {
    const h = harness(['nonce too low']);
    expect(await sendWithRetry(h.opts)).toBe(keccak256(RAW2));
    expect(h.sent).toEqual([RAW1, RAW2]);
    expect(h.signs).toEqual([false, true]);
  });

  it('treats "already known" as success with the hash of the signed bytes', async () => {
    const h = harness(['503 gateway', 'already known']);
    expect(await sendWithRetry(h.opts)).toBe(keccak256(RAW1));
  });

  it('gives up on a fatal error at once and after the last attempt otherwise', async () => {
    const fatal = harness(['insufficient funds for gas']);
    await expect(sendWithRetry(fatal.opts)).rejects.toThrow(/insufficient funds/);
    expect(fatal.sent).toHaveLength(1);
    const thrice = harness(['timeout', 'timeout', 'timeout']);
    await expect(sendWithRetry(thrice.opts)).rejects.toThrow(/timeout/);
    expect(thrice.sent).toHaveLength(3);
    const once = harness(['timeout']);
    await expect(sendWithRetry({ ...once.opts, attempts: 1 })).rejects.toThrow(/timeout/);
    expect(once.sent).toHaveLength(1);
  });

  it('keeps the outcome when the report itself throws (the bigint log line of 2026-10-16 to 10-30)', async () => {
    const report = () => {
      throw new TypeError('Do not know how to serialize a BigInt');
    };
    const retried = harness(['429 Too Many Requests']);
    expect(await sendWithRetry({ ...retried.opts, onAttemptError: report })).toBe(keccak256(RAW1));
    expect(retried.sent).toEqual([RAW1, RAW1]);
    const fatal = harness(['insufficient funds for gas']);
    await expect(sendWithRetry({ ...fatal.opts, onAttemptError: report })).rejects.toThrow(/insufficient funds/);
  });
});
