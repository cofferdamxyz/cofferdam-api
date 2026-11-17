// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The announcement feed's indexer (workspace decision 0086, rule 5, corrected
 * 2026-11-16; question 18).
 *
 * Phones cannot scan Base themselves (a public node answers at most 201 blocks
 * per `eth_getLogs`, decision 0032), so the plane indexes every ERC-5564
 * scheme 1 announcement of the announcer singleton and serves it from a cursor
 * (`GET /v1/announcements?after=`, `routes/announcements.ts`). It keeps:
 *   - an announcement whose transaction also moved value to the announced
 *     address: a non-zero ERC-20 `Transfer` to it in the same transaction, so
 *     a flood costs a transfer each;
 *   - every announcement the plane's own announcer sent (pay-link and
 *     self-derived addresses, announced after the money arrived), named by
 *     `ANNOUNCEMENTS_PLANE_CALLERS`.
 *
 * ASSUMPTION(ruling B): the plane reads public chain data (Base Sepolia's
 * public node, or `ANNOUNCEMENTS_RPC_URL`) and filters it itself; no vendor is
 * given the address set. The node sees two kinds of query: every announcement
 * in a block range, and the ERC-20 transfers in that range to the addresses
 * those announcements name, which are public already.
 *
 * ASSUMPTION(ruling F, USDC on Base at launch): value means a non-zero
 * transfer of a listed token (`ANNOUNCEMENTS_TOKENS`, else Base Sepolia's two
 * USDC contracts), so a Transfer-shaped log from any other contract counts for
 * nothing. A native ETH value inside an ERC-4337 op is an internal call that
 * `eth_getLogs` cannot see, so such an announcement is not kept; its payer
 * announced it, and a phone's full scan against a public node still finds it
 * (q18's spot check). One transfer keeps one announcement to its address, and
 * a transaction past `MAX_KEPT_PER_TX` keeps none, so a flood costs a transfer
 * each. The Sepolia MockUSDC may mint to anyone, so there a flood costs gas
 * only: past the feed's row ceiling (`ANNOUNCEMENT_CEILING`, counted by
 * triggers) the indexer stores nothing more and names what it reads as gaps,
 * so the registry's database never fills and the feed never stops.
 *
 * The indexer first checks that its node serves the chain it indexes, then
 * reads up to `SAFE_HEAD_MARGIN` blocks behind the chain's `safe` head, in
 * chunks of `ANNOUNCEMENT_LOG_RANGE` blocks, and stores a chunk's kept
 * announcements and the next block, the cursor in the last batch, so a failed
 * call leaves the cursor where it was and the next run reads the chunk again.
 * A refused call is an error, never an empty chunk (as `activityScan.ts`), and
 * a chunk counts only from a node that holds its last block. A chunk that
 * fails is read again in halves; one block the node itself keeps refusing
 * (`GAP_AFTER_FAILURES` runs over at least `GAP_AFTER_MS`; timeouts, rate
 * limits and network errors never count) is skipped as a gap the feed names,
 * so no stranger can stall the feed for good; one run holds a lease, so runs
 * never overlap; and an announcement that is not a
 * well-formed scheme 1 one (an ephemeral key other than 33 bytes, metadata
 * empty or over `MAX_METADATA_BYTES`) is never kept, so no row outgrows D1.
 */

import {
  BaseError,
  createPublicClient,
  HttpRequestError,
  LimitExceededRpcError,
  RpcRequestError,
  SocketClosedError,
  TimeoutError,
  decodeAbiParameters,
  getAddress,
  http,
  isAddress,
  keccak256,
  pad,
  stringToBytes,
  toHex,
  type Hex,
} from 'viem';

import { BASE_SEPOLIA_CHAIN_ID } from '../../chain/deployments.js';

/** The ERC-5564 announcer singleton, at one address on every chain it is deployed to. */
export const ERC5564_ANNOUNCER = '0x55649E01B5Df198D18D95b5cc5051630cfD45564' as const;
/** `Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)`. */
export const ANNOUNCEMENT_TOPIC = keccak256(stringToBytes('Announcement(uint256,address,address,bytes,bytes)'));
/** ERC-20 `Transfer(address indexed from, address indexed to, uint256 value)`. */
export const TRANSFER_TOPIC = keccak256(stringToBytes('Transfer(address,address,uint256)'));
/** Scheme 1: secp256k1 with view tags (rule 1). */
export const SCHEME_ID = 1n;
const SCHEME_TOPIC = pad(toHex(SCHEME_ID), { size: 32 });

