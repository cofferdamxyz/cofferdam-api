// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  ActivityRpcError,
  scanBackward,
  scanForwardHasTransfer,
  type LogReader,
  type TransferLog,
} from '../src/services/activityScan.js';

const ME = '0x' + 'a'.repeat(40);
const OTHER = '0x' + 'b'.repeat(40);

function log(blockNumber: number, from: string, to: string, logIndex = 0): TransferLog {
  return { hash: '0x' + blockNumber.toString(16).padStart(64, '0'), logIndex, blockNumber, timestamp: blockNumber, from, to, value: 1n };
}

/** A node that refuses spans above `maxSpan` (inclusive count), like sepolia.base.org's 201. */
function fakeReader(logs: TransferLog[], head: number, maxSpan = 201, failAt: Set<number> = new Set()) {
  const calls: Array<[number, number]> = [];
  const reader: LogReader = {
    head: async () => head,
    transfers: async (from, to) => {
      calls.push([from, to]);
      if (to - from + 1 > maxSpan) throw new Error('eth_getLogs is limited to a 200 range');
      if (failAt.has(from)) throw new Error('RPC Request failed.');
      return logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to);
    },
  };
  return { reader, calls };
}

describe('scanBackward', () => {
  it('stays within the node cap and finds transfers in either direction, newest first', async () => {
    const logs = [log(950, OTHER, ME), log(700, ME, OTHER), log(690, OTHER, OTHER)];
    const { reader, calls } = fakeReader(logs, 1000);
    const r = await scanBackward(reader, ME, { upper: 1000, lower: 0, limit: 10, range: 200, maxCalls: 10 });
    expect(r.matches.map((m) => m.blockNumber)).toEqual([950, 700]);
    expect(calls.every(([f, t]) => t - f + 1 <= 200)).toBe(true);
    expect(r.cursor).toBeNull();
  });

  it('a refused first call is an error, never an empty list', async () => {
    const { reader } = fakeReader([log(950, OTHER, ME)], 1000, 201);
    await expect(scanBackward(reader, ME, { upper: 1000, lower: 0, limit: 10, range: 2000 })).rejects.toBeInstanceOf(ActivityRpcError);
  });

  it('stops at the call budget and resumes below the last chunk scanned', async () => {
    const { reader, calls } = fakeReader([log(100, OTHER, ME)], 10_000);
    const r = await scanBackward(reader, ME, { upper: 10_000, lower: 0, limit: 10, range: 200, maxCalls: 3 });
    expect(calls).toHaveLength(3);
    expect(r.matches).toHaveLength(0);
    expect(r.cursor).toBe(10_000 - 600);
  });

  it('a later failure keeps what was found and the cursor resumes at the failed chunk', async () => {
    const { reader } = fakeReader([log(990, OTHER, ME)], 1000, 201, new Set([601]));
    const r = await scanBackward(reader, ME, { upper: 1000, lower: 0, limit: 10, range: 200, maxCalls: 10 });
    expect(r.matches.map((m) => m.blockNumber)).toEqual([990]);
    expect(r.cursor).toBe(800);
  });

  it('with more matches than the limit, resumes at the oldest one returned', async () => {
    const logs = [log(999, OTHER, ME, 2), log(999, OTHER, ME, 1), log(999, OTHER, ME, 0)];
    const { reader } = fakeReader(logs, 1000);
    const r = await scanBackward(reader, ME, { upper: 1000, lower: 0, limit: 2, range: 200 });
    expect(r.matches.map((m) => m.logIndex)).toEqual([2, 1]);
    expect(r.cursor).toBe(999);
  });
});

describe('scanForwardHasTransfer', () => {
  it('finds a transfer in a small gap within the cap', async () => {
    const { reader, calls } = fakeReader([log(1150, ME, OTHER)], 1200);
    expect(await scanForwardHasTransfer(reader, ME, { from: 1001, to: 1200, range: 200 })).toBe(true);
    expect(calls.every(([f, t]) => t - f + 1 <= 200)).toBe(true);
  });

  it('answers false when nothing touches the address', async () => {
    const { reader } = fakeReader([log(1150, OTHER, OTHER)], 1200);
    expect(await scanForwardHasTransfer(reader, ME, { from: 1001, to: 1200, range: 200 })).toBe(false);
  });

  it('answers true without scanning when the gap exceeds the budget', async () => {
    const { reader, calls } = fakeReader([], 1_000_000);
    expect(await scanForwardHasTransfer(reader, ME, { from: 1, to: 1_000_000, range: 200, maxCalls: 30 })).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('propagates a refusal instead of answering false', async () => {
    const { reader } = fakeReader([], 1200, 201, new Set([1001]));
    await expect(scanForwardHasTransfer(reader, ME, { from: 1001, to: 1200, range: 200 })).rejects.toBeInstanceOf(ActivityRpcError);
  });
});
