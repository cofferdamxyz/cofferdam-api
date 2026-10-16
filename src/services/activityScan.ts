// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Chunked ERC-20 Transfer scans over JSON-RPC `eth_getLogs`.
 *
 * Providers cap the block range of one `eth_getLogs` call. The public Base
 * Sepolia node accepts at most 201 blocks (checked 2026-10-15: 202 answers
 * "eth_getLogs is limited to a 200 range"), so the default chunk is 200
 * blocks. A call that still fails after one retry is an error, never an empty
 * result: an empty answer would read as "no transfers" and hide real activity.
 *
 * Each request makes at most `maxCalls` log calls. Base Sepolia moves to 200 ms
 * blocks with Denim (2026-10-21), so a block-count window shrinks tenfold in
 * time; the plane's webhook-fed store (`activityStore.ts`) carries history,
 * and this scan only reaches back as far as its call budget allows.
 *
 * Pure apart from the injected `LogReader`, so the tests drive it with fakes.
 */

/** One decoded Transfer log. */
export interface TransferLog {
  hash: string;
  logIndex: number;
  blockNumber: number;
  /** Unix seconds; Base logs carry `blockTimestamp`. */
  timestamp: number;
  from: string;
  to: string;
  value: bigint;
}

/** The chain reads a scan needs. */
export interface LogReader {
  head(): Promise<number>;
  /** Transfer logs of the token in `[fromBlock, toBlock]`, inclusive. */
  transfers(fromBlock: number, toBlock: number): Promise<TransferLog[]>;
}

/** Inclusive span per call accepted by the public Base Sepolia node. */
export const PUBLIC_LOG_RANGE = 200;
/** Log calls one request may make. */
export const MAX_LOG_CALLS = 30;

/** An RPC refusal that the route turns into a 502, so the app keeps its cache. */
export class ActivityRpcError extends Error {}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    try {
      return await fn();
    } catch (err) {
      throw new ActivityRpcError(err instanceof Error ? err.message : String(err));
    }
  }
}

function touches(log: TransferLog, addr: string): boolean {
  return log.from === addr || log.to === addr;
}

/** Newest first; one entry per (hash, logIndex). */
export function sortUnique(logs: TransferLog[]): TransferLog[] {
  const seen = new Set<string>();
  return [...logs]
    .sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex)
    .filter((l) => {
      const key = `${l.hash}:${l.logIndex}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export interface BackwardScan {
  /** Matching transfers, newest first, at most `limit`. */
  matches: TransferLog[];
  /** Pass as the next page's `toBlock` (inclusive); null once `lower` is reached. */
  cursor: number | null;
}

/**
 * Walk `[lower, upper]` from `upper` down in `range`-block chunks until
 * `limit` transfers touching `addr` are found, `lower` is reached or the call
 * budget runs out. The first chunk failing is an error; a later failure stops
 * the walk and the cursor resumes from the last chunk that succeeded.
 */
export async function scanBackward(
  reader: LogReader,
  address: string,
  opts: { upper: number; lower: number; limit: number; range?: number; maxCalls?: number },
): Promise<BackwardScan> {
  const addr = address.toLowerCase();
  const range = Math.max(1, opts.range ?? PUBLIC_LOG_RANGE);
  const maxCalls = Math.max(1, opts.maxCalls ?? MAX_LOG_CALLS);
  const lower = Math.max(0, opts.lower);
  const found: TransferLog[] = [];

  let chunkTo = opts.upper;
  let scannedDownTo = opts.upper + 1;
  for (let call = 0; call < maxCalls && chunkTo >= lower; call++) {
    const chunkFrom = Math.max(lower, chunkTo - range + 1);
    let logs: TransferLog[];
    try {
      logs = await withRetry(() => reader.transfers(chunkFrom, chunkTo));
    } catch (err) {
      if (call === 0) throw err;
      break;
    }
    for (const log of logs) if (touches(log, addr)) found.push(log);
    scannedDownTo = chunkFrom;
    if (found.length >= opts.limit) break;
    chunkTo = chunkFrom - 1;
  }

  const unique = sortUnique(found);
  const matches = unique.slice(0, opts.limit);
  let cursor: number | null;
  if (unique.length > opts.limit) {
    // More matches than returned: resume at the oldest one returned (the app dedups by id).
    cursor = matches[matches.length - 1]!.blockNumber;
  } else {
    cursor = scannedDownTo > lower ? scannedDownTo - 1 : null;
  }
  return { matches, cursor };
}

/**
 * Whether any transfer touching `addr` landed in `[from, to]`. A gap wider than
 * the call budget answers `true` without scanning, so the app refetches
 * instead of trusting a stale cache.
 */
export async function scanForwardHasTransfer(
  reader: LogReader,
  address: string,
  opts: { from: number; to: number; range?: number; maxCalls?: number },
): Promise<boolean> {
  const addr = address.toLowerCase();
  const range = Math.max(1, opts.range ?? PUBLIC_LOG_RANGE);
  const maxCalls = Math.max(1, opts.maxCalls ?? MAX_LOG_CALLS);
  if (opts.to < opts.from) return false;
  if (opts.to - opts.from + 1 > range * maxCalls) return true;
  for (let chunkFrom = opts.from; chunkFrom <= opts.to; chunkFrom += range) {
    const chunkTo = Math.min(opts.to, chunkFrom + range - 1);
    const logs = await withRetry(() => reader.transfers(chunkFrom, chunkTo));
    if (logs.some((l) => touches(l, addr))) return true;
  }
  return false;
}
