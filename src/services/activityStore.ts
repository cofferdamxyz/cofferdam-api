// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The plane's own record of token transfers, fed by a Coinbase Developer
 * Platform onchain webhook (`onchain.activity.detected`, filtered to the
 * token contract and its `Transfer` event; workspace decision 0032).
 *
 * One `ActivityDO` per (chain, address) holds that address's transfers of
 * every webhook-fed token, each row naming its token; reads filter by token, so
 * one token's transfers never answer for another's. The webhook writes each
 * transfer to its sender and its recipient; `/v1/activity` reads the store
 * first, for a webhook-fed token only (`ACTIVITY_TOKENS` in `activity.ts`), and
 * only scans RPC for blocks older than `ACTIVITY_INDEX_FROM_BLOCK`, the block
 * at which the subscription started.
 *
 * Pure apart from the injected namespace: signature checks, payload parsing
 * and the object's SQL are tested directly (the SQL on `node:sqlite`); the
 * Durable Object class lives in `activityDO.ts` because it imports
 * `cloudflare:workers`.
 */

import type { ActivityDO } from './activityDO.js';

/** One stored transfer; `value` is a decimal string of raw token units, `token` the contract, lower-case. */
export interface StoredTransfer {
  hash: string;
  logIndex: number;
  blockNumber: number;
  timestamp: number;
  from: string;
  to: string;
  value: string;
  token: string;
}

/** CDP network label to chain id. */
export const CDP_NETWORKS: Record<string, number> = {
  'base-sepolia': 84532,
  'base-mainnet': 8453,
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

// ── Signature (Hook0 `X-Hook0-Signature`, scheme v0) ─────────────────────────

/** Deliveries older or newer than this are refused (replay window). */
export const SIGNATURE_MAX_AGE_SECONDS = 300;

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Verify a CDP webhook delivery. The header reads `t=…,v0=…,h=…,v1=…`; `v0` is
 * HMAC-SHA256 (hex) of `{t}.{rawBody}` keyed with the subscription's
 * `metadata.secret`. The raw body must be the exact bytes received.
 */
export async function verifyCdpSignature(
  rawBody: string,
  header: string | undefined | null,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header || !secret) return false;
  const fields = new Map<string, string>();
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i > 0) fields.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  const t = fields.get('t');
  const v0 = fields.get('v0');
  if (!t || !v0 || !/^\d+$/.test(t)) return false;
  if (Math.abs(nowSeconds - Number(t)) > SIGNATURE_MAX_AGE_SECONDS) return false;
  const provided = hexToBytes(v0);
  if (!provided) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${rawBody}`)));
  return timingSafeEqual(mac, provided);
}

// ── Payload ──────────────────────────────────────────────────────────────────

export interface ParsedTransfer {
  chainId: number;
  transfer: StoredTransfer;
}

function toRawUnits(v: unknown): string | null {
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v).toString();
  // JSON numbers above 2^53 lose precision; refuse them rather than store a wrong amount.
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v).toString();
  return null;
}

function toSeconds(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e11 ? Math.floor(v / 1000) : Math.floor(v);
  if (typeof v === 'string') {
    if (/^\d+$/.test(v)) return toSeconds(Number(v));
    const ms = Date.parse(v);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return 0;
}

/**
 * Decode one `onchain.activity.detected` event into a transfer, or null when it
 * is not a `Transfer` of a token `isStoredToken` accepts on a known network
 * (the route passes `isWebhookFedToken`). Accepts the event at the top level or
 * under `data`.
 */
export function parseCdpTransfer(
  event: unknown,
  isStoredToken: (chainId: number, contract: string) => boolean,
): ParsedTransfer | null {
  if (!event || typeof event !== 'object') return null;
  const outer = event as Record<string, unknown>;
  const e = (outer.data && typeof outer.data === 'object' ? outer.data : outer) as Record<string, unknown>;

  const chainId = CDP_NETWORKS[String(e.network ?? '')];
  if (!chainId) return null;
  const contract = String(e.contract_address ?? '').toLowerCase();
  if (!ADDRESS.test(contract) || !isStoredToken(chainId, contract)) return null;
  if (e.event_name !== 'Transfer') return null;

  const p = (e.parameters ?? {}) as Record<string, unknown>;
  const from = String(p.from ?? '');
  const to = String(p.to ?? '');
  const hash = String(e.transaction_hash ?? '');
  const value = toRawUnits(p.value);
  const blockNumber = Number(e.block_number);
  const logIndex = Number(e.log_index);
  if (!ADDRESS.test(from) || !ADDRESS.test(to) || !TX_HASH.test(hash) || value == null) return null;
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0 || !Number.isSafeInteger(logIndex) || logIndex < 0) return null;

  return {
    chainId,
    transfer: {
      hash: hash.toLowerCase(),
      logIndex,
      blockNumber,
      timestamp: toSeconds(e.timestamp),
      from: from.toLowerCase(),
      to: to.toLowerCase(),
      value,
      token: contract,
    },
  };
}

/** The addresses whose records a transfer belongs to (a mint has no sender record). */
export function recordAddresses(t: StoredTransfer): string[] {
  const out = new Set<string>([t.to]);
  if (t.from !== ZERO_ADDRESS) out.add(t.from);
  return [...out];
}

// ── The object's SQL ─────────────────────────────────────────────────────────

/** The slice of `ctx.storage.sql` the record uses. */
export interface ActivitySql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** Rows returned by one `list` call. */
export const MAX_LIST = 100;

/** Create the table and its indexes. Idempotent; rows written before tokens were filtered keep serving. */
export function migrateActivityTable(sql: ActivitySql): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS transfers (
       id TEXT PRIMARY KEY,
       hash TEXT NOT NULL,
       log_index INTEGER NOT NULL,
       block INTEGER NOT NULL,
       ts INTEGER NOT NULL,
       from_addr TEXT NOT NULL,
       to_addr TEXT NOT NULL,
       value TEXT NOT NULL,
       token TEXT NOT NULL
     )`,
  );
  sql.exec('CREATE INDEX IF NOT EXISTS transfers_by_block ON transfers (block DESC, log_index DESC)');
  sql.exec('CREATE INDEX IF NOT EXISTS transfers_by_token_block ON transfers (token, block DESC, log_index DESC)');
}

