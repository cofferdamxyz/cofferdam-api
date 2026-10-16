// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The plane's own record of token transfers, fed by a Coinbase Developer
 * Platform onchain webhook (`onchain.activity.detected`, filtered to the
 * token contract and its `Transfer` event; workspace decision 0032).
 *
 * One `ActivityDO` per (chain, address) holds that address's transfers. The
 * webhook writes each transfer to its sender and its recipient; `/v1/activity`
 * reads the store first and only scans RPC for blocks older than
 * `ACTIVITY_INDEX_FROM_BLOCK`, the block at which the subscription started.
 *
 * Pure apart from the injected namespace: signature checks and payload
 * parsing are tested directly; the Durable Object class lives in
 * `activityDO.ts` because it imports `cloudflare:workers`.
 */

import type { ActivityDO } from './activityDO.js';

/** One stored transfer; `value` is a decimal string of raw token units. */
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
 * is not a `Transfer` of `tokenFor(chainId)` on a known network. Accepts the
 * event at the top level or under `data`.
 */
export function parseCdpTransfer(
  event: unknown,
  tokenFor: (chainId: number) => string | null,
): ParsedTransfer | null {
  if (!event || typeof event !== 'object') return null;
  const outer = event as Record<string, unknown>;
  const e = (outer.data && typeof outer.data === 'object' ? outer.data : outer) as Record<string, unknown>;

  const chainId = CDP_NETWORKS[String(e.network ?? '')];
  if (!chainId) return null;
  const token = tokenFor(chainId);
  const contract = String(e.contract_address ?? '').toLowerCase();
  if (!token || contract !== token.toLowerCase()) return null;
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

// ── Store ────────────────────────────────────────────────────────────────────

export interface ActivityStore {
  /** Returns whether the transfer was new (deliveries are at-least-once). */
  record(chainId: number, address: string, t: StoredTransfer): Promise<boolean>;
  /** Newest first, at most `limit`, optionally at or below `toBlock`. */
  list(chainId: number, address: string, limit: number, toBlock: number | null): Promise<StoredTransfer[]>;
  /** Highest block recorded for the address, or 0. */
  latestBlock(chainId: number, address: string): Promise<number>;
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

  async list(chainId: number, address: string, limit: number, toBlock: number | null): Promise<StoredTransfer[]> {
    return (await this.stub(chainId, address).list(limit, toBlock)) as StoredTransfer[];
  }

  latestBlock(chainId: number, address: string): Promise<number> {
    return this.stub(chainId, address).latestBlock();
  }
}
