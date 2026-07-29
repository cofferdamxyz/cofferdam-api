// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Activity service — fetches ERC-20 Transfer events for a wallet address.
 *
 * Dual data source strategy (decision 2026-06-26):
 * - Base Sepolia (84532): direct RPC `eth_getLogs` with 2000-block pagination.
 *   SQD Portal's base-sepolia dataset is archival-only and lags ~10 days behind
 *   chain head, so RPC is the only way to get recent testnet transactions.
 *   Public RPC caps eth_getLogs at 2000 blocks/call; 15 chunks × 2000 = 30K
 *   blocks ≈ 24h lookback at 2s block time.
 * - Base Mainnet (8453): SQD Portal Stream API (real-time, 7-day lookback).
 *   Portal's base-mainnet dataset has real_time=true, so the timestamp
 *   resolver and stream queries cover recent blocks.
 *
 * Optimistic UI on the client side (addPendingTx) ensures transactions
 * appear instantly; this route fills in confirmed history.
 */

import { createPublicClient, http, parseAbiItem, type Log } from 'viem';
import { base, baseSepolia } from 'viem/chains';

/** USDC token addresses per chain. */
const USDC_ADDRESSES: Record<number, { address: string; decimals: number }> = {
  // MockUSDC on Base Sepolia (from base-contracts/deployments/baseSepolia.json)
  84532: { address: '0x8c05Df95F91De2D70e0436B774fc9D1f86FF1f51', decimals: 6 },
  // Native USDC on Base Mainnet
  8453: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
};

function usdcFor(chainId: number): { address: string; decimals: number } {
  return USDC_ADDRESSES[chainId] ?? USDC_ADDRESSES[84532]!;
}

/** ERC-20 Transfer event signature: keccak256("Transfer(address,address,uint256)"). */
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Default lookback window in seconds (7 days). */
const LOOKBACK_SECONDS = 7 * 24 * 60 * 60;
const MAX_RESULTS = 50;

/** RPC pagination: Base Sepolia public RPC caps eth_getLogs at 2000 blocks/call. */
const RPC_BLOCK_BATCH = 2000;
const RPC_MAX_CHUNKS = 15; // 15 × 2000 = 30K blocks ≈ 24h at 2s block time

/** Default Portal base URLs per chain. */
const DEFAULT_PORTAL_URLS: Record<number, string> = {
  84532: 'https://portal.sqd.dev/datasets/base-sepolia',
  8453: 'https://portal.sqd.dev/datasets/base-mainnet',
};

/** Chain IDs that use the RPC fallback (Portal not real-time). */
const RPC_FALLBACK_CHAINS = new Set([84532]);

function portalUrlFor(chainId: number, override?: string): string {
  return override || DEFAULT_PORTAL_URLS[chainId] || DEFAULT_PORTAL_URLS[84532]!;
}

export interface ActivityTx {
  hash: string;
  direction: 'in' | 'out';
  from: string;
  to: string;
  value: string;
  valueFormatted: number;
  tokenAddress: string;
  blockNumber: number;
  timestamp: number;
  logIndex: number;
}

/** Result of getActivity: txs + cursor for pagination. */
export interface ActivityResult {
  transactions: ActivityTx[];
  /** Oldest block in the result set; pass as `toBlock` for the next page. */
  cursor: number | null;
}

/** Build an ActivityTx from a raw ERC-20 Transfer log. */
function logToTx(log: Log, addr: string, tokenAddress: string, decimals: number, timestamp: number): ActivityTx | null {
  if (!log.topics || log.topics.length < 3 || !log.data) return null;
  const from = '0x' + (log.topics[1] ?? '').slice(-40).toLowerCase();
  const to = '0x' + (log.topics[2] ?? '').slice(-40).toLowerCase();
  const value = BigInt(log.data as `0x${string}`);
  return {
    hash: log.transactionHash ?? '',
    direction: from === addr ? 'out' : 'in',
    from,
    to,
    value: value.toString(),
    valueFormatted: Number(value) / 10 ** decimals,
    tokenAddress: tokenAddress.toLowerCase(),
    blockNumber: Number(log.blockNumber ?? 0),
    timestamp,
    logIndex: Number(log.logIndex ?? 0),
  };
}

/** Parsed Portal block response (NDJSON, one per line). */
interface PortalBlock {
  header: { number: number; timestamp: number };
  logs?: Array<{
    address: string;
    topics: string[];
    data: string;
    logIndex: number;
    transactionHash: string;
  }>;
}

