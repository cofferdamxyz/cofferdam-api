// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A D1 database for the Work tests, on `node:sqlite` in memory with the real
 * migrations of `migrations/work/` applied, so the stores run their own SQL.
 * Only the slice the stores use: `prepare().bind()` with `first`, `all` and
 * `run`, and `batch` in one transaction.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

const MIGRATIONS = join(__dirname, '..', '..', '..', 'migrations', 'work');

export function workMigrations(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'));
}

export interface SqliteD1 {
  d1: D1Database;
  sqlite: DatabaseSync;
  /** Every statement prepared, in order, for asserting what reached the database. */
  statements: string[];
}

export function sqliteD1(migrations: string[] = workMigrations()): SqliteD1 {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const m of migrations) sqlite.exec(m);
  const statements: string[] = [];

  function statement(query: string, params: SQLInputValue[] = []) {
    const stmt = {
      bind(...values: unknown[]) {
        return statement(query, values.map((v) => (typeof v === 'boolean' ? Number(v) : v)) as SQLInputValue[]);
      },
      async first<T>(column?: string): Promise<T | null> {
        statements.push(query);
        const row = sqlite.prepare(query).get(...params) as Record<string, unknown> | undefined;
        if (!row) return null;
        return (column ? row[column] : row) as T;
      },
      async all<T>() {
        statements.push(query);
        return { results: sqlite.prepare(query).all(...params) as T[], success: true, meta: {} };
      },
      async run() {
        statements.push(query);
        const r = sqlite.prepare(query).run(...params);
        return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
    };
    return stmt;
  }

  const d1 = {
    prepare: (query: string) => statement(query),
    async batch(stmts: { run(): Promise<unknown> }[]) {
      sqlite.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        sqlite.exec('COMMIT');
        return out;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  };
  return { d1: d1 as unknown as D1Database, sqlite, statements };
}
