// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The ceremony co-sign gate (decision 0016).
 *
 * `CofferdamAccount4337.enrollFirstHigh` puts the first High (`cofferdam.xyz`)
 * passkey on a Partner or Managed account with three signatures: the account's
 * Partner or Managed authority signs the userOp, the new passkey proves
 * possession and RP with a WebAuthn assertion over
 * `firstHighChallenge(ceremonyNonce)`, and a Cofferdam ceremony attester
 * co-signs `ceremonyHash(...)`. This module decides whether the plane issues
 * that third signature. It is pure: every chain read and the attester call
 * come in through `CeremonyDeps`, so the gate unit-tests without a network.
 *
 * What the gate checks before asking the attester:
 *   1. the account is deployed and pins our module registry and our ceremony
 *      attester registry (so it came from our factory);
 *   2. no High exists yet (`upgradeLocked == false`);
 *   3. the signing authority is an active Partner or Managed one;
 *   4. the new key is the pinned High module and its assertion verifies over
 *      the account's own challenge for the current nonce, through the module's
 *      `isValidSignature` (RP pin and UV enforced on-chain);
 *   5. the attester's hash equals the account's `ceremonyHash` for the same
 *      inputs (encoding drift fails closed).
 * The window is short (ten minutes) and the nonce makes it single-use.
 *
 * Not yet here: the partner `csa1:` session check and the 72-hour cooldown
 * after a recovery (both need the partner registry and recovery records that
 * decision 0016 lists as plane work). The Partner authority still has to sign
 * the op itself, so an attestation alone moves nothing.
 */

import { getAddress, isAddress, isHex, keccak256, size, slice, toBytes, type Address, type Hex } from 'viem';
import type { SignCeremonyRequest, SignCeremonyResponse } from './attester.js';

/** `CofferdamAccount4337.ACTION_ENROLL_FIRST_HIGH`. */
export const ACTION_ENROLL_FIRST_HIGH: Hex = keccak256(toBytes('enroll-first-high'));

/** The on-chain `Tier` enum. */
export const TIER = { None: 0, LowUntrusted: 1, LowManaged: 2, High: 3, Partner: 4 } as const;

export const ZERO_WORD: Hex = `0x${'00'.repeat(32)}`;

/** Ten minutes of validity, one minute of clock skew. */
export const DEFAULT_WINDOW_SECONDS = 600;
export const DEFAULT_SKEW_SECONDS = 60;

/** Largest WebAuthn assertion blob the route accepts (4 KiB is generous). */
const MAX_ASSERTION_BYTES = 4096;

