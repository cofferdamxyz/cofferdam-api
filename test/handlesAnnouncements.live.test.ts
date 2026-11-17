// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live check of the announcement indexer against the public Base Sepolia node
 * (opt-in: ANNOUNCEMENTS_LIVE=1): the `safe` head reads, a run of 200-block
 * chunks stays under the node's cap, and every kept announcement passes the
 * value filter by construction. Public chain data only.
 */

import { describe, expect, it } from 'vitest';

import { D1FeedStore, FEED_CHAIN_ID, indexAnnouncements, rpcFeedChain } from '../src/services/handles/announcements.js';
import { handlesD1 } from './fixtures/handles/d1.js';

const LIVE = process.env.ANNOUNCEMENTS_LIVE === '1';
const RPC = process.env.ANNOUNCEMENTS_LIVE_RPC ?? 'https://sepolia.base.org';

describe.skipIf(!LIVE)('the announcement feed on Base Sepolia (live)', () => {
  it('indexes the last 1,000 safe blocks in 200-block chunks', async () => {
    const chain = rpcFeedChain(RPC);
    const head = await chain.safeHead();
    expect(head).toBeGreaterThan(0n);
    const store = new D1FeedStore(handlesD1().d1);
    const run = await indexAnnouncements({ chain, store, chainId: FEED_CHAIN_ID, fromBlock: Number(head) - 999, planeCallers: new Set(), now: () => Date.now(), maxChunks: 5 });
    expect(run.chunks).toBe(5);
    expect(run.through).toBe(Number(head));
    console.log(JSON.stringify({ head: Number(head), kept: run.kept }));
  }, 120_000);
});
