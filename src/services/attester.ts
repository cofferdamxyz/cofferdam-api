// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local copy of the Cofferdam attester RPC contract.
 *
 * **MUST stay byte-compatible with** `cofferdam-attester/src/rpc.ts`.
 *
 * Cloudflare service bindings resolve at runtime, but TypeScript
 * needs a static interface to type the binding. Since the two
 * Workers live in separate npm packages with separate tsconfigs,
 * we duplicate the interface here with this comment as the
 * coupling marker. A future `@cofferdam/types` package will absorb
 * the duplication.
 *
 * Wire shape rationale: bigints serialised as decimal strings, see
 * the source file in cofferdam-attester for the full reasoning.
 */

import type { Hex } from 'viem';

export interface SignBindRequest {
  readonly registry: Hex;
  readonly account: Hex;
  readonly pubSignals: readonly string[];
  /**
   * Preimage of the proof's `userIdentifier` signal:
   * `abi.encodePacked(bytes32(SelfApp.chainID), bytes32(userId), userDefinedData)`.
   * Signal 20 is a `ripemd160(sha256(...))` commitment, not the raw address,
   * so the attester needs the preimage to tie the proof to `account`.
   */
  readonly userContextData: Hex;
}

/** What the attester's Celo gate established before signing (decision 0004). */
export interface CeloGateReceipt {
  /** Celo chain id the gate read from (`42220`). */
  readonly chainId: string;
  /** Self's E_PASSPORT identity registry the roots were checked against. */
  readonly registry: Hex;
  /** `pubSignals[9]`, confirmed as a root Self published. */
  readonly merkleRoot: string;
  /** ISO `YYYY-MM-DD` decoded from the proof's date signals. */
  readonly proofDate: string;
}

export interface SignBindResponse {
  readonly attesterAddress: Hex;
  readonly messageHash: Hex;
  readonly signature: Hex;
  readonly chainId: string;
  readonly registry: Hex;
  readonly account: Hex;
  /** Echoed so the caller submits byte-identical bytes to `verifyAndBind`. */
  readonly userContextData: Hex;
  /** Always `celo`: the attester signs only after re-verifying on Celo. */
  readonly gate: 'celo';
  readonly celo: CeloGateReceipt;
}

/**
 * `extends Rpc.WorkerEntrypointBranded` is required to satisfy the
 * generic constraint on Cloudflare's `Service<T>` helper.
 */
/** Ceremony actions, named as `CofferdamAccount4337.ACTION_*` hash them. */
export type CeremonyAction = 'enroll-first-high' | 'replace-partner';

/** Request payload for `signCeremony` (decision 0016); bigints as decimal strings. */
export interface SignCeremonyRequest {
  readonly chainId: string;
  readonly account: Hex;
  readonly action: CeremonyAction;
  /** `keccak256(newConfig)` of the authority config the account will store. */
  readonly newKeyHash: Hex;
  /** The signing Partner authority's `partnerId`, or 32 zero bytes for Managed. */
  readonly partnerId: Hex;
  readonly nonce: string;
  readonly notBefore: string;
  readonly expiry: string;
}

/** Response from `signCeremony`: the `CeremonyAttestation` the account takes. */
export interface SignCeremonyResponse {
  readonly attesterAddress: Hex;
  /** Equals `CofferdamAccount4337.ceremonyHash(...)`. */
  readonly messageHash: Hex;
  /** 65-byte EIP-191 personal_sign signature. */
  readonly signature: Hex;
  readonly chainId: string;
  readonly account: Hex;
  readonly action: CeremonyAction;
  readonly nonce: string;
  readonly notBefore: string;
  readonly expiry: string;
}

export interface AttesterRpc extends Rpc.WorkerEntrypointBranded {
  signBind(req: SignBindRequest): Promise<SignBindResponse>;
  signCeremony(req: SignCeremonyRequest): Promise<SignCeremonyResponse>;
}
