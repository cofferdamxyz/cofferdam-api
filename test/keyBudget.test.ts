// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The hot keys' daily budget (workspace decision 0090 item 11, cdp-setup.md
 * E5): the object's SQL on node:sqlite, the limits from `KEY_BUDGETS`, and the
 * client, which alerts once, refuses only at the hard stop and fails open.
 */

import { DatabaseSync } from 'node:sqlite';
import type { Address, Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { Env } from '../src/env.js';
import {
  admitSend,
  budgetLimitsOf,
  keyBudgetOf,
  limitsFromWire,
  migrateBudgetTables,
  receiptGasWei,
  recordSpend,
  utcDay,
  type BudgetLimitsWire,
  type BudgetSql,
} from '../src/services/keyBudgetStore.js';

function sqlite(): BudgetSql {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query, ...bindings) {
      const rows = db.prepare(query).all(...(bindings as (string | number | null)[])) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
}

const DAY = '2026-11-26';
const ADDRESS: Address = '0x17838cDF0788eF83a70E95A645D7C1E9ac107E19';
const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

describe('the budget SQL, on node:sqlite', () => {
  let sql: BudgetSql;
  beforeEach(() => {
    sql = sqlite();
    migrateBudgetTables(sql);
    migrateBudgetTables(sql);
  });

  it('counts each send and alerts once, on the call that crosses the budget', () => {
    const limits = limitsFromWire({ calls: 2 });
    expect(admitSend(sql, DAY, limits)).toMatchObject({ allowed: true, calls: 1, alert: null });
    expect(admitSend(sql, DAY, limits)).toMatchObject({ allowed: true, calls: 2, alert: 'budget' });
    expect(admitSend(sql, DAY, limits)).toMatchObject({ allowed: true, calls: 3, alert: null });
  });

  it('refuses at the hard stop, alerting on the first refusal of the day only', () => {
    const limits = limitsFromWire({ hardCalls: 1 });
    expect(admitSend(sql, DAY, limits).allowed).toBe(true);
    expect(admitSend(sql, DAY, limits)).toMatchObject({ allowed: false, calls: 1, alert: 'stop' });
    expect(admitSend(sql, DAY, limits)).toMatchObject({ allowed: false, alert: null });
    expect(admitSend(sql, '2026-11-27', limits)).toMatchObject({ allowed: true, calls: 1 });
  });

  it('adds gas once per transaction, crosses the gas budget and then the gas hard stop', () => {
    const limits = limitsFromWire({ gasWei: '100', hardGasWei: '150' });
    admitSend(sql, DAY, limits);
    expect(recordSpend(sql, DAY, tx(1), 60n, limits)).toMatchObject({ gasWei: '60', alert: null });
    expect(recordSpend(sql, DAY, tx(1), 60n, limits)).toMatchObject({ gasWei: '60', alert: null });
    expect(recordSpend(sql, DAY, tx(2), 60n, limits)).toMatchObject({ gasWei: '120', alert: 'budget' });
    expect(admitSend(sql, DAY, limits).allowed).toBe(true);
    recordSpend(sql, DAY, tx(3), 40n, limits);
    expect(admitSend(sql, DAY, limits)).toMatchObject({ allowed: false, gasWei: '160' });
  });

  it('keeps gas past 2^53 exactly', () => {
    const limits = limitsFromWire({});
    recordSpend(sql, DAY, tx(1), 9_007_199_254_740_993n, limits);
    expect(recordSpend(sql, DAY, tx(2), 2n, limits).gasWei).toBe('9007199254740995');
  });

  it('sweeps days older than 35 and spent hashes older than two', () => {
    recordSpend(sql, '2026-10-01', tx(9), 5n, limitsFromWire({}));
    admitSend(sql, DAY, limitsFromWire({}));
    expect(sql.exec('SELECT day FROM days').toArray().map((r) => r.day)).toEqual([DAY]);
    expect(sql.exec('SELECT tx FROM spent').toArray()).toEqual([]);
  });
});

describe('the limits from KEY_BUDGETS', () => {
  it('reads a role, drops what is malformed, and is null for a role absent or bad JSON', () => {
    const env = { KEY_BUDGETS: JSON.stringify({ relayer: { calls: 10, gasWei: '5', hardCalls: -1, hardGasWei: '1e18' } }) };
    expect(budgetLimitsOf(env, 'relayer')).toEqual({ calls: 10, gasWei: '5' });
    expect(budgetLimitsOf(env, 'registrar')).toBeNull();
    expect(budgetLimitsOf({ KEY_BUDGETS: '{' }, 'relayer')).toBeNull();
    expect(budgetLimitsOf({}, 'relayer')).toBeNull();
  });

  it("takes a receipt's L2 gas and Base's L1 fee", () => {
    expect(receiptGasWei({ gasUsed: 100n, effectiveGasPrice: 3n, l1Fee: 7n })).toBe(307n);
    expect(receiptGasWei({ gasUsed: 100n, effectiveGasPrice: 3n })).toBe(300n);
    expect(receiptGasWei({})).toBe(0n);
  });

  it('days are UTC', () => {
    expect(utcDay(Date.parse('2026-11-26T23:59:59-03:00'))).toBe('2026-11-27');
  });
});

describe('keyBudgetOf', () => {
  let warn: MockInstance;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  /** A namespace over one in-memory object per name, as the Durable Object runs it. */
  function namespace(fail = false) {
    const objects = new Map<string, BudgetSql>();
    const names: string[] = [];
    const ns = {
      idFromName: (name: string) => {
        names.push(name);
        return name;
      },
      get: (id: string) => {
        if (!objects.has(id)) {
          const sql = sqlite();
          migrateBudgetTables(sql);
          objects.set(id, sql);
        }
        const sql = objects.get(id)!;
        return {
          admit: (day: string, l: BudgetLimitsWire) => (fail ? Promise.reject(new Error('boom 0xsecret')) : Promise.resolve(admitSend(sql, day, limitsFromWire(l)))),
          spend: (day: string, t: string, g: string, l: BudgetLimitsWire) => Promise.resolve(recordSpend(sql, day, t, BigInt(g), limitsFromWire(l))),
        };
      },
    };
    return { ns, names };
  }

  it('is a no-op while unbound', async () => {
    const budget = keyBudgetOf({} as Env, 'relayer', 84532, ADDRESS);
    await expect(budget.admit()).resolves.toBe(true);
    await budget.spend(tx(1), 1n);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keys one object per role, chain and address, logs the crossing once, and refuses at the hard stop', async () => {
    const { ns, names } = namespace();
    const env = { KEY_BUDGET_DO: ns, KEY_BUDGETS: JSON.stringify({ registrar: { calls: 1, hardCalls: 2 } }) } as unknown as Env;
    const budget = keyBudgetOf(env, 'registrar', 84532, ADDRESS, () => Date.parse(`${DAY}T12:00:00Z`));
    expect(await budget.admit()).toBe(true);
    expect(await budget.admit()).toBe(true);
    expect(await budget.admit()).toBe(false);
    expect(names[0]).toBe(`registrar:84532:${ADDRESS.toLowerCase()}`);
    const events = warn.mock.calls.map((c) => (JSON.parse(String(c[0])) as { event: string }).event);
    expect(events).toEqual(['key_budget_crossed', 'key_budget_stopped']);
  });

  it('fails open when the object does not answer, logging the error by name only', async () => {
    const { ns } = namespace(true);
    const budget = keyBudgetOf({ KEY_BUDGET_DO: ns } as unknown as Env, 'relayer', 8453, ADDRESS);
    await expect(budget.admit()).resolves.toBe(true);
    const line = String(warn.mock.calls[0]![0]);
    expect(JSON.parse(line)).toMatchObject({ event: 'key_budget_unavailable', step: 'admit', error: 'Error' });
    expect(line).not.toContain('0xsecret');
  });
});
