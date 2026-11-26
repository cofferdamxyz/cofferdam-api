// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The daily budget of each hot key (workspace decision 0090 item 11;
 * cdp-setup.md E5): one `KeyBudgetDO` per role, chain and signer address,
 * counting the transactions the key sends and the gas they paid per UTC day.
 *
 * - **The budget alerts.** The first send or receipt that takes a day past
 *   either budget (calls or gas) logs one `key_budget_crossed` line for the
 *   founder and the Ops bot; nothing is refused.
 * - **The hard stop refuses.** A send while the day is at or past either hard
 *   stop is refused (the relay answers `503 budget_exhausted`, the registrar's
 *   send fails as a node error does and its job waits). The first refusal of
 *   a day logs `key_budget_stopped`. The hard stops sit well above normal use,
 *   so spending the budget can't switch the relays off (item 11, ruling 5).
 * - **The cap against theft is the balance**, not this: a thief holding the
 *   credentials calls CDP directly. This counts only what the plane sends.
 * - **It fails open.** No binding, no budget for the role, or an object that
 *   does not answer: the send goes ahead and, for the last, one
 *   `key_budget_unavailable` line is logged. A meter must not become the
 *   outage it is meant to report.
 *
 * Under a CDP signer the nonce is CDP's (it fills it on `send`); the raw-key
 * lane keeps `relaySend.ts`'s re-sign on a nonce clash. So this object holds
 * the budget only, not the relay's nonce (decision 0012's open point stays
 * answered by CDP on mainnet).
 *
 * Budgets come from the var `KEY_BUDGETS`, JSON by role:
 *   { "relayer":   { "calls": 2000, "gasWei": "50000000000000000",
 *                    "hardCalls": 20000, "hardGasWei": "500000000000000000" },
 *     "registrar": { … } }
 * Each of the four is optional; a role absent or malformed is counted with no
 * alert and no stop. Gas is the receipt's `gasUsed × effectiveGasPrice` plus
 * Base's `l1Fee` when the receipt carries it, counted once per transaction.
 *
 * This module holds the SQL (run on `node:sqlite` by the tests) and the
 * client; the class is `keyBudgetDO.ts`, which imports `cloudflare:workers`.
 */

import type { Address, Hex } from 'viem';

import type { Env } from '../env.js';

export type BudgetRole = 'relayer' | 'registrar';

/** One role's limits; a missing one is no limit. */
export interface BudgetLimits {
  calls?: number;
  gasWei?: bigint;
  hardCalls?: number;
  hardGasWei?: bigint;
}

/** Wire form of the limits (bigints as decimal strings), as the object takes them. */
export interface BudgetLimitsWire {
  calls?: number;
  gasWei?: string;
  hardCalls?: number;
  hardGasWei?: string;
}

export type BudgetAlert = 'budget' | 'stop' | null;

export interface AdmitResult {
  allowed: boolean;
  calls: number;
  gasWei: string;
  /** Set on the one call of a day that crossed a budget or was the first refused. */
  alert: BudgetAlert;
}

export interface SpendResult {
  calls: number;
  gasWei: string;
  alert: BudgetAlert;
}

/** The slice of `ctx.storage.sql` the budget uses. */
export interface BudgetSql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** Days kept; a month and a bit, for the Ops bot's look back. */
const KEEP_DAYS = 35;

