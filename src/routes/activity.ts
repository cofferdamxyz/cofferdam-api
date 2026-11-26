// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono, type Context } from 'hono';
import { BASE_SEPOLIA_CHAIN_ID } from '../chain/deployments.js';
import type { Env } from '../env.js';
import { ActivityRpcError } from '../services/activityScan.js';
import {
  checkActivity,
  defaultActivityToken,
  findActivityToken,
  getActivity,
  isWebhookFedToken,
  STORE_CHAINS,
  type ActivityOptions,
  type ActivityToken,
} from '../services/activity.js';
import {
  DurableActivityStore,
  parseCdpTransfer,
  recordAddresses,
  verifyCdpSignature,
} from '../services/activityStore.js';

export const activityRoutes = new Hono<{ Bindings: Env }>();

/** Default chainId (Base Sepolia). Overridable via query param. */
const DEFAULT_CHAIN_ID = BASE_SEPOLIA_CHAIN_ID;

/**
 * Read options for a chain: the activity RPC, the log span and, on Sepolia, the
 * store. Mainnet reads SQD Portal, and its RPC fallback viem's public Base
 * endpoint (`services/activity.ts` passes it no URL), whatever the mainnet
 * switch: `BASE_RPC_URL` may be a keyed provider's URL, and `failure` below
 * answers the caller with the error's message, which for viem names the URL.
 */
export function activityOptions(env: Env, chainId: number): ActivityOptions {
  const range = Number(env.ACTIVITY_LOG_RANGE);
  const indexFrom = Number(env.ACTIVITY_INDEX_FROM_BLOCK);
  const storeOn = STORE_CHAINS.has(chainId) && env.ACTIVITY_DO != null && Number.isSafeInteger(indexFrom) && indexFrom > 0;
  return {
    rpcUrl:
      chainId === BASE_SEPOLIA_CHAIN_ID ? env.ACTIVITY_RPC_URL || env.BASE_SEPOLIA_RPC_URL : undefined,
    logRange: Number.isSafeInteger(range) && range > 0 ? range : undefined,
    store: storeOn ? new DurableActivityStore(env.ACTIVITY_DO!) : undefined,
    indexFromBlock: storeOn ? indexFrom : undefined,
  };
}

/**
 * The token a request reports on: the chain's default (USDC) when `token` is
 * absent, as older app builds send none; else the `ACTIVITY_TOKENS` entry at
 * that address on the chain, or null (the route answers 400 `unsupported_token`).
 */
export function requestedToken(chainId: number, param: string | undefined): ActivityToken | null {
  if (param == null || param === '') return defaultActivityToken(chainId);
  if (!/^0x[a-fA-F0-9]{40}$/.test(param)) return null;
  return findActivityToken(chainId, param);
}

function failure(c: Context<{ Bindings: Env }>, error: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  // An RPC refusal is upstream (502); anything else is ours (500). The app keeps its cache on both.
  return c.json({ ok: false, error, message }, err instanceof ActivityRpcError ? 502 : 500);
}

/**
 * GET /v1/activity?address=0x...&limit=20[&fromBlock=&toBlock=&chainId=&token=0x...]
 *
 * Recent transfers (incoming and outgoing) of one token for an address, newest
 * first, with `cursor` (the next page's `toBlock`) and `headBlock` (the newest
 * block covered). `token` is the address of the coin the app's revolver is on
 * (workspace decision 0100 question 7), one of the chain's `ACTIVITY_TOKENS`
 * (else 400 `unsupported_token`); absent, USDC. Each transaction's
 * `tokenAddress` is that token, lower-case, and `valueFormatted` uses its
 * decimals. Sepolia reads the webhook-fed store for a webhook-fed token
 * (MockUSDC), then chunked RPC, and scans any other token (pBRL); mainnet
 * reads SQD Portal (workspace decisions 0009 and 0032).
 */
