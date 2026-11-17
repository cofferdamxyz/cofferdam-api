// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The announcement feed (decision 0086, rule 5, corrected 2026-11-16; q18):
 * the indexer against a fake chain answering `eth_getLogs` by its filters, the
 * D1 store on the real migration, the cron, and `GET /v1/announcements`.
 */

import { encodeAbiParameters, getAddress, HttpRequestError, pad, RpcRequestError, TimeoutError, toHex, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAnnouncementsRoutes, END_OF_BLOCK, FEED_PAGE, readCursor } from '../src/routes/announcements.js';
import {
  ANNOUNCEMENT_TOPIC,
  D1FeedStore,
  DEFAULT_FEED_TOKENS,
  FeedFull,
  FeedNodeBehind,
  FEED_LEASE_MS,
  FeedTransient,
  GAP_AFTER_FAILURES,
  GAP_AFTER_MS,
  MAX_KEPT_PER_TX,
  transportFailure,
  decodeAnnouncement,
  ERC5564_ANNOUNCER,
  FEED_CHAIN_ID,
  FeedChainMismatch,
  indexAnnouncements,
  keptAnnouncements,
  parsePlaneCallers,
  TRANSFER_TOPIC,
  type FeedChain,
  type LogQuery,
  type RawLog,
} from '../src/services/handles/announcements.js';
import { feedStartBlock, runHandlesCron } from '../src/services/handles/cron.js';
import { handlesD1 } from './fixtures/handles/d1.js';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PLANE = '0x' + '70'.repeat(20);
const STRANGER = '0x' + '5a'.repeat(20);
const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
const tx = (n: number) => pad(toHex(n), { size: 32 });
const topicOf = (a: string) => pad(a.toLowerCase() as Hex, { size: 32 });

function announcement(block: number, logIndex: number, txn: number, stealth: string, caller = STRANGER, scheme = 1n): RawLog {
  return {
    address: ERC5564_ANNOUNCER,
    topics: [ANNOUNCEMENT_TOPIC, pad(toHex(scheme), { size: 32 }), topicOf(stealth), topicOf(caller)],
    data: encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [`0x02${'ee'.repeat(32)}`, '0x7f']),
    blockNumber: BigInt(block),
    logIndex,
    transactionHash: tx(txn),
  };
}

function transfer(block: number, logIndex: number, txn: number, to: string, amount = 1_000_000n): RawLog {
  return {
    address: USDC,
    topics: [TRANSFER_TOPIC, topicOf(STRANGER), topicOf(to)],
    data: pad(toHex(amount), { size: 32 }),
    blockNumber: BigInt(block),
    logIndex,
    transactionHash: tx(txn),
  };
}

/** `eth_getLogs` over a list: the address, each topic position (one, any of a list, or any) and the inclusive block range. */
function fakeChain(logs: RawLog[], head: number) {
  const queries: LogQuery[] = [];
  const chain: FeedChain & { queries: LogQuery[]; head: number; fail?: (q: LogQuery) => boolean; holds?: (b: bigint) => boolean } = {
    queries,
    head,
    async hasBlock(b) {
      return chain.holds ? chain.holds(b) : b <= BigInt(chain.head);
    },
    async chainId() {
      return FEED_CHAIN_ID;
    },
    async safeHead() {
      return BigInt(chain.head);
    },
    async logs(q) {
      queries.push(q);
      if (q.toBlock - q.fromBlock + 1n > 200n) throw new Error('eth_getLogs is limited to a 200 range');
      if (chain.fail?.(q)) throw new Error('refused');
      return logs.filter(
        (l) =>
          l.blockNumber >= q.fromBlock &&
          l.blockNumber <= q.toBlock &&
          (!q.address || (Array.isArray(q.address) ? q.address : [q.address]).some((a) => a.toLowerCase() === l.address.toLowerCase())) &&
          q.topics.every((t, i) => t === null || (Array.isArray(t) ? t.map((x) => x.toLowerCase()) : [t.toLowerCase()]).includes((l.topics[i] ?? '').toLowerCase())),
      );
    },
  };
  return chain;
}