/** Inclusive blocks per `eth_getLogs` call: the public node refuses more than 201 (decision 0032). */
export const ANNOUNCEMENT_LOG_RANGE = 200;
/** At most this many chunks per run, so one cron invocation stays short; the next run goes on. */
export const MAX_CHUNKS_PER_RUN = 10;
/** Stealth addresses per transfer query: one `topics` OR-list, kept short for public nodes. */
export const TRANSFER_ADDRESSES_PER_QUERY = 100;
/** The most metadata a kept announcement carries: the view tag and, as ERC-5564 suggests, a selector, a token and an amount, with room. */
export const MAX_METADATA_BYTES = 512;
/** Rows per D1 batch when a chunk is committed; the cursor goes in the last one. */
export const COMMIT_ROWS_PER_BATCH = 100;
/** Retries a run may spend halving refused chunks (200 blocks halve to one in eight). */
export const MAX_SPLITS_PER_RUN = 16;
/** Runs a single block must fail on before it is skipped as a gap the feed names. */
export const GAP_AFTER_FAILURES = 3;
/** And at least this long after its first failure, so a short outage never makes a gap. */
export const GAP_AFTER_MS = 30 * 60 * 1000;
/** The most announcements one transaction may have kept by the value filter; past it, none of them (a flood's shape). */
export const MAX_KEPT_PER_TX = 4;
/** How long one indexer run holds the lease (`D1FeedStore.lease`): longer than any run, so two never overlap. */
export const FEED_LEASE_MS = 5 * 60 * 1000;
/** Blocks behind the `safe` head the indexer stops, so a load-balanced node's lagging backend still holds them. */
export const SAFE_HEAD_MARGIN = 10n;
/** The most announcements the feed holds; past it the indexer stops and logs `FeedFull`, so the feed never fills the registry's database. */
export const ANNOUNCEMENT_CEILING = 1_000_000;

/** The node the indexer was given serves another chain: nothing is read or written. */
export class FeedChainMismatch extends Error {
  override name = 'FeedChainMismatch';
}

/** A log as `eth_getLogs` answers it, the fields the indexer reads. */
export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: string;
}

export interface LogQuery {
  /** One contract, or any of a list. */
  address?: string | string[];
  /** Per position: a topic, a list of topics (any), or null (any). */
  topics: (string | string[] | null)[];
  fromBlock: bigint;
  toBlock: bigint;
}

/** What the indexer asks of a chain: its id, its `safe` head, whether it holds a block, and `eth_getLogs`. */
export interface FeedChain {
  chainId(): Promise<number>;
  safeHead(): Promise<bigint>;
  hasBlock(block: bigint): Promise<boolean>;
  logs(query: LogQuery): Promise<RawLog[]>;
}

export interface Announcement {
  chainId: number;
  blockNumber: number;
  logIndex: number;
  txHash: string;
  /** The announced address (the one-time account, rule 5), EIP-55. */
  stealthAddress: string;
  caller: string;
  ephemeralPubKey: string;
  metadata: string;
}

export interface FeedStore {
  /** The next block the indexer reads on this chain, or null before its first run. */
  cursor(chainId: number): Promise<number | null>;
  /** The kept announcements of a chunk and the next block, the cursor in the last batch; `FeedFull` past `ANNOUNCEMENT_CEILING`. */
  commit(chainId: number, announcements: Announcement[], nextBlock: number, now: number): Promise<void>;
  /** Announcements after a position and up to block `through`, in chain order, at most `limit`. */
  page(chainId: number, after: { block: number; logIndex: number } | null, limit: number, through: number): Promise<Announcement[]>;
  /** Count a failed read of one block at the cursor; answers its failures and when the first was, or null for a block behind the cursor (a stale run). */
  failed(chainId: number, block: number, now: number): Promise<{ failures: number; firstFailedAt: number } | null>;
  /** Skip blocks `from` to `to` (from the cursor) as a named gap and move the cursor past them, in one batch; nothing for a stale run. */
  skip(chainId: number, from: number, to: number, reason: 'failed' | 'full', now: number): Promise<void>;
  /** Skipped ranges ending after `afterBlock` and starting at or before `through`, in order, at most `limit`. */
  gaps(chainId: number, afterBlock: number, through: number, limit: number): Promise<{ from: number; to: number }[]>;
}

