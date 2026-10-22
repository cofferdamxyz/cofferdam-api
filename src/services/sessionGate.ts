// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The session check every gated route shares (workspace decision 0055).
 *
 *   Authorization: DPoP csa1:…     (v2, device-bound)   + DPoP: <proof>
 *   Authorization: Bearer csa1:…   (v1, bearer; while CSA1_V1_ACCEPTED is not "false")
 *
 * A v2 token must be pinned to the account, unexpired, for the plane's
 * audience and of a tier the route accepts; its proof must be signed by the
 * device key the token names, for this method and URL, within a minute, and
 * with a `jti` the key's `PopReplayDO` has not seen. A fast token on a slow
 * route answers `401 step_up_required`, and the app asks for one Face ID.
 *
 * The on-chain High-authority check stays with each route: this module answers
 * only whether the request carries a valid session for the account.
 */

import type { Address } from 'viem';
import type { Env } from '../env.js';
import type { ReplayStore } from './popReplayStore.js';
import {
  POP_MAX_SKEW_S,
  SessionAttestationError,
  decodeAndVerifySessionAttestation,
  decodeAndVerifySessionAttestationV2,
  sessionAttestationVersion,
  verifyPopProof,
  type PasskeySession,
  type SessionTier,
} from './sessionAttestation.js';

/** A refusal, ready for `c.json(body, status)`. */
export interface SessionRefusal {
  status: 401 | 503;
  body: { ok: false; error: string; message?: string; hint?: string; requiredTier?: SessionTier };
}

/** A verified session: the passkey behind it and how it was carried. */
export interface SessionGrant {
  session: PasskeySession;
  /** `legacy` for a v1 bearer token. */
  tier: SessionTier | 'legacy';
}

export interface SessionGateInput {
  env: Env;
  /** The `Authorization` header. */
  authorization: string | undefined;
  /** The `DPoP` header. */
  proof: string | undefined;
  method: string;
  /** The full request URL (`c.req.url`). */
  url: string;
}

export interface SessionGateOptions {
  account: Address;
  /** The tier the route needs; `slow` refuses fast tokens with step-up. */
  requiredTier: SessionTier;
  /** How old a v1 bearer token may be. */
  v1MaxAgeMs: number;
  now: number;
  /** The replay cache; null when `POP_REPLAY_DO` is unbound. */
  replay: ReplayStore | null;
}

/** The token from `Authorization: DPoP …` or `Authorization: Bearer …`, or null. */
export function sessionToken(authorization: string | undefined): string | null {
  const token = authorization?.replace(/^(Bearer|DPoP)\s+/i, '').trim();
  return token ? token : null;
}

function refuse(status: 401 | 503, error: string, message?: string, extra: Partial<SessionRefusal['body']> = {}): SessionRefusal {
  return { status, body: { ok: false, error, ...(message ? { message } : {}), ...extra } };
}

/**
 * Check the request's session for `opts.account`. Returns the grant, or the
 * refusal to send; `null` input tokens answer `attestation_required`.
 */
export async function checkSession(input: SessionGateInput, opts: SessionGateOptions): Promise<SessionGrant | SessionRefusal> {
  const token = sessionToken(input.authorization);
  if (!token) {
    return refuse(401, 'attestation_required', undefined, { hint: 'Authorization: DPoP csa1:… with a DPoP proof' });
  }

  let version: number;
  try {
    version = sessionAttestationVersion(token);
  } catch (err) {
    return refuse(401, 'attestation_rejected', (err as Error).message);
  }

  if (version === 1) {
    if (input.env.CSA1_V1_ACCEPTED === 'false') {
      return refuse(401, 'attestation_rejected', 'csa1 v1 bearer tokens are no longer accepted; sign in again for a device-bound session.');
    }
    try {
      const att = decodeAndVerifySessionAttestation(token, {
        expect: { accountAddress: opts.account },
        maxAgeMs: opts.v1MaxAgeMs,
        now: opts.now,
      });
      return { session: att, tier: 'legacy' };
    } catch (err) {
      if (err instanceof SessionAttestationError) return refuse(401, 'attestation_rejected', err.message);
      throw err;
    }
  }

  let att;
  try {
    att = decodeAndVerifySessionAttestationV2(token, { expect: { accountAddress: opts.account }, now: opts.now });
  } catch (err) {
    if (err instanceof SessionAttestationError) return refuse(401, 'attestation_rejected', err.message);
    throw err;
  }
  if (opts.requiredTier === 'slow' && att.tier !== 'slow') {
    return refuse(401, 'step_up_required', 'this action needs a fresh passkey confirmation', { requiredTier: 'slow' });
  }
  if (!input.proof) {
    return refuse(401, 'proof_required', 'a device-bound session needs a DPoP proof on every request');
  }

  let checked;
  try {
    checked = verifyPopProof(input.proof, { token, htm: input.method, htu: input.url, now: opts.now });
  } catch (err) {
    if (err instanceof SessionAttestationError) return refuse(401, 'proof_rejected', err.message);
    throw err;
  }
  if (checked.jkt !== att.cnf.jkt) {
    return refuse(401, 'proof_rejected', "the proof is not signed by the session's device key");
  }

  if (!opts.replay) {
    // Development has no Durable Objects to spare; everywhere else an
    // unchecked proof is never accepted.
    if (input.env.ENVIRONMENT !== 'development') {
      return refuse(503, 'replay_store_unavailable', 'the proof replay cache is not bound');
    }
  } else {
    const fresh = await opts.replay.claim(
      att.cnf.jkt,
      `jti:${checked.jti}`,
      opts.now + 2 * POP_MAX_SKEW_S * 1000,
      opts.now,
    );
    if (!fresh) return refuse(401, 'proof_rejected', 'this proof has already been used');
  }

  const { v: _v, sig: _sig, expiresAt: _e, aud: _a, tier: _t, cnf: _c, ...session } = att;
  return { session, tier: att.tier };
}

/** Whether `checkSession` refused. */
export function isRefusal(result: SessionGrant | SessionRefusal): result is SessionRefusal {
  return 'status' in result;
}
