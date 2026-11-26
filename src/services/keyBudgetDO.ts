// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `KeyBudgetDO`: one SQLite-backed Durable Object per hot key, role and chain
 * (`relayer:84532:0x…`), the key's daily budget (workspace decision 0090 item
 * 11; `keyBudgetStore.ts` holds the SQL and the client). Holds counts, gas and
 * transaction hashes of the plane's own key, never a user's data.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { admitSend, limitsFromWire, migrateBudgetTables, recordSpend, type AdmitResult, type BudgetLimitsWire, type SpendResult } from './keyBudgetStore.js';

export class KeyBudgetDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      migrateBudgetTables(this.ctx.storage.sql);
    });
  }

  /** Refuse at the hard stop, else count the send. */
  async admit(day: string, limits: BudgetLimitsWire): Promise<AdmitResult> {
    return this.ctx.storage.transactionSync(() => admitSend(this.ctx.storage.sql, day, limitsFromWire(limits)));
  }

  /** Add a receipt's gas, once per transaction. */
  async spend(day: string, tx: string, gasWei: string, limits: BudgetLimitsWire): Promise<SpendResult> {
    const gas = /^\d{1,40}$/.test(gasWei) ? BigInt(gasWei) : 0n;
    return this.ctx.storage.transactionSync(() => recordSpend(this.ctx.storage.sql, day, tx, gas, limitsFromWire(limits)));
  }
}
