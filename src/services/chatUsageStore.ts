// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The chat's per-account usage meter: one row per account and month
 * (`YYYY-MM`, UTC) with turns, tokens and an estimated cost, so the founder
 * can see cost per user and `CHAT_MONTHLY_TOKEN_CAP` can stop an account that
 * goes past fair use.
 *
 * This module holds the store interface, the Durable Object adapter and the
 * pure arithmetic; the class itself lives in `chatUsageDO.ts` because it
 * imports `cloudflare:workers`, which the route tests cannot load (the same
 * split as `bundleStore.ts` and `bindBundleDO.ts`).
 *
 * Counted: every completed turn, the routed model's tokens when it reports
 * them, and the router's input tokens estimated from the length of its state.
 * Not counted: a failed turn, an early answer cancelled unread, and a model
 * that reports no usage. The cap counts the routed model's tokens in and out;
 * the router reaches the meter only as cost.
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
}

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

/** `CHAT_MONTHLY_TOKEN_CAP` as a positive integer; unset, empty or invalid means no cap. */
export function parseTokenCap(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The tokens a month counts against the cap. */
export function capTokens(usage: Pick<ChatMonthUsage, 'tokensIn' | 'tokensOut'> | null): number {
  return usage ? usage.tokensIn + usage.tokensOut : 0;
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

  async record(account: Address, month: string, delta: ChatUsageDelta): Promise<void> {
    await this.stub(account).record(month, delta);
  }

  async read(account: Address, month: string): Promise<ChatMonthUsage | null> {
    const row = await this.stub(account).read(month);
    return (row as ChatMonthUsage | null) ?? null;
  }
}
