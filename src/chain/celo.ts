// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only viem client for Celo mainnet, where Self.xyz anchors its identity
 * registry. The API reads it for two reasons only: to build gate-passing
 * synthetic signals for `/v1/attester/test-sign`, and to pre-flight a real
 * proof before paying for an attester call. The authoritative gate runs in
 * `cofferdam-attester`; nothing here is trusted by the chain.
 */

import { createPublicClient, http } from 'viem';

export const CELO_CHAIN_ID = 42220 as const;

/** Self `IdentityVerificationHubImplV2` proxy on Celo. */
export const SELF_HUB_ADDRESS = '0xe57F4773bd9c9d8b6Cd70431117d353298B9f5BF' as const;

/** Self `IdentityRegistryImplV1` proxy for E_PASSPORT, as `hub.registry(bytes32(1))` reports it. */
export const SELF_PASSPORT_REGISTRY_ADDRESS = '0x37F5CB8cB1f6B00aa768D8aA99F1A9289802A968' as const;

export const SELF_PASSPORT_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'getIdentityCommitmentMerkleRoot',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getPassportNoOfacRoot',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getNameAndDobOfacRoot',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getNameAndYobOfacRoot',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export type CeloClient = ReturnType<typeof buildCeloClient>;

function buildCeloClient(rpcUrl: string) {
  return createPublicClient({ transport: http(rpcUrl, { timeout: 10_000, retryCount: 2 }) });
}

let cached: { rpcUrl: string; client: CeloClient } | null = null;

export function getCeloClient(rpcUrl: string): CeloClient {
  if (!cached || cached.rpcUrl !== rpcUrl) cached = { rpcUrl, client: buildCeloClient(rpcUrl) };
  return cached.client;
}

export interface SelfRegistrySnapshot {
  readonly merkleRoot: bigint;
  readonly passportNoOfacRoot: bigint;
  readonly nameAndDobOfacRoot: bigint;
  readonly nameAndYobOfacRoot: bigint;
}

/** Current identity root and OFAC roots — exactly what the attester's gate accepts today. */
export async function readSelfRegistrySnapshot(client: CeloClient): Promise<SelfRegistrySnapshot> {
  const read = (functionName: (typeof SELF_PASSPORT_REGISTRY_ABI)[number]['name']) =>
    client.readContract({ address: SELF_PASSPORT_REGISTRY_ADDRESS, abi: SELF_PASSPORT_REGISTRY_ABI, functionName });
  const [merkleRoot, passportNoOfacRoot, nameAndDobOfacRoot, nameAndYobOfacRoot] = await Promise.all([
    read('getIdentityCommitmentMerkleRoot'),
    read('getPassportNoOfacRoot'),
    read('getNameAndDobOfacRoot'),
    read('getNameAndYobOfacRoot'),
  ]);
  return { merkleRoot, passportNoOfacRoot, nameAndDobOfacRoot, nameAndYobOfacRoot };
}

/** Today's UTC date as the six single-digit `currentDate` signals (YYMMDD). */
export function todayProofDateSignals(now: Date = new Date()): bigint[] {
  const yy = String(now.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`.split('').map((d) => BigInt(d));
}
