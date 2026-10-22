// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The replay cache behind `csa1:` v2 proofs (workspace decision 0055): one
 * `PopReplayDO` per device key, named by the key's RFC 7638 thumbprint, that
 * remembers each value it has accepted until that value could no longer verify.
 *
 *   - `jti:<jti>` — a proof's identifier, for twice the proof's clock window.
 *   - `tok:<ath>` — a slow token's hash, until the token expires: a slow token
 *     opens one security-critical action, not one per proof.
 *
 * A Durable Object rather than KV because a replay must be refused at once,
 * everywhere: KV's propagation let a first device run poll for a minute in
 * decision 0010. This module holds the SQL and the store adapter; the class is
 * in `popReplayDO.ts` because it imports `cloudflare:workers`, which the route
 * tests cannot load. The tests run the same SQL on `node:sqlite`.
 */

import type { Env } from '../env.js';

/** The slice of `ctx.storage.sql` the cache uses. */
export interface ReplaySql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** Create the table. Idempotent. */
export function migrateReplayTable(sql: ReplaySql): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS seen (
       key TEXT PRIMARY KEY,
       expires_at INTEGER NOT NULL
     )`,
  );
}

/**
 * Record `key` until `expiresAt` (Unix ms). True when the key is new or its
 * previous record has lapsed; false when it is still remembered. Lapsed rows
 * are swept on the way, a bounded batch per call.
 */
export function claimOnce(sql: ReplaySql, key: string, expiresAt: number, now: number): boolean {
  sql.exec('DELETE FROM seen WHERE key IN (SELECT key FROM seen WHERE expires_at <= ? LIMIT 100)', now);
  const existing = sql.exec('SELECT expires_at FROM seen WHERE key = ?', key).toArray()[0];
  if (existing && Number(existing.expires_at) > now) return false;
  sql.exec(
    'INSERT INTO seen (key, expires_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at',
    key,
    expiresAt,
  );
  return true;
}

/** What the gate needs: claim a value for one device key, once. */
export interface ReplayStore {
  claim(jkt: string, key: string, expiresAt: number, now: number): Promise<boolean>;
}

/** The `POP_REPLAY_DO` namespace as a `ReplayStore`, or null when it is not bound. */
export function envReplayStore(env: Env): ReplayStore | null {
  const ns = env.POP_REPLAY_DO;
  if (!ns) return null;
  return {
    claim: (jkt, key, expiresAt, now) => ns.get(ns.idFromName(jkt)).claim(key, expiresAt, now),
  };
}
