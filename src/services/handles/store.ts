// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The handle registry's reads, the share links and the hold lapse over D1
 * `cofferdam-handles-sepolia` until the MVP cut (`HANDLES_DB`, `migrations/handles/`; workspace decision
 * 0086, rule 4). The claim, the hold and the handle-scoped writes are not
 * built here: they wait on the SDK's typed data, the anchor, device
 * attestation and device sync (runbook step 3).
 *
 * The answers are pure functions of a row and the time (`resolutionOf`,
 * `availabilityOf`), so the routes and the tests read the same rules.
 */

import { getAddress } from 'viem';

/** How long a released label stays unclaimable (rule 3; enforced on chain, mirrored here): 0086's 365 days. */
export const QUARANTINE_MS = 365 * 24 * 60 * 60 * 1000;
/** The most share links alive at once (about 525 MB of ciphertext): past it an upload is refused, and the registry's own tables keep their room. */
export const SHARE_LINK_CEILING = 250_000;

/**
 * The quarantine the anchor this plane mirrors enforces: `HANDLES_QUARANTINE_DAYS`
 * when it is a whole number of days, else 365. Runbook step 2 deploys the
 * anchor with short delays on Base Sepolia so the release device tests finish
 * in a session; the variable follows that deployment's value.
 */
export function quarantineMs(raw: string | undefined): number {
  const days = raw && /^\d{1,4}$/.test(raw.trim()) ? Number(raw.trim()) : null;
  return days === null ? QUARANTINE_MS : days * 24 * 60 * 60 * 1000;
}
/** How long the hold log keeps a row after it ends: the 30-day limits read it (q20), plus a day. */
export const HOLD_LOG_RETENTION_MS = 31 * 24 * 60 * 60 * 1000;

export type HandleState = 'held' | 'active' | 'releasing' | 'quarantined' | 'reserved';

export interface HandleRow {
  label: string;
  handleId: string;
  identity: string;
  state: HandleState;
  serial: number | null;
  owner: string | null;
  metaAddress: string | null;
  onchain: boolean;
  discoverable: boolean;
  inboxId: string | null;
  heldUntil: number | null;
  releasedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** What `GET /v1/handles/:label` answers for a label that resolves. */
export interface Resolution {
  label: string;
  handleId: string;
  serial: number;
  /** The pinned handle key, EIP-55. */
  owner: string;
  /** Scheme 1: spending key then viewing key, compressed, 66 bytes in hex. */
  metaAddress: string;
  schemeId: 1;
  /**
   * False while the anchor's claim is queued for the relay: the owner and the
   * meta-address are the pending ones, which no client can check yet
   * (0086 q22 (ruled 2026-11-19 as recommended)). True once the anchor holds the record; the client
   * still checks every field against it (rule 5).
   */
  onChain: boolean;
}

/**
 * A row as a payer may see it, or null when the label must answer as absent:
 * no row, a held label (0086 q20 (ruled 2026-11-19 as recommended): resolves to nothing), a releasing
 * label (0086 q13 (ruled 2026-11-19 as recommended): resolves to nothing, so no payer derives to it),
 * a quarantined or reserved one. Discovery does not matter here: payment
 * resolution works with it off (rule 6).
 */
export function resolutionOf(row: HandleRow | null): Resolution | null {
  if (!row || row.state !== 'active') return null;
  if (row.serial == null || !row.owner || !row.metaAddress) return null;
  return {
    label: row.label,
    handleId: row.handleId,
    serial: row.serial,
    owner: getAddress(row.owner),
    metaAddress: row.metaAddress,
    schemeId: 1,
    // 0086 q22 (ruled 2026-11-19 as recommended): a queued claim answers its pending owner, marked unchecked.
    onChain: row.onchain,
  };
}

export type Availability = { available: true } | { available: false; reason: 'taken' | 'reserved' };

/**
 * Whether a stored-form label may be claimed or held now. A held label is
 * taken until its hold lapses (0086 q20 (ruled 2026-11-19 as recommended)); a releasing label is
 * taken (its old owner still holds it on chain); a quarantined one is taken
 * until 365 days after its release (rule 3). The 30-day block on the same
 * identity re-holding a label it let lapse is the held route's, not this
 * unauthenticated answer's.
 */
export function availabilityOf(row: HandleRow | null, reserved: boolean, now: number, quarantine = QUARANTINE_MS): Availability {
  if (reserved) return { available: false, reason: 'reserved' };
  if (!row) return { available: true };
  switch (row.state) {
    case 'held':
      return row.heldUntil != null && row.heldUntil > now ? { available: false, reason: 'taken' } : { available: true };
    case 'quarantined':
      return row.releasedAt != null && row.releasedAt + quarantine <= now ? { available: true } : { available: false, reason: 'taken' };
    case 'reserved':
      return { available: false, reason: 'reserved' };
    case 'active':
    case 'releasing':
      return { available: false, reason: 'taken' };
  }
}

export interface HandleStore {
  /** The row of a stored-form label, or null. */
  row(label: string): Promise<HandleRow | null>;
  /** Whether the label is on the reserved list. */
  reserved(label: string): Promise<boolean>;
  /** Store a share link's ciphertext under its token's hash: `taken` if that hash is, `full` past `SHARE_LINK_CEILING`. */
  putShareLink(tokenHash: string, ciphertext: Uint8Array, expiresAt: number): Promise<'stored' | 'taken' | 'full'>;
  /** Delete and return a share link's ciphertext if it has not expired: the first fetch is the only one. */
  takeShareLink(tokenHash: string, now: number): Promise<Uint8Array | null>;
  /** Housekeeping: expired share links, lapsed holds and old hold-log rows. Counts only. */
  sweep(now: number): Promise<{ links: number; holds: number; holdLog: number }>;
}

export interface Row {
  label: string;
  handle_id: string;
  identity: string;
  state: HandleState;
  serial: number | null;
  owner: string | null;
  meta_address: string | null;
  onchain: number;
  discoverable: number;
  inbox_id: string | null;
  held_until: number | null;
  released_at: number | null;
  created_at: number;
  updated_at: number;
}

export function fromRow(r: Row): HandleRow {
  return {
    label: r.label,
    handleId: r.handle_id,
    identity: r.identity,
    state: r.state,
    serial: r.serial,
    owner: r.owner,
    metaAddress: r.meta_address,
    onchain: r.onchain === 1,
    discoverable: r.discoverable === 1,
    inboxId: r.inbox_id,
    heldUntil: r.held_until,
    releasedAt: r.released_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** D1 hands a BLOB back as an array of numbers, an ArrayBuffer or a typed array, by runtime. */
function toBytes(v: unknown): Uint8Array | null {
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v) && v.every((n) => typeof n === 'number')) return Uint8Array.from(v as number[]);
  return null;
}

export class D1HandleStore implements HandleStore {

