// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `ChatUsageDO` — one SQLite-backed Durable Object per account behind
 * `DurableChatUsageStore` (`chatUsageStore.ts`): the chat's usage meter, one
 * row per UTC month. Counts and an estimated cost in millionths of a dollar,
 * all integers; never any message text.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { MONTH, type ChatMonthUsage, type ChatUsageDelta } from './chatUsageStore.js';

const int = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
};

export class ChatUsageDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS months (
           month TEXT PRIMARY KEY,
           turns INTEGER NOT NULL DEFAULT 0,
           tokens_in INTEGER NOT NULL DEFAULT 0,
           tokens_out INTEGER NOT NULL DEFAULT 0,
           router_calls INTEGER NOT NULL DEFAULT 0,
           estimated_micro_usd INTEGER NOT NULL DEFAULT 0,
           last_turn_at INTEGER NOT NULL DEFAULT 0
         )`,
      );
    });
  }

  /** Add one turn's usage to its month. */
  async record(month: string, usage: ChatUsageDelta): Promise<void> {
    if (!MONTH.test(month)) throw new Error(`invalid month ${month}`);
    this.ctx.storage.sql.exec(
      `INSERT INTO months (month, turns, tokens_in, tokens_out, router_calls, estimated_micro_usd, last_turn_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (month) DO UPDATE SET
         turns = turns + excluded.turns,
         tokens_in = tokens_in + excluded.tokens_in,
         tokens_out = tokens_out + excluded.tokens_out,
         router_calls = router_calls + excluded.router_calls,
         estimated_micro_usd = estimated_micro_usd + excluded.estimated_micro_usd,
         last_turn_at = MAX(last_turn_at, excluded.last_turn_at)`,
      month,
      int(usage.turns),
      int(usage.tokensIn),
      int(usage.tokensOut),
      int(usage.routerCalls),
      int(usage.estimatedMicroUsd),
      int(usage.at),
    );
  }

  /** The month's row, or null before its first turn. */
  async read(month: string): Promise<ChatMonthUsage | null> {
    const rows = this.ctx.storage.sql.exec('SELECT * FROM months WHERE month = ?', month).toArray();
    const r = rows[0];
    if (!r) return null;
    return {
      month: String(r.month),
      turns: Number(r.turns),
      tokensIn: Number(r.tokens_in),
      tokensOut: Number(r.tokens_out),
      routerCalls: Number(r.router_calls),
      estimatedMicroUsd: Number(r.estimated_micro_usd),
      lastTurnAt: Number(r.last_turn_at),
    };
  }
}
