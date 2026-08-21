// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * /v1/attester routes.
 *
 * Smoke-test endpoint(s) that exercise the cross-Worker plumbing:
 *
 *   POST /v1/attester/test-sign  → builds a synthetic pubSignals array
 *                                  for `account`, calls the attester
 *                                  Worker via service binding, then
 *                                  verifies the resulting signature
 *                                  on-chain via
 *                                  SelfAttesterRegistry.verifyAttesterSig.
 *
 * If `onchainValid: true` comes back, the full identity rail is wired:
 *   1. cofferdam-api → cofferdam-attester service binding works
 *   2. attester key signs the canonical preimage byte-for-byte
 *   3. attester address is allow-listed in SelfAttesterRegistry
 *   4. EIP-191 + ECDSA recovery agree between viem and Solidity
 *
 * NOTE: this endpoint produces a real signature. It does NOT submit
 * `verifyAndBind` (the synthetic pubSignals would fail the Groth16
 * proof and the nullifier mappings), but a leaked pair would be a
 * minor info-disclosure (signed nonce + scope) — fine for α
 * development, gate behind ENVIRONMENT before mainnet.
 */

import { Hono } from 'hono';
import {
  concat,
  encodePacked,
  getAddress,
  isAddress,
  pad,
  ripemd160,
  sha256,
  stringToHex,
  type Hex,
} from 'viem';
import type { Env } from '../env.js';
import { getBaseSepoliaClient } from '../chain/client.js';
import { SEPOLIA_DEPLOYMENTS, BASE_SEPOLIA_CHAIN_ID } from '../chain/deployments.js';

export const attesterRoutes = new Hono<{ Bindings: Env }>();

// ─────────────────────────────────────────────────────────────────
// Constants — kept local to the test endpoint until a richer chain
// manifest justifies promoting them.
// ─────────────────────────────────────────────────────────────────

/** uint256 indices for the `vc_and_disclose` proof's 21 public signals. */
const PUB_SIGNAL_INDEX = {
  NULLIFIER: 7,
  ATTESTATION_ID: 8,
  SCOPE: 19,
  USER_IDENTIFIER: 20,
} as const;

const PUB_SIGNALS_LENGTH = 21;

/** Self.xyz `AttestationId.E_PASSPORT`. */
const E_PASSPORT_ATTESTATION_ID = 1n;

/**
 * Poseidon hash of `cofferdam.xyz` × `cofferdam-bind-v1` — the scope
 * locked into `NullifierRegistry.expectedScope`.
 *
 * Mirrors `COFFERDAM_BIND_V1_SCOPE` in
 * `base-contracts/scripts/lib/selfScope.ts` (which asserts the value
 * against Self's own derivation in a unit test) and
 * `SelfApp.scope` in `cofferdam-app/src/features/self/selfAppConfig.ts`.
 * Re-vendor together with `SEPOLIA_DEPLOYMENTS` whenever the registry
 * is redeployed — `expectedScope` is immutable.
 */
const COFFERDAM_BIND_V1_SCOPE =
  9385173979550103756914225592429331034074493553395666193753061396908251355773n;

/**
 * `destChainID` the app declares in its `SelfApp` config. Self folds this
 * into the `userIdentifier` commitment, so it must match
 * `NullifierRegistry.selfDestChainId`. This is Self's destination-chain
 * field, NOT Base Sepolia's 84532.
 */
const SELF_DEST_CHAIN_ID = 42220;

/**
 * Rebuild the `userContextData` preimage Self commits to.
 * Layout: `abi.encodePacked(bytes32(destChainId), bytes32(userId), userDefinedData)`.
 * Mirrors `getSolidityPackedUserContextData` in `self/common/src/utils/hash.ts`.
 */
function buildUserContextData(
  destChainId: number,
  userId: Hex,
  userDefinedData = '',
): Hex {
  return concat([
    // `uint256` already encodes to exactly 32 bytes; `userId` is left-padded
    // the same way Self's `zeroPadValue(..., 32)` does.
    encodePacked(['uint256'], [BigInt(destChainId)]),
    pad(userId, { size: 32 }),
    userDefinedData === '' ? '0x' : stringToHex(userDefinedData),
  ]);
}