describe('decodeAnnouncement', () => {
  it('reads a scheme 1 announcement of the singleton: the announced account, caller, ephemeral key and metadata', () => {
    const stealth = addr(0xa1);
    expect(decodeAnnouncement(announcement(10, 3, 1, stealth), FEED_CHAIN_ID)).toEqual({
      chainId: FEED_CHAIN_ID,
      blockNumber: 10,
      logIndex: 3,
      txHash: tx(1),
      stealthAddress: stealth,
      caller: getAddress(STRANGER),
      ephemeralPubKey: `0x02${'ee'.repeat(32)}`,
      metadata: '0x7f',
    });
  });

  it('keeps only well-formed scheme 1 fields: a 33-byte compressed key and 1 to 512 bytes of metadata', () => {
    const withData = (key: Hex, metadata: Hex) => ({ ...announcement(10, 0, 1, addr(1)), data: encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [key, metadata]) });
    const key = `0x03${'ab'.repeat(32)}` as Hex;
    expect(decodeAnnouncement(withData(key, `0x${'01'.repeat(512)}`), FEED_CHAIN_ID)).not.toBeNull();
    expect(decodeAnnouncement(withData(key, `0x${'01'.repeat(513)}`), FEED_CHAIN_ID)).toBeNull();
    expect(decodeAnnouncement(withData(key, '0x'), FEED_CHAIN_ID)).toBeNull();
    expect(decodeAnnouncement(withData(`0x04${'ab'.repeat(32)}`, '0x01'), FEED_CHAIN_ID)).toBeNull();
    expect(decodeAnnouncement(withData(`0x04${'ab'.repeat(64)}`, '0x01'), FEED_CHAIN_ID)).toBeNull();
    // About a megabyte of key or metadata, which would outgrow a D1 row, is never kept.
    expect(decodeAnnouncement(withData(key, `0x${'00'.repeat(1_000_000)}`), FEED_CHAIN_ID)).toBeNull();
  });

  it('refuses another scheme, another contract, another event and data that does not decode', () => {
    const ok = announcement(10, 0, 1, addr(1));
    expect(decodeAnnouncement(announcement(10, 0, 1, addr(1), STRANGER, 2n), FEED_CHAIN_ID)).toBeNull();
    expect(decodeAnnouncement({ ...ok, address: USDC }, FEED_CHAIN_ID)).toBeNull();
    expect(decodeAnnouncement({ ...ok, topics: [TRANSFER_TOPIC, ...ok.topics.slice(1)] }, FEED_CHAIN_ID)).toBeNull();
    expect(decodeAnnouncement({ ...ok, topics: ok.topics.slice(0, 3) }, FEED_CHAIN_ID)).toBeNull();
    expect(decodeAnnouncement({ ...ok, data: '0x1234' }, FEED_CHAIN_ID)).toBeNull();
  });
});