/** A scheme 1 announcement log as an `Announcement`, or null when it is not one. */
export function decodeAnnouncement(log: RawLog, chainId: number): Announcement | null {
  if (log.address.toLowerCase() !== ERC5564_ANNOUNCER.toLowerCase()) return null;
  const [topic0, scheme, stealth, caller] = log.topics;
  if (log.topics.length !== 4 || topic0?.toLowerCase() !== ANNOUNCEMENT_TOPIC || scheme?.toLowerCase() !== SCHEME_TOPIC) return null;
  try {
    const [ephemeralPubKey, metadata] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], log.data as Hex);
    // Scheme 1: a compressed secp256k1 key, and metadata that starts with the view tag and stays small.
    if (!/^0x0[23][0-9a-f]{64}$/i.test(ephemeralPubKey)) return null;
    const metadataBytes = (metadata.length - 2) / 2;
    if (metadataBytes < 1 || metadataBytes > MAX_METADATA_BYTES) return null;
    return {
      chainId,
      blockNumber: Number(log.blockNumber),
      logIndex: log.logIndex,
      txHash: log.transactionHash.toLowerCase(),
      stealthAddress: topicAddress(stealth!),
      caller: topicAddress(caller!),
      ephemeralPubKey,
      metadata,
    };
  } catch {
    return null;
  }
}

/** The address in an indexed topic's last 20 bytes, EIP-55. */
function topicAddress(topic: string): string {
  return getAddress(`0x${topic.slice(-40)}`);
}

/** A non-zero ERC-20 transfer's recipient, lower case, or null. ERC-721's `Transfer` has four topics and is left out. */
function erc20Recipient(log: RawLog): string | null {
  if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(log.data) || /^0x0+$/.test(log.data)) return null;
  return `0x${log.topics[2]!.slice(-40)}`.toLowerCase();
}

/** `ANNOUNCEMENTS_PLANE_CALLERS`: comma-separated addresses, lower case; anything else is dropped. */
export function parsePlaneCallers(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter((a) => isAddress(a))
      .map((a) => a.toLowerCase()),
  );
}

/** Tokens whose transfers count as value (ASSUMPTION(ruling F): USDC on Base at launch): `ANNOUNCEMENTS_TOKENS`, else Base Sepolia's. */
export const DEFAULT_FEED_TOKENS = [
  // The plane's MockUSDC (src/chain/deployments.ts, the activity service's token).
  '0x8c05Df95F91De2D70e0436B774fc9D1f86FF1f51',
  // Circle's USDC on Base Sepolia.
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
] as const;

/** `ANNOUNCEMENTS_TOKENS`: comma-separated token addresses, lower case; unset or empty, `DEFAULT_FEED_TOKENS`. */
export function parseFeedTokens(raw: string | undefined): Set<string> {
  const listed = parsePlaneCallers(raw);
  return listed.size ? listed : new Set(DEFAULT_FEED_TOKENS.map((t) => t.toLowerCase()));
}

/** The node answered an empty range for blocks it does not hold yet: the run stops, nothing is skipped. */
export class FeedNodeBehind extends Error {
  override name = 'FeedNodeBehind';
}

/** The feed holds `ANNOUNCEMENT_CEILING` rows: the run stops, and the cron's log line is the alert. */
export class FeedFull extends Error {
  override name = 'FeedFull';
}

/**
 * Which announcements of a block range the feed keeps (see the module
 * comment): the plane's own, and those with a non-zero transfer of a listed
 * token to the announced address in the same transaction, one announcement per
 * such transfer (the lowest log indexes first), and none of a transaction that
 * would keep more than `MAX_KEPT_PER_TX` that way, so a flood costs a transfer
 * each and one transaction cannot fill the feed. Answers the kept ones, the raw
 * announcement count, how many were kept without the value check because a
 * one-block transfer query for their address was refused, and how many a
 * transaction over the cap lost.
 */
