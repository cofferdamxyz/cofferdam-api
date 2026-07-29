// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from 'hono';
import type { Env } from '../env.js';
import { getActivity, checkActivity } from '../services/activity.js';

export const activityRoutes = new Hono<{ Bindings: Env }>();

/** Default chainId (Base Sepolia). Overridable via query param. */
const DEFAULT_CHAIN_ID = 84532;

/**
 * GET /v1/activity?address=0x...&limit=20
 *
 * Returns recent ERC-20 Transfer events (incoming + outgoing) for a wallet
 * address on Base Sepolia. Queries the SQD Portal Stream API — full history,
 * no indexer process, SQD manages all node infrastructure.
 *
 * See ENTERPRISE_MODULE_PLAN.md §3 (decision 2026-06-26).
 */
activityRoutes.get('/', async (c) => {
  const address = c.req.query('address');
  if (!address) {
    return c.json({ ok: false, error: 'missing_address' }, 400);
  }

  // Basic address validation (0x + 40 hex chars).
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return c.json({ ok: false, error: 'invalid_address' }, 400);
  }

  const limitParam = c.req.query('limit');
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 20, 1), 50) : 20;

  const fromBlockParam = c.req.query('fromBlock');
  const fromBlock =
    fromBlockParam != null && /^\d+$/.test(fromBlockParam)
      ? parseInt(fromBlockParam, 10)
      : undefined;

  const chainIdParam = c.req.query('chainId');
  const chainId = chainIdParam ? parseInt(chainIdParam, 10) : DEFAULT_CHAIN_ID;

  const toBlockParam = c.req.query('toBlock');
  const toBlock =
    toBlockParam != null && /^\d+$/.test(toBlockParam)
      ? parseInt(toBlockParam, 10)
      : undefined;

  try {
    const result = await getActivity(
      c.env.SQD_PORTAL_URL,
      address,
      limit,
      fromBlock,
      chainId,
      c.env.BASE_SEPOLIA_RPC_URL,
      toBlock,
    );
    return c.json({
      ok: true,
      chainId,
      address: address.toLowerCase(),
      transactions: result.transactions,
      cursor: result.cursor,
    });
  } catch (err) {
    return c.json(
      {
        ok: false,
        error: 'activity_fetch_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
});

/**
 * GET /v1/activity/check?address=0x...&sinceBlock=12345
 *
 * Lightweight reconciliation check — queries Portal from `sinceBlock + 1` to
 * head with minimal fields. Returns `{ hasNew, latestBlock }` so the client
 * can decide whether to fetch the full activity list or serve from its local
 * cache.
 */
activityRoutes.get('/check', async (c) => {
  const address = c.req.query('address');
  if (!address) {
    return c.json({ ok: false, error: 'missing_address' }, 400);
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return c.json({ ok: false, error: 'invalid_address' }, 400);
  }

  const sinceBlockParam = c.req.query('sinceBlock');
  const sinceBlock = sinceBlockParam ? parseInt(sinceBlockParam, 10) : 0;
  if (!Number.isFinite(sinceBlock) || sinceBlock < 0) {
    return c.json({ ok: false, error: 'invalid_since_block' }, 400);
  }

  const chainIdParam = c.req.query('chainId');
  const chainId = chainIdParam ? parseInt(chainIdParam, 10) : DEFAULT_CHAIN_ID;

  try {
    const result = await checkActivity(
      c.env.SQD_PORTAL_URL,
      address,
      sinceBlock,
      chainId,
      c.env.BASE_SEPOLIA_RPC_URL,
    );
    return c.json({
      ok: true,
      chainId,
      address: address.toLowerCase(),
      hasNew: result.hasNew,
      latestBlock: result.latestBlock,
    });
  } catch (err) {
    return c.json(
      {
        ok: false,
        error: 'activity_check_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
});
