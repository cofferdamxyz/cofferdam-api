// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The chat's per-account usage meter: one row per account and month
 * (`YYYY-MM`, UTC) with turns, tokens and an estimated cost, so the founder
 * can see cost per user and `CHAT_MONTHLY_USD_CAP` can stop an account that
 * goes past fair use. Caps are in dollars, not tokens, so a model change does
 * not change what a cap (or, later, a plan) buys.
 *
 * This module holds the store interface, the Durable Object adapter, the
 * object's SQL and the pure arithmetic; the class itself lives in
 * `chatUsageDO.ts` because it imports `cloudflare:workers`, which the route
 * tests cannot load (the same split as `bundleStore.ts` and `bindBundleDO.ts`).
 * The tests run the same SQL on `node:sqlite`.
 *
 * Each month is also split per model (the `month_models` table, from
 * 2026-10-20): the turns a model answered or filled an action's fields for,
 * its tokens and its own share of the cost. The router is not an entry. It
 * runs on every turn and is a step of the turn, not a model that answers;
 * its tokens are an estimate the totals never count. As an entry it would
 * count every question twice and break the sum of the tokens. Its calls and
 * its cost stay in the month's totals only, so the models' tokens add up to
 * the totals' and their costs to the total less the router's. A turn that
 * sent only fixed text (a refusal, say) is in the totals and in no model.
 *
 * The same object class also keeps one plane-wide row per month (the object
 * named `plane:global`): the sum of every account's spend, which the global
 * brake `AI_MONTHLY_BUDGET_USD` reads. Every hosted AI op reports to both
 * rows: the chat today, the cloud document extraction when it lands. The
 * plane-wide row is split per model the same way; no route reads that yet.
 *
 * Counted: every completed turn, the routed model's tokens when it reports
 * them, and the router's input tokens estimated from the length of its state.
 * Not counted: a failed turn, an early answer cancelled unread, and a model
 * that reports no usage. The cap counts the estimated cost: the routed
 * model's tokens and the router's estimate, priced.
 */

import type { Address } from 'viem';

import type { ChatTurnUsage } from './chat/run.js';
import type { ChatUsageDO } from './chatUsageDO.js';
import { modelCostMicroUsd } from './inference/index.js';

/** What one turn adds to its month. Integers only; cost in millionths of a dollar. */
export interface ChatUsageDelta {
  turns: number;
  /** The routed model's tokens; the router's estimate is priced but never counted here. */
  tokensIn: number;
  tokensOut: number;
  routerCalls: number;
  /** The whole turn: the routed model and the router. */
  estimatedMicroUsd: number;
  /** The model that wrote the answer or filled the action's fields; null when the turn sent only fixed text. */
  model: string | null;
  /** That model's own share of `estimatedMicroUsd`, without the router's. */
  modelMicroUsd: number;
  /** Unix milliseconds. */
  at: number;
}

/** One model's part of a month (the router is never one; see the module comment). */
export interface ChatModelUsage {
  model: string;
  /** Turns this model answered or filled an action's fields for. */
  turns: number;
  tokensIn: number;
  tokensOut: number;
  /** This model's own cost, without the router's. */
  estimatedMicroUsd: number;
}

/** One account's month as stored. */
export interface ChatMonthUsage {
  month: string;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  routerCalls: number;
  estimatedMicroUsd: number;
  /** Unix milliseconds of the last recorded turn. */
  lastTurnAt: number;
  /** The month per model, most-used first: by turns, then tokens, then id. */
  models: ChatModelUsage[];
}

export interface ChatUsageStore {
  record(account: Address, month: string, delta: ChatUsageDelta): Promise<void>;
  /** Null when the account has no turn that month. */
  read(account: Address, month: string): Promise<ChatMonthUsage | null>;
  /** The plane-wide row: every account's spend added together. */
  recordGlobal(month: string, delta: ChatUsageDelta): Promise<void>;
  readGlobal(month: string): Promise<ChatMonthUsage | null>;
}

/** The Durable Object name of the plane-wide row; accounts are named by address, so it cannot collide. */
export const GLOBAL_USAGE_NAME = 'plane:global';