describe('keptAnnouncements (rule 5, q18)', () => {
  it('keeps an announcement whose transaction moved value to the announced address, and the plane’s own', async () => {
    const [paid, free, elsewhere, zero, own, nft] = [1, 2, 3, 4, 5, 6].map((n) => addr(0xb0 + n));
    const logs = [
      announcement(100, 0, 1, paid!),
      transfer(100, 1, 1, paid!),
      announcement(100, 2, 2, free!),
      // A transfer to the address in another transaction does not count.
      announcement(101, 0, 3, elsewhere!),
      transfer(101, 1, 4, elsewhere!),
      announcement(101, 2, 5, zero!),
      transfer(101, 3, 5, zero!, 0n),
      announcement(102, 0, 6, own!, PLANE),
      // An ERC-721 Transfer (four topics) is not an ERC-20 payment.
      announcement(102, 1, 7, nft!),
      { ...transfer(102, 2, 7, nft!), topics: [...transfer(102, 2, 7, nft!).topics, pad('0x01', { size: 32 })] },
    ];
    const chain = fakeChain(logs, 200);
    const { kept } = await keptAnnouncements(chain, FEED_CHAIN_ID, 100n, 102n, parsePlaneCallers(` ${PLANE},not-an-address`));
    expect(kept.map((a) => a.stealthAddress)).toEqual([paid, own]);
    // The transfer query names the announced addresses the plane does not vouch for, over the same blocks; never the plane's own.
    const transferQuery = chain.queries.find((q) => q.topics[0] === TRANSFER_TOPIC)!;
    expect(transferQuery.fromBlock).toBe(100n);
    expect(transferQuery.toBlock).toBe(102n);
    expect(transferQuery.address).toEqual(DEFAULT_FEED_TOKENS.map((t) => t.toLowerCase()));
    expect((transferQuery.topics[2] as string[]).length).toBe(5);
    expect(transferQuery.topics[2]).not.toContain(topicOf(own!));
  });

  it('counts only transfers of a listed token: a Transfer-shaped log from another contract is nothing', async () => {
    const stealth = addr(0xf1);
    const junk = { ...transfer(100, 1, 1, stealth), address: '0x' + '99'.repeat(20) };
    const chain = fakeChain([announcement(100, 0, 1, stealth), junk], 200);
    expect((await keptAnnouncements(chain, FEED_CHAIN_ID, 100n, 100n, new Set())).kept).toEqual([]);
    // No token listed: nothing but the plane's own is kept, and no transfer is asked for.
    const none = fakeChain([announcement(100, 0, 1, stealth), transfer(100, 1, 1, stealth)], 200);
    expect((await keptAnnouncements(none, FEED_CHAIN_ID, 100n, 100n, new Set(), new Set())).kept).toEqual([]);
    expect(none.queries).toHaveLength(1);
  });

  it('within one block, halves a refused transfer query down to one address, and keeps unchecked an address still refused alone', async () => {
    const [a, b, c] = [addr(0xa01), addr(0xa02), addr(0xa03)];
    const chain = fakeChain([announcement(7, 0, 1, a), transfer(7, 1, 1, a), announcement(7, 2, 2, b), announcement(7, 3, 3, c), transfer(7, 4, 3, c)], 200);
    // The node refuses any transfer query that names b (its result too large).
    chain.fail = (q) => q.topics[0] === TRANSFER_TOPIC && (q.topics[2] as string[]).includes(topicOf(b));
    const out = await keptAnnouncements(chain, FEED_CHAIN_ID, 7n, 7n, new Set());
    expect(out.kept.map((x) => x.stealthAddress)).toEqual([a, b, c]);
    expect(out.unchecked).toBe(1);
    // Across several blocks the refusal goes up, for the indexer to halve the range.
    await expect(keptAnnouncements(chain, FEED_CHAIN_ID, 6n, 7n, new Set())).rejects.toThrow('refused');
  });

  it('asks for transfers only when an announcement needs a check, in batches of 100 addresses', async () => {
    const own = fakeChain([announcement(5, 0, 1, addr(1), PLANE)], 10);
    await keptAnnouncements(own, FEED_CHAIN_ID, 0n, 10n, parsePlaneCallers(PLANE));
    expect(own.queries).toHaveLength(1);
    const many = fakeChain(Array.from({ length: 250 }, (_, i) => announcement(5, i, i + 1, addr(0x1000 + i))), 10);
    await keptAnnouncements(many, FEED_CHAIN_ID, 0n, 10n, new Set());
    expect(many.queries.map((q) => (q.topics[2] as string[] | undefined)?.length ?? 0)).toEqual([0, 100, 100, 50]);
  });
});

