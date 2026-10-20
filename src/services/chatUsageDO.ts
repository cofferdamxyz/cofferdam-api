// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `ChatUsageDO` — one SQLite-backed Durable Object per account behind
 * `DurableChatUsageStore` (`chatUsageStore.ts`): the chat's usage meter, one
 * row per UTC month and one per month and model. Counts and an estimated cost
 * in millionths of a dollar, all integers; never any message text. The SQL
 * lives in `chatUsageStore.ts` so the tests can run it.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { migrateUsageTables, readUsage, recordUsage, type ChatMonthUsage, type ChatUsageDelta } from './chatUsageStore.js';

export class ChatUsageDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrateUsageTables(this.ctx.storage.sql);
    });
  }

  /** Add one turn's usage to its month and to its model, in one transaction. */
  async record(month: string, usage: ChatUsageDelta): Promise<void> {
    this.ctx.storage.transactionSync(() => recordUsage(this.ctx.storage.sql, month, usage));
  }

  /** The month's totals and its models, or null before its first turn. */
  async read(month: string): Promise<ChatMonthUsage | null> {
    return readUsage(this.ctx.storage.sql, month);
  }
}
