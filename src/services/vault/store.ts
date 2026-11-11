// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Vault mirror's store (workspace decision 0081, item 4; runbook
 * `docs/runbooks/vault-build.md`, step 4): opaque sealed bytes under one
 * account's prefix in the R2 bucket `cofferdam-vault`, bound as `VAULT`. The
 * plane never holds a key or a plaintext; it puts, reads, lists and deletes
 * bytes it cannot open.
 *
 * `VaultStore` is the seam the routes use, so the tests run on
 * `MemoryVaultStore`, which checks a `sha256` the way R2 does and throws the
 * same error shape for a mismatch.
 */

/** An object's facts, without its bytes. */
export interface VaultObjectInfo {
  key: string;
  size: number;
  /** R2's `httpEtag` (quoted). */
  etag: string;
  uploaded: Date;
}

/** An object with its bytes, streamed. */
export interface VaultObjectBody extends VaultObjectInfo {
  body: ReadableStream<Uint8Array>;
}

export interface VaultListPage {
  objects: VaultObjectInfo[];
  /** Present when more objects follow; pass it back to read them. */
  cursor?: string;
}

export interface VaultPutOptions {
  /** Hex SHA-256 the store checks the bytes against (`R2PutOptions.sha256`). */
  sha256?: string;
}

export interface VaultStore {
  /**
   * Store `body` under `key`. A `ReadableStream` must come with a known length
   * (a request body with `content-length`): R2 refuses a stream without one.
   */
  put(key: string, body: ReadableStream<Uint8Array> | Uint8Array, opts?: VaultPutOptions): Promise<VaultObjectInfo>;
  get(key: string): Promise<VaultObjectBody | null>;
  head(key: string): Promise<VaultObjectInfo | null>;
  /** Delete up to `VAULT_PAGE` keys; a missing key is not an error. */
  delete(keys: string[]): Promise<void>;
  /** One page of up to `VAULT_PAGE` keys under `prefix`, in key order. */
  list(opts: { prefix: string; cursor?: string }): Promise<VaultListPage>;
}

/**
 * R2's error code for a checksum that does not match the bytes (`BadDigest`,
 * v4 code 10037). workerd rejects the `put` with an `R2Error` whose `code` is
 * this number and whose message reads `put: The SHA-256 checksum you specified
 * did not match what we received. … (10037)` (miniflare's `BadDigest` in
 * `dist/src/workers/r2/bucket.worker.js`, formatted by workerd's `r2-rpc.c++`
 * as `action: message (v4code)`).
 */
export const R2_BAD_DIGEST = 10037;

/** Whether `err` is R2's refusal of a `put` whose checksum did not match. */
export function isChecksumMismatch(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code === R2_BAD_DIGEST) return true;
  return typeof message === 'string' && message.endsWith(`(${R2_BAD_DIGEST})`);
}

/** The most keys one R2 `list` answers and one `delete` takes. */
export const VAULT_PAGE = 1_000;

function info(o: R2Object): VaultObjectInfo {
  return { key: o.key, size: o.size, etag: o.httpEtag, uploaded: o.uploaded };
}

/** The store over the `VAULT` R2 binding. */
export function r2VaultStore(bucket: R2Bucket): VaultStore {
  return {
    async put(key, body, opts) {
      const o = await bucket.put(key, body, opts?.sha256 ? { sha256: opts.sha256 } : undefined);
      return info(o);
    },
    async get(key) {
      const o = await bucket.get(key);
      return o ? { ...info(o), body: o.body as ReadableStream<Uint8Array> } : null;
    },
    async head(key) {
      const o = await bucket.head(key);
      return o ? info(o) : null;
    },
    async delete(keys) {
      if (keys.length) await bucket.delete(keys);
    },
    async list({ prefix, cursor }) {
      const page = await bucket.list({ prefix, cursor, limit: VAULT_PAGE });
      return { objects: page.objects.map(info), ...(page.truncated ? { cursor: page.cursor } : {}) };
    },
  };
}

/** The store `VAULT` gives the routes, or null when the bucket is not bound. */
export function envVaultStore(env: { VAULT?: R2Bucket }): VaultStore | null {
  return env.VAULT ? r2VaultStore(env.VAULT) : null;
}