/**
 * The `vc_and_disclose` circuit's `userIdentifier` public signal is NOT the
 * user's address — it is `uint160(ripemd160(sha256(userContextData)))`.
 * Mirrors `calculateUserIdentifierHash` in `self/common/src/utils/hash.ts`
 * and `NullifierRegistry._checkUserContext` on-chain.
 */
function calculateUserIdentifierHash(userContextData: Hex): bigint {
  return BigInt(ripemd160(sha256(userContextData)));
}

/** Minimal ABI fragment for `SelfAttesterRegistry.verifyAttesterSig`. */
const SELF_ATTESTER_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'verifyAttesterSig',
    stateMutability: 'view',
    inputs: [
      { name: 'messageHash', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

// ─────────────────────────────────────────────────────────────────
// POST /v1/attester/test-sign
// ─────────────────────────────────────────────────────────────────

interface TestSignBody {
  account?: unknown;
  nullifier?: unknown;
}

attesterRoutes.post('/test-sign', async (c) => {
  // ── Parse body ──────────────────────────────────────────────
  let body: TestSignBody;
  try {
    body = (await c.req.json()) as TestSignBody;
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400);
  }

  if (typeof body.account !== 'string' || !isAddress(body.account)) {
    return c.json(
      { ok: false, error: 'bad_account', hint: 'expected 0x-prefixed EIP-55 address' },
      400,
    );
  }
  const account = getAddress(body.account);

  // Optional caller-supplied nullifier; default to a deterministic
  // non-zero value so re-running the smoke test is idempotent.
  let nullifier: bigint;
  if (body.nullifier === undefined) {
    nullifier = 1n; // sentinel; never actually bound on-chain.
  } else if (typeof body.nullifier === 'string' && /^\d+$/.test(body.nullifier)) {
    nullifier = BigInt(body.nullifier);
  } else {
    return c.json(
      { ok: false, error: 'bad_nullifier', hint: 'expected decimal string' },
      400,
    );
  }

  // ── Build synthetic pubSignals ──────────────────────────
  // `userIdentifier` must be the commitment over userContextData, not the
  // raw address — the registry recomputes it and rejects any mismatch.
  const userContextData = buildUserContextData(SELF_DEST_CHAIN_ID, account);

  const pubSignals = new Array<bigint>(PUB_SIGNALS_LENGTH).fill(0n);
  pubSignals[PUB_SIGNAL_INDEX.NULLIFIER] = nullifier;
  pubSignals[PUB_SIGNAL_INDEX.ATTESTATION_ID] = E_PASSPORT_ATTESTATION_ID;
  pubSignals[PUB_SIGNAL_INDEX.SCOPE] = COFFERDAM_BIND_V1_SCOPE;
  pubSignals[PUB_SIGNAL_INDEX.USER_IDENTIFIER] =
    calculateUserIdentifierHash(userContextData);

  const pubSignalsStr = pubSignals.map((x) => x.toString());

  // ── Call attester via service binding ───────────────────────
  const registry: Hex = SEPOLIA_DEPLOYMENTS.NullifierRegistry.address;
  let signed: Awaited<ReturnType<typeof c.env.ATTESTER.signBind>>;
  try {
    signed = await c.env.ATTESTER.signBind({
      registry,
      account,
      pubSignals: pubSignalsStr,
      userContextData,
    });
  } catch (err) {
    return c.json(
      {
        ok: false,
        error: 'attester_rpc_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }

  // ── Verify on-chain ────────────────────────────────────────
  const client = getBaseSepoliaClient(c.env.BASE_SEPOLIA_RPC_URL);
  let onchainValid: boolean;
  try {
    onchainValid = await client.readContract({
      address: SEPOLIA_DEPLOYMENTS.SelfAttesterRegistry.address,
      abi: SELF_ATTESTER_REGISTRY_ABI,
      functionName: 'verifyAttesterSig',
      args: [signed.messageHash, signed.signature],
    });
  } catch (err) {
    return c.json(
      {
        ok: false,
        stage: 'onchain_verify',
        error: 'rpc_failed',
        message: err instanceof Error ? err.message : String(err),
        signed,
      },
      502,
    );
  }

  return c.json({
    ok: true,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    registry,
    account,
    pubSignals: pubSignalsStr,
    userContextData,
    signed,
    onchainValid,
  });
});
