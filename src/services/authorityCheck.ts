// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * On-chain authority check for a `csa1:` session attestation: is the key that
 * signed the envelope an active authority on the account it names, on the
 * module that matches its signature scheme (`webauthn` → the pinned
 * `WebAuthnPasskeyAuthority`, `p256` → the test-only `PasskeyAuthority`)?
 *
 * A verified envelope alone proves only that the holder of `publicKey` signed
 * those fields; anyone can mint one for any address. Shared by
 * `POST /v1/session/verify-attestation` (`checkOnChain`) and the bind-bundle
 * pickup gate, which refuses a bundle to a key that is not a High authority on
 * the account (2026-10-15).
 */

import { getAddress, type Address } from 'viem';

import { chainContext, type ChainEnv } from '../chain/chains.js';
import { BASE_SEPOLIA_CHAIN_ID, DEPLOYMENTS_BY_CHAIN, passkeyModuleFor, type ChainDeployments, type PlaneChainId } from '../chain/deployments.js';
import { encodePasskeyConfig, type PasskeySession } from './sessionAttestation.js';

/** Authority-registry read surface of `CofferdamAccount4337`. */
export const COFFERDAM_ACCOUNT_AUTHORITY_ABI = [
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

/** Outcome of the on-chain authority check. */
export type AuthorityCheck =
  | { status: 'active'; authorityId: number; module: Address; tier: number }
  | { status: 'not_found' }
  | { status: 'account_not_deployed' }
  | { status: 'chain_unsupported'; chainId: number }
  | { status: 'check_failed'; message: string };

/**
 * Where the check may read. A string is Base Sepolia's RPC URL and nothing
 * else: the Self pickup (Sepolia until Self retires, decision 0080 (1)) and
 * the Vault mirror (decision 0081, whose chain question is its own) pass one.
 * An env reads the chain the attestation names, through `chainContext`:
 * Sepolia as before, mainnet only when it is switched on and has the module.
 */
export type AuthorityChains = string | ChainEnv;

/** Read the account's authority registry and confirm the attesting passkey is active on it. */
export async function checkOnChainAuthority(
  att: PasskeySession,
  chains: AuthorityChains,
  tables?: Readonly<Record<PlaneChainId, ChainDeployments>>,
): Promise<AuthorityCheck> {
  const env: ChainEnv = typeof chains === 'string' ? { BASE_SEPOLIA_RPC_URL: chains } : chains;
  if (typeof chains === 'string' && att.chainId !== BASE_SEPOLIA_CHAIN_ID) {
    return { status: 'chain_unsupported', chainId: att.chainId };
  }
  const chain = chainContext(env, att.chainId, tables ?? DEPLOYMENTS_BY_CHAIN);
  const module = chain && passkeyModuleFor(chain.deployments, att.alg);
  if (!chain || !module) {
    return { status: 'chain_unsupported', chainId: att.chainId };
  }
  try {
    const client = chain.client;
    const address = getAddress(att.accountAddress) as Address;

    const code = await client.getCode({ address });
    if (!code || code === '0x') return { status: 'account_not_deployed' };

    const expectedConfig = encodePasskeyConfig(att.publicKey).toLowerCase();
    const expectedModule = module.toLowerCase();
    const count = await client.readContract({
      address,
      abi: COFFERDAM_ACCOUNT_AUTHORITY_ABI,
      functionName: 'authorityCount',
    });

    for (let id = 0n; id < count; id++) {
      const [authorityModule, tier, active, config] = await client.readContract({
        address,
        abi: COFFERDAM_ACCOUNT_AUTHORITY_ABI,
        functionName: 'getAuthority',
        args: [id],
      });
      // The authority is THIS passkey iff it is active, holds the same public
      // key (config) and is verified by the module that matches the
      // attestation's signature scheme (WebAuthn vs raw P-256).
      if (active && config.toLowerCase() === expectedConfig && authorityModule.toLowerCase() === expectedModule) {
        return { status: 'active', authorityId: Number(id), module: authorityModule, tier };
      }
    }
    return { status: 'not_found' };
  } catch (err) {
    return { status: 'check_failed', message: err instanceof Error ? err.message : String(err) };
  }
}