export async function keptAnnouncements(
  chain: FeedChain,
  chainId: number,
  fromBlock: bigint,
  toBlock: bigint,
  planeCallers: ReadonlySet<string>,
  tokens: ReadonlySet<string> = parseFeedTokens(undefined),
): Promise<{ kept: Announcement[]; raw: number; unchecked: number; dropped: number }> {
  const raw = await chain.logs({ address: ERC5564_ANNOUNCER, topics: [ANNOUNCEMENT_TOPIC, SCHEME_TOPIC], fromBlock, toBlock });
  const all = raw
    .map((l) => decodeAnnouncement(l, chainId))
    .filter((a): a is Announcement => a !== null)
    .sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
  const kept = new Set(all.filter((a) => planeCallers.has(a.caller.toLowerCase())));
  const open = all.filter((a) => !kept.has(a));
  let unchecked = 0;
  let dropped = 0;
  if (open.length && tokens.size) {
    // How many distinct non-zero transfers of a listed token each transaction made to each address.
    const paid = new Map<string, number>();
    const vouched = new Set<string>();
    // One transfer query per batch of announced addresses, over the same blocks and the listed tokens only.
    const ask = async (addresses: string[]): Promise<void> => {
      try {
        const transfers = await chain.logs({ address: [...tokens], topics: [TRANSFER_TOPIC, null, addresses.map((a) => pad(a as Hex, { size: 32 }))], fromBlock, toBlock });
        for (const t of transfers) {
          const to = tokens.has(t.address.toLowerCase()) ? erc20Recipient(t) : null;
          if (!to) continue;
          const key = `${t.transactionHash.toLowerCase()}:${to}`;
          paid.set(key, (paid.get(key) ?? 0) + 1);
        }
      } catch (err) {
        // Across several blocks the indexer halves the range; within one, the address list halves, and an address the node
        // still refuses alone is kept unchecked: the value filter is a brake on floods, never a reason to stall the feed.
        if (fromBlock !== toBlock || err instanceof FeedTransient) throw err;
        if (addresses.length > 1) {
          const half = Math.ceil(addresses.length / 2);
          await ask(addresses.slice(0, half));
          await ask(addresses.slice(half));
        } else vouched.add(addresses[0]!);
      }
    };
    const addresses = [...new Set(open.map((a) => a.stealthAddress.toLowerCase()))];
    for (let i = 0; i < addresses.length; i += TRANSFER_ADDRESSES_PER_QUERY) await ask(addresses.slice(i, i + TRANSFER_ADDRESSES_PER_QUERY));
    const used = new Map<string, number>();
    const byTx = new Map<string, Announcement[]>();
    for (const a of open) {
      const key = `${a.txHash}:${a.stealthAddress.toLowerCase()}`;
      const vouch = vouched.has(a.stealthAddress.toLowerCase());
      if (!vouch && (used.get(key) ?? 0) >= (paid.get(key) ?? 0)) continue;
      used.set(key, (used.get(key) ?? 0) + 1);
      byTx.set(a.txHash, [...(byTx.get(a.txHash) ?? []), a]);
    }
    for (const list of byTx.values()) {
      if (list.length > MAX_KEPT_PER_TX) {
        dropped += list.length;
        continue;
      }
      for (const a of list) {
        kept.add(a);
        if (vouched.has(a.stealthAddress.toLowerCase())) unchecked++;
      }
    }
  }
  return { kept: all.filter((a) => kept.has(a)), raw: raw.length, unchecked, dropped };
}

export interface IndexDeps {
  chain: FeedChain;
  store: FeedStore;
  chainId: number;
  /** `ANNOUNCEMENTS_FROM_BLOCK`: where the first run starts. */
  fromBlock: number;
  planeCallers: ReadonlySet<string>;
  /** The tokens whose transfers count as value (`parseFeedTokens`). */
  tokens?: ReadonlySet<string>;
  now: () => number;
  range?: number;
  maxChunks?: number;
  maxSplits?: number;
}

export interface IndexRun {
  /** Chunks committed or skipped this run. */
  chunks: number;
  /** Announcements kept this run. */
  kept: number;
  /** Announcements kept without the value check (a refused one-block transfer query). */
  unchecked: number;
  /** Announcements left out because their transaction passed `MAX_KEPT_PER_TX`. */
  dropped: number;
  /** Blocks skipped this run as named gaps: a block the node kept refusing, or every block read while the feed was full. */
  gaps: number;
  /** Whether the feed sat at its ceiling this run (the founder's alert). */
  full: boolean;
  /** The last block indexed or skipped, or null when the run moved nothing. */
  through: number | null;
}

