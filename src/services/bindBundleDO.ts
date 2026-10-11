// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `BindBundleDO` — the per-account Durable Object behind `DurableBindStore`.
 *
 * Holds at most one pending bind bundle. `put` stores it and arms an alarm at
 * `expiresAt`; `get` returns it while unexpired; `delete` and the alarm wipe
 * it. SQLite-backed (`new_sqlite_classes` in wrangler.jsonc) so storage is
 * the modern, free-tier-eligible flavour. No secrets: a bundle holds only
 * what becomes public at bind time.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';
import { BIND_BUNDLE_VERSION, type BindBundle } from './selfBind.js';

const KEY = 'bundle';

export class BindBundleDO extends DurableObject<Env> {
  async put(bundle: BindBundle): Promise<void> {
    await this.ctx.storage.put(KEY, bundle);
    await this.ctx.storage.setAlarm(bundle.expiresAt);
  }

  async get(): Promise<BindBundle | null> {
    const bundle = await this.ctx.storage.get<BindBundle>(KEY);
    if (!bundle) return null;
    if (bundle.version !== BIND_BUNDLE_VERSION || bundle.expiresAt <= Date.now()) {
      await this.ctx.storage.deleteAll();
      return null;
    }
    return bundle;
  }

  async delete(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  /** TTL: the object empties itself when the bundle expires. */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
