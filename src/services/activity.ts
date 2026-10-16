// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Activity service — USDC Transfer events for a wallet address.
 *
 * - Base Sepolia (84532): the plane's own record, fed by a Coinbase Developer
 *   Platform onchain webhook (`activityStore.ts`, workspace decision 0032),
 *   once `ACTIVITY_INDEX_FROM_BLOCK` and the `ACTIVITY_DO` binding are set.
 *   Blocks older than the subscription, and every request while the store is
 *   off, come from chunked `eth_getLogs` scans (`activityScan.ts`): the public
 *   node caps one call at 201 blocks, so scans run in 200-block chunks within a
 *   per-request call budget. SQD Portal's base-sepolia dataset is not
 *   real-time, so it cannot serve recent testnet activity.
 * - Base Mainnet (8453): SQD Portal Stream API (real-time dataset, 7-day
 *   lookback). The public Portal is rate-limited and used without an API key;
 *   on 429/529/502/503 or a network failure the same query runs as a chunked
 *   RPC scan and Portal is skipped for `Retry-After`.
 *
 * RPC refusals surface as errors (502 on the route), never as an empty list,
 * so the app keeps its cache instead of showing no activity.
 */

import { createPublicClient, http, parseAbiItem } from 'viem';
import { base, baseSepolia } from 'viem/chains';

import {
  MAX_LOG_CALLS,
  PUBLIC_LOG_RANGE,
  scanBackward,
  scanForwardHasTransfer,
  type LogReader,
  type TransferLog,
} from './activityScan.js';
import type { ActivityStore, StoredTransfer } from './activityStore.js';

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

/** The token the activity routes report on for a chain, or null for an unknown chain. */
export function activityTokenFor(chainId: number): string | null {
  return USDC_ADDRESSES[chainId]?.address ?? null;
}

/** Chains whose activity the webhook-fed store records. */
export const STORE_CHAINS = new Set([84532]);

/** ERC-20 Transfer event signature: keccak256("Transfer(address,address,uint256)"). */
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Default lookback window in seconds (7 days). */
const LOOKBACK_SECONDS = 7 * 24 * 60 * 60;
const MAX_RESULTS = 50;

/** Portal dataset slugs per chain; the default URL and the override check derive from them. */
const PORTAL_DATASETS: Record<number, string> = {
  84532: 'base-sepolia',
  8453: 'base-mainnet',
};

/** Default Portal base URLs per chain. */
const DEFAULT_PORTAL_URLS: Record<number, string> = Object.fromEntries(
  Object.entries(PORTAL_DATASETS).map(([chainId, slug]) => [chainId, `https://portal.sqd.dev/datasets/${slug}`]),
);

/** Chain IDs that use the RPC fallback (Portal not real-time). */
const RPC_FALLBACK_CHAINS = new Set([84532]);

/**
 * The Portal URL for a chain. `SQD_PORTAL_URL` overrides the default only for
 * the chain whose dataset it names (`…/datasets/base-mainnet` serves 8453 and
 * nothing else), so a Sepolia value in the deployment can never send a
 * `chainId=8453` request to the Sepolia dataset. Exported for its tests.
 */
export function portalUrlFor(chainId: number, override?: string): string {
  const slug = PORTAL_DATASETS[chainId];
  if (override && slug && override.includes(`/${slug}`)) return override;
  return DEFAULT_PORTAL_URLS[chainId] || DEFAULT_PORTAL_URLS[84532]!;
}

/** Portal refused for capacity or availability; the caller falls back to RPC. */
class PortalUnavailableError extends Error {}

/** `rate_limit_error` (429/529) and `availability_error` (502/503) are retryable; the rest are not. */
const PORTAL_RETRYABLE_STATUSES = new Set([429, 502, 503, 529]);
const PORTAL_DEFAULT_BACKOFF_SECONDS = 5;

/** Per-isolate circuit breaker: skip Portal until `Retry-After` has elapsed. */
let portalBackoffUntil = 0;

async function portalFetch(url: string, init?: RequestInit): Promise<Response> {
  if (Date.now() < portalBackoffUntil) {
    throw new PortalUnavailableError('Portal backoff active');
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new PortalUnavailableError(err instanceof Error ? err.message : String(err));
  }
  if (PORTAL_RETRYABLE_STATUSES.has(res.status)) {
    const retryAfter = Number(res.headers.get('Retry-After'));
    const seconds = retryAfter > 0 ? retryAfter : PORTAL_DEFAULT_BACKOFF_SECONDS;
    portalBackoffUntil = Date.now() + seconds * 1000;
    throw new PortalUnavailableError(`Portal HTTP ${res.status}`);
  }
  return res;
}