/** Pad a 20-byte address to a 32-byte topic (left-padded with zeros). */
function padAddressToTopic(addr: string): string {
  return '0x' + addr.slice(2).toLowerCase().padStart(64, '0');
}

/** Resolve a Unix timestamp (seconds) to a block number via Portal.
 * If the dataset hasn't indexed up to the requested timestamp (e.g. archival-
 * only datasets that lag behind chain head), retries with progressively older
 * timestamps before falling back to genesis. */
async function resolveBlockAtTimestamp(
  portalBase: string,
  timestamp: number,
): Promise<number> {
  // Try the requested timestamp, then step back in 7-day increments.
  for (let attempt = 0; attempt < 4; attempt++) {
    const ts = timestamp - attempt * LOOKBACK_SECONDS;
    const res = await fetch(`${portalBase}/timestamps/${ts}/block`);
    if (res.ok) {
      const data = (await res.json()) as { block_number: number };
      return data.block_number;
    }
    if (res.status !== 404) {
      throw new Error(`Portal timestamp resolve HTTP ${res.status}`);
    }
    // 404 → dataset hasn't reached this timestamp, try older.
  }
  // All attempts failed — scan from genesis.
  return 0;
}

export interface ActivityCheckResult {
  hasNew: boolean;
  latestBlock: number;
}

/**
 * Lightweight check for new ERC-20 Transfer events since a given block.
 * Queries Portal with minimal fields (block number only) from `sinceBlock + 1`
 * to head. Returns whether any new txs exist and the latest block seen.
 *
 * Used by the app for reconciliation: if no new txs, the app serves from its
 * local AsyncStorage cache instead of fetching the full activity list.
 */
export async function checkActivity(
  portalUrl: string | undefined,
  address: string,
  sinceBlock: number,
  chainId: number = 84532,
  rpcUrl?: string,
): Promise<ActivityCheckResult> {
  if (RPC_FALLBACK_CHAINS.has(chainId)) {
    return checkActivityViaRpc(address, sinceBlock, chainId, rpcUrl);
  }
  return checkActivityViaPortal(portalUrl, address, sinceBlock, chainId);
}

