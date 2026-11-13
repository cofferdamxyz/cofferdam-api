// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * viem public clients for the plane's chains: Base Sepolia (84532), where
 * every deployed path runs today, and Base mainnet (8453), behind
 * `BASE_MAINNET_ENABLED` and `BASE_RPC_URL` (workspace decision 0080; see
 * `chains.ts`, which decides when a chain may be read at all).
 *
 * Read-only. Signing happens client-side in the RN app (passkey-bound)
 * or in cofferdam-attester (SelfAttester signing key). The one key the
 * Worker holds is the relayer's (`routes/aa.ts`), Sepolia only.
 */

import { createPublicClient, http, type Chain, type HttpTransport, type PublicClient } from 'viem';
import { base, baseSepolia } from 'viem/chains';

/**
 * Base Sepolia public client type, inferred from `createPublicClient` so the
 * chain-bound shape (`baseSepolia`) is preserved. Avoids the
 * unrelated-PublicClient-generic structural-mismatch noise from viem v2.
 */
export type BaseSepoliaClient = ReturnType<typeof buildBaseSepoliaClient>;

/** A public client on either of the plane's chains: what a per-chain read takes. */
export type ChainClient = PublicClient<HttpTransport, Chain>;

function buildBaseSepoliaClient(rpcUrl: string) {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(rpcUrl),
  });
}

/** Lazily-constructed and request-scoped — Workers re-use across invocations on the same isolate. */
let cachedClient: BaseSepoliaClient | null = null;
let cachedRpcUrl: string | null = null;

/**
 * Get (or build) the Base Sepolia public client. Re-builds if the configured
 * RPC URL changes (which it shouldn't at runtime, but defensive).
 */
export function getBaseSepoliaClient(rpcUrl: string): BaseSepoliaClient {
  if (cachedClient && cachedRpcUrl === rpcUrl) {
    return cachedClient;
  }
  cachedClient = buildBaseSepoliaClient(rpcUrl);
  cachedRpcUrl = rpcUrl;
  return cachedClient;
}

let cachedBase: ChainClient | null = null;
let cachedBaseRpcUrl: string | null = null;

/**
 * Get (or build) the Base mainnet public client on `rpcUrl`: `BASE_RPC_URL`,
 * which in development is the Base-mainnet fork (anvil keeps chain id 8453).
 * There is no default URL: callers reach it only through `chainContext`,
 * which refuses mainnet unless it is switched on.
 */
export function getBaseClient(rpcUrl: string): ChainClient {
  if (cachedBase && cachedBaseRpcUrl === rpcUrl) return cachedBase;
  cachedBase = createPublicClient({ chain: base, transport: http(rpcUrl) }) as ChainClient;
  cachedBaseRpcUrl = rpcUrl;
  return cachedBase;
}
