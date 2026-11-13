// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The log policy of the identity routes (workspace decision 0080, item 4 of
 * milestone M1).
 *
 * A log line of an identity route never carries a passport identifier (Self's
 * nullifier, a ZKPassport identifier or its keyed tag), a proof or its public
 * inputs, the evidence an op carries, `custom_data` or Self's
 * `userContextData`, the op's `callData`, `initCode` or signature, or a second
 * account bound to the same passport. Lines name the account or the network
 * (and Workers Logs keep the request's IP beside them), so any of these next to
 * it links a passport to an account or a person, in logs kept outside the
 * chain's own record. A revert reason is logged by its error's name only
 * (`userOpOutcome.ts`), since the registries' errors carry the identifier.
 *
 * The identity routes: `/v1/self/*` (until Self retires), the relay
 * `/v1/aa/user-operation` (a bind is an op of the account's own) and
 * `/v1/attester/*`. `test/identityLogs.test.ts` drives them with a recorded
 * console and fails on any line that holds one of these keys or values.
 */

/** Keys a line of an identity route may not hold, at any depth. */
export const IDENTITY_LOG_FORBIDDEN_KEY =
  /nullifier|identifier|proof|evidence|custom_?data|user_?context|pub(lic)?_?signals|call_?data|init_?code|signature|previous_?account|bound_?account/i;

function bigintAsString(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function withoutForbidden(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutForbidden);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!IDENTITY_LOG_FORBIDDEN_KEY.test(k)) out[k] = withoutForbidden(v);
    }
    return out;
  }
  return value;
}

/**
 * One JSON log line of an identity route: the forbidden keys dropped at every
 * depth, bigints as decimal strings. The drop is a backstop; a caller still
 * passes only what the policy allows.
 */
export function identityLogLine(fields: Record<string, unknown>): string {
  return JSON.stringify(withoutForbidden(fields), bigintAsString);
}
