// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from 'hono';
import type { Env } from '../env.js';
import { getBaseSepoliaClient } from '../chain/client.js';
import {
  SEPOLIA_DEPLOYMENTS,
  BASE_SEPOLIA_CHAIN_ID,
  type ContractDeployment,
} from '../chain/deployments.js';

export const sepoliaRoutes = new Hono<{ Bindings: Env }>();

/**
 * Read the current Base Sepolia block height. Smoke-tests that
 * the Worker can talk to the upstream RPC and that the RN app's chain
 * pipeline is alive.
 */
sepoliaRoutes.get('/block-height', async (c) => {
  const client = getBaseSepoliaClient(c.env.BASE_SEPOLIA_RPC_URL);
  try {
    const blockNumber = await client.getBlockNumber();
    return c.json({
      ok: true,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      blockNumber: blockNumber.toString(),
      rpcUrl: c.env.BASE_SEPOLIA_RPC_URL,
    });
  } catch (err) {
    return c.json(
      {
        ok: false,
        error: 'rpc_unreachable',
        message: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
});

/**
 * Return the deployed Cofferdam-relevant contracts on Base Sepolia.
 *
 * Read-only; the addresses are vendored from
 * `base-contracts/deployments/baseSepolia.json`. The Worker doesn't yet
 * fetch live state for each contract — it just enumerates them so the
 * RN app can render a "deployments are live" smoke-test card during
 * Session 1.
 */
sepoliaRoutes.get('/contracts', (c) => {
  const entries = Object.entries(SEPOLIA_DEPLOYMENTS).map(([name, d]) => {
    const dep = d as ContractDeployment;
    return {
      name,
      address: dep.address,
      txHash: dep.txHash,
      deployedAt: dep.deployedAt,
      deployer: dep.deployer,
      explorerUrl: `https://sepolia.basescan.org/address/${dep.address}`,
    };
  });
  return c.json({
    ok: true,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    contracts: entries,
  });
});
