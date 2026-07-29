// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * /v1/session routes — relying-party verification of `@cofferdam/sdk`
 * `SignInResponse` artifacts.
 *
 *   POST /v1/session/verify-attestation
 *     Body: {
 *       attestation: string,                  // the `csa1:` token from SignInResponse
 *       expect?: { scope?, appPseudonym?,     // optional field pins
 *                  accountAddress?, chainId? },
 *       maxAgeMs?: number,                    // optional freshness bound
 *       checkOnChain?: boolean                // also confirm the passkey is an
 *     }                                       // active authority on the account
 *
 *   Verifies the passkey-signed envelope binds the sign-in fields to the
 *   presented public key (the cryptographic "session origin" proof). With
 *   `checkOnChain` it additionally reads the on-chain account's authority
 *   registry (Base Sepolia only) to confirm that public key is an active
 *   authority — the full authorisation gate. A counterfactual (not-yet-deployed)
 *   account returns `authority: 'account_not_deployed'`, which is expected before
 *   the user's first on-chain op and does NOT invalidate the attestation.
 */

import { Hono } from 'hono';
import { getAddress, type Address } from 'viem';
import type { Env } from '../env.js';
import { getBaseSepoliaClient } from '../chain/client.js';
import {
  PASSKEY_AUTHORITY_MODULE_BY_SCHEME,
  BASE_SEPOLIA_CHAIN_ID,
} from '../chain/deployments.js';
import {
  decodeAndVerifySessionAttestation,
  encodePasskeyConfig,
  SessionAttestationDecodeError,
  SessionAttestationExpiredError,
  SessionAttestationVerificationError,
  type SessionAttestation,
  type SessionAttestationExpectation,
} from '../services/sessionAttestation.js';

export const sessionRoutes = new Hono<{ Bindings: Env }>();

/** Authority-registry read surface of `CofferdamSmartAccount` (contracts/v2/auth). */
const COFFERDAM_ACCOUNT_ABI = [
  {
    type: 'function',
    name: 'authorityCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getAuthority',
    stateMutability: 'view',
    inputs: [{ name: 'authorityId', type: 'uint256' }],
    outputs: [
      { name: 'module', type: 'address' },
      { name: 'tier', type: 'uint8' },
      { name: 'active', type: 'bool' },
      { name: 'config', type: 'bytes' },
    ],
  },
] as const;

/** Outcome of the optional on-chain authority cross-check. */
type AuthorityCheck =
  | { status: 'active'; authorityId: number; module: Address; tier: number }
  | { status: 'not_found' }
  | { status: 'account_not_deployed' }
  | { status: 'chain_unsupported'; chainId: number }
  | { status: 'check_failed'; message: string };

interface VerifyBody {
  attestation?: unknown;
  expect?: unknown;
  maxAgeMs?: unknown;
  checkOnChain?: unknown;
}

/** Pull a well-typed `expect` from untrusted JSON (ignores unknown keys). */
function parseExpect(raw: unknown): SessionAttestationExpectation | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: SessionAttestationExpectation = {};
  if (typeof o.scope === 'string') out.scope = o.scope;
  if (typeof o.appPseudonym === 'string') out.appPseudonym = o.appPseudonym;
  if (typeof o.accountAddress === 'string') out.accountAddress = o.accountAddress;
  if (typeof o.chainId === 'number') out.chainId = o.chainId;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Read the account's authority registry and confirm the passkey is active. */
async function checkOnChainAuthority(
  att: SessionAttestation,
  rpcUrl: string,
): Promise<AuthorityCheck> {
  if (att.chainId !== BASE_SEPOLIA_CHAIN_ID) {
    return { status: 'chain_unsupported', chainId: att.chainId };
  }
  try {
    const client = getBaseSepoliaClient(rpcUrl);
    const address = getAddress(att.accountAddress) as Address;

    const code = await client.getCode({ address });
    if (!code || code === '0x') return { status: 'account_not_deployed' };

    const expectedConfig = encodePasskeyConfig(att.publicKey).toLowerCase();
    const expectedModule = PASSKEY_AUTHORITY_MODULE_BY_SCHEME[att.alg].toLowerCase();
    const count = await client.readContract({
      address,
      abi: COFFERDAM_ACCOUNT_ABI,
      functionName: 'authorityCount',
    });

    for (let id = 0n; id < count; id++) {
      const [module, tier, active, config] = await client.readContract({
        address,
        abi: COFFERDAM_ACCOUNT_ABI,
        functionName: 'getAuthority',
        args: [id],
      });
      // The authority is THIS passkey iff it's active, holds the same public
      // key (config), AND is verified by the module that matches the
      // attestation's signature scheme (WebAuthn vs raw P-256).
      if (
        active &&
        config.toLowerCase() === expectedConfig &&
        module.toLowerCase() === expectedModule
      ) {
        return { status: 'active', authorityId: Number(id), module, tier };
      }
    }
    return { status: 'not_found' };
  } catch (err) {
    return { status: 'check_failed', message: err instanceof Error ? err.message : String(err) };
  }
}

sessionRoutes.post('/verify-attestation', async (c) => {
  let body: VerifyBody;
  try {
    body = (await c.req.json()) as VerifyBody;
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400);
  }

  if (typeof body.attestation !== 'string') {
    return c.json(
      { ok: false, error: 'bad_attestation', hint: 'expected a csa1: attestation string' },
      400,
    );
  }

  const maxAgeMs =
    typeof body.maxAgeMs === 'number' && Number.isFinite(body.maxAgeMs) && body.maxAgeMs >= 0
      ? body.maxAgeMs
      : undefined;

  let att: SessionAttestation;
  try {
    att = decodeAndVerifySessionAttestation(body.attestation, {
      expect: parseExpect(body.expect),
      maxAgeMs,
    });
  } catch (err) {
    // Map verification failures to a 400 with a stable, machine-readable code.
    let error = 'verification_failed';
    if (err instanceof SessionAttestationDecodeError) error = 'malformed_attestation';
    else if (err instanceof SessionAttestationExpiredError) error = 'attestation_expired';
    else if (err instanceof SessionAttestationVerificationError) error = 'verification_failed';
    return c.json(
      { ok: false, error, message: err instanceof Error ? err.message : String(err) },
      400,
    );
  }

  const claims = {
    scope: att.scope,
    appPseudonym: att.appPseudonym,
    accountAddress: att.accountAddress,
    chainId: att.chainId,
    verified: att.verified,
    issuedAt: att.issuedAt,
    alg: att.alg,
    publicKey: att.publicKey,
  };

  // Signature verified — the holder of `publicKey` authorised exactly these
  // fields. Optionally escalate to the on-chain authorisation check.
  if (body.checkOnChain === true) {
    const authority = await checkOnChainAuthority(att, c.env.BASE_SEPOLIA_RPC_URL);
    return c.json({ ok: true, claims, authority });
  }

  return c.json({ ok: true, claims });
});
