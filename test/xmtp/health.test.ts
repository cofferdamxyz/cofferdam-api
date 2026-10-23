// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { BACKEND_TABLES, checkDatabase, cleanupBlockedBy } from '../../xmtp/cleanup/src/health.js';
import type { Query } from '../../xmtp/cleanup/src/run.js';

const NOW = new Date('2026-10-23T13:30:00Z');

/** A fake database: the tables it has, and what `_sqlx_migrations` answers (or throws). */
function fakeDb(tables: readonly string[], migrations?: Record<string, unknown> | Error): Query {
  return async (text) => {
    if (text.includes('pg_catalog.pg_class')) return tables.map((name) => ({ name }));
    if (text.includes('FROM _sqlx_migrations')) {
      if (migrations instanceof Error) throw migrations;
      return [migrations ?? { applied: 0, latest: null, all_ok: false }];
    }
    throw new Error(`unexpected query: ${text}`);
  };
}

describe('checkDatabase', () => {
  it('is ok when every backend table exists and the migrations succeeded', async () => {
    const health = await checkDatabase(
      fakeDb(BACKEND_TABLES, { applied: 2, latest: '20261012000000', all_ok: true }),
      NOW,
    );
    expect(health).toEqual({
      ok: true,
      missing: [],
      migrations: { applied: 2, latest: '20261012000000', allSucceeded: true },
      checkedAt: '2026-10-23T13:30:00.000Z',
    });
  });

  it('lists every table and reports no migrations on an empty database', async () => {
    const health = await checkDatabase(fakeDb([]), NOW);
    expect(health.ok).toBe(false);
    expect(health.missing).toEqual([...BACKEND_TABLES]);
    expect(health.migrations).toBeNull();
  });

  it('is not ok when a migration failed', async () => {
    const health = await checkDatabase(fakeDb(BACKEND_TABLES, { applied: 2, latest: '20261012000000', all_ok: false }), NOW);
    expect(health.ok).toBe(false);
    expect(health.migrations?.allSucceeded).toBe(false);
  });

  it('reports migrations as unknown when the role cannot read them', async () => {
    const health = await checkDatabase(fakeDb(BACKEND_TABLES, new Error('permission denied for table _sqlx_migrations')), NOW);
    expect(health.missing).toEqual([]);
    expect(health.migrations).toBeNull();
    expect(health.ok).toBe(false);
  });
});

describe('cleanupBlockedBy', () => {
  it('blocks the run until envelopes and push_cursor exist', async () => {
    const empty = await checkDatabase(fakeDb([]), NOW);
    expect(cleanupBlockedBy(empty, true)).toEqual(['envelopes', 'push_cursor']);
    expect(cleanupBlockedBy(empty, false)).toEqual(['envelopes']);
    const migrated = await checkDatabase(fakeDb(BACKEND_TABLES, { applied: 2, latest: '20261012000000', all_ok: true }), NOW);
    expect(cleanupBlockedBy(migrated, true)).toEqual([]);
  });
});

/**
 * Read-only against a real migrated database, opt-in:
 *   XMTP_HEALTH_PG_URL=postgres://localhost/xmtp yarn vitest run test/xmtp/health.test.ts
 */
const LIVE = process.env.XMTP_HEALTH_PG_URL;
describe.skipIf(!LIVE)('checkDatabase on a real database', () => {
  it('finds the backend schema', async () => {
    const client = new pg.Client({ connectionString: LIVE });
    await client.connect();
    try {
      const health = await checkDatabase(async (text, params) => (await client.query<Record<string, unknown>>(text, params)).rows);
      expect(health.missing).toEqual([]);
      expect(health.ok).toBe(true);
    } finally {
      await client.end();
    }
  });
});
