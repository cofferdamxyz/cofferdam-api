// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The handover relay's store (workspace decision 0081, step 5): the interface
 * the Vault routes call and the Durable Object adapter. The class itself lives
 * in `vaultHandoffDO.ts`, because it imports `cloudflare:workers`, which the
 * route tests cannot load; it is exported from the Worker entry.
 *
 * A Durable Object, not KV, for the reason `bundleStore.ts` gives: the new
 * phone's take must see the old phone's put at once, from any colo.
 */

import type { Env } from '../env.js';
import type { HandoffTake, VaultHandoffDO } from './vaultHandoffDO.js';

export type { HandoffTake } from './vaultHandoffDO.js';

export interface HandoffStore {
  /** `account` is the lower-cased attested address; `exists` when its slot already holds a put. */
  put(keyHash: string, account: string, blob: Uint8Array, expiresAt: number, now: number): Promise<'stored' | 'exists'>;
  take(keyHash: string, account: string, now: number): Promise<HandoffTake>;
}

/**
 * One Durable Object per `keyHash` and account, so one account's put can never move another's alarm or keep its
 * slot past its ten minutes, and another account's take reaches an object that holds nothing.
 */
export class DurableHandoffStore implements HandoffStore {
  constructor(private readonly namespace: DurableObjectNamespace<VaultHandoffDO>) {}

  async put(keyHash: string, account: string, blob: Uint8Array, expiresAt: number, now: number): Promise<'stored' | 'exists'> {
    const answer = await this.namespace.getByName(`${keyHash}:${account}`).put(account, blob, expiresAt, now);
    return answer as 'stored' | 'exists';
  }

  async take(keyHash: string, account: string, now: number): Promise<HandoffTake> {
    // The RPC stub types the structured-cloned result with a Disposable mixin;
    // the wire value is the answer as the object returned it.
    const answer = await this.namespace.getByName(`${keyHash}:${account}`).take(account, now);
    return answer as unknown as HandoffTake;
  }
}

/** The relay behind `VAULT_HANDOFF_DO`, or null when it is not bound. */
export function envHandoffStore(env: Env): HandoffStore | null {
  return env.VAULT_HANDOFF_DO ? new DurableHandoffStore(env.VAULT_HANDOFF_DO) : null;
}