activityRoutes.get('/', async (c) => {
  const address = c.req.query('address');
  if (!address) {
    return c.json({ ok: false, error: 'missing_address' }, 400);
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return c.json({ ok: false, error: 'invalid_address' }, 400);
  }

  const limitParam = c.req.query('limit');
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 20, 1), 50) : 20;

  const fromBlockParam = c.req.query('fromBlock');
  const fromBlock =
    fromBlockParam != null && /^\d+$/.test(fromBlockParam) ? parseInt(fromBlockParam, 10) : undefined;

  const chainIdParam = c.req.query('chainId');
  const chainId = chainIdParam ? parseInt(chainIdParam, 10) : DEFAULT_CHAIN_ID;

  const toBlockParam = c.req.query('toBlock');
  const toBlock = toBlockParam != null && /^\d+$/.test(toBlockParam) ? parseInt(toBlockParam, 10) : undefined;

  const token = requestedToken(chainId, c.req.query('token'));
  if (!token) {
    return c.json({ ok: false, error: 'unsupported_token' }, 400);
  }

  try {
    const result = await getActivity(
      c.env.SQD_PORTAL_URL,
      address,
      limit,
      fromBlock,
      chainId,
      { ...activityOptions(c.env, chainId), token },
      toBlock,
    );
    return c.json({
      ok: true,
      chainId,
      address: address.toLowerCase(),
      token: token.address.toLowerCase(),
      transactions: result.transactions,
      cursor: result.cursor,
      headBlock: result.headBlock ?? null,
    });
  } catch (err) {
    return failure(c, 'activity_fetch_failed', err);
  }
});

/**
 * GET /v1/activity/check?address=0x...&sinceBlock=12345[&chainId=&token=0x...]
 *
 * Whether any transfer of the token touching the address landed after
 * `sinceBlock`, and the newest block seen. `token` as on `GET /v1/activity`
 * (absent, USDC; a token off the chain's table, 400 `unsupported_token`). The
 * app serves its cache when `hasNew` is false and keeps `latestBlock` as its
 * next `sinceBlock`, per token.
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

  const token = requestedToken(chainId, c.req.query('token'));
  if (!token) {
    return c.json({ ok: false, error: 'unsupported_token' }, 400);
  }

  try {
    const result = await checkActivity(c.env.SQD_PORTAL_URL, address, sinceBlock, chainId, {
      ...activityOptions(c.env, chainId),
      token,
    });
    return c.json({
      ok: true,
      chainId,
      address: address.toLowerCase(),
      token: token.address.toLowerCase(),
      hasNew: result.hasNew,
      latestBlock: result.latestBlock,
    });
  } catch (err) {
    return failure(c, 'activity_check_failed', err);
  }
});

/** The subscriptions' secrets in `CDP_WEBHOOK_SECRET`, comma-separated (one per subscription: MockUSDC, pBRL). */
export function webhookSecrets(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * GET and HEAD /v1/activity/webhooks/cdp: CDP refuses a subscription whose
 * target does not answer HEAD with 200, and Hono serves HEAD through the GET
 * route. Empty, and the same whatever is configured.
 */
activityRoutes.get('/webhooks/cdp', (c) => c.body(null, 200));

/**
 * POST /v1/activity/webhooks/cdp
 *
 * Coinbase Developer Platform onchain webhook (`onchain.activity.detected`,
 * filtered to the token contract and `Transfer`). Verifies `X-Hook0-Signature`
 * over the raw body, then records each transfer of a webhook-fed token
 * (`ACTIVITY_TOKENS` entries with `webhookFed`, MockUSDC today) for its sender
 * and recipient. Deliveries are at-least-once; the store dedupes on
 * (hash, logIndex). Events for other contracts or networks are acknowledged
 * and ignored.
 */
activityRoutes.post('/webhooks/cdp', async (c) => {
  const secrets = webhookSecrets(c.env.CDP_WEBHOOK_SECRET);
  if (secrets.length === 0 || !c.env.ACTIVITY_DO) {
    return c.json({ ok: false, error: 'activity_store_unprovisioned' }, 503);
  }
  const raw = await c.req.text();
  const header = c.req.header('x-hook0-signature');
  let signed = false;
  for (const secret of secrets) if (!signed && (await verifyCdpSignature(raw, header, secret))) signed = true;
  if (!signed) {
    return c.json({ ok: false, error: 'invalid_signature' }, 401);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ ok: false, error: 'bad_json' }, 400);
  }

  const store = new DurableActivityStore(c.env.ACTIVITY_DO);
  const events = Array.isArray(body) ? body : [body];
  let recorded = 0;
  let ignored = 0;
  for (const event of events) {
    const parsed = parseCdpTransfer(event, isWebhookFedToken);
    if (!parsed || !STORE_CHAINS.has(parsed.chainId)) {
      ignored++;
      continue;
    }
    for (const addr of recordAddresses(parsed.transfer)) {
      if (await store.record(parsed.chainId, addr, parsed.transfer)) recorded++;
    }
  }
  return c.json({ ok: true, recorded, ignored });
});
