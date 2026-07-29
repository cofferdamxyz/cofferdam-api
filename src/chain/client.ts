// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * viem public client for Base Sepolia.
 *
 * Read-only. Signing happens client-side in the RN app (passkey-bound)
 * or in cofferdam-attester (SelfAttester signing key). This Worker
 * never holds private keys for chain interaction.
 */

import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';

/**
 * Base Sepolia public client type, inferred from `createPublicClient` so the
 * chain-bound shape (`baseSepolia`) is preserved. Avoids the
 * unrelated-PublicClient-generic structural-mismatch noise from viem v2.
 */
export type BaseSepoliaClient = ReturnType<typeof buildBaseSepoliaClient>;

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
