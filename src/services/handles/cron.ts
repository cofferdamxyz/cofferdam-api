// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The handle registry's scheduled run (`wrangler.jsonc` `triggers.crons`,
 * every minute): the sweep of expired share links, lapsed holds and old
 * hold-log rows, then one run of the announcement indexer. Each step logs
 * counts only, and a failure of one does not stop the other.
 */

import { chainRpcUrl } from '../../chain/chains.js';
import type { Env } from '../../env.js';
import { D1FeedStore, FEED_CHAIN_ID, indexAnnouncements, parseFeedTokens, parsePlaneCallers, rpcFeedChain, type FeedChain } from './announcements.js';
import { handlesLog } from './limits.js';
import { D1HandleStore } from './store.js';

export interface HandlesCronDeps {
  now(): number;
  /** The feed's chain (default: JSON-RPC on `ANNOUNCEMENTS_RPC_URL`, else Base Sepolia's URL). */
  chain?(env: Env): FeedChain | null;
}

/** `ANNOUNCEMENTS_FROM_BLOCK` as a block number, or null (the indexer is off). */
export function feedStartBlock(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,12}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

function envFeedChain(env: Env): FeedChain | null {
  const url = env.ANNOUNCEMENTS_RPC_URL?.trim() || chainRpcUrl(env, FEED_CHAIN_ID);
  return url ? rpcFeedChain(url) : null;
}

export async function runHandlesCron(env: Env, deps: HandlesCronDeps): Promise<void> {
  const db = env.HANDLES_DB;
  if (!db) return;
  try {
    const swept = await new D1HandleStore(db).sweep(deps.now());
    handlesLog({ route: 'cron', step: 'sweep', ...swept });
  } catch (err) {
    handlesLog({ route: 'cron', step: 'sweep', error: err instanceof Error ? err.name : typeof err });
  }

  const fromBlock = feedStartBlock(env.ANNOUNCEMENTS_FROM_BLOCK);
  const chain = fromBlock === null ? null : (deps.chain ?? envFeedChain)(env);
  if (fromBlock === null || !chain) return;
  const feed = new D1FeedStore(db);
  const holder = crypto.randomUUID();
  // One run at a time: a run that overlaps another (a slow node) does nothing, so no failure is counted twice.
  if (!(await feed.lease(FEED_CHAIN_ID, holder, deps.now()).catch(() => false))) {
    handlesLog({ route: 'cron', step: 'announcements', leased: false });
    return;
  }
  try {
    const run = await indexAnnouncements({
      chain,
      store: feed,
      chainId: FEED_CHAIN_ID,
      fromBlock,
      planeCallers: parsePlaneCallers(env.ANNOUNCEMENTS_PLANE_CALLERS),
      tokens: parseFeedTokens(env.ANNOUNCEMENTS_TOKENS),
      now: () => deps.now(),
    });
    // A gap or an unchecked keep is an alert for the founder: the feed names the gap, and phones scan it themselves.
    handlesLog({
      route: 'cron',
      step: 'announcements',
      chunks: run.chunks,
      kept: run.kept,
      unchecked: run.unchecked,
      dropped: run.dropped,
      gaps: run.gaps,
      full: run.full,
      through: run.through ?? -1,
    });
  } catch (err) {
    // The chunks before the failure are committed; the next run reads the failed one again.
    handlesLog({ route: 'cron', step: 'announcements', error: err instanceof Error ? err.name : typeof err });
  } finally {
    await feed.release(FEED_CHAIN_ID, holder).catch(() => undefined);
  }
}
