// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The chat's per-account usage meter: one row per account and month
 * (`YYYY-MM`, UTC) with turns, tokens and an estimated cost, so the founder
 * can see cost per user and `CHAT_MONTHLY_USD_CAP` can stop an account that
 * goes past fair use. Caps are in dollars, not tokens, so a model change does
 * not change what a cap (or, later, a plan) buys.
 *
 * This module holds the store interface, the Durable Object adapter and the
 * pure arithmetic; the class itself lives in `chatUsageDO.ts` because it
 * imports `cloudflare:workers`, which the route tests cannot load (the same
 * split as `bundleStore.ts` and `bindBundleDO.ts`).
 *
 * The same object class also keeps one plane-wide row per month (the object
 * named `plane:global`): the sum of every account's spend, which the global
 * brake `AI_MONTHLY_BUDGET_USD` reads. Every hosted AI op reports to both
 * rows: the chat today, the cloud document extraction when it lands.
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
  tokensIn: number;
  tokensOut: number;
  routerCalls: number;
  estimatedMicroUsd: number;
  /** Unix milliseconds. */
  at: number;
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

const count = (n: number | null | undefined) => (n != null && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/** What a finished turn adds to the meter, priced with `MODEL_PRICES`. */
export function usageDelta(
  usage: ChatTurnUsage,
  at: number,
  log?: (fields: Record<string, unknown>) => void,
): ChatUsageDelta {
  const tokensIn = count(usage.tokensIn);
  const tokensOut = count(usage.tokensOut);
  const routerIn = usage.router.called ? count(usage.router.tokensIn) : 0;
  const model = usage.model && (tokensIn || tokensOut) ? modelCostMicroUsd(usage.model, tokensIn, tokensOut, log) : 0;
  const router = routerIn ? modelCostMicroUsd(usage.router.model, routerIn, 0, log) : 0;
  return {
    turns: 1,
    tokensIn,
    tokensOut,
    routerCalls: usage.router.called ? 1 : 0,
    estimatedMicroUsd: model + router,
    at,
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
