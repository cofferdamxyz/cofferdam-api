// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `AttachmentQuotaDO` — one SQLite-backed Durable Object per account (`account:<address>`) and one plane-wide
 * (`plane:attachments`) behind `DurableQuotaStore` (`attachments/quotaStore.ts`): class bytes granted per UTC day,
 * nothing else. The SQL lives in `quotaStore.ts` so the tests can run it.
 */

import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env.js';
import { migrateQuotaTables, release, reserve, usedInWindow, type Reservation } from './attachments/quotaStore.js';

export class AttachmentQuotaDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      migrateQuotaTables(this.ctx.storage.sql);
    });
  }

  async reserve(day: string, bytes: number, limit: number, windowDays: number): Promise<Reservation> {
    return this.ctx.storage.transactionSync(() => reserve(this.ctx.storage.sql, day, bytes, limit, windowDays));
  }

  async release(day: string, bytes: number): Promise<void> {
    this.ctx.storage.transactionSync(() => release(this.ctx.storage.sql, day, bytes));
  }

  async used(day: string, windowDays: number): Promise<number> {
    return usedInWindow(this.ctx.storage.sql, day, windowDays);
  }
}