/**
 * Insert a transfer once; the key `{hash}:{logIndex}` dedupes at-least-once
 * deliveries. Returns whether it was new (the object runs one call at a time,
 * so the read and the insert cannot interleave).
 */
export function insertTransfer(sql: ActivitySql, t: StoredTransfer): boolean {
  const id = `${t.hash}:${t.logIndex}`;
  if (sql.exec('SELECT 1 AS x FROM transfers WHERE id = ?', id).toArray().length > 0) return false;
  sql.exec(
    `INSERT OR IGNORE INTO transfers (id, hash, log_index, block, ts, from_addr, to_addr, value, token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    t.hash,
    t.logIndex,
    t.blockNumber,
    t.timestamp,
    t.from,
    t.to,
    t.value,
    t.token.toLowerCase(),
  );
  return true;
}

/** One token's transfers, newest first, at most `limit` (capped at `MAX_LIST`), optionally at or below `toBlock`. */
export function listTransfers(sql: ActivitySql, token: string, limit: number, toBlock: number | null): StoredTransfer[] {
  const n = Math.min(Math.max(1, Math.floor(limit)), MAX_LIST);
  const t = token.toLowerCase();
  const rows = toBlock == null
    ? sql.exec('SELECT * FROM transfers WHERE token = ? ORDER BY block DESC, log_index DESC LIMIT ?', t, n)
    : sql.exec('SELECT * FROM transfers WHERE token = ? AND block <= ? ORDER BY block DESC, log_index DESC LIMIT ?', t, toBlock, n);
  return rows.toArray().map((r) => ({
    hash: String(r.hash),
    logIndex: Number(r.log_index),
    blockNumber: Number(r.block),
    timestamp: Number(r.ts),
    from: String(r.from_addr),
    to: String(r.to_addr),
    value: String(r.value),
    token: String(r.token),
  }));
}

/** Highest block recorded for one token, or 0. */
export function latestTransferBlock(sql: ActivitySql, token: string): number {
  const row = sql.exec('SELECT MAX(block) AS b FROM transfers WHERE token = ?', token.toLowerCase()).toArray()[0];
  return row?.b == null ? 0 : Number(row.b);
}

// ── Store ────────────────────────────────────────────────────────────────────

export interface ActivityStore {
  /** Returns whether the transfer was new (deliveries are at-least-once). */
  record(chainId: number, address: string, t: StoredTransfer): Promise<boolean>;
  /** One token's transfers, newest first, at most `limit`, optionally at or below `toBlock`. */
  list(chainId: number, address: string, token: string, limit: number, toBlock: number | null): Promise<StoredTransfer[]>;
  /** Highest block recorded for the address and token, or 0. */
  latestBlock(chainId: number, address: string, token: string): Promise<number>;
}

/** One Durable Object per (chain, address), named `{chainId}:{address}`. */
export class DurableActivityStore implements ActivityStore {
  constructor(private readonly namespace: DurableObjectNamespace<ActivityDO>) {}

  private stub(chainId: number, address: string) {
    return this.namespace.getByName(`${chainId}:${address.toLowerCase()}`);
  }

  record(chainId: number, address: string, t: StoredTransfer): Promise<boolean> {
    return this.stub(chainId, address).record(t);
  }

  async list(chainId: number, address: string, token: string, limit: number, toBlock: number | null): Promise<StoredTransfer[]> {
    return (await this.stub(chainId, address).list(token, limit, toBlock)) as StoredTransfer[];
  }

  latestBlock(chainId: number, address: string, token: string): Promise<number> {
    return this.stub(chainId, address).latestBlock(token);
  }
}
