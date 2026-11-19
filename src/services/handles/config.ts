// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The handle registry's settings read from the env (workspace decision 0086;
 * runbook `docs/runbooks/handles-build.md`, step 3), each with its default.
 *
 * **Unbuilt gates.** Three checks 0086 asks of the claim and the handle-scoped
 * requests wait on work not built anywhere yet:
 * - `device-attestation`: the App Attest or Play Integrity assertion on a hold
 *   and a claim (rule 4, q20), decision 0078's first build item;
 * - `install-proof`: 0082's install proof beside every handle-scoped request
 *   (q12), device-sync steps 6, 7 and 10;
 * - `locator-pin`: the pinned mirror locator's signature on a claim, a rename, a
 *   release, an advance and an unfreeze (q19), device-sync step 4.
 * `HANDLES_SKIP_UNBUILT_GATES` names those a deployment goes without (a comma
 * list). A gate not named refuses its routes with `503 <gate>_unbuilt`, so
 * nothing passes a check that does not exist by default. `ENVIRONMENT=production`
 * ignores the list: production refuses until each gate is built. The Sepolia test
 * deployment names all three; with them skipped a handle-scoped request needs the
 * account's High session and the handle key's signature, as 0086 rule 4 first
 * said (q12's recommended install proof is stronger).
 */

import { getAddress, type Address } from 'viem';

import { BASE_SEPOLIA_CHAIN_ID } from '../../chain/deployments.js';
import type { Env } from '../../env.js';

export const UNBUILT_GATES = ['device-attestation', 'install-proof', 'locator-pin'] as const;
export type UnbuiltGate = (typeof UNBUILT_GATES)[number];

/** Whether a deployment goes without `gate` (never in production). */
export function skipsGate(env: Env, gate: UnbuiltGate): boolean {
  if (env.ENVIRONMENT === 'production') return false;
  return (env.HANDLES_SKIP_UNBUILT_GATES ?? '')
    .split(',')
    .map((s) => s.trim())
    .includes(gate);
}

/** The chain the anchor and the registry's typed data name: Base Sepolia until the production cut. */
export const HANDLES_CHAIN_ID = BASE_SEPOLIA_CHAIN_ID;

/** `HANDLE_ANCHOR_ADDRESS`, or null while the anchor is not deployed. */
export function anchorAddressOf(env: Env): Address | null {
  const raw = env.HANDLE_ANCHOR_ADDRESS?.trim();
  return raw && /^0x[0-9a-fA-F]{40}$/.test(raw) ? getAddress(raw) : null;
}

/** A `min,max` pair of seconds, else the default. */
function delayRange(raw: string | undefined, fallback: [number, number]): [number, number] {
  const m = raw?.trim().match(/^(\d{1,8}),(\d{1,8})$/);
  if (!m) return fallback;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  return lo <= hi ? [lo, hi] : fallback;
}

/** A claim's relay delay (rule 3: minutes to hours): `HANDLES_RELAY_DELAY_S`, else 10 minutes to 3 hours. */
export const claimDelayRange = (env: Env) => delayRange(env.HANDLES_RELAY_DELAY_S, [600, 3 * 3600]);
/** A rename's release delay (rule 3: one to seven days): `HANDLES_RELEASE_DELAY_S`, else that. */
export const releaseDelayRange = (env: Env) => delayRange(env.HANDLES_RELEASE_DELAY_S, [86_400, 7 * 86_400]);

/** A uniform draw in `[lo, hi]` seconds, as milliseconds. */
export function randomDelayMs([lo, hi]: [number, number]): number {
  const span = hi - lo + 1;
  const draw = crypto.getRandomValues(new Uint32Array(1))[0]! % span;
  return (lo + draw) * 1000;
}

/** How long a held label is held (q20): 14 days. */
export const HOLD_MS = 14 * 24 * 60 * 60 * 1000;
/** The window the limits count over (q20, rule 7): 30 days. */
export const LIMIT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** A registry request's expiry may sit at most this far ahead. */
export const REQUEST_MAX_AHEAD_S = 10 * 60;
/** The Verified statement's life (rule 9): 30 days. */
export const VERIFIED_TTL_S = 30 * 24 * 60 * 60;

/**
 * The limits, each over 30 days. ASSUMPTION(0086 q20 and rule 4): 0086 asks for
 * a limit per install and per account without numbers; these are this build's.
 */
export const LIMITS = {
  /** Holds per identity (one at a time, by the unique index; replacing one counts). */
  holdsPerIdentity: 3,
  /** Holds and claims together per install (the session's passkey). */
  perInstall: 6,
  /** Claims per identity (a rename's claim counts). */
  claimsPerIdentity: 3,
  /** Renames per identity (rule 7: at most once in 30 days). */
  renamesPerIdentity: 1,
} as const;
