// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The database's state as the XMTP backend leaves it: whether its first boot
 * migrated the schema (workspace decision 0042, docs/runbooks/xmtp-backend.md).
 * The backend creates these tables in `public` on its first successful boot and
 * records each migration in `_sqlx_migrations`. Names and counts only: nothing
 * here reads a row of user data.
 *
 * Table presence comes from pg_class, which every role can read, so the check
 * works under the read-and-delete cleanup role too; the migrations table needs
 * SELECT, and a role without it reports `migrations: null`.
 */

import type { Query } from './run.js';

/** The tables of the backend-8.0.0-rc2 schema (two migrations, the last 20261012000000). */
export const BACKEND_TABLES = [
  '_sqlx_migrations',
  'allocation_boundary',
  'envelopes',
  'identifier_association',
  'push_cursor',
  'push_recipient',
  'push_subscription',
  'topic_watermark',
] as const;

/** What the hourly run deletes from; without them it skips instead of failing. */
export const CLEANUP_TABLES = ['envelopes', 'push_cursor'] as const;

export interface DatabaseHealth {
  /** Every backend table exists and every recorded migration succeeded. */
  ok: boolean;
  /** Backend tables not found in `public`. */
  missing: string[];
  /** `null` when `_sqlx_migrations` is missing or this role cannot read it. */
  migrations: { applied: number; latest: string | null; allSucceeded: boolean } | null;
  checkedAt: string;
}

export async function checkDatabase(query: Query, now: Date = new Date()): Promise<DatabaseHealth> {
  const present = await query(
    `SELECT c.relname AS name
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[])`,
    [[...BACKEND_TABLES]],
  );
  const found = new Set(present.map((r) => String(r.name)));
  const missing = BACKEND_TABLES.filter((t) => !found.has(t));

  let migrations: DatabaseHealth['migrations'] = null;
  if (found.has('_sqlx_migrations')) {
    try {
      const [row] = await query(
        `SELECT count(*)::int AS applied, max(version)::text AS latest, coalesce(bool_and(success), false) AS all_ok
           FROM _sqlx_migrations`,
        [],
      );
      migrations = {
        applied: Number(row?.applied ?? 0),
        latest: row?.latest == null ? null : String(row.latest),
        allSucceeded: row?.all_ok === true,
      };
    } catch {
      migrations = null; // no SELECT on the migrations table for this role
    }
  }

  return {
    ok: missing.length === 0 && migrations !== null && migrations.applied > 0 && migrations.allSucceeded,
    missing,
    migrations,
    checkedAt: now.toISOString(),
  };
}

/** The tables the cleanup needs that the check did not find. */
export function cleanupBlockedBy(health: DatabaseHealth, pushCursorGuard: boolean): string[] {
  return CLEANUP_TABLES.filter((t) => (t !== 'push_cursor' || pushCursorGuard) && health.missing.includes(t));
}
