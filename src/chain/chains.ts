// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Which chain a request may read, and through which client (workspace
 * decision 0080, milestone M1).
 *
 * Base Sepolia (84532) is always on, on `BASE_SEPOLIA_RPC_URL`, exactly as
 * before. Base mainnet (8453) is off unless `BASE_MAINNET_ENABLED` is
 * `"true"` and `BASE_RPC_URL` is set: in development that URL is the
 * Base-mainnet fork (`yarn node:start:base` in base-contracts, anvil on :8546
 * keeping chain id 8453); deployed, it stays unset until the founder sets it.
 * Any other chain id is never read.
 *
 * Mainnet on is still not mainnet served: every path also needs its contracts
 * in `DEPLOYMENTS_BY_CHAIN`, and the mainnet table is empty.
 */

import { getBaseClient, getBaseSepoliaClient, type ChainClient } from './client.js';
import {
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  DEPLOYMENTS_BY_CHAIN,
  type ChainDeployments,
  type PlaneChainId,
} from './deployments.js';

/** The vars the chain switch reads (a subset of `Env`, so tests pass plain objects). */
export interface ChainEnv {
  BASE_SEPOLIA_RPC_URL?: string;
  BASE_RPC_URL?: string;
  BASE_MAINNET_ENABLED?: string;
}

/** The public Base Sepolia node, the fallback the relay and the ceremony already used. */
export const DEFAULT_BASE_SEPOLIA_RPC_URL = 'https://sepolia.base.org';

/** A chain the plane may read for this request: its id, client and deployments. */
export interface ChainContext {
  readonly chainId: PlaneChainId;
  readonly client: ChainClient;
  readonly deployments: ChainDeployments;
}

/** True only for exactly `BASE_MAINNET_ENABLED="true"` with a non-empty `BASE_RPC_URL`. */
export function mainnetEnabled(env: ChainEnv): boolean {
  return env.BASE_MAINNET_ENABLED === 'true' && typeof env.BASE_RPC_URL === 'string' && env.BASE_RPC_URL.trim() !== '';
}

/** The RPC URL to read `chainId` through, or null when that chain is off or unknown. */
export function chainRpcUrl(env: ChainEnv, chainId: number): string | null {
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return env.BASE_SEPOLIA_RPC_URL || DEFAULT_BASE_SEPOLIA_RPC_URL;
  if (chainId === BASE_MAINNET_CHAIN_ID && mainnetEnabled(env)) return env.BASE_RPC_URL!.trim();
  return null;
}

/**
 * The chain a request names, if the plane may read it: null for an unknown
 * chain and for mainnet while it is switched off. `tables` lets the tests give
 * mainnet the contracts it does not have yet.
 */
export function chainContext(
  env: ChainEnv,
  chainId: number,
  tables: Readonly<Record<PlaneChainId, ChainDeployments>> = DEPLOYMENTS_BY_CHAIN,
): ChainContext | null {
  const rpcUrl = chainRpcUrl(env, chainId);
  if (rpcUrl === null) return null;
  if (chainId === BASE_SEPOLIA_CHAIN_ID) {
    return { chainId, client: getBaseSepoliaClient(rpcUrl) as unknown as ChainClient, deployments: tables[chainId] };
  }
  return { chainId: BASE_MAINNET_CHAIN_ID, client: getBaseClient(rpcUrl), deployments: tables[BASE_MAINNET_CHAIN_ID] };
}
