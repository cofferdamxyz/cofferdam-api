// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `ActivityDO` — one SQLite-backed Durable Object per (chain, address) behind
 * `DurableActivityStore` (`activityStore.ts`, workspace decision 0032).
 *
 * Holds the address's token transfers as the CDP webhook delivers them. The
 * primary key is `{hash}:{logIndex}`, so the at-least-once deliveries dedupe on
 * insert. Public chain data only: no keys, no identity.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import type { StoredTransfer } from './activityStore.js';

/** Rows returned by one `list` call. */
const MAX_LIST = 100;

export class ActivityDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS transfers (
           id TEXT PRIMARY KEY,
           hash TEXT NOT NULL,
           log_index INTEGER NOT NULL,
           block INTEGER NOT NULL,
           ts INTEGER NOT NULL,
           from_addr TEXT NOT NULL,
           to_addr TEXT NOT NULL,
           value TEXT NOT NULL,
           token TEXT NOT NULL
         )`,
      );
      this.ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS transfers_by_block ON transfers (block DESC, log_index DESC)');
    });
  }

  async record(t: StoredTransfer): Promise<boolean> {
    const cursor = this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO transfers (id, hash, log_index, block, ts, from_addr, to_addr, value, token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `${t.hash}:${t.logIndex}`,
      t.hash,
      t.logIndex,
      t.blockNumber,
      t.timestamp,
      t.from,
      t.to,
      t.value,
      t.token,
    );
    return cursor.rowsWritten > 0;
  }

  async list(limit: number, toBlock: number | null): Promise<StoredTransfer[]> {
    const n = Math.min(Math.max(1, Math.floor(limit)), MAX_LIST);
    const rows = toBlock == null
      ? this.ctx.storage.sql.exec('SELECT * FROM transfers ORDER BY block DESC, log_index DESC LIMIT ?', n)
      : this.ctx.storage.sql.exec('SELECT * FROM transfers WHERE block <= ? ORDER BY block DESC, log_index DESC LIMIT ?', toBlock, n);
    return rows.toArray().map((r) => ({
      hash: String(r.hash),
      logIndex: Number(r.log_index),
      blockNumber: Number(r.block),
      timestamp: Number(r.ts),
      from: String(r.from_addr),
      to: String(r.to_addr),
      value: String(r.value),
      token: String(r.token),
    }));
  }

  async latestBlock(): Promise<number> {
    const row = this.ctx.storage.sql.exec('SELECT MAX(block) AS b FROM transfers').one();
    return row.b == null ? 0 : Number(row.b);
  }
}