  async row(label: string): Promise<HandleRow | null> {
    const r = await this.db.prepare('SELECT * FROM handles WHERE label = ?').bind(label).first<Row>();
    return r ? fromRow(r) : null;
  }

  async reserved(label: string): Promise<boolean> {
    return (await this.db.prepare('SELECT 1 AS hit FROM reserved_labels WHERE label = ?').bind(label).first<{ hit: number }>()) !== null;
  }

  constructor(
    private readonly db: D1Database,
    private readonly ceiling = SHARE_LINK_CEILING,
  ) {}

  async putShareLink(tokenHash: string, ciphertext: Uint8Array, expiresAt: number): Promise<'stored' | 'taken' | 'full'> {
    // The ceiling in the same statement, on the trigger-kept count: two uploads at once cannot both pass it by one.
    const { meta } = await this.db
      .prepare(
        `INSERT INTO share_links (token_hash, ciphertext, expires_at)
         SELECT ?1, ?2, ?3 WHERE (SELECT n FROM handles_counters WHERE name = 'share_links') < ?4
         ON CONFLICT (token_hash) DO NOTHING`,
      )
      .bind(tokenHash, ciphertext, expiresAt, this.ceiling)
      .run();
    if (meta.changes > 0) return 'stored';
    const live = await this.db.prepare("SELECT n FROM handles_counters WHERE name = 'share_links'").first<{ n: number }>();
    return live && live.n >= this.ceiling ? 'full' : 'taken';
  }

  async takeShareLink(tokenHash: string, now: number): Promise<Uint8Array | null> {
    // One statement: two fetches at once cannot both read it. An expired row is deleted too, and answers nothing.
    const r = await this.db
      .prepare('DELETE FROM share_links WHERE token_hash = ? RETURNING ciphertext, expires_at')
      .bind(tokenHash)
      .first<{ ciphertext: unknown; expires_at: number }>();
    if (!r || r.expires_at <= now) return null;
    return toBytes(r.ciphertext);
  }

  async sweep(now: number): Promise<{ links: number; holds: number; holdLog: number }> {
    // 0086 q20 (ruled 2026-11-19 as recommended): a hold lapses after its 14 days; its row goes, its log row records the lapse.
    const [links, , holds, holdLog] = await this.db.batch([
      this.db.prepare('DELETE FROM share_links WHERE expires_at <= ?').bind(now),
      this.db
        .prepare(
          `UPDATE handle_holds SET ended_at = ?1, outcome = 'lapsed'
           WHERE outcome IS NULL AND held_until <= ?1`,
        )
        .bind(now),
      this.db.prepare("DELETE FROM handles WHERE state = 'held' AND held_until <= ?").bind(now),
      this.db.prepare('DELETE FROM handle_holds WHERE ended_at IS NOT NULL AND ended_at <= ?').bind(now - HOLD_LOG_RETENTION_MS),
    ]);
    const changes = (r: D1Result | undefined) => Number(r?.meta?.changes ?? 0);
    return { links: changes(links), holds: changes(holds), holdLog: changes(holdLog) };
  }
}