export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The UTC month a time falls in, `YYYY-MM`. */
export function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/** The first instant of the next UTC month, when a month's cap resets. */
export function monthResetsAt(ms: number): Date {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

/**
 * A dollar amount from a variable (`CHAT_MONTHLY_USD_CAP`,
 * `AI_MONTHLY_BUDGET_USD`; decimals allowed) in micro-dollars; unset, empty,
 * zero or invalid means none.
 */
export function parseUsdMicro(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1_000_000) : null;
}

/**
 * What a turn is assumed to cost before an account has enough turns of its
 * own: a short answer, about 1,000 tokens in and 150 out on `gemma-4` plus the
 * router (2026-10-20 estimate; re-check against the meter after launch).
 */
export const TYPICAL_TURN_MICRO_USD = 200;
/** Turns an account needs this month before its own average is used. */
export const OWN_AVERAGE_AFTER_TURNS = 10;

const DAY_MS = 86_400_000;

export interface CapEstimate {
  usd: number;
  remainingUsd: number;
  /** About how many more turns the rest of the cap buys, at this account's average or the typical cost. */
  turnsLeft: number;
  /** `turnsLeft` spread over the days left in the month, the last one included. */
  turnsPerDay: number;
  resetsAt: string;
}

/** The cap as the user reads it: what is left, in dollars and in turns. */
export function capEstimate(capMicroUsd: number, usage: ChatMonthUsage | null, now: number): CapEstimate {
  const spent = usage?.estimatedMicroUsd ?? 0;
  const remaining = Math.max(0, capMicroUsd - spent);
  const turns = usage?.turns ?? 0;
  const perTurn = turns >= OWN_AVERAGE_AFTER_TURNS && spent > 0 ? spent / turns : TYPICAL_TURN_MICRO_USD;
  const turnsLeft = Math.floor(remaining / perTurn);
  const resetsAt = monthResetsAt(now);
  const daysLeft = Math.max(1, Math.ceil((resetsAt.getTime() - now) / DAY_MS));
  return {
    usd: capMicroUsd / 1_000_000,
    remainingUsd: remaining / 1_000_000,
    turnsLeft,
    turnsPerDay: Math.floor(turnsLeft / daysLeft),
    resetsAt: resetsAt.toISOString(),
  };
}

/** A count as stored: a whole number, zero for anything negative, missing or not a number. */
const int = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
};

/** What a finished turn adds to the meter, priced with `MODEL_PRICES`. */
export function usageDelta(
  usage: ChatTurnUsage,
  at: number,
  log?: (fields: Record<string, unknown>) => void,
): ChatUsageDelta {
  const tokensIn = int(usage.tokensIn);
  const tokensOut = int(usage.tokensOut);
  const routerIn = usage.router.called ? int(usage.router.tokensIn) : 0;
  const model = usage.model && (tokensIn || tokensOut) ? modelCostMicroUsd(usage.model, tokensIn, tokensOut, log) : 0;
  const router = routerIn ? modelCostMicroUsd(usage.router.model, routerIn, 0, log) : 0;
  return {
    turns: 1,
    tokensIn,
    tokensOut,
    routerCalls: usage.router.called ? 1 : 0,
    estimatedMicroUsd: model + router,
    model: usage.model || null,
    modelMicroUsd: model,
    at,
  };
}

/**
 * The slice of a Durable Object's SQLite storage (`ctx.storage.sql`) the meter
 * uses; the tests pass `node:sqlite` behind the same shape.
 */
export interface UsageSql {
  exec(query: string, ...bindings: (string | number)[]): { toArray(): Record<string, unknown>[] };
}

/** Longer ids are not split per model; the plane's own pins are far shorter. */
const MODEL_ID_MAX = 128;

/**
 * The meter's tables, created when the object starts. Idempotent: an object
 * from before 2026-10-20 has `months` only and gains `month_models` on its
 * next start, so its earlier turns are in the totals and in no model.
 */