/** RPC-based check: eth_getLogs from sinceBlock+1 to chain head. */
async function checkActivityViaRpc(
  address: string,
  sinceBlock: number,
  chainId: number,
  rpcUrl?: string,
): Promise<ActivityCheckResult> {
  const addr = address.toLowerCase();
  const token = usdcFor(chainId);
  const client = createPublicClient({
    chain: chainId === 8453 ? base : baseSepolia,
    transport: http(rpcUrl),
  });

  const head = await client.getBlockNumber();
  const latestBlock = Number(head);

  const logs = await client.getLogs({
    address: token.address as `0x${string}`,
    events: [parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')],
    fromBlock: BigInt(sinceBlock + 1),
    toBlock: head,
  }).catch(() => [] as Log[]);

  // Filter for logs where the address is either from or to.
  const matchingLogs = logs.filter((l) => {
    if (!l.topics || l.topics.length < 3) return false;
    const from = '0x' + l.topics[1]!.slice(-40).toLowerCase();
    const to = '0x' + l.topics[2]!.slice(-40).toLowerCase();
    return from === addr || to === addr;
  });

  return { hasNew: matchingLogs.length > 0, latestBlock };
}

/** Portal-based check (mainnet). */
async function checkActivityViaPortal(
  portalUrl: string | undefined,
  address: string,
  sinceBlock: number,
  chainId: number,
): Promise<ActivityCheckResult> {
  const portalBase = portalUrlFor(chainId, portalUrl);
  const addr = address.toLowerCase();
  const paddedAddr = padAddressToTopic(addr);
  const token = usdcFor(chainId);

  const body = {
    type: 'evm' as const,
    fromBlock: sinceBlock + 1,
    fields: { block: { number: true } },
    logs: [
      { address: [token.address], topic0: [TRANSFER_TOPIC], topic1: [paddedAddr] },
      { address: [token.address], topic0: [TRANSFER_TOPIC], topic2: [paddedAddr] },
    ],
  };

  let latestBlock = sinceBlock;
  let hasNew = false;

  let currentFrom = sinceBlock + 1;
  const MAX_ITERATIONS = 10;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const res = await fetch(`${portalBase}/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, fromBlock: currentFrom }),
    });

    if (res.status === 204) break;
    if (!res.ok) {
      throw new Error(`Portal stream HTTP ${res.status}: ${await res.text()}`);
    }

    const text = await res.text();
    const lines = text.trim().split('\n').filter(Boolean);
    if (lines.length === 0) break;

    for (const line of lines) {
      const block = JSON.parse(line) as PortalBlock;
      latestBlock = Math.max(latestBlock, block.header.number);
      if (block.logs && block.logs.length > 0) {
        hasNew = true;
      }
    }

    if (hasNew) break;

    const lastLine = lines[lines.length - 1];
    if (!lastLine) break;
    const lastBlock = (JSON.parse(lastLine) as PortalBlock).header.number;
    currentFrom = lastBlock + 1;
  }

  return { hasNew, latestBlock };
}

export async function getActivity(
  portalUrl: string | undefined,
  address: string,
  limit: number = 10,
  fromBlock?: number,
  chainId: number = 84532,
  rpcUrl?: string,
  toBlock?: number,
): Promise<ActivityResult> {
  if (RPC_FALLBACK_CHAINS.has(chainId)) {
    return getActivityViaRpc(address, limit, fromBlock, chainId, rpcUrl, toBlock);
  }
  return getActivityViaPortal(portalUrl, address, limit, fromBlock, chainId, toBlock);
}

/**
 * RPC-based activity fetch for Sepolia (or any chain in RPC_FALLBACK_CHAINS).
 * Paginates eth_getLogs in 2000-block chunks from chain head backwards.
 * 15 chunks × 2000 blocks = 30K blocks ≈ 24h lookback at 2s block time.
 */
async function getActivityViaRpc(
  address: string,
  limit: number,
  fromBlock: number | undefined,
  chainId: number,
  rpcUrl?: string,
  toBlockOverride?: number,
): Promise<ActivityResult> {
  const addr = address.toLowerCase();
  const token = usdcFor(chainId);
  const client = createPublicClient({
    chain: chainId === 8453 ? base : baseSepolia,
    transport: http(rpcUrl),
  });

  const head = await client.getBlockNumber();
  const headNum = Number(head);

  // Determine block range: toBlock (cursor) or head; fromBlock or 24h lookback.
  const upperBlock = toBlockOverride != null && toBlockOverride >= 0 ? toBlockOverride : headNum;
  let startBlock: number;
  if (fromBlock != null && fromBlock >= 0) {
    startBlock = fromBlock;
  } else {
    // Estimate 24h lookback: 86400s / 2s per block = 43200 blocks.
    startBlock = Math.max(0, upperBlock - 43200);
  }

  const cap = Math.min(limit, MAX_RESULTS);
  const event = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
  const allTxs: ActivityTx[] = [];

  // Paginate from upperBlock backwards in 2000-block chunks.
  let chunkToBlock = upperBlock;
  for (let chunk = 0; chunk < RPC_MAX_CHUNKS; chunk++) {
    const fromBn = Math.max(startBlock, chunkToBlock - RPC_BLOCK_BATCH + 1);
    if (fromBn > chunkToBlock) break;

    const logs = await client.getLogs({
      address: token.address as `0x${string}`,
      events: [event],
      fromBlock: BigInt(fromBn),
      toBlock: BigInt(chunkToBlock),
    }).catch(() => [] as Log[]);

    // Filter for logs where the address is either from or to.
    const matchingLogs = logs.filter((l) => {
      if (!l.topics || l.topics.length < 3) return false;
      const from = '0x' + l.topics[1]!.slice(-40).toLowerCase();
      const to = '0x' + l.topics[2]!.slice(-40).toLowerCase();
      return from === addr || to === addr;
    });

    // Fetch block timestamps for unique blocks in this batch.
    const blockNums = [...new Set(logs.map((l) => Number(l.blockNumber)))];
    const blockTsMap = new Map<number, number>();
    for (const bn of blockNums) {
      const block = await client.getBlock({ blockNumber: BigInt(bn) }).catch(() => null);
      if (block) blockTsMap.set(bn, Number(block.timestamp));
    }

    for (const log of matchingLogs) {
      const bn = Number(log.blockNumber ?? 0);
      const tx = logToTx(log, addr, token.address, token.decimals, blockTsMap.get(bn) ?? 0);
      if (tx) allTxs.push(tx);
    }

    if (allTxs.length >= cap * 2) break;
    chunkToBlock = fromBn - 1;
    if (chunkToBlock < startBlock) break;
  }

  // Sort desc, dedup, cap.
  allTxs.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
  const seen = new Set<string>();
  const unique = allTxs.filter((t) => {
    const key = `${t.hash}:${t.logIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const capped = unique.slice(0, cap);
  const cursor = capped.length > 0 ? capped[capped.length - 1]!.blockNumber : null;
  return { transactions: capped, cursor };
}

/**
 * Portal-based activity fetch for Mainnet (real-time dataset).
 * 7-day lookback via Portal's timestamp-to-block resolver.
 */
async function getActivityViaPortal(
  portalUrl: string | undefined,
  address: string,
  limit: number,
  fromBlock: number | undefined,
  chainId: number,
  toBlockOverride?: number,
): Promise<ActivityResult> {
  const portalBase = portalUrlFor(chainId, portalUrl);
  const addr = address.toLowerCase();
  const paddedAddr = padAddressToTopic(addr);
  const token = usdcFor(chainId);

  const startBlock =
    fromBlock != null && fromBlock >= 0
      ? fromBlock
      : await resolveBlockAtTimestamp(
          portalBase,
          Math.floor(Date.now() / 1000) - LOOKBACK_SECONDS,
        );

  const baseBody = {
    type: 'evm' as const,
    fields: {
      block: { number: true, timestamp: true },
      log: {
        address: true,
        topics: true,
        data: true,
        logIndex: true,
        transactionHash: true,
      },
    },
    logs: [
      { address: [token.address], topic0: [TRANSFER_TOPIC], topic1: [paddedAddr] },
      { address: [token.address], topic0: [TRANSFER_TOPIC], topic2: [paddedAddr] },
    ],
  };

  const transfers: Array<{
    hash: string;
    from: string;
    to: string;
    data: string;
    blockNumber: number;
    timestamp: number;
    logIndex: number;
  }> = [];

  let currentFrom = startBlock;
  const cap = Math.min(limit, MAX_RESULTS);
  const MAX_ITERATIONS = 50;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const body: Record<string, unknown> = { ...baseBody, fromBlock: currentFrom };
    if (toBlockOverride != null && toBlockOverride >= 0) {
      body.toBlock = toBlockOverride;
    }

    const res = await fetch(`${portalBase}/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 204) break;
    if (!res.ok) {
      throw new Error(`Portal stream HTTP ${res.status}: ${await res.text()}`);
    }

    const text = await res.text();
    const lines = text.trim().split('\n').filter(Boolean);
    if (lines.length === 0) break;

    let lastBlock = currentFrom - 1;

    for (const line of lines) {
      const block = JSON.parse(line) as PortalBlock;
      lastBlock = block.header.number;

      if (!block.logs) continue;

      for (const log of block.logs) {
        if (!log.topics || log.topics.length < 3) continue;
        const from = '0x' + (log.topics[1] ?? '').slice(-40).toLowerCase();
        const to = '0x' + (log.topics[2] ?? '').slice(-40).toLowerCase();

        transfers.push({
          hash: log.transactionHash ?? '',
          from,
          to,
          data: log.data ?? '0x0',
          blockNumber: block.header.number,
          timestamp: block.header.timestamp ?? 0,
          logIndex: log.logIndex ?? 0,
        });
      }
    }

    currentFrom = lastBlock + 1;
    if (transfers.length >= cap * 2) break;
    // Stop if we've passed the toBlock cursor.
    if (toBlockOverride != null && lastBlock >= toBlockOverride) break;
  }

  transfers.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);

  const seen = new Set<string>();
  const unique = transfers.filter((t) => {
    const key = `${t.hash}:${t.logIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const capped = unique.slice(0, cap);

  const result: ActivityTx[] = capped.map((t) => {
    const value = BigInt(t.data);
    return {
      hash: t.hash,
      direction: (t.from === addr ? 'out' : 'in') as 'in' | 'out',
      from: t.from,
      to: t.to,
      value: value.toString(),
      valueFormatted: Number(value) / 10 ** token.decimals,
      tokenAddress: token.address.toLowerCase(),
      blockNumber: t.blockNumber,
      timestamp: t.timestamp,
      logIndex: t.logIndex,
    };
  });

  const cursor = result.length > 0 ? result[result.length - 1]!.blockNumber : null;
  return { transactions: result, cursor };
}