export const CEREMONY_ACCOUNT_ABI = [
  { type: 'function', name: 'upgradeLocked', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'ceremonyNonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'MODULE_REGISTRY', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'CEREMONY_ATTESTERS', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'firstHighChallenge',
    stateMutability: 'view',
    inputs: [{ name: 'nonce', type: 'uint256' }],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'ceremonyHash',
    stateMutability: 'view',
    inputs: [
      { name: 'action', type: 'bytes32' },
      { name: 'newKeyHash', type: 'bytes32' },
      { name: 'partnerId', type: 'bytes32' },
      { name: 'nonce', type: 'uint256' },
      { name: 'notBefore', type: 'uint48' },
      { name: 'expiry', type: 'uint48' },
    ],
    outputs: [{ type: 'bytes32' }],
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

export const AUTHORITY_MODULE_ABI = [
  {
    type: 'function',
    name: 'isValidSignature',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'digest', type: 'bytes32' },
      { name: 'config', type: 'bytes' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

export class CeremonyRequestError extends Error {
  constructor(
    readonly code:
      | 'bad_request'
      | 'account_not_deployed'
      | 'not_a_cofferdam_account'
      | 'high_already_exists'
      | 'signer_not_eligible'
      | 'high_module_not_allowed'
      | 'assertion_invalid'
      | 'ceremony_hash_mismatch',
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CeremonyRequestError';
  }
}

function bad(message: string): never {
  throw new CeremonyRequestError('bad_request', message, 400);
}

/** `POST /v1/ceremony/first-high` body, parsed. */
export interface FirstHighRequest {
  readonly account: Address;
  /** The Partner or Managed authority that will sign the `enrollFirstHigh` op. */
  readonly signerId: bigint;
  /** The High module the new key installs; must be the pinned WebAuthn authority. */
  readonly highModule: Address;
  /** `abi.encode(qx, qy)` of the new passkey. */
  readonly highConfig: Hex;
  /** `abi.encode(WebAuthnAuth)` over `firstHighChallenge(ceremonyNonce)`. */
  readonly highAssertion: Hex;
}

export function parseFirstHighBody(body: unknown, defaultHighModule: Address): FirstHighRequest {
  if (!body || typeof body !== 'object') bad('body must be a JSON object');
  const b = body as Record<string, unknown>;
  const account = b.account;
  if (typeof account !== 'string' || !isAddress(account)) bad('account must be an address');
  const signerRaw = b.signerId ?? 0;
  const signerStr = typeof signerRaw === 'number' ? String(signerRaw) : signerRaw;
  if (typeof signerStr !== 'string' || !/^\d+$/.test(signerStr)) bad('signerId must be a non-negative integer');
  const highModule = b.highModule ?? defaultHighModule;
  if (typeof highModule !== 'string' || !isAddress(highModule)) bad('highModule must be an address');
  const highConfig = b.highConfig;
  if (typeof highConfig !== 'string' || !isHex(highConfig) || size(highConfig) !== 64) {
    bad('highConfig must be abi.encode(qx, qy): 64 bytes of hex');
  }
  const highAssertion = b.highAssertion;
  if (typeof highAssertion !== 'string' || !isHex(highAssertion) || size(highAssertion) === 0) {
    bad('highAssertion must be a non-empty hex string');
  }
  if (size(highAssertion) > MAX_ASSERTION_BYTES) bad('highAssertion is too large');
  return {
    account: getAddress(account as string),
    signerId: BigInt(signerStr as string),
    highModule: getAddress(highModule as string),
    highConfig: (highConfig as string).toLowerCase() as Hex,
    highAssertion: (highAssertion as string).toLowerCase() as Hex,
  };
}

/** What the gate reads from the account. */
export interface AccountSnapshot {
  readonly upgradeLocked: boolean;
  readonly nonce: bigint;
  readonly moduleRegistry: Address;
  readonly ceremonyRegistry: Address;
  /** `firstHighChallenge(nonce)`. */
  readonly challenge: Hex;
  readonly signer: { readonly module: Address; readonly tier: number; readonly active: boolean; readonly config: Hex };
}

export interface CeremonyPins {
  readonly chainId: bigint;
  readonly moduleRegistry: Address;
  readonly ceremonyRegistry: Address;
  /** The only High module the plane co-signs for: `WebAuthnPasskeyAuthority`. */
  readonly highModule: Address;
}

export interface CeremonyHashArgs {
  readonly action: Hex;
  readonly newKeyHash: Hex;
  readonly partnerId: Hex;
  readonly nonce: bigint;
  readonly notBefore: bigint;
  readonly expiry: bigint;
}

export interface CeremonyDeps {
  readonly pins: CeremonyPins;
  /** Read the account; throws `account_not_deployed` when there is no code. */
  readAccount(account: Address, signerId: bigint): Promise<AccountSnapshot>;
  /** `module.isValidSignature(account, challenge, config, assertion)`; false on revert. */
  verifyAssertion(module: Address, account: Address, challenge: Hex, config: Hex, assertion: Hex): Promise<boolean>;
  /** `account.ceremonyHash(...)` for the cross-check. */
  onChainCeremonyHash(account: Address, args: CeremonyHashArgs): Promise<Hex>;
  /** The attester Worker's `signCeremony`. */
  sign(req: SignCeremonyRequest): Promise<SignCeremonyResponse>;
  /** Unix seconds; injected by tests. */
  now?: () => number;
  windowSeconds?: number;
  skewSeconds?: number;
}

export interface FirstHighAttestation {
  readonly account: Address;
  readonly signerId: string;
  readonly nonce: string;
  readonly challenge: Hex;
  readonly highModule: Address;
  readonly newKeyHash: Hex;
  readonly partnerId: Hex;
  /** The `CeremonyAttestation` struct for `enrollFirstHigh`. */
  readonly attestation: { readonly notBefore: string; readonly expiry: string; readonly signature: Hex };
  readonly attesterAddress: Address;
  readonly ceremonyHash: Hex;
}

/** The `partnerId` word of a Partner config (`qx, qy, rpIdHash, partnerId, partnerSigner`). */
export function partnerIdOf(tier: number, config: Hex): Hex {
  if (tier !== TIER.Partner) return ZERO_WORD;
  if (size(config) !== 160) {
    throw new CeremonyRequestError('signer_not_eligible', 'Partner authority config is not 160 bytes', 409);
  }
  return slice(config, 96, 128);
}

export async function issueFirstHighAttestation(deps: CeremonyDeps, req: FirstHighRequest): Promise<FirstHighAttestation> {
  const { pins } = deps;
  if (getAddress(req.highModule) !== getAddress(pins.highModule)) {
    throw new CeremonyRequestError(
      'high_module_not_allowed',
      `High is a cofferdam.xyz passkey on ${pins.highModule}; ${req.highModule} is not co-signed`,
      409,
    );
  }

  const snap = await deps.readAccount(req.account, req.signerId);
  if (
    getAddress(snap.moduleRegistry) !== getAddress(pins.moduleRegistry) ||
    getAddress(snap.ceremonyRegistry) !== getAddress(pins.ceremonyRegistry)
  ) {
    throw new CeremonyRequestError('not_a_cofferdam_account', 'account does not pin the Cofferdam registries', 409);
  }
  if (snap.upgradeLocked) {
    throw new CeremonyRequestError('high_already_exists', 'account already has a High authority', 409);
  }
  const { signer } = snap;
  if (!signer.active || (signer.tier !== TIER.Partner && signer.tier !== TIER.LowManaged)) {
    throw new CeremonyRequestError(
      'signer_not_eligible',
      `authority ${req.signerId.toString()} is not an active Partner or Managed authority`,
      409,
    );
  }
  const partnerId = partnerIdOf(signer.tier, signer.config);

  const ok = await deps.verifyAssertion(req.highModule, req.account, snap.challenge, req.highConfig, req.highAssertion);
  if (!ok) {
    throw new CeremonyRequestError(
      'assertion_invalid',
      'the new passkey did not prove the account challenge (RP, UV or signature)',
      422,
    );
  }

  const now = BigInt(deps.now ? deps.now() : Math.floor(Date.now() / 1000));
  const notBefore = now - BigInt(deps.skewSeconds ?? DEFAULT_SKEW_SECONDS);
  const expiry = now + BigInt(deps.windowSeconds ?? DEFAULT_WINDOW_SECONDS);
  const newKeyHash = keccak256(req.highConfig);
  const args: CeremonyHashArgs = { action: ACTION_ENROLL_FIRST_HIGH, newKeyHash, partnerId, nonce: snap.nonce, notBefore, expiry };

  const signed = await deps.sign({
    chainId: pins.chainId.toString(),
    account: req.account,
    action: 'enroll-first-high',
    newKeyHash,
    partnerId,
    nonce: snap.nonce.toString(),
    notBefore: notBefore.toString(),
    expiry: expiry.toString(),
  });

  const expected = await deps.onChainCeremonyHash(req.account, args);
  if (expected.toLowerCase() !== signed.messageHash.toLowerCase()) {
    throw new CeremonyRequestError(
      'ceremony_hash_mismatch',
      'attester hash differs from the account ceremonyHash; refusing to hand out the signature',
      500,
    );
  }

  return {
    account: req.account,
    signerId: req.signerId.toString(),
    nonce: snap.nonce.toString(),
    challenge: snap.challenge,
    highModule: req.highModule,
    newKeyHash,
    partnerId,
    attestation: { notBefore: notBefore.toString(), expiry: expiry.toString(), signature: signed.signature },
    attesterAddress: getAddress(signed.attesterAddress),
    ceremonyHash: signed.messageHash,
  };
}
