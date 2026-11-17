// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/** `HANDLES_DB` for the tests: node:sqlite in memory with the real `migrations/handles/` applied (`sqliteD1`). */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sqliteD1, type SqliteD1 } from '../work/d1.js';

const MIGRATIONS = join(__dirname, '..', '..', '..', 'migrations', 'handles');

export function handlesMigrations(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'));
}

export function handlesD1(): SqliteD1 {
  return sqliteD1(handlesMigrations());
}

/** A row in the stored form the registry writes, active and on chain unless told otherwise. */
export function insertHandle(db: SqliteD1, over: Partial<Record<string, unknown>> & { label: string; handle_id: string }): void {
  const row: Record<string, unknown> = {
    identity: `id-${over.label}`,
    state: 'active',
    serial: 1,
    owner: '0x' + '11'.repeat(20),
    meta_address: '0x02' + 'aa'.repeat(32) + '03' + 'bb'.repeat(32),
    onchain: 1,
    discoverable: 0,
    inbox_id: null,
    held_until: null,
    released_at: null,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
  const keys = Object.keys(row);
  db.sqlite.prepare(`INSERT INTO handles (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...(keys.map((k) => row[k]) as never[]));
}
