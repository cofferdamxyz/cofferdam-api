// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The handle registry's writes over D1 `HANDLES_DB` (workspace decision 0086,
 * rules 3 to 7; migrations `0001_handles.sql` and `0002_claims.sql`): the
 * identity map's first table, holds and claims, discovery, the key history,
 * the watched addresses, renames and releases, the anchor relay's queue and the
 * freezes the registrar signed. Each write that touches more than one row is
 * one `batch`, so it lands whole or not at all: a claim that loses a race on the
 * label or on the identity's one active handle fails its insert, and the batch
 * rolls back (`RegistryConflict`).
 *
 * No account, IP or name is written: an account is kept only as its keyed tag
 * (`mapKey.ts`), and a watched address's secrets only sealed.
 */

import type { Address, Hex } from 'viem';

import { fromRow, type HandleRow, type Row } from './store.js';

/** A write that lost a race on a unique key: the label, the identity's one handle, an address. */
export class RegistryConflict extends Error {
  /** `taken`: a unique key (the label, the identity's one handle); `changed`: a batch guard (a row moved meanwhile). */
  constructor(readonly kind: 'taken' | 'changed' = 'taken') {
    super(`registry conflict: ${kind}`);
    this.name = 'RegistryConflict';
  }
}

function constraintKind(err: unknown): 'taken' | 'changed' | null {
  const m = err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}` : String(err);
  if (/CHECK constraint failed/i.test(m)) return 'changed';
  return /UNIQUE constraint failed|PRIMARY KEY|SQLITE_CONSTRAINT/i.test(m) ? 'taken' : null;
}

async function batchOrConflict(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
  try {
    await db.batch(stmts);
  } catch (err) {
    const kind = constraintKind(err);
    if (kind) throw new RegistryConflict(kind);
    throw err;
  }
}

/** A random identity id (rule 4): never an account, never a hash of a passport identifier. */
export function newIdentityId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return 'id_' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export type JobKind = 'claim' | 'release' | 'apply' | 'advance';
export type JobState = 'queued' | 'sent' | 'done' | 'failed' | 'cancelled';

export interface AnchorJob {
  id: number;
  kind: JobKind;
  handleId: Hex;
  args: Record<string, string>;
  notBefore: number;
  state: JobState;
  txHash: Hex | null;
  attempts: number;
  error: string | null;
  updatedAt: number;
}

interface JobRow {
  id: number;
  kind: JobKind;
  handle_id: string;
  args: string;
  not_before: number;
  state: JobState;
  tx_hash: string | null;
  attempts: number;
  error: string | null;
  updated_at: number;
}

const fromJob = (r: JobRow): AnchorJob => ({
  id: r.id,
  kind: r.kind,
  handleId: r.handle_id as Hex,
  args: JSON.parse(r.args) as Record<string, string>,
  notBefore: r.not_before,
  state: r.state,
  txHash: r.tx_hash as Hex | null,
  attempts: r.attempts,
  error: r.error,
  updatedAt: r.updated_at,
});

/** What a claim writes beside the row. */
export interface ClaimWrite {
  label: string;
  handleId: Hex;
  identity: string;
  installTag: string;
  serial: number;
  owner: Address;
  metaAddress: Hex;
  /** The owner's `OwnerClaim` signature, which the relay sends. */
  ownerClaimSignature: Hex;
  /** When the relay may send the claim. */
  relayAt: number;
  /** For a rename's claim, the old label's handle id: a claim that fails for good gives the old label back. */
  renameOf?: Hex;
  now: number;
  /** The quarantine in ms: a quarantined row released at least this long ago is replaced. */
  quarantineMs: number;
}

const lower = (s: string) => s.toLowerCase();

export class D1HandleRegistry {
  constructor(private readonly db: D1Database) {}

  // ── The identity map ───────────────────────────────────────────────────────

  async identityOf(accountTag: string): Promise<string | null> {
    const r = await this.db.prepare('SELECT identity FROM identity_accounts WHERE account_tag = ?').bind(accountTag).first<{ identity: string }>();
    return r?.identity ?? null;
  }

  /** The identity of an account's tag, minted on first use (rule 4). */
  async ensureIdentity(accountTag: string, now: number): Promise<string> {
    await this.db
      .prepare('INSERT INTO identity_accounts (account_tag, identity, created_at) VALUES (?, ?, ?) ON CONFLICT (account_tag) DO NOTHING')
      .bind(accountTag, newIdentityId(), now)
      .run();
    const id = await this.identityOf(accountTag);
    if (!id) throw new Error('identity not minted');
    return id;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** The identity's rows that are its own: held, active and releasing. */
  async rowsOf(identity: string): Promise<HandleRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM handles WHERE identity = ? AND state IN ('held', 'active', 'releasing') ORDER BY created_at")
      .bind(identity)
      .all<Row>();
    return results.map(fromRow);
  }

  async reserved(label: string): Promise<boolean> {
    return (await this.db.prepare('SELECT 1 AS hit FROM reserved_labels WHERE label = ?').bind(label).first<{ hit: number }>()) !== null;
  }

  async row(label: string): Promise<HandleRow | null> {
    const r = await this.db.prepare('SELECT * FROM handles WHERE label = ?').bind(label).first<Row>();
    return r ? fromRow(r) : null;
  }

  async rowById(handleId: string): Promise<HandleRow | null> {
    const r = await this.db.prepare('SELECT * FROM handles WHERE handle_id = ?').bind(handleId).first<Row>();
    return r ? fromRow(r) : null;
  }

  /** Discoverable active handles by prefix (rule 6): at most `limit`, label order. */
  async search(prefix: string, limit: number): Promise<{ label: string; inboxId: string }[]> {
    // The prefix is the stored grammar (a-z, 0-9, -), so it holds no LIKE wildcard; the range scan uses the partial index.
    const { results } = await this.db
      .prepare(
        `SELECT label, inbox_id FROM handles
         WHERE discoverable = 1 AND state = 'active' AND label >= ?1 AND label < ?1 || '{'
         ORDER BY label LIMIT ?2`,
      )
      .bind(prefix, limit)
      .all<{ label: string; inbox_id: string }>();
    return results.map((r) => ({ label: r.label, inboxId: r.inbox_id }));
  }

  // ── Nonces and limits ────────────────────────────────────────────────────

  /** Take a registry request's nonce once; false when it was seen. */
  async takeNonce(nonce: string, expiresAtMs: number): Promise<boolean> {
    const { meta } = await this.db
      .prepare('INSERT INTO registry_nonces (nonce, expires_at) VALUES (?, ?) ON CONFLICT (nonce) DO NOTHING')
      .bind(lower(nonce), expiresAtMs)
      .run();
    return Number(meta.changes) > 0;
  }

  async countEvents(by: 'identity' | 'install_tag', value: string, kinds: readonly ('claim' | 'rename' | 'release')[], since: number): Promise<number> {
    const r = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM handle_events WHERE ${by} = ? AND kind IN (${kinds.map(() => '?').join(', ')}) AND at >= ?`)
      .bind(value, ...kinds, since)
      .first<{ n: number }>();
    return Number(r?.n ?? 0);
  }

  async countHolds(by: 'identity' | 'install_tag', value: string, since: number): Promise<number> {
    const r = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM handle_holds WHERE ${by} = ? AND held_at >= ?`)
      .bind(value, since)
      .first<{ n: number }>();
    return Number(r?.n ?? 0);
  }

  /** Whether this identity or install let a hold of `label` lapse since `since` (q20's 30-day block). */
  async lapsedRecently(label: string, identity: string, installTag: string, since: number): Promise<boolean> {
    const r = await this.db
      .prepare(
        `SELECT 1 AS hit FROM handle_holds
         WHERE label = ? AND outcome = 'lapsed' AND ended_at >= ? AND (identity = ? OR install_tag = ?) LIMIT 1`,
      )
      .bind(label, since, identity, installTag)
      .first<{ hit: number }>();
    return r !== null;
  }

  // ── Holds (q20) ──────────────────────────────────────────────────────────

  /**
   * Hold `label` for `identity` until `heldUntil`. 0086 q20 (ruled 2026-11-19 as recommended): one
   * label per identity, so an earlier held label of the identity is let go
   * (its log row `released`); a lapsed hold of the label by anyone is cleared
   * first. A label with any other row is taken: `RegistryConflict`.
   */
  async hold(input: { label: string; handleId: Hex; identity: string; installTag: string; owner: Address; now: number; heldUntil: number }): Promise<void> {
    const { label, handleId, identity, installTag, owner, now, heldUntil } = input;
    const db = this.db;
    await batchOrConflict(db, [
      db.prepare(`UPDATE handle_holds SET ended_at = ?1, outcome = 'lapsed' WHERE outcome IS NULL AND label = ?2 AND held_until <= ?1`).bind(now, label),
      db.prepare("DELETE FROM handles WHERE label = ? AND state = 'held' AND held_until <= ?").bind(label, now),
      // The identity's earlier hold, of this label or another, gives way (a re-hold starts its 14 days again).
      db.prepare(`UPDATE handle_holds SET ended_at = ?1, outcome = 'released' WHERE outcome IS NULL AND identity = ?2`).bind(now, identity),
      db.prepare("DELETE FROM handles WHERE identity = ? AND state = 'held'").bind(identity),
      db
        .prepare(
          `INSERT INTO handles (label, handle_id, identity, state, serial, owner, meta_address, onchain, discoverable, held_until, created_at, updated_at)
           VALUES (?, ?, ?, 'held', NULL, ?, NULL, 0, 0, ?, ?, ?)`,
        )
        .bind(label, handleId, identity, lower(owner), heldUntil, now, now),
      db
        .prepare('INSERT INTO handle_holds (label, identity, install_tag, held_at, held_until) VALUES (?, ?, ?, ?, ?)')
        .bind(label, identity, installTag, now, heldUntil),
    ]);
  }

  // ── Claims ───────────────────────────────────────────────────────────────

  /** The statements that make `w` an active row, queued for the relay (shared by claim and rename). */
  private claimStatements(w: ClaimWrite): D1PreparedStatement[] {
    const db = this.db;
    return [
      // A lapsed hold of the label, this identity's own hold of it, or a quarantine that has ended, gives way.
      db.prepare(`UPDATE handle_holds SET ended_at = ?1, outcome = 'lapsed' WHERE outcome IS NULL AND label = ?2 AND held_until <= ?1`).bind(w.now, w.label),
      db
        .prepare(
          `DELETE FROM handles WHERE label = ?1 AND (
             (state = 'held' AND (held_until <= ?2 OR identity = ?3))
             OR (state = 'quarantined' AND released_at <= ?2 - ?4))`,
        )
        .bind(w.label, w.now, w.identity, w.quarantineMs),
      db
        .prepare(`UPDATE handle_holds SET ended_at = ?1, outcome = CASE WHEN label = ?3 THEN 'claimed' ELSE 'released' END WHERE outcome IS NULL AND identity = ?2`)
        .bind(w.now, w.identity, w.label),
      db.prepare("DELETE FROM handles WHERE identity = ? AND state = 'held'").bind(w.identity),
      db
        .prepare(
          `INSERT INTO handles (label, handle_id, identity, state, serial, owner, meta_address, onchain, discoverable, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?, 0, 0, ?, ?)`,
        )
        .bind(w.label, w.handleId, w.identity, w.serial, lower(w.owner), lower(w.metaAddress), w.now, w.now),
      this.historyStatement(w.identity, w.handleId, w.serial, w.owner, w.metaAddress, w.now),
      db.prepare("INSERT INTO handle_events (identity, install_tag, kind, at) VALUES (?, ?, 'claim', ?)").bind(w.identity, w.installTag, w.now),
      this.jobStatement(
        'claim',
        w.handleId,
        {
          owner: lower(w.owner),
          metaAddress: lower(w.metaAddress),
          serial: String(w.serial),
          ownerSig: w.ownerClaimSignature,
          ...(w.renameOf ? { renameOf: w.renameOf } : {}),
        },
        w.relayAt,
        w.now,
      ),
    ];
  }

  private historyStatement(identity: string, handleId: string, serial: number, owner: string, meta: string, now: number): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO handle_key_history (identity, handle_id, serial, owner, meta_address, added_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .bind(identity, handleId, serial, lower(owner), lower(meta), now);
  }

  private jobStatement(kind: JobKind, handleId: string, args: Record<string, string>, notBefore: number, now: number): D1PreparedStatement {
    return this.db
      .prepare(`INSERT INTO anchor_jobs (kind, handle_id, args, not_before, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)`)
      .bind(kind, handleId, JSON.stringify(args), notBefore, now, now);
  }

  /** Claim a label (rule 4): the row, the key history, the event and the relay's job, at once. */
  async claim(w: ClaimWrite): Promise<void> {
    await batchOrConflict(this.db, this.claimStatements(w));
  }

  /**
   * A rename (rule 7): the old row to `releasing` (resolving to nothing, never
   * discoverable; 0086 q13 (ruled 2026-11-19 as recommended)), the new label claimed, the old label's
   * `release` queued after its own delay.
   */
  async rename(input: {
    oldHandleId: Hex;
    claim: ClaimWrite;
    release: { owner: Address; deadline: string; ownerSig: Hex; relayAt: number };
  }): Promise<void> {
    const { oldHandleId, claim: w, release } = input;
    const db = this.db;
    await batchOrConflict(db, [
      db
        .prepare(`UPDATE handles SET state = 'releasing', discoverable = 0, inbox_id = NULL, updated_at = ? WHERE handle_id = ? AND identity = ? AND state = 'active'`)
        .bind(w.now, oldHandleId, w.identity),
      // The update must have hit (the old row is this identity's active one, not moved by a
      // concurrent release): the guard's CHECK fails otherwise and the whole batch rolls back.
      db.prepare('INSERT INTO batch_guard (ok) SELECT changes()'),
      db.prepare('DELETE FROM batch_guard'),
      db.prepare("INSERT INTO handle_events (identity, install_tag, kind, at) VALUES (?, ?, 'rename', ?)").bind(w.identity, w.installTag, w.now),
      ...this.claimStatements(w),
      // The old label's release waits for the new label's claim to land, whatever the delays drawn.
      this.jobStatement('release', oldHandleId, { owner: lower(release.owner), deadline: release.deadline, ownerSig: release.ownerSig, afterClaim: w.handleId }, release.relayAt, w.now),
    ]);
  }

  /** A release (rule 7, account deletion): the row to `releasing` and its `release` queued. */
  async release(input: { handleId: Hex; identity: string; installTag: string; owner: Address; deadline: string; ownerSig: Hex; relayAt: number; now: number }): Promise<void> {
    const db = this.db;
    await batchOrConflict(db, [
      db
        .prepare(`UPDATE handles SET state = 'releasing', discoverable = 0, inbox_id = NULL, updated_at = ? WHERE handle_id = ? AND identity = ? AND state IN ('active', 'releasing')`)
        .bind(input.now, input.handleId, input.identity),
      db.prepare(`UPDATE anchor_jobs SET state = 'cancelled', updated_at = ? WHERE handle_id = ? AND kind = 'release' AND state = 'queued'`).bind(input.now, input.handleId),
      db.prepare("INSERT INTO handle_events (identity, install_tag, kind, at) VALUES (?, ?, 'release', ?)").bind(input.identity, input.installTag, input.now),
      this.jobStatement('release', input.handleId, { owner: lower(input.owner), deadline: input.deadline, ownerSig: input.ownerSig }, input.relayAt, input.now),
    ]);
  }

  /** Whether a release of the label is queued or on its way to the anchor. */
  async releaseInFlight(handleId: string): Promise<boolean> {
    const r = await this.db
      .prepare(`SELECT 1 AS hit FROM anchor_jobs WHERE handle_id = ? AND kind IN ('release', 'apply') AND state IN ('queued', 'sent') LIMIT 1`)
      .bind(handleId)
      .first<{ hit: number }>();
    return r !== null;
  }

  // ── Discovery (rule 6) ───────────────────────────────────────────────────

  async setDiscoverable(handleId: string, identity: string, discoverable: boolean, inboxId: string | null, now: number): Promise<boolean> {
    const { meta } = await this.db
      .prepare(`UPDATE handles SET discoverable = ?, inbox_id = ?, updated_at = ? WHERE handle_id = ? AND identity = ? AND state = 'active'`)
      .bind(discoverable ? 1 : 0, discoverable ? inboxId : null, now, handleId, identity)
      .run();
    return Number(meta.changes) > 0;
  }

  // ── The advance (rule 3) ─────────────────────────────────────────────────

  /**
   * The row follows the anchor's owner and meta-address (an advance once mined,
   * an owner change applied on chain, the Safe's rekey), and the key history
   * keeps both, so `addresses` still accepts addresses of the earlier epoch.
   */
  async followOwner(row: HandleRow, owner: Address, metaAddress: Hex, now: number): Promise<void> {
    await this.db.batch(this.followStatements(row, owner, metaAddress, now));
  }

  /** A sent advance, settled by the relay: the row follows only once the transaction is mined. */
  async queueAdvance(
    handleId: string,
    args: { owner: string; metaAddress: string; releaseDeadline?: string; releaseSig?: string; releaseAt?: string; releaseAfterClaim?: string },
    txHash: Hex,
    now: number,
  ): Promise<void> {
    const stored = { ...args, owner: lower(args.owner), metaAddress: lower(args.metaAddress) };
    await this.db
      .prepare(`INSERT INTO anchor_jobs (kind, handle_id, args, not_before, state, tx_hash, created_at, updated_at) VALUES ('advance', ?, ?, ?, 'sent', ?, ?, ?)`)
      .bind(handleId, JSON.stringify(stored), now, txHash, now, now)
      .run();
  }

  /**
   * A mined advance: the row and the key history follow the new key, and a
   * releasing label's release, signed by the new key, is queued again (q13).
   */
  async settleAdvance(job: AnchorJob, now: number): Promise<void> {
    const row = await this.rowById(job.handleId);
    const stmts: D1PreparedStatement[] = [];
    if (row) {
      stmts.push(...this.followStatements(row, job.args.owner as Address, job.args.metaAddress as Hex, now));
      if (row.state === 'releasing' && job.args.releaseSig && job.args.releaseDeadline) {
        // The release keeps its rename's order and delay (`afterClaim`, `releaseAt`).
        stmts.push(
          ...this.requeueStatements(
            job.handleId,
            {
              owner: lower(job.args.owner!),
              deadline: job.args.releaseDeadline,
              ownerSig: job.args.releaseSig,
              ...(job.args.releaseAfterClaim ? { afterClaim: job.args.releaseAfterClaim } : {}),
            },
            Number(job.args.releaseAt ?? now),
            now,
          ),
        );
      }
    }
    stmts.push(this.jobDoneStatement(job.id, now));
    await this.db.batch(stmts);
  }

  /** Settle the sent advance with this transaction hash, whose receipt the route already read. */
  async settleAdvanceTx(handleId: string, txHash: Hex, now: number): Promise<void> {
    for (const job of await this.jobsOf(handleId)) {
      if (job.kind === 'advance' && job.state === 'sent' && job.txHash?.toLowerCase() === txHash.toLowerCase()) await this.settleAdvance(job, now);
    }
  }

  /**
   * A releasing label's queued release made stale by a registrar call that
   * raised the record's nonce (a hold, renewal, veto or unfreeze): requeued
   * with the owner's new signature (keeping a rename's `afterClaim` and its
   * time), or, without one, cancelled, so the relay does not spend its tries
   * and the user signs `/release` again.
   */
  async resignRelease(handleId: string, fresh: { owner: Address; deadline: string; ownerSig: Hex; relayAt: number } | null, now: number): Promise<void> {
    const queued = await this.queuedRelease(handleId);
    if (!queued) return;
    if (!fresh) {
      await this.db.prepare(`UPDATE anchor_jobs SET state = 'cancelled', error = 'resign', updated_at = ? WHERE id = ? AND state = 'queued'`).bind(now, queued.id).run();
      return;
    }
    const args: Record<string, string> = { owner: lower(fresh.owner), deadline: fresh.deadline, ownerSig: fresh.ownerSig };
    if (queued.args.afterClaim) args.afterClaim = queued.args.afterClaim;
    await this.db.batch(this.requeueStatements(handleId, args, Math.max(queued.notBefore, fresh.relayAt), now));
  }

  /** Whether an advance of the record is sent and not yet settled. */
  async advancePending(handleId: string): Promise<boolean> {
    const r = await this.db
      .prepare(`SELECT 1 AS hit FROM anchor_jobs WHERE handle_id = ? AND kind = 'advance' AND state IN ('queued', 'sent') LIMIT 1`)
      .bind(handleId)
      .first<{ hit: number }>();
    return r !== null;
  }

  /** The queued release of a label, if one is waiting (a rename's carries `afterClaim`). */
  async queuedRelease(handleId: string): Promise<AnchorJob | null> {
    return (await this.jobsOf(handleId)).filter((j) => j.kind === 'release' && j.state === 'queued').at(-1) ?? null;
  }

  private jobDoneStatement(id: number, now: number): D1PreparedStatement {
    return this.db.prepare(`UPDATE anchor_jobs SET state = 'done', error = NULL, updated_at = ? WHERE id = ?`).bind(now, id);
  }

  private followStatements(row: HandleRow, owner: Address, metaAddress: Hex, now: number): D1PreparedStatement[] {
    return [
      this.db
        .prepare(`UPDATE handles SET owner = ?, meta_address = ?, updated_at = ? WHERE handle_id = ? AND identity = ? AND state IN ('active', 'releasing')`)
        .bind(lower(owner), lower(metaAddress), now, row.handleId, row.identity),
      this.historyStatement(row.identity, row.handleId, row.serial!, owner, metaAddress, now),
    ];
  }

  private requeueStatements(handleId: string, args: Record<string, string>, relayAt: number, now: number): D1PreparedStatement[] {
    return [
      this.db.prepare(`UPDATE anchor_jobs SET state = 'cancelled', updated_at = ? WHERE handle_id = ? AND kind IN ('release', 'apply') AND state = 'queued'`).bind(now, handleId),
      this.jobStatement('release', handleId, args, relayAt, now),
    ];
  }

  /**
   * A rename whose new claim the anchor refused for good: the old label's
   * queued release is cancelled and the old row is active again, so the user
   * keeps the label they had. A release already sent cannot be called back.
   */
  private restoreStatements(oldHandleId: string, now: number): D1PreparedStatement[] {
    return [
      this.db.prepare(`UPDATE anchor_jobs SET state = 'cancelled', updated_at = ? WHERE handle_id = ? AND kind = 'release' AND state = 'queued'`).bind(now, oldHandleId),
      this.db
        .prepare(
          `UPDATE handles SET state = 'active', updated_at = ? WHERE handle_id = ? AND state = 'releasing'
           AND NOT EXISTS (SELECT 1 FROM anchor_jobs WHERE handle_id = ? AND kind IN ('release', 'apply') AND state IN ('sent', 'done'))`,
        )
        .bind(now, oldHandleId, oldHandleId),
    ];
  }

  /**
   * A job the anchor refused for good, in one batch, the job's own update last:
   * a claim's row goes (the label and the identity are free again), and a
   * rename's claim gives the old label back (its queued release cancelled).
   */
  async failJob(job: AnchorJob, reason: string, now: number): Promise<void> {
    const stmts: D1PreparedStatement[] = [];
    if (job.kind === 'claim') {
      stmts.push(
        this.db.prepare(`DELETE FROM handles WHERE handle_id = ? AND owner = ? AND state = 'active' AND onchain = 0`).bind(job.handleId, lower(job.args.owner!)),
      );
      if (job.args.renameOf) stmts.push(...this.restoreStatements(job.args.renameOf, now));
    }
    stmts.push(this.db.prepare(`UPDATE anchor_jobs SET state = 'failed', error = ?, updated_at = ? WHERE id = ?`).bind(reason, now, job.id));
    await this.db.batch(stmts);
  }

  // ── Keys and watched addresses (rule 5, q18) ─────────────────────────────

  /** Whether `metaAddress` is one this identity's handles have had. */
  async hadMetaAddress(identity: string, metaAddress: string): Promise<boolean> {
    const r = await this.db
      .prepare('SELECT 1 AS hit FROM handle_key_history WHERE identity = ? AND meta_address = ? LIMIT 1')
      .bind(identity, lower(metaAddress))
      .first<{ hit: number }>();
    return r !== null;
  }

  /**
   * Watch an address for good. `identity` and `handleId` are the map key's
   * tags of the identity and the handle id (`MapKeys.tag('watch-identity' |
   * 'watch-handle', …)`), never the values the `handles` rows hold in clear
   * (the review of 2026-11-19, M3; migration 0002's column names predate it).
   * `ours` when it was already this identity's,
   * `theirs` when another's, `limit` past the identity's bound, `full` past the
   * table's ceiling. Both bounds are checked in the insert itself.
   */
  async watch(input: {
    address: Address;
    identity: string;
    handleId: string;
    source: 'own' | 'pay';
    sealed: Uint8Array;
    now: number;
    perIdentity: number;
    perIdentityPerDay: number;
    ceiling: number;
  }): Promise<'added' | 'ours' | 'theirs' | 'limit' | 'full'> {
    const address = lower(input.address);
    const { meta } = await this.db
      .prepare(
        `INSERT INTO watched_addresses (address, identity, handle_id, source, sealed, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE (SELECT n FROM handles_counters WHERE name = 'watched_addresses') < ?7
           AND (SELECT COUNT(*) FROM watched_addresses WHERE identity = ?2) < ?8
           AND (SELECT COUNT(*) FROM watched_addresses WHERE identity = ?2 AND created_at > ?6 - 86400000) < ?9
         ON CONFLICT (address) DO NOTHING`,
      )
      .bind(address, input.identity, input.handleId, input.source, input.sealed, input.now, input.ceiling, input.perIdentity, input.perIdentityPerDay)
      .run();
    if (Number(meta.changes) > 0) return 'added';
    const r = await this.db.prepare('SELECT identity FROM watched_addresses WHERE address = ?').bind(address).first<{ identity: string }>();
    if (r) return r.identity === input.identity ? 'ours' : 'theirs';
    const live = await this.db.prepare("SELECT n FROM handles_counters WHERE name = 'watched_addresses'").first<{ n: number }>();
    return live && live.n >= input.ceiling ? 'full' : 'limit';
  }

  // ── Freezes the registrar signed (q15) ───────────────────────────────────

  /** Record a registrar-paid send (and, for a veto, what q15 reads); answers the row's id. */
  async recordFreeze(handleId: string, kind: 'hold' | 'renew' | 'veto' | 'advance' | 'unfreeze', owner: Address, serial: number, now: number): Promise<number> {
    const { meta } = await this.db
      .prepare('INSERT INTO handle_freezes (handle_id, kind, owner, serial, at) VALUES (?, ?, ?, ?, ?)')
      .bind(handleId, kind, lower(owner), serial, now)
      .run();
    return Number(meta.last_row_id);
  }

  /** A veto whose call the simulation refused never left the plane: it no longer counts against unfreeze, only against the budget. */
  async demoteFreeze(id: number): Promise<void> {
    await this.db.prepare("UPDATE handle_freezes SET kind = 'hold' WHERE id = ? AND kind = 'veto'").bind(id).run();
  }

  /**
   * Whether the plane vetoed a change on this record while it had this serial
   * (one holding: a label released and claimed again starts clean). 0086 q15 (ruled 2026-11-19 as recommended):
   * "never after a veto under the same phrase"; until q19's pinned locator tells
   * one phrase from another, any veto on the record counts, whatever key holds it
   * since (an advance to another key of the same phrase must not reopen it).
   * Stricter than q15 (the review of 2026-11-19, L5): q15 lets a rotation to a
   * new phrase end in `unfreeze` even after a veto, and here the record stays
   * frozen until the freeze lapses or the Safe lifts it. When the pin is built,
   * an accepted re-pin (q19) clears this mark for the record's serial.
   */
  async vetoed(handleId: string, serial: number): Promise<boolean> {
    const r = await this.db
      .prepare("SELECT 1 AS hit FROM handle_freezes WHERE handle_id = ? AND serial = ? AND kind = 'veto' LIMIT 1")
      .bind(handleId, serial)
      .first<{ hit: number }>();
    return r !== null;
  }

  /** The registrar-paid transactions on this record since `since` (the per-handle daily cap). */
  async registrarSends(handleId: string, since: number): Promise<number> {
    const r = await this.db.prepare('SELECT COUNT(*) AS n FROM handle_freezes WHERE handle_id = ? AND at >= ?').bind(handleId, since).first<{ n: number }>();
    return Number(r?.n ?? 0);
  }

  // ── The relay's lease ────────────────────────────────────────────────────

  /** Take the relay's lease for `ms`; false while another run holds it. */
  async leaseRelay(holder: string, now: number, ms: number): Promise<boolean> {
    const { meta } = await this.db
      .prepare(
        `INSERT INTO relay_lease (name, holder, until) VALUES ('relay', ?1, ?2)
         ON CONFLICT (name) DO UPDATE SET holder = ?1, until = ?2 WHERE relay_lease.until <= ?3`,
      )
      .bind(holder, now + ms, now)
      .run();
    return Number(meta.changes) > 0;
  }

  async releaseRelay(holder: string): Promise<void> {
    await this.db.prepare("UPDATE relay_lease SET until = 0 WHERE name = 'relay' AND holder = ?").bind(holder).run();
  }

  // ── The relay's queue ────────────────────────────────────────────────────

  async dueJobs(now: number, limit: number): Promise<AnchorJob[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM anchor_jobs WHERE state IN ('queued', 'sent') AND not_before <= ? ORDER BY not_before, id LIMIT ?`)
      .bind(now, limit)
      .all<JobRow>();
    return results.map(fromJob);
  }

  async jobsOf(handleId: string): Promise<AnchorJob[]> {
    const { results } = await this.db.prepare('SELECT * FROM anchor_jobs WHERE handle_id = ? ORDER BY id').bind(handleId).all<JobRow>();
    return results.map(fromJob);
  }

  async updateJob(id: number, patch: { state: JobState; txHash?: Hex | null; notBefore?: number; attempts?: number; error?: string | null }, now: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE anchor_jobs SET state = ?, tx_hash = COALESCE(?, tx_hash), not_before = COALESCE(?, not_before),
           attempts = COALESCE(?, attempts), error = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(patch.state, patch.txHash ?? null, patch.notBefore ?? null, patch.attempts ?? null, patch.error ?? null, now, id)
      .run();
  }

  /** Move a job's turn later without touching anything else (its `updated_at` keeps the send's time). */
  async pushBack(id: number, notBefore: number): Promise<void> {
    await this.db.prepare('UPDATE anchor_jobs SET not_before = ? WHERE id = ?').bind(notBefore, id).run();
  }

  async queueApply(handleId: string, notBefore: number, now: number): Promise<void> {
    await this.jobStatement('apply', handleId, {}, notBefore, now).run();
  }

  /** A claim landed: the row is on chain. */
  async markOnChain(handleId: string, owner: string, now: number): Promise<void> {
    await this.db
      .prepare(`UPDATE handles SET onchain = 1, updated_at = ? WHERE handle_id = ? AND owner = ? AND state IN ('active', 'releasing')`)
      .bind(now, handleId, lower(owner))
      .run();
  }

  /** A release took effect on chain (rule 3): the row is quarantined from `releasedAt`. */
  async markReleased(handleId: string, releasedAt: number, now: number): Promise<void> {
    await this.db
      .prepare(`UPDATE handles SET state = 'quarantined', onchain = 1, released_at = ?, discoverable = 0, inbox_id = NULL, updated_at = ? WHERE handle_id = ? AND state = 'releasing'`)
      .bind(releasedAt, now, handleId)
      .run();
  }

  /** Housekeeping: expired nonces, old events and old finished jobs. Counts only. */
  async sweep(now: number): Promise<{ nonces: number; events: number; jobs: number }> {
    const month = 31 * 24 * 60 * 60 * 1000;
    const [nonces, events, jobs] = await this.db.batch([
      this.db.prepare('DELETE FROM registry_nonces WHERE expires_at <= ?').bind(now),
      this.db.prepare('DELETE FROM handle_events WHERE at <= ?').bind(now - month),
      this.db.prepare(`DELETE FROM anchor_jobs WHERE state IN ('done', 'cancelled') AND updated_at <= ?`).bind(now - month),
    ]);
    const changes = (r: D1Result | undefined) => Number(r?.meta?.changes ?? 0);
    return { nonces: changes(nonces), events: changes(events), jobs: changes(jobs) };
  }
}
