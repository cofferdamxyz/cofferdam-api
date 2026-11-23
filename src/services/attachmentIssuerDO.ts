// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `AttachmentIssuerDO` — one SQLite-backed Durable Object (named `issuer`) that makes and keeps the attachment
 * issuer's keys per epoch (`attachments/issuerKeys.ts`, workspace decision 0093): each private key only wrapped under
 * the secret `ATTACHMENT_KEY_WRAP`. A request for an epoch it has not made yet makes it once, whoever asks first;
 * epochs whose tokens are dead are dropped.
 */

import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env.js';
import { liveEpochs } from './attachments/classes.js';
import {
  IssuerKeysError,
  dropBefore,
  generateEpochKeys,
  importWrapKey,
  migrateIssuerTables,
  wrapKeyId,
  readEpoch,
  writeEpoch,
  type StoredClassKey,
} from './attachments/issuerKeys.js';

export class AttachmentIssuerDO extends DurableObject<Env> {
  private readonly making = new Map<number, Promise<StoredClassKey[]>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      migrateIssuerTables(this.ctx.storage.sql);
    });
  }

  private secret(): string {
    const secret = this.env.ATTACHMENT_KEY_WRAP;
    // A thrown error crosses RPC as a plain Error with its message: the route logs that message.
    if (!secret) throw new IssuerKeysError('ATTACHMENT_KEY_WRAP is not set in the issuer object');
    return secret;
  }

  /** The epoch's wrapped keys under the current wrap key, made now if this is the first ask (or the key was replaced). */
  async epochKeys(epoch: number): Promise<StoredClassKey[]> {
    if (!Number.isInteger(epoch) || epoch < 0) throw new IssuerKeysError(`invalid epoch ${epoch}`);
    const secret = this.secret();
    const wrapId = await wrapKeyId(secret);
    const stored = readEpoch(this.ctx.storage.sql, epoch, wrapId);
    if (stored) return stored;
    let pending = this.making.get(epoch);
    if (!pending) {
      pending = (async () => {
        const keys = await generateEpochKeys(epoch, await importWrapKey(secret), wrapId);
        const kept = this.ctx.storage.transactionSync(() => writeEpoch(this.ctx.storage.sql, keys));
        dropBefore(this.ctx.storage.sql, Math.min(...liveEpochs(Date.now())));
        return kept;
      })().finally(() => this.making.delete(epoch));
      this.making.set(epoch, pending);
    }
    return pending;
  }

  /** The epoch's keys under the current wrap key if they exist; never makes them. */
  async storedEpoch(epoch: number): Promise<StoredClassKey[] | null> {
    return readEpoch(this.ctx.storage.sql, epoch, await wrapKeyId(this.secret()));
  }
}
