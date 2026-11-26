// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `ActivityDO` — one SQLite-backed Durable Object per (chain, address) behind
 * `DurableActivityStore` (`activityStore.ts`, workspace decision 0032).
 *
 * Holds the address's token transfers as the CDP webhook delivers them, each
 * row naming its token; reads are per token. The primary key is
 * `{hash}:{logIndex}`, so the at-least-once deliveries dedupe on insert. The
 * SQL is in `activityStore.ts`, run on `node:sqlite` by the tests. Public chain
 * data only: no keys, no identity.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import {
  insertTransfer,
  latestTransferBlock,
  listTransfers,
  migrateActivityTable,
  type StoredTransfer,
} from './activityStore.js';

export class ActivityDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      migrateActivityTable(this.ctx.storage.sql);
    });
  }

  async record(t: StoredTransfer): Promise<boolean> {
    return insertTransfer(this.ctx.storage.sql, t);
  }

  async list(token: string, limit: number, toBlock: number | null): Promise<StoredTransfer[]> {
    return listTransfers(this.ctx.storage.sql, token, limit, toBlock);
  }

  async latestBlock(token: string): Promise<number> {
    return latestTransferBlock(this.ctx.storage.sql, token);
  }
}