/**
 * One run: from the stored cursor (else `fromBlock`) towards the `safe` head
 * less `SAFE_HEAD_MARGIN`, chunk by chunk.
 *
 * - A chunk that fails is read again in halves, within `maxSplits`.
 * - A single block the node refuses with an error of its own (a JSON-RPC
 *   error, never a timeout, a rate limit, a network error or a store error:
 *   `FeedTransient`) counts a failure against itself; once it has failed on
 *   `GAP_AFTER_FAILURES` runs, the first at least `GAP_AFTER_MS` earlier, it is
 *   skipped as a gap the feed names, so phones scan it against a public node
 *   themselves, and no block can stall the feed for good.
 * - Every chunk's last block must be one the node holds before anything is
 *   committed (`FeedNodeBehind` otherwise, no gap): a lagging backend's empty
 *   or short answer is never taken for no announcements.
 * - At the feed's row ceiling (`FeedFull` from the store) the chunk is skipped
 *   as a named gap ('full') and the run goes on, so a full feed degrades to
 *   phones scanning, never to a stop; `full` in the run is the alert.
 * - A node of another chain stops the run before anything is read.
 */
export async function indexAnnouncements(deps: IndexDeps): Promise<IndexRun> {
  const range = BigInt(deps.range ?? ANNOUNCEMENT_LOG_RANGE);
  const maxChunks = deps.maxChunks ?? MAX_CHUNKS_PER_RUN;
  const tokens = deps.tokens ?? parseFeedTokens(undefined);
  let splits = deps.maxSplits ?? MAX_SPLITS_PER_RUN;
  const served = await deps.chain.chainId();
  if (served !== deps.chainId) throw new FeedChainMismatch(`the node serves chain ${served}, not ${deps.chainId}`);
  let next = BigInt((await deps.store.cursor(deps.chainId)) ?? deps.fromBlock);
  const head = (await deps.chain.safeHead()) - SAFE_HEAD_MARGIN;
  const run: IndexRun = { chunks: 0, kept: 0, unchecked: 0, dropped: 0, gaps: 0, full: false, through: null };
  let span = range;
  const advance = (to: bigint) => {
    run.chunks++;
    run.through = Number(to);
    next = to + 1n;
  };
  while (next <= head && run.chunks < maxChunks) {
    const to = next + span - 1n < head ? next + span - 1n : head;
    let read: Awaited<ReturnType<typeof keptAnnouncements>>;
    try {
      read = await keptAnnouncements(deps.chain, deps.chainId, next, to, deps.planeCallers, tokens);
      // The node must hold the chunk's last block, or its answer may be a lagging backend's (REVIEW.md: never a failed read as empty).
      if (!(await deps.chain.hasBlock(to))) throw new FeedNodeBehind(`the node has no block ${to}`);
      await deps.store.commit(deps.chainId, read.kept, Number(to + 1n), deps.now());
    } catch (err) {
      if (err instanceof FeedNodeBehind || err instanceof FeedTransient) throw err;
      if (err instanceof FeedFull) {
        await deps.store.skip(deps.chainId, Number(next), Number(to), 'full', deps.now());
        run.full = true;
        run.gaps += Number(to - next + 1n);
        advance(to);
        continue;
      }
      if (to > next && splits > 0) {
        splits--;
        span = (to - next + 2n) / 2n;
        continue;
      }
      if (to > next) throw err;
      const now = deps.now();
      const failure = await deps.store.failed(deps.chainId, Number(next), now);
      if (!failure || failure.failures < GAP_AFTER_FAILURES || now - failure.firstFailedAt < GAP_AFTER_MS) throw err;
      await deps.store.skip(deps.chainId, Number(next), Number(next), 'failed', now);
      run.gaps++;
      advance(next);
      continue;
    }
    run.kept += read.kept.length;
    run.unchecked += read.unchecked;
    run.dropped += read.dropped;
    advance(to);
    // Back towards the full range after a halved chunk read.
    span = span * 2n < range ? span * 2n : range;
  }
  return run;
}

/** The chains the feed indexes: Base Sepolia for now (runbook step 3); mainnet waits on 0086 rule 10's gates. */
export const FEED_CHAIN_ID = BASE_SEPOLIA_CHAIN_ID;

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string | null;
  logIndex: string | null;
  transactionHash: string | null;
}

/**
 * A call that failed for a reason of the transport, not of the block asked
 * for (a timeout, a rate limit, a network or HTTP error): never counted against
 * a block, never halved; the run stops and the next one tries again.
 */
export class FeedTransient extends Error {
  override name = 'FeedTransient';
}

