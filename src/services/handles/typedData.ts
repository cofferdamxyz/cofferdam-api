// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The EIP-712 types of the handle anchor and the registry (workspace decision
 * 0086, rules 3 and 4), as cofferdam-sdk `packages/core/src/identity/handle.ts`
 * defines them, byte for byte. The plane does not depend on the SDK; the shared
 * fixture (`test/fixtures/handles/handleAnchorTypes.json`, copied from the SDK
 * unchanged) pins every type string, type hash, domain separator and signed
 * vector against these definitions (`test/handlesTypedData.test.ts`).
 *
 * Two statements the plane signs are this build's own and in no fixture yet:
 * `SameIdentity` (the rename notice's same-identity statement, rule 7) and
 * `VerifiedStatement` (rule 9). ASSUMPTION(0086 rules 7 and 9): 0086 names what
 * each says; the field names and types are this build's, signed by the
 * registrar key in the registry domain.
 */

import { recoverTypedDataAddress, type Address, type Hex, type TypedDataDomain } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';

export const HANDLE_ANCHOR_DOMAIN_NAME = 'CofferdamHandleAnchor';
export const HANDLE_REGISTRY_DOMAIN_NAME = 'CofferdamHandleRegistry';
export const HANDLE_DOMAIN_VERSION = '1';

export function anchorDomain(chainId: number, anchor: Address): TypedDataDomain {
  return { name: HANDLE_ANCHOR_DOMAIN_NAME, version: HANDLE_DOMAIN_VERSION, chainId, verifyingContract: anchor };
}

export function registryDomain(chainId: number): TypedDataDomain {
  return { name: HANDLE_REGISTRY_DOMAIN_NAME, version: HANDLE_DOMAIN_VERSION, chainId };
}

const f = (name: string, type: string) => ({ name, type }) as const;

/** The anchor's 15 types (SDK `HANDLE_ANCHOR_TYPES`). */
export const ANCHOR_TYPES = {
  RegistrarClaim: [f('handleId', 'bytes32'), f('owner', 'address'), f('serial', 'uint64'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  OwnerClaim: [f('handleId', 'bytes32'), f('metaAddress', 'bytes'), f('serial', 'uint64')],
  TransferOwner: [f('handleId', 'bytes32'), f('newOwner', 'address'), f('newMetaAddress', 'bytes'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  TransferOwnerAccept: [f('handleId', 'bytes32'), f('previousOwner', 'address'), f('newMetaAddress', 'bytes'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  SetMetaAddress: [f('handleId', 'bytes32'), f('newMetaAddress', 'bytes'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  Release: [f('handleId', 'bytes32'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  Cancel: [f('handleId', 'bytes32'), f('pendingNonce', 'uint256'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  Advance: [f('handleId', 'bytes32'), f('newOwner', 'address'), f('newMetaAddress', 'bytes'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  AdvanceAccept: [f('handleId', 'bytes32'), f('previousOwner', 'address'), f('newMetaAddress', 'bytes'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  RegistrarAdvance: [
    f('handleId', 'bytes32'),
    f('previousOwner', 'address'),
    f('newOwner', 'address'),
    f('newMetaAddress', 'bytes'),
    f('nonce', 'uint256'),
    f('deadline', 'uint64'),
  ],
  Hold: [f('handleId', 'bytes32'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  RenewHold: [f('handleId', 'bytes32'), f('frozenUntil', 'uint64'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  Veto: [f('handleId', 'bytes32'), f('pendingNonce', 'uint256'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  // ASSUMPTION(0086 q15): `unfreeze` exists, signed by the owner and a registrar.
  Unfreeze: [f('handleId', 'bytes32'), f('frozenUntil', 'uint64'), f('nonce', 'uint256'), f('deadline', 'uint64')],
  RegistrarUnfreeze: [f('handleId', 'bytes32'), f('frozenUntil', 'uint64'), f('nonce', 'uint256'), f('deadline', 'uint64')],
} as const;

/** The registry's 5 handle-scoped request types (SDK `HANDLE_REGISTRY_TYPES`), plus the plane's two statements. */
export const REGISTRY_TYPES = {
  RegistryClaim: [f('label', 'string'), f('handleId', 'bytes32'), f('owner', 'address'), f('metaAddress', 'bytes'), f('nonce', 'bytes32'), f('expiresAt', 'uint64')],
  SetDiscoverable: [
    f('handleId', 'bytes32'),
    f('serial', 'uint64'),
    f('discoverable', 'bool'),
    f('inboxId', 'string'),
    f('nonce', 'bytes32'),
    f('expiresAt', 'uint64'),
  ],
  RenameHandle: [
    f('handleId', 'bytes32'),
    f('serial', 'uint64'),
    f('newLabel', 'string'),
    f('newHandleId', 'bytes32'),
    f('newOwner', 'address'),
    f('newMetaAddress', 'bytes'),
    f('nonce', 'bytes32'),
    f('expiresAt', 'uint64'),
  ],
  ReleaseHandle: [f('handleId', 'bytes32'), f('serial', 'uint64'), f('nonce', 'bytes32'), f('expiresAt', 'uint64')],
  RegisterAddress: [
    f('handleId', 'bytes32'),
    f('serial', 'uint64'),
    f('account', 'address'),
    f('ephemeralPublicKey', 'bytes'),
    f('sharedSecretHash', 'bytes32'),
    f('metaAddress', 'bytes'),
    f('nonce', 'bytes32'),
    f('expiresAt', 'uint64'),
  ],
  // ASSUMPTION(0086 rule 7): the same-identity statement a rename notice carries; fields this build's.
  SameIdentity: [f('oldHandleId', 'bytes32'), f('newHandleId', 'bytes32'), f('newSerial', 'uint64'), f('newOwner', 'address'), f('issuedAt', 'uint64')],
  // ASSUMPTION(0086 rule 9): the Verified statement, valid 30 days; fields this build's.
  VerifiedStatement: [f('handleId', 'bytes32'), f('serial', 'uint64'), f('owner', 'address'), f('bound', 'bool'), f('expiresAt', 'uint64')],
} as const;

export type AnchorPrimaryType = keyof typeof ANCHOR_TYPES;
export type RegistryPrimaryType = keyof typeof REGISTRY_TYPES;

type Message = Record<string, unknown>;

/** The signer of an anchor-domain message, or null for a malformed signature. */
export async function anchorSigner(
  chainId: number,
  anchor: Address,
  primaryType: AnchorPrimaryType,
  message: Message,
  signature: Hex,
): Promise<Address | null> {
  try {
    return await recoverTypedDataAddress({
      domain: anchorDomain(chainId, anchor),
      types: { [primaryType]: ANCHOR_TYPES[primaryType] },
      primaryType,
      message,
      signature,
    } as unknown as Parameters<typeof recoverTypedDataAddress>[0]);
  } catch {
    return null;
  }
}

/** The signer of a registry-domain message, or null for a malformed signature. */
export async function registrySigner(chainId: number, primaryType: RegistryPrimaryType, message: Message, signature: Hex): Promise<Address | null> {
  try {
    return await recoverTypedDataAddress({
      domain: registryDomain(chainId),
      types: { [primaryType]: REGISTRY_TYPES[primaryType] },
      primaryType,
      message,
      signature,
    } as unknown as Parameters<typeof recoverTypedDataAddress>[0]);
  } catch {
    return null;
  }
}

/** The registrar's signature over an anchor-domain message. */
export function signAnchor(account: PrivateKeyAccount, chainId: number, anchor: Address, primaryType: AnchorPrimaryType, message: Message): Promise<Hex> {
  return account.signTypedData({
    domain: anchorDomain(chainId, anchor),
    types: { [primaryType]: ANCHOR_TYPES[primaryType] },
    primaryType,
    message,
  } as unknown as Parameters<PrivateKeyAccount['signTypedData']>[0]);
}

/** The registrar's signature over one of the plane's registry-domain statements. */
export function signRegistry(account: PrivateKeyAccount, chainId: number, primaryType: RegistryPrimaryType, message: Message): Promise<Hex> {
  return account.signTypedData({
    domain: registryDomain(chainId),
    types: { [primaryType]: REGISTRY_TYPES[primaryType] },
    primaryType,
    message,
  } as unknown as Parameters<PrivateKeyAccount['signTypedData']>[0]);
}
