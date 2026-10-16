// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live check against the public Base Sepolia node (opt-in: ACTIVITY_LIVE=1).
 * The public node caps eth_getLogs at 201 blocks; the scan must stay under it
 * and return real transfers instead of an empty list.
 */

import { describe, expect, it } from 'vitest';

import { checkActivity, getActivity } from '../src/services/activity.js';

const LIVE = process.env.ACTIVITY_LIVE === '1';
const ACCOUNT = process.env.ACTIVITY_LIVE_ADDRESS ?? '0xbb5238708557943af8348edc7ffaaca15c751c53';
const RPC = 'https://sepolia.base.org';

describe.skipIf(!LIVE)('activity on Base Sepolia (live)', () => {
  it('scans in 200-block chunks and finds recent transfers', async () => {
    const r = await getActivity(undefined, ACCOUNT, 5, 0, 84532, { rpcUrl: RPC });
    expect(r.headBlock).toBeGreaterThan(0);
    expect(r.transactions.length).toBeGreaterThan(0);
    for (const tx of r.transactions) {
      expect([tx.from, tx.to]).toContain(ACCOUNT);
      expect(tx.timestamp).toBeGreaterThan(1_700_000_000);
    }
  }, 120_000);

  it('the check covers a gap wider than one call', async () => {
    const first = await getActivity(undefined, ACCOUNT, 1, 0, 84532, { rpcUrl: RPC });
    const newest = first.transactions[0]!.blockNumber;
    const r = await checkActivity(undefined, ACCOUNT, newest - 1, 84532, { rpcUrl: RPC });
    expect(r.hasNew).toBe(true);
    expect(r.latestBlock).toBeGreaterThanOrEqual(newest);
  }, 120_000);
});