/** A viem error that is the transport's (no JSON-RPC error from the node) as `FeedTransient`; anything else as it is. */
export function transportFailure(err: unknown): unknown {
  if (!(err instanceof BaseError)) return err;
  const transport = err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError || e instanceof SocketClosedError || e instanceof LimitExceededRpcError);
  const node = err.walk((e) => e instanceof RpcRequestError);
  // A 429 or a timeout carries no JSON-RPC answer; LimitExceeded is the node's rate limit, not the block's fault.
  return transport && (!node || transport instanceof LimitExceededRpcError) ? new FeedTransient(transport.name) : err;
}

/** The feed's chain over JSON-RPC: `eth_getLogs` as sent (a refusal throws), the `safe` block's number, and whether a block exists. */
export function rpcFeedChain(rpcUrl: string): FeedChain {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 1 }) });
  const call = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (err) {
      throw transportFailure(err);
    }
  };
  return {
    chainId: () => call(() => client.getChainId()),
    safeHead: () => call(async () => (await client.getBlock({ blockTag: 'safe' })).number),
    hasBlock: (block) =>
      call(async () => {
        const found = (await client.request({ method: 'eth_getBlockByNumber', params: [toHex(block), false] } as never)) as unknown;
        return found !== null && found !== undefined;
      }),
    logs: (q) =>
      call(async () => {
        const params = {
          ...(q.address ? { address: q.address } : {}),
          topics: q.topics,
          fromBlock: toHex(q.fromBlock),
          toBlock: toHex(q.toBlock),
        };
        const logs = (await client.request({ method: 'eth_getLogs', params: [params] } as never)) as RpcLog[];
        // A pending log has no block yet; the safe head never returns one.
        return logs
          .filter((l) => l.blockNumber && l.logIndex && l.transactionHash)
          .map((l) => ({
            address: l.address,
            topics: l.topics,
            data: l.data,
            blockNumber: BigInt(l.blockNumber!),
            logIndex: Number(BigInt(l.logIndex!)),
            transactionHash: l.transactionHash!,
          }));
      }),
  };
}

interface AnnouncementRow {
  chain_id: number;
  block_number: number;
  log_index: number;
  tx_hash: string;
  stealth_address: string;
  caller: string;
  ephemeral_pub_key: string;
  metadata: string;
}

export class D1FeedStore implements FeedStore {
  constructor(
    private readonly db: D1Database,
    private readonly ceiling = ANNOUNCEMENT_CEILING,
  ) {}

  async cursor(chainId: number): Promise<number | null> {
    const r = await this.db.prepare('SELECT next_block FROM announcement_cursor WHERE chain_id = ?').bind(chainId).first<{ next_block: number }>();
    return r ? r.next_block : null;
  }

  async commit(chainId: number, announcements: Announcement[], nextBlock: number, now: number): Promise<void> {
    // A chunk read again after a crash between runs writes the same rows: kept, not doubled.
    const rows = announcements.map((a) =>
      this.db
        .prepare(
          `INSERT INTO announcements (chain_id, block_number, log_index, tx_hash, stealth_address, caller, ephemeral_pub_key, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (chain_id, block_number, log_index) DO NOTHING`,
        )
        .bind(chainId, a.blockNumber, a.logIndex, a.txHash, a.stealthAddress, a.caller, a.ephemeralPubKey, a.metadata),
    );
    if (rows.length) {
      const held = await this.db.prepare("SELECT n FROM handles_counters WHERE name = 'announcements'").first<{ n: number }>();
      if ((held?.n ?? 0) + rows.length > this.ceiling) throw new FeedFull(`the feed holds ${held?.n ?? 0} announcements`);
    }
    const cursor = this.cursorTo(chainId, nextBlock, now);
    // A block read at last is no longer failing.
    const cleared = this.db.prepare('DELETE FROM announcement_failures WHERE chain_id = ? AND block_number < ?').bind(chainId, nextBlock);
    // A batch per hundred rows, the cursor with the last: rows a failed batch left are written again, once, next run.
    for (let i = 0; i + COMMIT_ROWS_PER_BATCH < rows.length; i += COMMIT_ROWS_PER_BATCH) await this.db.batch(rows.slice(i, i + COMMIT_ROWS_PER_BATCH));
    const tail = rows.length ? rows.slice(Math.floor((rows.length - 1) / COMMIT_ROWS_PER_BATCH) * COMMIT_ROWS_PER_BATCH) : [];
    await this.db.batch([...tail, cleared, cursor]);
  }