export function migrateUsageTables(sql: UsageSql): void {
  sql.exec(
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
  sql.exec(
    `CREATE TABLE IF NOT EXISTS month_models (
       month TEXT NOT NULL,
       model TEXT NOT NULL,
       turns INTEGER NOT NULL DEFAULT 0,
       tokens_in INTEGER NOT NULL DEFAULT 0,
       tokens_out INTEGER NOT NULL DEFAULT 0,
       estimated_micro_usd INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (month, model)
     )`,
  );
}

/**
 * Add one turn to its month's totals and to its model's row. The caller runs
 * it in one transaction. A delta without a usable model id (fixed text, or a
 * caller from before the split) adds to the totals only, which the cap reads.
 */
export function recordUsage(sql: UsageSql, month: string, delta: ChatUsageDelta): void {
  if (!MONTH.test(month)) throw new Error(`invalid month ${month}`);
  const estimated = int(delta.estimatedMicroUsd);
  sql.exec(
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
    int(delta.turns),
    int(delta.tokensIn),
    int(delta.tokensOut),
    int(delta.routerCalls),
    estimated,
    int(delta.at),
  );
  const model = delta.model;
  if (typeof model !== 'string' || model.length === 0 || model.length > MODEL_ID_MAX) return;
  sql.exec(
    `INSERT INTO month_models (month, model, turns, tokens_in, tokens_out, estimated_micro_usd)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (month, model) DO UPDATE SET
       turns = turns + excluded.turns,
       tokens_in = tokens_in + excluded.tokens_in,
       tokens_out = tokens_out + excluded.tokens_out,
       estimated_micro_usd = estimated_micro_usd + excluded.estimated_micro_usd`,
    month,
    model,
    int(delta.turns),
    int(delta.tokensIn),
    int(delta.tokensOut),
    // A model's share never exceeds the turn it is part of.
    Math.min(int(delta.modelMicroUsd), estimated),
  );
}

/** The month's totals and its models, most-used first; null before the month's first turn. */
export function readUsage(sql: UsageSql, month: string): ChatMonthUsage | null {
  const r = sql.exec('SELECT * FROM months WHERE month = ?', month).toArray()[0];
  if (!r) return null;
  const models = sql
    .exec(
      `SELECT model, turns, tokens_in, tokens_out, estimated_micro_usd FROM month_models
       WHERE month = ?
       ORDER BY turns DESC, tokens_in + tokens_out DESC, model`,
      month,
    )
    .toArray()
    .map((m) => ({
      model: String(m.model),
      turns: Number(m.turns),
      tokensIn: Number(m.tokens_in),
      tokensOut: Number(m.tokens_out),
      estimatedMicroUsd: Number(m.estimated_micro_usd),
    }));
  return {
    month: String(r.month),
    turns: Number(r.turns),
    tokensIn: Number(r.tokens_in),
    tokensOut: Number(r.tokens_out),
    routerCalls: Number(r.router_calls),
    estimatedMicroUsd: Number(r.estimated_micro_usd),
    lastTurnAt: Number(r.last_turn_at),
    models,
  };
}

/** One Durable Object per account, named by the lower-cased address. */
export class DurableChatUsageStore implements ChatUsageStore {
  constructor(private readonly namespace: DurableObjectNamespace<ChatUsageDO>) {}

  private stub(account: Address) {
    return this.namespace.getByName(account.toLowerCase());
  }

  private global() {
    return this.namespace.getByName(GLOBAL_USAGE_NAME);
  }

  async recordGlobal(month: string, delta: ChatUsageDelta): Promise<void> {
    await this.global().record(month, delta);
  }

  async readGlobal(month: string): Promise<ChatMonthUsage | null> {
    const row = await this.global().read(month);
    return (row as ChatMonthUsage | null) ?? null;
  }

  async record(account: Address, month: string, delta: ChatUsageDelta): Promise<void> {
    await this.stub(account).record(month, delta);
  }

  async read(account: Address, month: string): Promise<ChatMonthUsage | null> {
    const row = await this.stub(account).read(month);
    return (row as ChatMonthUsage | null) ?? null;
  }
}
