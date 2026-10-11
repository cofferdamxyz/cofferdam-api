// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bind-bundle hand-off store (decision 0010).
 *
 * The first device run showed why Workers KV is the wrong shape for this
 * hand-off: Self's relayer writes the bundle from a US colo, the phone reads
 * from its own, KV propagates in up to a minute and caches negative lookups,
 * so the app had to poll for minutes. A Durable Object per account is
 * strongly consistent and globally addressed: the write is visible to the
 * next read anywhere, and the object's alarm enforces the TTL.
 *
 * This module holds the store interface and the DO-backed adapter; the DO
 * class itself lives in `bindBundleDO.ts` (it imports `cloudflare:workers`,
 * which the route tests cannot load) and is exported from the Worker entry.
 */

import type { Address } from 'viem';
import type { BindBundle } from './selfBind.js';
import type { BindBundleDO } from './bindBundleDO.js';

export interface BundleStore {
  put(bundle: BindBundle): Promise<void>;
  get(account: Address): Promise<BindBundle | null>;
  delete(account: Address): Promise<void>;
}

/** One Durable Object per account, named by the lower-cased address. */
export class DurableBindStore implements BundleStore {
  constructor(private readonly namespace: DurableObjectNamespace<BindBundleDO>) {}

  private stub(account: Address) {
    return this.namespace.getByName(account.toLowerCase());
  }

  async put(bundle: BindBundle): Promise<void> {
    await this.stub(bundle.account).put(bundle);
  }

  async get(account: Address): Promise<BindBundle | null> {
    // The RPC stub types the structured-cloned result with widened tuples
    // (and a Disposable mixin); the wire value is the bundle as stored.
    const bundle = await this.stub(account).get();
    return (bundle as unknown as BindBundle | null) ?? null;
  }

  async delete(account: Address): Promise<void> {
    await this.stub(account).delete();
  }
}