  private cursorTo(chainId: number, nextBlock: number, now: number): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO announcement_cursor (chain_id, next_block, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (chain_id) DO UPDATE SET next_block = excluded.next_block, updated_at = excluded.updated_at
         WHERE excluded.next_block > announcement_cursor.next_block`,
      )
      .bind(chainId, nextBlock, now);
  }

  async failed(chainId: number, block: number, now: number): Promise<{ failures: number; firstFailedAt: number } | null> {
    // Only the block at the cursor: a run that began before another moved the cursor past it counts nothing.
    const r = await this.db
      .prepare(
        `INSERT INTO announcement_failures (chain_id, block_number, failures, first_failed_at, last_failed_at)
         SELECT ?1, ?2, 1, ?3, ?3 WHERE ?2 >= COALESCE((SELECT next_block FROM announcement_cursor WHERE chain_id = ?1), 0)
         ON CONFLICT (chain_id, block_number) DO UPDATE SET failures = failures + 1, last_failed_at = excluded.last_failed_at
         RETURNING failures, first_failed_at`,
      )
      .bind(chainId, block, now)
      .first<{ failures: number; first_failed_at: number }>();
    return r ? { failures: r.failures, firstFailedAt: r.first_failed_at } : null;
  }

  async skip(chainId: number, from: number, to: number, reason: 'failed' | 'full', now: number): Promise<void> {
    const atCursor = 'COALESCE((SELECT next_block FROM announcement_cursor WHERE chain_id = ?1), 0)';
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO announcement_skips (chain_id, from_block, to_block, reason, skipped_at)
           SELECT ?1, ?2, ?3, ?4, ?5 WHERE ?2 >= ${atCursor}
           ON CONFLICT (chain_id, from_block) DO NOTHING`,
        )
        .bind(chainId, from, to, reason, now),
      this.db.prepare('DELETE FROM announcement_failures WHERE chain_id = ? AND block_number <= ?').bind(chainId, to),
      this.cursorTo(chainId, to + 1, now),
    ]);
  }

  async gaps(chainId: number, afterBlock: number, through: number, limit: number): Promise<{ from: number; to: number }[]> {
    const { results } = await this.db
      .prepare(
        `SELECT from_block, to_block FROM announcement_skips
         WHERE chain_id = ? AND to_block > ? AND from_block <= ?
         ORDER BY from_block LIMIT ?`,
      )
      .bind(chainId, afterBlock, through, limit)
      .all<{ from_block: number; to_block: number }>();
    return results.map((r) => ({ from: r.from_block, to: r.to_block }));
  }

  /** Take the chain's indexer lease until `now + ms`, unless another run holds it; true when taken. */
  async lease(chainId: number, holder: string, now: number, ms = FEED_LEASE_MS): Promise<boolean> {
    const { meta } = await this.db
      .prepare(
        `INSERT INTO announcement_lease (chain_id, holder, until) VALUES (?1, ?2, ?3)
         ON CONFLICT (chain_id) DO UPDATE SET holder = excluded.holder, until = excluded.until
         WHERE announcement_lease.until <= ?4`,
      )
      .bind(chainId, holder, now + ms, now)
      .run();
    return meta.changes > 0;
  }

  /** Give the lease back, if this holder still has it. */
  async release(chainId: number, holder: string): Promise<void> {
    await this.db.prepare('DELETE FROM announcement_lease WHERE chain_id = ? AND holder = ?').bind(chainId, holder).run();
  }

  async page(chainId: number, after: { block: number; logIndex: number } | null, limit: number, through: number): Promise<Announcement[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM announcements
         WHERE chain_id = ?1 AND (block_number > ?2 OR (block_number = ?2 AND log_index > ?3)) AND block_number <= ?5
         ORDER BY block_number, log_index LIMIT ?4`,
      )
      .bind(chainId, after?.block ?? -1, after?.logIndex ?? -1, limit, through)
      .all<AnnouncementRow>();
    return results.map((r) => ({
      chainId: r.chain_id,
      blockNumber: r.block_number,
      logIndex: r.log_index,
      txHash: r.tx_hash,
      stealthAddress: r.stealth_address,
      caller: r.caller,
      ephemeralPubKey: r.ephemeral_pub_key,
      metadata: r.metadata,
    }));
  }
}