describe('indexAnnouncements', () => {
  it('reads from the start block to the safe head in chunks of 200, committing each with the next block', async () => {
    const db = handlesD1();
    const store = new D1FeedStore(db.d1);
    const stealth = addr(0xc1);
    // The safe head is 1,460; the indexer stops SAFE_HEAD_MARGIN (10) blocks behind it.
    const chain = fakeChain([announcement(1_150, 0, 1, stealth), transfer(1_150, 1, 1, stealth), announcement(1_390, 0, 2, addr(0xc2))], 1_460);
    const run = await indexAnnouncements({ chain, store, chainId: FEED_CHAIN_ID, fromBlock: 1_000, planeCallers: new Set(), now: () => 7 });
    expect(run).toEqual({ chunks: 3, kept: 1, unchecked: 0, dropped: 0, gaps: 0, full: false, through: 1_450 });
    const ranges = chain.queries.filter((q) => q.topics[0] === ANNOUNCEMENT_TOPIC).map((q) => [Number(q.fromBlock), Number(q.toBlock)]);
    expect(ranges).toEqual([
      [1_000, 1_199],
      [1_200, 1_399],
      [1_400, 1_450],
    ]);
    expect(await store.cursor(FEED_CHAIN_ID)).toBe(1_451);
    expect((await store.page(FEED_CHAIN_ID, null, 10, 1_450)).map((a) => a.stealthAddress)).toEqual([stealth]);
    // The next run starts from the stored cursor, and does nothing until the safe head moves.
    chain.queries.length = 0;
    expect(await indexAnnouncements({ chain, store, chainId: FEED_CHAIN_ID, fromBlock: 0, planeCallers: new Set(), now: () => 8 })).toEqual({ chunks: 0, kept: 0, unchecked: 0, dropped: 0, gaps: 0, full: false, through: null });
    expect(chain.queries).toEqual([]);
  });

  it('stops at its chunk limit, and after a refused call keeps what it committed and reads the failed chunk again', async () => {
    const db = handlesD1();
    const store = new D1FeedStore(db.d1);
    const chain = fakeChain([], 10_000);
    expect((await indexAnnouncements({ chain, store, chainId: FEED_CHAIN_ID, fromBlock: 0, planeCallers: new Set(), now: () => 1, maxChunks: 2 })).through).toBe(399);
    chain.fail = (q) => q.fromBlock === 600n;
    await expect(indexAnnouncements({ chain, store, chainId: FEED_CHAIN_ID, fromBlock: 0, planeCallers: new Set(), now: () => 2 })).rejects.toThrow('refused');
    expect(await store.cursor(FEED_CHAIN_ID)).toBe(600);
    chain.fail = undefined;
    chain.queries.length = 0;
    await indexAnnouncements({ chain, store, chainId: FEED_CHAIN_ID, fromBlock: 0, planeCallers: new Set(), now: () => 3, maxChunks: 1 });
    expect(Number(chain.queries[0]!.fromBlock)).toBe(600);
  });

  it('reads a refused chunk again in halves, down to one block, and throws only when one block is refused', async () => {
    const db = handlesD1();
    const store = new D1FeedStore(db.d1);
    const stealth = addr(0xe1);
    const chain = fakeChain([announcement(150, 0, 1, stealth), transfer(150, 1, 1, stealth)], 409);
    // The node refuses any range over 50 blocks that holds block 120 (a flood's result too large).
    chain.fail = (q) => q.fromBlock <= 120n && q.toBlock >= 120n && q.toBlock - q.fromBlock >= 50n;
    const run = await indexAnnouncements({ chain, store, chainId: FEED_CHAIN_ID, fromBlock: 0, planeCallers: new Set(), now: () => 1 });
    expect(run.through).toBe(399);
    expect(run.kept).toBe(1);
    expect(await store.cursor(FEED_CHAIN_ID)).toBe(400);
    const read = chain.queries.filter((q) => q.topics[0] === ANNOUNCEMENT_TOPIC && !chain.fail!(q)).map((q) => [Number(q.fromBlock), Number(q.toBlock)]);
    // Every block read once, in order, after the halvings.
    let next = 0;
    for (const [from, to] of read) {
      expect(from).toBe(next);
      next = to! + 1;
    }
    expect(next).toBe(400);
    // One block the node refuses stops the run there, with what came before committed.
    const stuck = fakeChain([], 409);
    stuck.fail = (q) => q.fromBlock <= 120n && q.toBlock >= 120n;
    const db2 = handlesD1();
    const store2 = new D1FeedStore(db2.d1);
    await expect(indexAnnouncements({ chain: stuck, store: store2, chainId: FEED_CHAIN_ID, fromBlock: 0, planeCallers: new Set(), now: () => 1 })).rejects.toThrow('refused');
    expect(await store2.cursor(FEED_CHAIN_ID)).toBe(120);
  });

  it('skips one block as a named gap once the node refused it on three runs over 30 minutes', async () => {
    const db = handlesD1();
    const store = new D1FeedStore(db.d1);
    const stealth = addr(0xe9);
    const chain = fakeChain([announcement(150, 0, 1, stealth), transfer(150, 1, 1, stealth)], 409);
    chain.fail = (q) => q.fromBlock <= 120n && q.toBlock >= 120n;
    let clock = 0;
    const deps = { chain, store, chainId: FEED_CHAIN_ID, fromBlock: 0, planeCallers: new Set<string>(), now: () => clock };
    // Three runs within a few minutes are not enough: a short outage never makes a gap.
    for (let i = 0; i < GAP_AFTER_FAILURES + 1; i++) {
      clock += 60_000;
      await expect(indexAnnouncements(deps)).rejects.toThrow('refused');
    }
    expect(await store.cursor(FEED_CHAIN_ID)).toBe(120);
    clock += GAP_AFTER_MS;
    const run = await indexAnnouncements(deps);
    expect(run).toMatchObject({ gaps: 1, kept: 1, through: 399 });
    expect(await store.gaps(FEED_CHAIN_ID, -1, 399, 10)).toEqual([{ from: 120, to: 120 }]);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM announcement_failures').get()).toEqual({ n: 0 });
    // The feed names the gap to every phone, which scans that block against a public node itself.
    const body = (await (await createAnnouncementsRoutes({ store: () => store }).request('/', {}, {} as never)).json()) as any;
    expect(body.gaps).toEqual([{ from: 120, to: 120 }]);
    expect(body.items.map((x: { stealthAddress: string }) => x.stealthAddress)).toEqual([stealth]);
    expect((await (await createAnnouncementsRoutes({ store: () => store }).request('/?after=120:1000000', {}, {} as never)).json()) as any).toMatchObject({ gaps: [] });
  });

  it('never counts a transport failure against a block: the run stops, nothing is halved or counted', async () => {
    const db = handlesD1();
    const store = new D1FeedStore(db.d1);
    const chain = fakeChain([], 409);
    chain.fail = () => true;
    const logs = chain.logs.bind(chain);
    chain.logs = async (q) => {
      try {
        return await logs(q);
      } catch {
        throw new FeedTransient('HttpRequestError');
      }
    };
    let clock = 0;
    const deps = { chain, store, chainId: FEED_CHAIN_ID, fromBlock: 0, planeCallers: new Set<string>(), now: () => (clock += GAP_AFTER_MS) };
    for (let i = 0; i < 5; i++) await expect(indexAnnouncements(deps)).rejects.toThrow(FeedTransient);
    expect(chain.queries).toHaveLength(5);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM announcement_failures').get()).toEqual({ n: 0 });
    expect(await store.gaps(FEED_CHAIN_ID, -1, 1_000, 10)).toEqual([]);
  });

  it('reads viem’s transport errors as transient, and a node’s own JSON-RPC error as the block’s', () => {
    const http429 = new HttpRequestError({ url: 'https://node.example', status: 429 });
    expect(transportFailure(http429)).toBeInstanceOf(FeedTransient);
    expect(transportFailure(new TimeoutError({ body: {}, url: 'https://node.example' }))).toBeInstanceOf(FeedTransient);
    const tooMany = new RpcRequestError({ body: {}, url: 'https://node.example', error: { code: -32602, message: 'query returned more than 10000 results' } });
    expect(transportFailure(tooMany)).toBe(tooMany);
    const plain = new Error('x');
    expect(transportFailure(plain)).toBe(plain);
  });

  it('forgets a block’s failures once it is read, and a run behind the cursor counts or skips nothing', async () => {
    const db = handlesD1();
    const store = new D1FeedStore(db.d1);
    const chain = fakeChain([], 409);
    let failing = true;
    chain.fail = (q) => failing && q.fromBlock <= 120n && q.toBlock >= 120n;
    const deps = { chain, store, chainId: FEED_CHAIN_ID, fromBlock: 0, planeCallers: new Set<string>(), now: () => 5 };
    await expect(indexAnnouncements(deps)).rejects.toThrow('refused');
    failing = false;
    await indexAnnouncements(deps);
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM announcement_failures').get()).toEqual({ n: 0 });
    // A stale run (the cursor moved past 120 meanwhile) counts no failure there and names no gap.
    expect(await store.failed(FEED_CHAIN_ID, 120, 6)).toBeNull();
    await store.skip(FEED_CHAIN_ID, 120, 120, 'failed', 6);
    expect(await store.gaps(FEED_CHAIN_ID, -1, 1_000, 10)).toEqual([]);
    expect(await store.cursor(FEED_CHAIN_ID)).toBe(400);
  });

  it('keeps one announcement per transfer, and none of a transaction past the per-transaction cap', async () => {
    const x = addr(0xb01);
    const many = Array.from({ length: MAX_KEPT_PER_TX + 1 }, (_, i) => addr(0xc00 + i));
    const logs = [
      // One transfer to x, three announcements naming x in the same transaction: one is kept, the first.
      announcement(10, 0, 1, x),
      announcement(10, 1, 1, x),
      announcement(10, 2, 1, x),
      transfer(10, 3, 1, x),
      // A transaction paying five addresses and announcing each: over the cap, none kept.
      ...many.flatMap((m, i) => [announcement(11, 2 * i, 2, m), transfer(11, 2 * i + 1, 2, m)]),
    ];
    const out = await keptAnnouncements(fakeChain(logs, 100), FEED_CHAIN_ID, 10n, 11n, new Set());
    expect(out.kept.map((a) => [a.stealthAddress, a.logIndex])).toEqual([[x, 0]]);
    expect(out.dropped).toBe(MAX_KEPT_PER_TX + 1);
  });

  it('at the feed’s ceiling, skips what it reads as named gaps and goes on, never stops', async () => {
    const db = handlesD1();
    const store = new D1FeedStore(db.d1, 1);
    const [a, b] = [addr(0xd01), addr(0xd02)];
    const chain = fakeChain([announcement(50, 0, 1, a, PLANE), announcement(250, 0, 2, b, PLANE)], 609);
    const run = await indexAnnouncements({ chain, store, chainId: FEED_CHAIN_ID, fromBlock: 0, planeCallers: parsePlaneCallers(PLANE), now: () => 1 });
    expect(run).toMatchObject({ full: true, kept: 1, gaps: 200, through: 599 });
    expect(await store.cursor(FEED_CHAIN_ID)).toBe(600);
    expect(await store.gaps(FEED_CHAIN_ID, -1, 599, 10)).toEqual([{ from: 200, to: 399 }]);
    expect((await store.page(FEED_CHAIN_ID, null, 10, 599)).map((x) => x.stealthAddress)).toEqual([a]);
  });

  it('holds one run at a time with a lease that expires', async () => {
    const db = handlesD1();
    const store = new D1FeedStore(db.d1);
    expect(await store.lease(FEED_CHAIN_ID, 'one', 1_000)).toBe(true);
    expect(await store.lease(FEED_CHAIN_ID, 'two', 2_000)).toBe(false);
    await store.release(FEED_CHAIN_ID, 'two');
    expect(await store.lease(FEED_CHAIN_ID, 'two', 2_000)).toBe(false);
    expect(await store.lease(FEED_CHAIN_ID, 'two', 1_000 + FEED_LEASE_MS)).toBe(true);
    await store.release(FEED_CHAIN_ID, 'two');
    expect(await store.lease(FEED_CHAIN_ID, 'three', 1_000 + FEED_LEASE_MS)).toBe(true);
  });

  it('never takes an empty answer for blocks the node does not hold: the run stops, with no gap', async () => {
    const db = handlesD1();
    const store = new D1FeedStore(db.d1);
    const chain = fakeChain([], 409);
    chain.holds = (b) => b < 300n;
    const deps = { chain, store, chainId: FEED_CHAIN_ID, fromBlock: 0, planeCallers: new Set<string>(), now: () => 5 };
    for (let i = 0; i < GAP_AFTER_FAILURES + 1; i++) await expect(indexAnnouncements(deps)).rejects.toThrow(FeedNodeBehind);
    expect(await store.cursor(FEED_CHAIN_ID)).toBe(200);
    expect(await store.gaps(FEED_CHAIN_ID, -1, 1_000, 10)).toEqual([]);
  });

  it('stops at the feed’s row ceiling rather than fill the registry’s database', async () => {
    const db = handlesD1();
    const store = new D1FeedStore(db.d1, 2);
    const items = [1, 2, 3].map((i) => decodeAnnouncement(announcement(5, i, i, addr(0x3000 + i), PLANE), FEED_CHAIN_ID)!);
    await store.commit(FEED_CHAIN_ID, items.slice(0, 2), 6, 1);
    await expect(store.commit(FEED_CHAIN_ID, items.slice(2), 7, 2)).rejects.toThrow(FeedFull);
    expect(await store.cursor(FEED_CHAIN_ID)).toBe(6);
    // An empty chunk still moves the cursor.
    await store.commit(FEED_CHAIN_ID, [], 8, 3);
    expect(await store.cursor(FEED_CHAIN_ID)).toBe(8);
    expect(db.sqlite.prepare("SELECT n FROM handles_counters WHERE name = 'announcements'").get()).toEqual({ n: 2 });
  });

  it('refuses a node that serves another chain, before reading or writing anything', async () => {
    const db = handlesD1();
    const store = new D1FeedStore(db.d1);
    const chain = fakeChain([], 1_000);
    chain.chainId = async () => 8453;
    await expect(indexAnnouncements({ chain, store, chainId: FEED_CHAIN_ID, fromBlock: 0, planeCallers: new Set(), now: () => 1 })).rejects.toThrow(FeedChainMismatch);
    expect(chain.queries).toEqual([]);
    expect(await store.cursor(FEED_CHAIN_ID)).toBeNull();
  });

  it('commits a large chunk in batches of 100 rows, the cursor with the last', async () => {
    const db = handlesD1();
    const store = new D1FeedStore(db.d1);
    const items = Array.from({ length: 250 }, (_, i) => decodeAnnouncement(announcement(5, i, i + 1, addr(0x2000 + i), PLANE), FEED_CHAIN_ID)!);
    const batches: number[] = [];
    const batch = db.d1.batch.bind(db.d1);
    (db.d1 as { batch: unknown }).batch = async (stmts: D1PreparedStatement[]) => (batches.push(stmts.length), batch(stmts));
    await store.commit(FEED_CHAIN_ID, items, 6, 1);
    // The last batch also carries the clearing of failures and the cursor.
    expect(batches).toEqual([100, 100, 52]);
    expect(await store.page(FEED_CHAIN_ID, null, 1_000, 5)).toHaveLength(250);
    batches.length = 0;
    await store.commit(FEED_CHAIN_ID, [], 7, 2);
    expect(batches).toEqual([2]);
    expect(await store.cursor(FEED_CHAIN_ID)).toBe(7);
  });

  it('writes a chunk read twice once, and never moves the cursor back', async () => {
    const db = handlesD1();
    const store = new D1FeedStore(db.d1);
    const a = decodeAnnouncement(announcement(5, 0, 1, addr(1), PLANE), FEED_CHAIN_ID)!;
    await store.commit(FEED_CHAIN_ID, [a], 10, 1);
    await store.commit(FEED_CHAIN_ID, [a], 6, 2);
    expect(await store.cursor(FEED_CHAIN_ID)).toBe(10);
    expect(await store.page(FEED_CHAIN_ID, null, 10, 100)).toHaveLength(1);
  });
});

