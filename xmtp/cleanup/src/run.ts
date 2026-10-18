// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One cleanup run: loop batches per kind until a batch comes back short or the
 * time budget is spent (Hyperdrive caps a query at 60 s; a run stays under 45 s).
 * Pure over an injected `query`, so the tests drive it against fakes and the
 * M0 runbook drives it against a real Postgres.
 */

import { KIND_GROUP_MESSAGE, KIND_WELCOME, keyPackageBatch, sequentialBatch } from './sql.js';

export type Query = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

export interface CleanupConfig {
  /** Mirrors backend.toml [retention]; a change resets the resume points. */
  retention: { groupMessageS: number; welcomeS: number; keyPackageS: number };
  graceS: number;
  /** How far behind the cutoff a row must be before the resume point passes it. */
  marginS: number;
  batch: number;
  budgetMs: number;
  /** Off only when the backend runs without [push]: its cursor then never moves. */
  pushCursorGuard: boolean;
}

export interface CleanupState {
  fingerprint: string;
  /** Per kind, the highest sequence id below which nothing deletable remains. */
  resume: Record<string, string>;
}

export interface RunReport {
  deleted: { groupMessages: number; welcomes: number; keyPackages: number };
  state: CleanupState;
  timedOut: boolean;
}

export function fingerprint(cfg: CleanupConfig): string {
  const r = cfg.retention;
  return `v1:${r.groupMessageS}:${r.welcomeS}:${r.keyPackageS}`;
}

const NS = 1_000_000_000n;

export async function runCleanup(
  query: Query,
  cfg: CleanupConfig,
  previous: CleanupState | null,
  now: () => number = Date.now,
): Promise<RunReport> {
  const started = now();
  const fp = fingerprint(cfg);
  const state: CleanupState =
    previous && previous.fingerprint === fp
      ? { fingerprint: fp, resume: { ...previous.resume } }
      : { fingerprint: fp, resume: {} };
  const deleted = { groupMessages: 0, welcomes: 0, keyPackages: 0 };
  const grace = (BigInt(cfg.graceS) * NS).toString();
  const margin = (BigInt(cfg.marginS) * NS).toString();
  const outOfTime = () => now() - started > cfg.budgetMs;
  let timedOut = false;

  const seq = sequentialBatch(cfg.pushCursorGuard);
  for (const [kind, key] of [
    [KIND_GROUP_MESSAGE, 'groupMessages'],
    [KIND_WELCOME, 'welcomes'],
  ] as const) {
    for (;;) {
      if (outOfTime()) {
        timedOut = true;
        break;
      }
      const resume = state.resume[String(kind)] ?? '0';
      const rows = await query(seq, [kind, resume, grace, cfg.batch, margin]);
      deleted[key] += rows.length;
      let next = BigInt(resume);
      for (const row of rows) {
        const id = BigInt(String(row.sequence_id));
        if (row.settled === true && id > next) next = id;
      }
      state.resume[String(kind)] = next.toString();
      if (rows.length < cfg.batch) break;
    }
  }

  const kp = keyPackageBatch(cfg.pushCursorGuard);
  for (;;) {
    if (outOfTime()) {
      timedOut = true;
      break;
    }
    const rows = await query(kp, [grace, cfg.batch]);
    deleted.keyPackages += rows.length;
    if (rows.length < cfg.batch) break;
  }

  return { deleted, state, timedOut };
}
