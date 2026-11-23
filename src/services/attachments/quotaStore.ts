// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The attachment quota (workspace decision 0093, rules 2 to 4): one Durable Object per account holding class bytes
 * granted per UTC day, and nothing else (no token, no digest, no conversation, no time finer than the day); and one
 * plane-wide object (`plane:attachments`) holding the day's total for the ceiling. A grant is reserved before any
 * token is signed and given back when signing fails, in one transaction per object.
 *
 * The SQL lives here so the tests run it on `node:sqlite`; the class is `attachmentQuotaDO.ts`, since it imports
 * `cloudflare:workers` (the split `chatUsageStore.ts` uses).
 */

import type { Address } from 'viem';

import { windowStart } from './classes.js';
import type { AttachmentQuotaDO } from '../attachmentQuotaDO.js';

export const GLOBAL_QUOTA_NAME = 'plane:attachments';
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** The slice of `ctx.storage.sql` the quota uses; the tests pass `node:sqlite` behind the same shape. */
export interface QuotaSql {
  exec(query: string, ...bindings: (string | number)[]): { toArray(): Record<string, unknown>[] };
}

export interface Reservation {
  ok: boolean;
  /** Class bytes granted in the window, this reservation included when it was taken. */
  used: number;
}

export function migrateQuotaTables(sql: QuotaSql): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, bytes INTEGER NOT NULL DEFAULT 0)`);
}

function checkDay(day: string): void {
  if (!DAY.test(day)) throw new Error(`invalid day ${day}`);
}

/** Class bytes granted from the window's first day to `day`; days before the window are dropped. */
export function usedInWindow(sql: QuotaSql, day: string, windowDays: number): number {
  checkDay(day);
  const start = windowStart(day, windowDays);
  sql.exec('DELETE FROM days WHERE day < ?', start);
  const row = sql.exec('SELECT COALESCE(SUM(bytes), 0) AS used FROM days WHERE day >= ? AND day <= ?', start, day).toArray()[0];
  return Number(row?.used ?? 0);
}

/** Takes `bytes` on `day` when the window stays within `limit`; the caller runs it in one transaction. */
export function reserve(sql: QuotaSql, day: string, bytes: number, limit: number, windowDays: number): Reservation {
  if (!Number.isInteger(bytes) || bytes <= 0) throw new Error('reservation must be a positive number of bytes');
  const used = usedInWindow(sql, day, windowDays);
  if (used + bytes > limit) return { ok: false, used };
  sql.exec(
    'INSERT INTO days (day, bytes) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET bytes = bytes + excluded.bytes',
    day,
    bytes,
  );
  return { ok: true, used: used + bytes };
}

/** Gives back what a reservation on `day` took, when its tokens could not be signed. Never below zero. */
export function release(sql: QuotaSql, day: string, bytes: number): void {
  checkDay(day);
  if (!Number.isInteger(bytes) || bytes <= 0) return;
  sql.exec('UPDATE days SET bytes = MAX(0, bytes - ?) WHERE day = ?', bytes, day);
}

/** The quota as the route uses it: an account's window and the plane-wide day. */
export interface QuotaStore {
  reserve(account: Address, day: string, bytes: number, limit: number, windowDays: number): Promise<Reservation>;
  release(account: Address, day: string, bytes: number): Promise<void>;
  used(account: Address, day: string, windowDays: number): Promise<number>;
  reserveGlobal(day: string, bytes: number, ceiling: number): Promise<Reservation>;
  releaseGlobal(day: string, bytes: number): Promise<void>;
}

/** One object per account, named by the lower-cased address; the plane-wide one by `GLOBAL_QUOTA_NAME`. */
export class DurableQuotaStore implements QuotaStore {
  constructor(private readonly namespace: DurableObjectNamespace<AttachmentQuotaDO>) {}

  private account(account: Address) {
    return this.namespace.getByName(`account:${account.toLowerCase()}`);
  }

  private global() {
    return this.namespace.getByName(GLOBAL_QUOTA_NAME);
  }

  async reserve(account: Address, day: string, bytes: number, limit: number, windowDays: number): Promise<Reservation> {
    return (await this.account(account).reserve(day, bytes, limit, windowDays)) as Reservation;
  }

  async release(account: Address, day: string, bytes: number): Promise<void> {
    await this.account(account).release(day, bytes);
  }

  async used(account: Address, day: string, windowDays: number): Promise<number> {
    return Number(await this.account(account).used(day, windowDays));
  }

  async reserveGlobal(day: string, bytes: number, ceiling: number): Promise<Reservation> {
    return (await this.global().reserve(day, bytes, ceiling, 1)) as Reservation;
  }

  async releaseGlobal(day: string, bytes: number): Promise<void> {
    await this.global().release(day, bytes);
  }
}