/** Run a Portal query; on capacity/availability refusal run the RPC equivalent instead. */
async function withRpcFallback<T>(portal: () => Promise<T>, rpc: () => Promise<T>): Promise<T> {
  try {
    return await portal();
  } catch (err) {
    if (!(err instanceof PortalUnavailableError)) throw err;
    console.warn(`activity: ${err.message}; falling back to RPC`);
    return rpc();
  }
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
  /** Pass as `toBlock` for the next (older) page; null when there is nothing older. */
  cursor: number | null;
  /** Newest block the answer covers; the app keeps it as its next `sinceBlock`. */
  headBlock?: number;
}

/** Options shared by the activity reads. */
export interface ActivityOptions {
  /** RPC endpoint for the chain (Sepolia: `ACTIVITY_RPC_URL`, else `BASE_SEPOLIA_RPC_URL`). */
  rpcUrl?: string;
  /** Inclusive block span per `eth_getLogs` call (default 200, the public node's cap). */
  logRange?: number;
  /** Webhook-fed store, used for `STORE_CHAINS` when `indexFromBlock` is set. */
  store?: ActivityStore;
  /** First block the store is complete from (the subscription's start). */
  indexFromBlock?: number;
}

function toActivityTx(
  t: { hash: string; logIndex: number; blockNumber: number; timestamp: number; from: string; to: string; value: bigint | string },
  addr: string,
  token: { address: string; decimals: number },
): ActivityTx {
  const value = BigInt(t.value);
  return {
    hash: t.hash,
    direction: t.from === addr ? 'out' : 'in',
    from: t.from,
    to: t.to,
    value: value.toString(),
    valueFormatted: Number(value) / 10 ** token.decimals,
    tokenAddress: token.address.toLowerCase(),
    blockNumber: t.blockNumber,
    timestamp: t.timestamp,
    logIndex: t.logIndex,
  };
}

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/** A `LogReader` over viem for the chain's USDC contract. */
function viemReader(chainId: number, rpcUrl: string | undefined): LogReader {
  const token = usdcFor(chainId);
  const client = createPublicClient({ chain: chainId === 8453 ? base : baseSepolia, transport: http(rpcUrl) });
  return {
    head: async () => Number(await client.getBlockNumber()),
    transfers: async (fromBlock, toBlock): Promise<TransferLog[]> => {
      const logs = await client.getLogs({
        address: token.address as `0x${string}`,
        event: TRANSFER_EVENT,
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
      });
      const out: TransferLog[] = [];
      for (const log of logs) {
        if (!log.args.from || !log.args.to || log.args.value == null || !log.transactionHash) continue;
        // Base logs carry `blockTimestamp` (an OP Stack extension); older nodes may not.
        const ts = (log as { blockTimestamp?: bigint | string }).blockTimestamp;
        out.push({
          hash: log.transactionHash,
          logIndex: Number(log.logIndex ?? 0),
          blockNumber: Number(log.blockNumber ?? 0),
          timestamp: ts != null ? Number(BigInt(ts)) : 0,
          from: log.args.from.toLowerCase(),
          to: log.args.to.toLowerCase(),
          value: log.args.value,
        });
      }
      return out;
    },
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
    const res = await portalFetch(`${portalBase}/timestamps/${ts}/block`);
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
  opts: ActivityOptions = {},
): Promise<ActivityCheckResult> {
  if (STORE_CHAINS.has(chainId) && opts.store && opts.indexFromBlock != null) {
    const latest = await opts.store.latestBlock(chainId, address);
    return { hasNew: latest > sinceBlock, latestBlock: Math.max(latest, sinceBlock) };
  }
  if (RPC_FALLBACK_CHAINS.has(chainId)) {
    return checkActivityViaRpc(address, sinceBlock, chainId, opts);
  }
  // The public RPC fallback uses the chain's default endpoint: the Sepolia URLs are Sepolia-only.
  return withRpcFallback(
    () => checkActivityViaPortal(portalUrl, address, sinceBlock, chainId),
    () => checkActivityViaRpc(address, sinceBlock, chainId, { logRange: opts.logRange }),
  );
}

/** RPC-based check: chunked `eth_getLogs` from `sinceBlock + 1` to head. */
async function checkActivityViaRpc(
  address: string,
  sinceBlock: number,
  chainId: number,
  opts: ActivityOptions,
): Promise<ActivityCheckResult> {
  const reader = viemReader(chainId, opts.rpcUrl);
  const latestBlock = await reader.head();
  const hasNew = await scanForwardHasTransfer(reader, address, {
    from: sinceBlock + 1,
    to: latestBlock,
    range: opts.logRange,
    maxCalls: MAX_LOG_CALLS,
  });
  return { hasNew, latestBlock };
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
    const res = await portalFetch(`${portalBase}/stream`, {
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
  opts: ActivityOptions = {},
  toBlock?: number,
): Promise<ActivityResult> {
  if (STORE_CHAINS.has(chainId) && opts.store && opts.indexFromBlock != null) {
    const storeOpts = { ...opts, store: opts.store, indexFromBlock: opts.indexFromBlock };
    return getActivityWithStore(address, limit, fromBlock, chainId, storeOpts, toBlock);
  }
  if (RPC_FALLBACK_CHAINS.has(chainId)) {
    return getActivityViaRpc(address, limit, fromBlock, chainId, opts, toBlock);
  }
  return withRpcFallback(
    () => getActivityViaPortal(portalUrl, address, limit, fromBlock, chainId, toBlock),
    () => getActivityViaRpc(address, limit, fromBlock, chainId, { logRange: opts.logRange }, toBlock),
  );
}

/**
 * Store first: the webhook-fed record covers blocks from `indexFromBlock`;
 * older blocks, and the rest of a short page, come from a chunked RPC scan.
 */
async function getActivityWithStore(
  address: string,
  limit: number,
  fromBlock: number | undefined,
  chainId: number,
  opts: ActivityOptions & { store: ActivityStore; indexFromBlock: number },
  toBlock?: number,
): Promise<ActivityResult> {
  const addr = address.toLowerCase();
  const token = usdcFor(chainId);
  const cap = Math.min(limit, MAX_RESULTS);
  const lower = Math.max(0, fromBlock ?? 0);
  const upper = toBlock != null && toBlock >= 0 ? toBlock : null;

  let stored: StoredTransfer[] = [];
  if (upper == null || upper >= opts.indexFromBlock) {
    stored = (await opts.store.list(chainId, addr, cap, upper)).filter(
      (t) => t.blockNumber >= Math.max(lower, opts.indexFromBlock),
    );
  }
  const txs = stored.map((t) => toActivityTx(t, addr, token));
  const latest = upper == null ? await opts.store.latestBlock(chainId, addr) : undefined;
  const headBlock = latest != null ? Math.max(latest, opts.indexFromBlock) : undefined;

  if (txs.length >= cap) {
    return { transactions: txs, cursor: txs[txs.length - 1]!.blockNumber, headBlock };
  }
  const rpcUpper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, opts.indexFromBlock - 1);
  if (rpcUpper < lower) {
    return { transactions: txs, cursor: null, headBlock };
  }
  const older = await getActivityViaRpc(addr, cap - txs.length, lower, chainId, opts, rpcUpper);
  return { transactions: [...txs, ...older.transactions], cursor: older.cursor, headBlock };
}

/**
 * RPC activity: walks back from `toBlock` (or head) in `logRange`-block chunks
 * within the call budget; the cursor resumes below the last chunk scanned.
 */
async function getActivityViaRpc(
  address: string,
  limit: number,
  fromBlock: number | undefined,
  chainId: number,
  opts: ActivityOptions,
  toBlockOverride?: number,
): Promise<ActivityResult> {
  const addr = address.toLowerCase();
  const token = usdcFor(chainId);
  const reader = viemReader(chainId, opts.rpcUrl);
  const head = await reader.head();
  const upper = toBlockOverride != null && toBlockOverride >= 0 ? Math.min(toBlockOverride, head) : head;

  const { matches, cursor } = await scanBackward(reader, addr, {
    upper,
    lower: fromBlock != null && fromBlock >= 0 ? fromBlock : 0,
    limit: Math.min(limit, MAX_RESULTS),
    range: opts.logRange ?? PUBLIC_LOG_RANGE,
    maxCalls: MAX_LOG_CALLS,
  });
  return {
    transactions: matches.map((t) => toActivityTx(t, addr, token)),
    cursor,
    headBlock: toBlockOverride == null ? head : undefined,
  };
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

    const res = await portalFetch(`${portalBase}/stream`, {
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
