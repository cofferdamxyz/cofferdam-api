// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The attachment issuer's keys, made per epoch (workspace decision 0093, rule 4; 30-day epochs, the founder's ruling
 * of 2026-11-23). `AttachmentIssuerDO` makes one RSA-PSS 2048-bit key per size class when an epoch first needs them,
 * keeps each private key only wrapped (AES-256-GCM under the secret `ATTACHMENT_KEY_WRAP`, bound to its epoch and
 * class), and hands the wrapped keys and the public keys to the route, which unwraps them in memory and imports them
 * as non-extractable `RSA-RAW` keys. Rotation is therefore automatic, and the one secret never changes.
 *
 * The SQL and the key work live here so the tests run them in Node; the class is `attachmentIssuerDO.ts`.
 */

import { ATTACHMENT_CLASSES } from './classes.js';

export interface StoredClassKey {
  epoch: number;
  class: number;
  /** Which wrap key it is under (`wrapKeyId`): a set under a replaced key is made again. */
  wrapId: string;
  /** base64: a 12-byte nonce, then the AES-GCM ciphertext of the PKCS#8 private key. */
  wrapped: string;
  /** base64url modulus and exponent of the public key (JWK `n`, `e`). */
  n: string;
  e: string;
}

export class IssuerKeysError extends Error {
  override readonly name = 'IssuerKeysError';
}

const RSA_PSS = { name: 'RSA-PSS', hash: 'SHA-384' } as const;
const F4 = new Uint8Array([1, 0, 1]);

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const aad = (epoch: number, c: number) => new TextEncoder().encode(`cofferdam-attachments-issuer:${epoch}:${c}`);

/** A short id of the wrap secret (16 hex of its SHA-256), never the secret: which key a stored set is under. */
export async function wrapKeyId(secret: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cofferdam-attachments-wrap-id:${secret.trim()}`)));
  return Array.from(d.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The wrap key from the secret `ATTACHMENT_KEY_WRAP` (base64 of 32 bytes); an error naming the problem, never the key. */
export async function importWrapKey(secret: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = fromBase64(secret.trim());
  } catch {
    throw new IssuerKeysError('ATTACHMENT_KEY_WRAP is not base64');
  }
  if (raw.length !== 32) throw new IssuerKeysError('ATTACHMENT_KEY_WRAP must be 32 bytes');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** One epoch's keys, one per class, wrapped under the key `wrapId` names. */
export async function generateEpochKeys(epoch: number, wrapKey: CryptoKey, wrapId: string): Promise<StoredClassKey[]> {
  const out: StoredClassKey[] = [];
  for (let c = 0; c < ATTACHMENT_CLASSES.length; c++) {
    const pair = (await crypto.subtle.generateKey({ ...RSA_PSS, modulusLength: 2048, publicExponent: F4 }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(epoch, c) }, wrapKey, pkcs8));
    pkcs8.fill(0);
    const { n, e } = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
    const wrapped = new Uint8Array(iv.length + ct.length);
    wrapped.set(iv);
    wrapped.set(ct, iv.length);
    out.push({ epoch, class: c, wrapId, wrapped: toBase64(wrapped), n: n!, e: e! });
  }
  return out;
}

/** A class key's PKCS#8 bytes; the caller zeroes them once imported. */
export async function unwrapClassKey(key: StoredClassKey, wrapKey: CryptoKey): Promise<Uint8Array> {
  const wrapped = fromBase64(key.wrapped);
  try {
    const pkcs8 = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: wrapped.slice(0, 12), additionalData: aad(key.epoch, key.class) },
      wrapKey,
      wrapped.slice(12),
    );
    return new Uint8Array(pkcs8);
  } catch {
    throw new IssuerKeysError(`epoch ${key.epoch} class ${key.class} does not unwrap under ATTACHMENT_KEY_WRAP`);
  }
}

// ── the object's SQL ────────────────────────────────────────────────────────

export interface IssuerSql {
  exec(query: string, ...bindings: (string | number)[]): { toArray(): Record<string, unknown>[] };
}

export function migrateIssuerTables(sql: IssuerSql): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS class_keys (
       epoch INTEGER NOT NULL,
       class INTEGER NOT NULL,
       wrap_id TEXT NOT NULL,
       wrapped TEXT NOT NULL,
       n TEXT NOT NULL,
       e TEXT NOT NULL,
       PRIMARY KEY (epoch, class)
     )`,
  );
}

/**
 * An epoch's keys in class order under the wrap key `wrapId` names, or null until every class has one under it. A set
 * under another wrap key (the secret was replaced) reads as missing, so the object makes the epoch again: its public
 * keys change and the tokens of the old set no longer verify (the runbook's Attachment tokens says so).
 */
export function readEpoch(sql: IssuerSql, epoch: number, wrapId: string): StoredClassKey[] | null {
  const rows = sql.exec('SELECT epoch, class, wrap_id, wrapped, n, e FROM class_keys WHERE epoch = ? AND wrap_id = ? ORDER BY class', epoch, wrapId).toArray();
  if (rows.length !== ATTACHMENT_CLASSES.length) return null;
  return rows.map((r) => ({
    epoch: Number(r.epoch),
    class: Number(r.class),
    wrapId: String(r.wrap_id),
    wrapped: String(r.wrapped),
    n: String(r.n),
    e: String(r.e),
  }));
}

/** Writes an epoch's keys unless it has a set under the same wrap key; returns what is stored, so makers agree on one set. */
export function writeEpoch(sql: IssuerSql, keys: StoredClassKey[]): StoredClassKey[] {
  const { epoch, wrapId } = keys[0]!;
  const existing = readEpoch(sql, epoch, wrapId);
  if (existing) return existing;
  sql.exec('DELETE FROM class_keys WHERE epoch = ?', epoch);
  for (const k of keys) {
    sql.exec('INSERT INTO class_keys (epoch, class, wrap_id, wrapped, n, e) VALUES (?, ?, ?, ?, ?, ?)', k.epoch, k.class, k.wrapId, k.wrapped, k.n, k.e);
  }
  return keys;
}

/** Drops epochs older than `keepFrom`: their tokens are dead, so their keys are of no use. */
export function dropBefore(sql: IssuerSql, keepFrom: number): void {
  sql.exec('DELETE FROM class_keys WHERE epoch < ?', keepFrom);
}
