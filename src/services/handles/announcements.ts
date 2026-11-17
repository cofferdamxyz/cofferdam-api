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
 * ASSUMPTION(ruling F, USDC on Base at launch): value means an ERC-20
 * transfer. A native ETH value inside an ERC-4337 op is an internal call that
 * `eth_getLogs` cannot see, so such an announcement is not kept; its payer
 * announced it, and a phone's full scan against a public node still finds it
 * (q18's spot check). Any ERC-20 counts, not USDC alone, so a junk token's
 * transfer passes: the flood residual q18 states.
 *
 * The indexer reads up to the chain's `safe` head, in chunks of
 * `ANNOUNCEMENT_LOG_RANGE` blocks, and stores a chunk's kept announcements and
 * the next block in one batch, so a failed call leaves the cursor where it was
 * and the next run reads the chunk again. A refused call is an error, never an
 * empty chunk (as `activityScan.ts`).
 */

import {
  createPublicClient,
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
  address?: string;
  /** Per position: a topic, a list of topics (any), or null (any). */
  topics: (string | string[] | null)[];
  fromBlock: bigint;
  toBlock: bigint;
}

/** What the indexer asks of a chain: its `safe` head and `eth_getLogs`. */
export interface FeedChain {
  safeHead(): Promise<bigint>;
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
  /** The kept announcements of a chunk and the next block, in one batch. */
  commit(chainId: number, announcements: Announcement[], nextBlock: number, now: number): Promise<void>;
  /** Announcements after a position and up to block `through`, in chain order, at most `limit`. */
  page(chainId: number, after: { block: number; logIndex: number } | null, limit: number, through: number): Promise<Announcement[]>;
}

/** A scheme 1 announcement log as an `Announcement`, or null when it is not one. */
export function decodeAnnouncement(log: RawLog, chainId: number): Announcement | null {
  if (log.address.toLowerCase() !== ERC5564_ANNOUNCER.toLowerCase()) return null;
  const [topic0, scheme, stealth, caller] = log.topics;
  if (log.topics.length !== 4 || topic0?.toLowerCase() !== ANNOUNCEMENT_TOPIC || scheme?.toLowerCase() !== SCHEME_TOPIC) return null;
  try {
    const [ephemeralPubKey, metadata] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], log.data as Hex);
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

/**
 * Which announcements of a block range the feed keeps (see the module
 * comment): the plane's own, and those with a non-zero ERC-20 transfer to the
 * announced address in the same transaction.
 */
export async function keptAnnouncements(
  chain: FeedChain,
  chainId: number,
  fromBlock: bigint,
  toBlock: bigint,
  planeCallers: ReadonlySet<string>,
): Promise<Announcement[]> {
  const raw = await chain.logs({ address: ERC5564_ANNOUNCER, topics: [ANNOUNCEMENT_TOPIC, SCHEME_TOPIC], fromBlock, toBlock });
  const all = raw.map((l) => decodeAnnouncement(l, chainId)).filter((a): a is Announcement => a !== null);
  const kept = new Set(all.filter((a) => planeCallers.has(a.caller.toLowerCase())));
  const open = all.filter((a) => !kept.has(a));
  if (open.length) {
    // One transfer query per batch of announced addresses, over the same blocks; a payment moves value in its own transaction.
    const addresses = [...new Set(open.map((a) => a.stealthAddress.toLowerCase()))];
    const paid = new Set<string>();
    for (let i = 0; i < addresses.length; i += TRANSFER_ADDRESSES_PER_QUERY) {
      const batch = addresses.slice(i, i + TRANSFER_ADDRESSES_PER_QUERY).map((a) => pad(a as Hex, { size: 32 }));
      const transfers = await chain.logs({ topics: [TRANSFER_TOPIC, null, batch], fromBlock, toBlock });
      for (const t of transfers) {
        const to = erc20Recipient(t);
        if (to) paid.add(`${t.transactionHash.toLowerCase()}:${to}`);
      }
    }
    for (const a of open) if (paid.has(`${a.txHash}:${a.stealthAddress.toLowerCase()}`)) kept.add(a);
  }
  return all.filter((a) => kept.has(a));
}

export interface IndexDeps {
  chain: FeedChain;
  store: FeedStore;
  chainId: number;
  /** `ANNOUNCEMENTS_FROM_BLOCK`: where the first run starts. */
  fromBlock: number;
  planeCallers: ReadonlySet<string>;
  now: () => number;
  range?: number;
  maxChunks?: number;
}

export interface IndexRun {
  /** Chunks committed this run. */
  chunks: number;
  /** Announcements kept this run. */
  kept: number;
  /** The last block indexed, or null when the run committed nothing. */
  through: number | null;
}

/** One run: from the stored cursor (else `fromBlock`) towards the `safe` head, chunk by chunk. A failed call throws; the chunks before it stay committed. */
export async function indexAnnouncements(deps: IndexDeps): Promise<IndexRun> {
  const range = deps.range ?? ANNOUNCEMENT_LOG_RANGE;
  const maxChunks = deps.maxChunks ?? MAX_CHUNKS_PER_RUN;
  let next = BigInt((await deps.store.cursor(deps.chainId)) ?? deps.fromBlock);
  const head = await deps.chain.safeHead();
  const run: IndexRun = { chunks: 0, kept: 0, through: null };
  while (next <= head && run.chunks < maxChunks) {
    const to = next + BigInt(range - 1) < head ? next + BigInt(range - 1) : head;
    const kept = await keptAnnouncements(deps.chain, deps.chainId, next, to, deps.planeCallers);
    await deps.store.commit(deps.chainId, kept, Number(to + 1n), deps.now());
    run.chunks++;
    run.kept += kept.length;
    run.through = Number(to);
    next = to + 1n;
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

/** The feed's chain over JSON-RPC: `eth_getLogs` as sent (a refusal throws), and the `safe` block's number. */
export function rpcFeedChain(rpcUrl: string): FeedChain {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 1 }) });
  return {
    async safeHead() {
      const block = await client.getBlock({ blockTag: 'safe' });
      return block.number;
    },
    async logs(q) {
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
    },
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
  constructor(private readonly db: D1Database) {}

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
    const cursor = this.db
      .prepare(
        `INSERT INTO announcement_cursor (chain_id, next_block, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (chain_id) DO UPDATE SET next_block = excluded.next_block, updated_at = excluded.updated_at
         WHERE excluded.next_block > announcement_cursor.next_block`,
      )
      .bind(chainId, nextBlock, now);
    await this.db.batch([...rows, cursor]);
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
