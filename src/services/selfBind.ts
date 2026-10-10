// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Self.xyz proof intake → bind bundle.
 *
 * With `endpointType: 'https'` Self's relayer delivers a finished
 * `vc_and_disclose` proof to the app's configured endpoint — never to the
 * phone, which only learns `VERIFICATION_COMPLETE {success}`. That endpoint is
 * `POST /v1/self/verify` on this Worker (routes/self.ts). This module holds the
 * pure parts: normalising the relayer's payload (bigints arrive as decimal
 * strings or bare hex; `userContextData` as hex without `0x`), recovering the
 * target account from `userContextData`, swapping the Groth16 `b` coordinates
 * into Solidity order, and shaping the bundle the app fetches to submit
 * `NullifierRegistry.verifyAndBind`.
 *
 * Nothing here is trusted by the chain: the attester's Celo gate decides
 * whether a bundle exists at all, and `verifyAndBind` re-verifies everything.
 */

import { getAddress, type Address, type Hex } from 'viem';
import type { SignBindResponse } from './attester.js';

/** Self `AttestationId.E_PASSPORT`; the only document type the registry binds. */
export const E_PASSPORT_ATTESTATION_ID = 1;
export const PUB_SIGNALS_LENGTH = 21;
/** `vc_and_disclose` (E_PASSPORT) nullifier index. */
export const NULLIFIER_INDEX = 7;
/** How long a signed bundle waits in KV for the app to submit it. */
export const BIND_BUNDLE_TTL_SECONDS = 30 * 60;
export const BIND_BUNDLE_VERSION = 1 as const;

const UINT256_MAX = (1n << 256n) - 1n;

export class SelfVerifyRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SelfVerifyRequestError';
  }
}

/** Base-10 bigint string — the wire form the attester expects. */
export type Decimal = string;

export interface ProofPoints {
  readonly a: readonly [Decimal, Decimal];
  readonly b: readonly [readonly [Decimal, Decimal], readonly [Decimal, Decimal]];
  readonly c: readonly [Decimal, Decimal];
}

export interface SelfVerifyRequest {
  readonly attestationId: number;
  /** As delivered by the relayer: snarkjs coordinate order. */
  readonly proof: ProofPoints;
  readonly publicSignals: readonly Decimal[];
  /** 0x-prefixed, lower-case, ≥ 64 bytes. */
  readonly userContextData: Hex;
  /** Recovered from `userContextData[32..64]`. */
  readonly account: Address;
  readonly nullifier: Decimal;
}

/**
 * Normalise a relayer bigint. Self's SDK accepts decimal strings or hex
 * without `0x` (`SelfBackendVerifier` prefixes anything containing a–f), so we
 * accept both plus `0x` hex and safe integers.
 */
export function toDecimal(value: unknown, label: string): Decimal {
  let v: bigint;
  if (typeof value === 'bigint') {
    v = value;
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new SelfVerifyRequestError('bad_bigint', `${label} is not a non-negative safe integer`);
    }
    v = BigInt(value);
  } else if (typeof value === 'string') {
    const s = value.trim();
    if (/^\d+$/.test(s)) v = BigInt(s);
    else if (/^0x[0-9a-fA-F]+$/.test(s)) v = BigInt(s);
    else if (/^[0-9a-fA-F]+$/.test(s)) v = BigInt(`0x${s}`);
    else throw new SelfVerifyRequestError('bad_bigint', `${label} is neither decimal nor hex: ${s.slice(0, 32)}`);
  } else {
    throw new SelfVerifyRequestError('bad_bigint', `${label} must be a string or number, got ${typeof value}`);
  }
  if (v < 0n || v > UINT256_MAX) {
    throw new SelfVerifyRequestError('bad_bigint', `${label} is out of uint256 range`);
  }
  return v.toString();
}

function pair(value: unknown, label: string): [Decimal, Decimal] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new SelfVerifyRequestError('bad_proof', `${label} must be a 2-element array`);
  }
  return [toDecimal(value[0], `${label}[0]`), toDecimal(value[1], `${label}[1]`)];
}

/** Normalise `userContextData`: Self sends bare hex; we store it 0x-prefixed and lower-case. */
export function normalizeUserContextData(raw: unknown): Hex {
  if (typeof raw !== 'string') {
    throw new SelfVerifyRequestError('bad_user_context', 'userContextData must be a hex string');
  }
  const hex = raw.trim().replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new SelfVerifyRequestError('bad_user_context', 'userContextData is not even-length hex');
  }
  if (hex.length < 128) {
    throw new SelfVerifyRequestError(
      'bad_user_context',
      `userContextData must be at least 64 bytes (destChainId ‖ userId), got ${hex.length / 2}`,
    );
  }
  return `0x${hex}`;
}

/**
 * The account a proof binds to is the user id Self left-padded into the second
 * 32-byte word of `userContextData`. `NullifierRegistry._checkUserContext`
 * compares the whole word, so the twelve high bytes must be zero.
 */
export function accountFromUserContextData(userContextData: Hex): Address {
  const word = userContextData.slice(2 + 64, 2 + 128);
  if (!/^0{24}[0-9a-f]{40}$/.test(word)) {
    throw new SelfVerifyRequestError(
      'user_id_not_address',
      'userContextData user id is not an address-shaped 32-byte word; SelfApp.userId must be the AA address',
    );
  }
  return getAddress(`0x${word.slice(24)}`);
}