export function migrateBudgetTables(sql: BudgetSql): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS days (
       day TEXT PRIMARY KEY,
       calls INTEGER NOT NULL DEFAULT 0,
       gas_wei TEXT NOT NULL DEFAULT '0',
       refused INTEGER NOT NULL DEFAULT 0,
       alerted_budget INTEGER NOT NULL DEFAULT 0,
       alerted_stop INTEGER NOT NULL DEFAULT 0
     )`,
  );
  sql.exec(`CREATE TABLE IF NOT EXISTS spent (tx TEXT PRIMARY KEY, day TEXT NOT NULL)`);
}

/** `YYYY-MM-DD` in UTC. */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function dayBefore(day: string, days: number): string {
  return utcDay(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000);
}

function readDay(sql: BudgetSql, day: string) {
  sql.exec('INSERT INTO days (day) VALUES (?) ON CONFLICT(day) DO NOTHING', day);
  const row = sql.exec('SELECT calls, gas_wei, alerted_budget, alerted_stop FROM days WHERE day = ?', day).toArray()[0]!;
  return { calls: Number(row.calls), gasWei: BigInt(String(row.gas_wei)), alertedBudget: Number(row.alerted_budget) === 1, alertedStop: Number(row.alerted_stop) === 1 };
}

function sweep(sql: BudgetSql, day: string): void {
  sql.exec('DELETE FROM days WHERE day IN (SELECT day FROM days WHERE day < ? LIMIT 50)', dayBefore(day, KEEP_DAYS));
  sql.exec('DELETE FROM spent WHERE tx IN (SELECT tx FROM spent WHERE day < ? LIMIT 200)', dayBefore(day, 2));
}

export function limitsFromWire(w: BudgetLimitsWire | null | undefined): BudgetLimits {
  const big = (v: string | undefined) => (v !== undefined && /^\d{1,30}$/.test(v) ? BigInt(v) : undefined);
  const int = (v: number | undefined) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
  return { calls: int(w?.calls), gasWei: big(w?.gasWei), hardCalls: int(w?.hardCalls), hardGasWei: big(w?.hardGasWei) };
}

function overBudget(l: BudgetLimits, calls: number, gas: bigint): boolean {
  return (l.calls !== undefined && calls >= l.calls) || (l.gasWei !== undefined && gas >= l.gasWei);
}

function atHardStop(l: BudgetLimits, calls: number, gas: bigint): boolean {
  return (l.hardCalls !== undefined && calls >= l.hardCalls) || (l.hardGasWei !== undefined && gas >= l.hardGasWei);
}

/** Before a send: refuse at the hard stop, else count the call. Run inside one transaction. */
export function admitSend(sql: BudgetSql, day: string, limits: BudgetLimits): AdmitResult {
  sweep(sql, day);
  const d = readDay(sql, day);
  if (atHardStop(limits, d.calls, d.gasWei)) {
    const first = !d.alertedStop;
    sql.exec('UPDATE days SET refused = refused + 1, alerted_stop = 1 WHERE day = ?', day);
    return { allowed: false, calls: d.calls, gasWei: d.gasWei.toString(), alert: first ? 'stop' : null };
  }
  const calls = d.calls + 1;
  const crossed = !d.alertedBudget && overBudget(limits, calls, d.gasWei);
  sql.exec('UPDATE days SET calls = ?, alerted_budget = alerted_budget OR ? WHERE day = ?', calls, crossed ? 1 : 0, day);
  return { allowed: true, calls, gasWei: d.gasWei.toString(), alert: crossed ? 'budget' : null };
}

/** After a receipt: add its gas once per transaction. Run inside one transaction. */
export function recordSpend(sql: BudgetSql, day: string, tx: string, gasWei: bigint, limits: BudgetLimits): SpendResult {
  const d = readDay(sql, day);
  const seen = sql.exec('SELECT 1 FROM spent WHERE tx = ?', tx.toLowerCase()).toArray()[0];
  if (seen || gasWei <= 0n) return { calls: d.calls, gasWei: d.gasWei.toString(), alert: null };
  sql.exec('INSERT INTO spent (tx, day) VALUES (?, ?)', tx.toLowerCase(), day);
  const gas = d.gasWei + gasWei;
  const crossed = !d.alertedBudget && overBudget(limits, d.calls, gas);
  sql.exec('UPDATE days SET gas_wei = ?, alerted_budget = alerted_budget OR ? WHERE day = ?', gas.toString(), crossed ? 1 : 0, day);
  return { calls: d.calls, gasWei: gas.toString(), alert: crossed ? 'budget' : null };
}

export type KeyBudgetEnv = Pick<Env, 'KEY_BUDGETS' | 'KEY_BUDGET_DO'>;

/** A role's limits from `KEY_BUDGETS`, or null when the role has none or the JSON is malformed. */
export function budgetLimitsOf(env: Pick<KeyBudgetEnv, 'KEY_BUDGETS'>, role: BudgetRole): BudgetLimitsWire | null {
  if (!env.KEY_BUDGETS) return null;
  try {
    const parsed = JSON.parse(env.KEY_BUDGETS) as Record<string, unknown>;
    const w = parsed?.[role];
    if (!w || typeof w !== 'object') return null;
    const l = limitsFromWire(w as BudgetLimitsWire);
    return {
      ...(l.calls !== undefined ? { calls: l.calls } : {}),
      ...(l.gasWei !== undefined ? { gasWei: l.gasWei.toString() } : {}),
      ...(l.hardCalls !== undefined ? { hardCalls: l.hardCalls } : {}),
      ...(l.hardGasWei !== undefined ? { hardGasWei: l.hardGasWei.toString() } : {}),
    };
  } catch {
    return null;
  }
}

/** What a sender needs: may it send, and the gas a receipt showed. Never throws. */
export interface KeyBudget {
  /** False only at the hard stop. */
  admit(): Promise<boolean>;
  spend(tx: Hex, gasWei: bigint): Promise<void>;
}

/** The gas a receipt paid: `gasUsed × effectiveGasPrice`, plus Base's `l1Fee` when present. */
export function receiptGasWei(r: { gasUsed?: bigint; effectiveGasPrice?: bigint; l1Fee?: bigint | null }): bigint {
  const l2 = r.gasUsed !== undefined && r.effectiveGasPrice !== undefined ? r.gasUsed * r.effectiveGasPrice : 0n;
  return l2 + (typeof r.l1Fee === 'bigint' ? r.l1Fee : 0n);
}

const NO_BUDGET: KeyBudget = { admit: () => Promise.resolve(true), spend: () => Promise.resolve() };

/**
 * The budget of one key on one chain, or a no-op while `KEY_BUDGET_DO` is
 * unbound. A role without limits is still counted, so the Ops bot reads its
 * days, with no alert and no stop.
 */
export function keyBudgetOf(env: KeyBudgetEnv, role: BudgetRole, chainId: number, address: Address, now: () => number = Date.now): KeyBudget {
  const ns = env.KEY_BUDGET_DO;
  if (!ns) return NO_BUDGET;
  const limits = budgetLimitsOf(env, role) ?? {};
  const stub = () => ns.get(ns.idFromName(`${role}:${chainId}:${address.toLowerCase()}`));
  const log = (event: string, fields: Record<string, unknown>) =>
    console.warn(JSON.stringify({ event, role, chainId, address, ...fields }));
  return {
    async admit() {
      const day = utcDay(now());
      try {
        const r = await stub().admit(day, limits);
        if (r.alert === 'budget') log('key_budget_crossed', { day, calls: r.calls, gasWei: r.gasWei, limits });
        if (r.alert === 'stop') log('key_budget_stopped', { day, calls: r.calls, gasWei: r.gasWei, limits });
        return r.allowed;
      } catch (err) {
        log('key_budget_unavailable', { step: 'admit', error: err instanceof Error ? err.name : 'error' });
        return true;
      }
    },
    async spend(tx, gasWei) {
      const day = utcDay(now());
      try {
        const r = await stub().spend(day, tx, gasWei.toString(), limits);
        if (r.alert === 'budget') log('key_budget_crossed', { day, calls: r.calls, gasWei: r.gasWei, limits });
      } catch (err) {
        log('key_budget_unavailable', { step: 'spend', error: err instanceof Error ? err.name : 'error' });
      }
    },
  };
}
