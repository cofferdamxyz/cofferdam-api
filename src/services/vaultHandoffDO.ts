// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `VaultHandoffDO` — the device-link ceremony's one-shot relay (workspace
 * decision 0081, step 5; runbook `docs/runbooks/vault-build.md`), behind
 * `DurableHandoffStore`. One object per `keyHash` (the hash of the new phone's
 * X25519 handover key) and account, so no account can move another's alarm.
 *
 * The old phone puts the sealed roots once; the new phone takes them once.
 * Each account has its own slot (`slot:<account>`), so a take by another
 * account never reads this one's blob, and a put by another account never
 * blocks this one's. A take leaves a tombstone until the alarm so the second
 * take answers "taken" rather than "pending". SQLite-backed
 * (`new_sqlite_classes` in wrangler.jsonc). It holds opaque sealed bytes,
 * never a key: the blob opens only with the new phone's private key.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';

export interface HandoffEntry {
  /** The sealed blob, null once taken. */
  blob: Uint8Array | null;
  taken: boolean;
  /** Epoch milliseconds; the slot is gone (or answers as empty) from then on. */
  expiresAt: number;
}

export type HandoffTake = { status: 'ok'; blob: Uint8Array } | { status: 'pending' } | { status: 'taken' };

const slotKey = (account: string) => `slot:${account}`;

export class VaultHandoffDO extends DurableObject<Env> {
  /** Stores the account's blob, or answers `exists` when its slot is live or taken. */
  async put(account: string, blob: Uint8Array, expiresAt: number, now: number): Promise<'stored' | 'exists'> {
    const key = slotKey(account);
    const existing = await this.ctx.storage.get<HandoffEntry>(key);
    if (existing && existing.expiresAt > now) return 'exists';
    await this.ctx.storage.put(key, { blob, taken: false, expiresAt } satisfies HandoffEntry);
    // Another account's slot may hold a later alarm; never pull it earlier.
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm < expiresAt) await this.ctx.storage.setAlarm(expiresAt);
    return 'stored';
  }

  /** The blob once, then a tombstone; an empty or expired slot is `pending`. */
  async take(account: string, now: number): Promise<HandoffTake> {
    const key = slotKey(account);
    const entry = await this.ctx.storage.get<HandoffEntry>(key);
    if (!entry) return { status: 'pending' };
    // An alarm can fire late: the expiry is checked against the clock here too.
    if (entry.expiresAt <= now) {
      await this.ctx.storage.delete(key);
      return { status: 'pending' };
    }
    if (entry.taken || !entry.blob) return { status: 'taken' };
    // The tombstone keeps the expiry, and the alarm stays armed to delete it.
    await this.ctx.storage.put(key, { blob: null, taken: true, expiresAt: entry.expiresAt } satisfies HandoffEntry);
    return { status: 'ok', blob: entry.blob };
  }

  /** TTL: the object empties itself at the latest slot's expiry. */
  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
