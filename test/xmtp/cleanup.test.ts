// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { configFrom } from '../../xmtp/cleanup/src/index.js';
import { fingerprint, runCleanup, type CleanupConfig, type Query } from '../../xmtp/cleanup/src/run.js';
import { keyPackageBatch, sequentialBatch } from '../../xmtp/cleanup/src/sql.js';

const CFG: CleanupConfig = {
  retention: { groupMessageS: 2592000, welcomeS: 7776000, keyPackageS: 7776000 },
  graceS: 604800,
  marginS: 3600,
  batch: 2,
  budgetMs: 45_000,
  pushCursorGuard: true,
};

describe('the SQL', () => {
  it('keeps every rule of the design in every statement', () => {
    for (const sql of [sequentialBatch(true), keyPackageBatch(true)]) {
      expect(sql).toContain('expiry_ns IS NOT NULL');
      expect(sql).toContain('is_commit_or_proposal = false');
      expect(sql).toContain('clock_timestamp()');
      expect(sql).toContain('push_cursor');
      expect(sql).toContain('SKIP LOCKED');
    }
    expect(keyPackageBatch(true)).toContain("'\\x03'::bytea");
    expect(keyPackageBatch(true)).toContain('max(k.sequence_id)');
    expect(sequentialBatch(false)).not.toContain('push_cursor');
  });
});

describe('a run', () => {
  /** A fake database: per-kind queues of rows the next query "deletes". */
  function fake(batches: Record<string, { sequence_id: string; settled: boolean }[][]>) {
    const seen: unknown[][] = [];
    const query: Query = async (text, params) => {
      seen.push(params);
      const kind = text.includes("'\\x03'") ? 'kp' : String(params[0]);
      return (batches[kind]?.shift() ?? []) as Record<string, unknown>[];
    };
    return { query, seen };
  }

  it('advances each resume point only past settled rows', async () => {
    const db = fake({
      '0': [
        [
          { sequence_id: '5', settled: true },
          { sequence_id: '9', settled: true },
        ],
        [{ sequence_id: '12', settled: false }],
      ],
      '1': [[{ sequence_id: '7', settled: true }]],
      kp: [[{ sequence_id: '3', settled: true }]],
    });
    const report = await runCleanup(db.query, CFG, null);
    expect(report.deleted).toEqual({ groupMessages: 3, welcomes: 1, keyPackages: 1 });
    expect(report.state.resume).toEqual({ '0': '9', '1': '7' });
    // The second group batch started from the first batch's settled maximum.
    expect(db.seen[1]![1]).toBe('9');
    expect(db.seen[0]![2]).toBe((604800n * 1_000_000_000n).toString());
  });

  it('starts over when retention changes', async () => {
    const db = fake({});
    const old = { fingerprint: 'v1:1:2:3', resume: { '0': '99999' } };
    await runCleanup(db.query, CFG, old);
    expect(db.seen[0]![1]).toBe('0');
    const kept = { fingerprint: fingerprint(CFG), resume: { '0': '99999' } };
    const db2 = fake({});
    await runCleanup(db2.query, CFG, kept);
    expect(db2.seen[0]![1]).toBe('99999');
  });

  it('stops when the time budget is spent', async () => {
    let t = 0;
    const query: Query = async () => {
      t += 20_000;
      return [
        { sequence_id: String(t), settled: true },
        { sequence_id: String(t + 1), settled: true },
      ];
    };
    const report = await runCleanup(query, CFG, null, () => t);
    expect(report.timedOut).toBe(true);
  });

  it('reads its configuration from the Worker vars', () => {
    const cfg = configFrom({
      RETENTION_GROUP_MESSAGE_SECONDS: '2592000',
      RETENTION_WELCOME_SECONDS: '7776000',
      RETENTION_KEY_PACKAGE_SECONDS: '7776000',
    } as never);
    expect(cfg.graceS).toBe(604800);
    expect(cfg.batch).toBe(5000);
    expect(cfg.pushCursorGuard).toBe(true);
    expect(() => configFrom({ RETENTION_GROUP_MESSAGE_SECONDS: '0' } as never)).toThrow(/RETENTION/);
  });
});

/**
 * Against the real XMTP schema: XMTP_CLEANUP_PG_URL=postgres://…/xmtp_cleanup_test
 * pointing at a database the backend has migrated (start xmtp-backend on it once).
 * The database name must end in `_test`: the test empties `envelopes`.
 */
const LIVE = process.env.XMTP_CLEANUP_PG_URL;
describe.skipIf(!LIVE)('against the XMTP schema (live)', () => {
  it('deletes exactly the rows the rules allow', async () => {
    const { Client } = await import('pg');
    const url = new URL(LIVE!);
    expect(url.pathname.endsWith('_test')).toBe(true);
    const db = new Client({ connectionString: LIVE });
    await db.connect();
    try {
      const nowNs = BigInt(Date.now()) * 1_000_000n;
      const day = 86_400n * 1_000_000_000n;
      await db.query('TRUNCATE envelopes');
      const rows: [number, number, bigint | null, boolean, string][] = [
        // id, kind, expiry (null = permanent), commit?, label
        [1, 0, nowNs - 40n * day, false, 'old message: delete'],
        [2, 0, nowNs - 40n * day, true, 'old commit: keep'],
        [3, 2, null, false, 'identity update: keep'],
        [4, 1, nowNs - 10n * day, false, 'old welcome: delete'],
        [5, 0, nowNs - 3n * day, false, 'expired inside the grace: keep'],
        [6, 3, nowNs - 30n * day, false, 'superseded key package: delete'],
        [7, 3, nowNs - 20n * day, false, 'newest key package of its topic: keep'],
        [8, 0, nowNs + 10n * day, false, 'not expired: keep'],
        [9, 4, null, false, 'commit-log entry: keep'],
        [10, 0, nowNs - 40n * day, false, 'above the push cursor: keep'],
      ];
      for (const [id, kind, expiry, commit] of rows) {
        const topic = Buffer.from([kind, ...new Array(16).fill(kind === 3 ? 3 : id)]);
        const hash = Buffer.alloc(32, id);
        await db.query(
          `INSERT INTO envelopes (sequence_id, topic, server_ns, expiry_ns, message_hash, is_commit_or_proposal, payload, push_eligible)
           VALUES ($1, $2, $3, $4, $5, $6, '\\x00', false)`,
          [id, topic, (nowNs - 100n * day).toString(), expiry?.toString() ?? null, hash, commit],
        );
      }
      await db.query('UPDATE push_cursor SET sequence_id = 9 WHERE singleton');
      const report = await runCleanup(
        async (text, params) => (await db.query(text, params)).rows,
        { ...CFG, batch: 5000 },
        null,
      );
      const left = (await db.query('SELECT sequence_id::int AS id FROM envelopes ORDER BY 1')).rows.map((r) => r.id);
      expect(left).toEqual([2, 3, 5, 7, 8, 9, 10]);
      expect(report.deleted).toEqual({ groupMessages: 1, welcomes: 1, keyPackages: 1 });
      expect(report.state.resume).toEqual({ '0': '1', '1': '4' });
    } finally {
      await db.query('TRUNCATE envelopes');
      await db.end();
    }
  });
});