describe('GET /v1/announcements', () => {
  async function seeded(count: number, through: number) {
    const db = handlesD1();
    const store = new D1FeedStore(db.d1);
    const items = Array.from({ length: count }, (_, i) => decodeAnnouncement(announcement(10 + Math.floor(i / 3), i % 3, i + 1, addr(0x100 + i), PLANE), FEED_CHAIN_ID)!);
    await store.commit(FEED_CHAIN_ID, items, through + 1, 1);
    const ip = { keys: [] as string[], limit: async ({ key }: { key: string }) => (ip.keys.push(key), { success: true }) };
    const app = createAnnouncementsRoutes({ store: () => store });
    const get = async (query = '') => {
      const res = await app.request(`/${query}`, { headers: { 'cf-connecting-ip': '192.0.2.9' } }, { HANDLES_IP_RL: ip } as never);
      return { res, body: (await res.json()) as any };
    };
    return { db, store, get, ip };
  }

  it('pages in chain order from a cursor, the same bytes for every caller, and points past the indexed blocks once caught up', async () => {
    const f = await seeded(FEED_PAGE + 5, 400);
    const first = await f.get();
    expect(first.res.status).toBe(200);
    expect(first.body.chainId).toBe(FEED_CHAIN_ID);
    expect(first.body.items).toHaveLength(FEED_PAGE);
    expect(first.body.items[0]).toMatchObject({ position: '10:0', blockNumber: 10, logIndex: 0, metadata: '0x7f' });
    const last = first.body.items[FEED_PAGE - 1];
    expect(first.body.next).toBe(last.position);
    expect(first.body.through).toBe(400);
    const second = await f.get(`?after=${first.body.next}`);
    expect(second.body.items).toHaveLength(5);
    expect(second.body.next).toBe(`400:${END_OF_BLOCK}`);
    const caughtUp = await f.get(`?after=${second.body.next}`);
    expect(caughtUp.body.items).toEqual([]);
    expect(caughtUp.body.next).toBe(`400:${END_OF_BLOCK}`);
    // Two callers asking the same thing get the same bytes.
    expect(JSON.stringify((await f.get(`?after=${first.body.next}`)).body)).toBe(JSON.stringify(second.body));
    expect(f.ip.keys.every((k) => k === 'announce-ip:192.0.2.9')).toBe(true);
  });

  it('serves nothing past the indexed blocks, even rows a later chunk is writing', async () => {
    const f = await seeded(3, 9);
    // Rows at block 10 exist but the cursor says block 9 is the last indexed: the page stops there.
    expect((await f.get()).body).toMatchObject({ items: [], next: `9:${END_OF_BLOCK}`, through: 9 });
  });

  it('answers an empty feed before the first run, refuses a bad cursor, and 503 unbound', async () => {
    const db = handlesD1();
    const app = createAnnouncementsRoutes({ store: () => new D1FeedStore(db.d1) });
    expect(await (await app.request('/', {}, {} as never)).json()).toEqual({ ok: true, chainId: FEED_CHAIN_ID, items: [], gaps: [], next: null, through: null });
    for (const bad of ['abc', '1:', ':1', '1:2:3', `1:${END_OF_BLOCK + 1}`]) expect((await app.request(`/?after=${bad}`, {}, {} as never)).status).toBe(400);
    expect(readCursor('12:3')).toEqual({ block: 12, logIndex: 3 });
    const unbound = createAnnouncementsRoutes();
    expect((await unbound.request('/', {}, {} as never)).status).toBe(503);
  });
});

