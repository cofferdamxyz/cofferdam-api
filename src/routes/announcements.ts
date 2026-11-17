// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * /v1/announcements — the announcement feed (workspace decision 0086, rule 5,
 * corrected 2026-11-16; question 18; runbook step 3).
 *
 *   GET /v1/announcements?after=<block>:<logIndex>
 *        → 200 { ok, chainId, items: [{ position, blockNumber, logIndex, txHash, stealthAddress, caller, ephemeralPubKey, metadata }],
 *                next, through }
 *
 * The scheme 1 announcements the indexer kept (`services/handles/announcements.ts`),
 * in chain order, `FEED_PAGE` at a time, after the position `after` names
 * (from the start without it). `next` is the cursor to ask with next: the last
 * item's position on a full page, else the end of the last block indexed
 * (`through`), so a phone that has caught up asks from there. `through` is
 * null before the indexer's first run.
 *
 * Unauthenticated, the same bytes for every caller who asks the same thing,
 * no IP kept, rate-limited per IP like the other public routes. A phone reads
 * it with each epoch's viewing key (rule 1's recovery, a linked phone's
 * balances, q18's scan); the phone also spot-checks it against a public node,
 * since a compromised plane could leave an announcement out (q18).
 */

import { Hono } from 'hono';

import type { Env } from '../env.js';
import { D1FeedStore, FEED_CHAIN_ID, type Announcement, type FeedStore } from '../services/handles/announcements.js';
import { handlesLog, publicLimit } from '../services/handles/limits.js';

/** Items per page: fixed, so every caller asking from one cursor gets the same page. */
export const FEED_PAGE = 500;
/** A cursor's log index past every log of its block: "after the whole block". */
export const END_OF_BLOCK = 1_000_000;

const CURSOR = /^(\d{1,12}):(\d{1,7})$/;

export function readCursor(raw: string | undefined): { block: number; logIndex: number } | null | 'bad' {
  if (raw === undefined || raw === '') return null;
  const m = CURSOR.exec(raw);
  if (!m) return 'bad';
  const block = Number(m[1]);
  const logIndex = Number(m[2]);
  if (logIndex > END_OF_BLOCK) return 'bad';
  return { block, logIndex };
}

export interface AnnouncementsRouteDeps {
  store?(env: Env): FeedStore | null;
}

export function envFeedStore(env: Env): FeedStore | null {
  return env.HANDLES_DB ? new D1FeedStore(env.HANDLES_DB) : null;
}

function item(a: Announcement) {
  return {
    position: `${a.blockNumber}:${a.logIndex}`,
    blockNumber: a.blockNumber,
    logIndex: a.logIndex,
    txHash: a.txHash,
    stealthAddress: a.stealthAddress,
    caller: a.caller,
    ephemeralPubKey: a.ephemeralPubKey,
    metadata: a.metadata,
  };
}

export function createAnnouncementsRoutes(deps: AnnouncementsRouteDeps = {}) {
  const routes = new Hono<{ Bindings: Env }>();
  const storeOf = (env: Env) => (deps.store ?? envFeedStore)(env);

  routes.get('/', async (c) => {
    const limited = await publicLimit(c, 'announce');
    if (limited) return limited;
    const after = readCursor(c.req.query('after'));
    if (after === 'bad') return c.json({ ok: false, error: 'bad_cursor', hint: 'after is <block>:<logIndex>' }, 400, { 'cache-control': 'no-store' });
    const store = storeOf(c.env);
    if (!store) return c.json({ ok: false, error: 'handles_db_unprovisioned' }, 503, { 'cache-control': 'no-store' });
    try {
      // The cursor first, and the page bounded by it: a chunk the indexer commits meanwhile is neither half-read nor skipped.
      const cursor = await store.cursor(FEED_CHAIN_ID);
      const through = cursor === null ? null : cursor - 1;
      const page = through === null ? [] : await store.page(FEED_CHAIN_ID, after, FEED_PAGE, through);
      const last = page[page.length - 1];
      let next: string | null;
      if (page.length === FEED_PAGE && last) next = `${last.blockNumber}:${last.logIndex}`;
      else if (through !== null && (!after || through >= after.block)) next = `${through}:${END_OF_BLOCK}`;
      else next = after ? `${after.block}:${after.logIndex}` : null;
      handlesLog({ route: 'announcements', items: page.length });
      // A short TTL: the page after a cursor only grows as the indexer goes on.
      return c.json({ ok: true, chainId: FEED_CHAIN_ID, items: page.map(item), next, through }, 200, { 'cache-control': 'public, max-age=10' });
    } catch (err) {
      handlesLog({ route: 'announcements', error: err instanceof Error ? err.name : typeof err });
      return c.json({ ok: false, error: 'handles_unavailable' }, 503, { 'cache-control': 'no-store' });
    }
  });

  return routes;
}

export const announcementsRoutes = createAnnouncementsRoutes();