/** Parse and normalise the relayer's POST body. Throws `SelfVerifyRequestError`. */
export function parseSelfVerifyBody(raw: unknown): SelfVerifyRequest {
  if (!raw || typeof raw !== 'object') {
    throw new SelfVerifyRequestError('bad_request', 'body must be a JSON object');
  }
  const o = raw as Record<string, unknown>;

  const attestationId = Number(o.attestationId);
  if (attestationId !== E_PASSPORT_ATTESTATION_ID) {
    throw new SelfVerifyRequestError(
      'unsupported_attestation_id',
      `only E_PASSPORT (${E_PASSPORT_ATTESTATION_ID}) proofs bind; got ${String(o.attestationId)}`,
    );
  }

  const p = o.proof as Record<string, unknown> | undefined;
  if (!p || typeof p !== 'object') {
    throw new SelfVerifyRequestError('bad_proof', 'proof must be an object with a, b, c');
  }
  if (!Array.isArray(p.b) || p.b.length !== 2) {
    throw new SelfVerifyRequestError('bad_proof', 'proof.b must be a 2×2 array');
  }
  const proof: ProofPoints = {
    a: pair(p.a, 'proof.a'),
    b: [pair(p.b[0], 'proof.b[0]'), pair(p.b[1], 'proof.b[1]')],
    c: pair(p.c, 'proof.c'),
  };

  if (!Array.isArray(o.publicSignals) || o.publicSignals.length !== PUB_SIGNALS_LENGTH) {
    throw new SelfVerifyRequestError(
      'bad_public_signals',
      `publicSignals must have ${PUB_SIGNALS_LENGTH} entries, got ${
        Array.isArray(o.publicSignals) ? o.publicSignals.length : typeof o.publicSignals
      }`,
    );
  }
  const publicSignals = o.publicSignals.map((v, i) => toDecimal(v, `publicSignals[${i}]`));

  const userContextData = normalizeUserContextData(o.userContextData);
  const account = accountFromUserContextData(userContextData);

  return {
    attestationId,
    proof,
    publicSignals,
    userContextData,
    account,
    nullifier: publicSignals[NULLIFIER_INDEX]!,
  };
}

/**
 * snarkjs emits `b` as `[[x1, x2], [y1, y2]]`; Solidity verifiers expect each
 * pair reversed. Mirrors the swap in `SelfBackendVerifier.verify`.
 */
export function toSolidityProof(p: ProofPoints): ProofPoints {
  return {
    a: p.a,
    b: [
      [p.b[0][1], p.b[0][0]],
      [p.b[1][1], p.b[1][0]],
    ],
    c: p.c,
  };
}

/** Everything the app needs to call `NullifierRegistry.verifyAndBind`. */
export interface BindBundle {
  readonly version: typeof BIND_BUNDLE_VERSION;
  readonly account: Address;
  /** Base chain id the attester signed for. */
  readonly chainId: string;
  readonly registry: Hex;
  /** Solidity coordinate order — pass straight into `verifyAndBind(a, b, c, …)`. */
  readonly proof: ProofPoints;
  readonly pubSignals: readonly Decimal[];
  readonly userContextData: Hex;
  readonly attesterSig: Hex;
  readonly attesterAddress: Hex;
  readonly messageHash: Hex;
  readonly nullifier: Decimal;
  readonly celo: SignBindResponse['celo'];
  readonly createdAt: number;
  readonly expiresAt: number;
}

export function buildBindBundle(
  req: SelfVerifyRequest,
  signed: SignBindResponse,
  now: number = Date.now(),
): BindBundle {
  return {
    version: BIND_BUNDLE_VERSION,
    account: req.account,
    chainId: signed.chainId,
    registry: signed.registry,
    proof: toSolidityProof(req.proof),
    pubSignals: req.publicSignals,
    userContextData: signed.userContextData,
    attesterSig: signed.signature,
    attesterAddress: signed.attesterAddress,
    messageHash: signed.messageHash,
    nullifier: req.nullifier,
    celo: signed.celo,
    createdAt: now,
    expiresAt: now + BIND_BUNDLE_TTL_SECONDS * 1000,
  };
}

/**
 * KV-backed bundle store. One pending bundle per account:
 *
 *   bind:<account, lower-case>  → BindBundle (JSON), TTL `BIND_BUNDLE_TTL_SECONDS`
 */
export class BindBundleStore {
  constructor(private readonly kv: KVNamespace) {}

  static key(account: Address): string {
    return `bind:${account.toLowerCase()}`;
  }

  async put(bundle: BindBundle): Promise<void> {
    await this.kv.put(BindBundleStore.key(bundle.account), JSON.stringify(bundle), {
      expirationTtl: BIND_BUNDLE_TTL_SECONDS,
    });
  }

  async get(account: Address): Promise<BindBundle | null> {
    const raw = await this.kv.get(BindBundleStore.key(account), 'json');
    if (!raw || typeof raw !== 'object') return null;
    const b = raw as BindBundle;
    return b.version === BIND_BUNDLE_VERSION ? b : null;
  }

  async delete(account: Address): Promise<void> {
    await this.kv.delete(BindBundleStore.key(account));
  }
}
