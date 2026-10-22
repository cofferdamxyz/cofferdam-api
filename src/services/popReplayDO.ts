// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `PopReplayDO` — one SQLite-backed Durable Object per device key behind
 * `envReplayStore` (`popReplayStore.ts`): the values a `csa1:` v2 proof or slow
 * token may use only once (workspace decision 0055). Holds no account data,
 * only proof identifiers and token hashes with their expiry.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { claimOnce, migrateReplayTable } from './popReplayStore.js';

export class PopReplayDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrateReplayTable(this.ctx.storage.sql);
    });
  }

  /** True the first time `key` is claimed before `expiresAt`; false on a replay. */
  async claim(key: string, expiresAt: number, now: number): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => claimOnce(this.ctx.storage.sql, key, expiresAt, now));
  }
}