describe('the cron', () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((l: string) => void lines.push(l));
  });
  afterEach(() => vi.restoreAllMocks());

  it('sweeps, then indexes only when ANNOUNCEMENTS_FROM_BLOCK is set, logging counts only', async () => {
    const db = handlesD1();
    const stealth = addr(0xd1);
    const chain = fakeChain([announcement(50, 0, 1, stealth), transfer(50, 1, 1, stealth)], 120);
    await runHandlesCron({ HANDLES_DB: db.d1 } as never, { now: () => 1, chain: () => chain });
    expect(chain.queries).toEqual([]);
    await runHandlesCron({ HANDLES_DB: db.d1, ANNOUNCEMENTS_FROM_BLOCK: '40' } as never, { now: () => 2, chain: () => chain });
    expect(await new D1FeedStore(db.d1).cursor(FEED_CHAIN_ID)).toBe(111);
    expect(lines.map((l) => JSON.parse(l) as Record<string, unknown>)).toEqual([
      { kind: 'handles', route: 'cron', step: 'sweep', links: 0, holds: 0, holdLog: 0 },
      { kind: 'handles', route: 'cron', step: 'sweep', links: 0, holds: 0, holdLog: 0 },
      { kind: 'handles', route: 'cron', step: 'announcements', chunks: 1, kept: 1, unchecked: 0, dropped: 0, gaps: 0, full: false, through: 110 },
    ]);
    expect(lines.join('\n').toLowerCase()).not.toContain(stealth.slice(2).toLowerCase());
  });

  it('does nothing unbound, and a failed index run is logged by name', async () => {
    await runHandlesCron({} as never, { now: () => 1 });
    expect(lines).toEqual([]);
    const db = handlesD1();
    const chain = fakeChain([], 10);
    chain.fail = () => true;
    await runHandlesCron({ HANDLES_DB: db.d1, ANNOUNCEMENTS_FROM_BLOCK: '0' } as never, { now: () => 1, chain: () => chain });
    expect(JSON.parse(lines[1]!)).toEqual({ kind: 'handles', route: 'cron', step: 'announcements', error: 'Error' });
  });

  it('reads the start block strictly', () => {
    expect(feedStartBlock(undefined)).toBeNull();
    expect(feedStartBlock('')).toBeNull();
    expect(feedStartBlock('12x')).toBeNull();
    expect(feedStartBlock('-1')).toBeNull();
    expect(feedStartBlock(' 34000000 ')).toBe(34_000_000);
  });
});
