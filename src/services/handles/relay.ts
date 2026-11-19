// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The anchor relay (workspace decision 0086, rule 3, "Relaying"): each cron run
 * sends the queued anchor calls whose random delay has passed, as one batch of
 * transactions from the registrar key, and reads the receipts of those sent
 * before.
 *
 * - **claim:** the registrar signs `RegistrarClaim` over the record's next
 *   serial and its nonce at send time, with a one-hour deadline; the owner's
 *   `OwnerClaim` was taken at the claim. A record already the claim's is done; a
 *   record another key owns, or whose serial moved, fails the job and drops the
 *   row, so the label and the identity are free again.
 * - **release:** the owner's `Release`, signed at the request; waits while the
 *   label's claim has not landed. Once mined, `apply` is queued for when the
 *   anchor's delay has passed.
 * - **apply:** `applyChange` once the release is ripe and the record is not
 *   frozen; then the row is `quarantined` from the release's block time.
 * - **advance:** sent at once by its route; settled here, so the row follows
 *   the new key only once the transaction is mined.
 *
 * A transient failure (a node error, a pending receipt) leaves the job for the
 * next run; only a contract revert counts, and it is final after
 * `MAX_ATTEMPTS`. A rename's claim that fails for good gives the old label back
 * (its queued release is cancelled). One run at a time: a D1 lease, so two runs
 * never send the same job. Nothing here logs a
 * label or an account: the log line carries the job's kind, its id and the
 * revert's name.
 */

import type { Hex } from 'viem';

import { AnchorRevert, CHANGE_KIND, ZERO_ADDRESS, type AnchorChain } from './anchor.js';
import { handlesLog } from './limits.js';
import type { AnchorJob, D1HandleRegistry } from './registry.js';
import { signAnchor } from './typedData.js';

/** Jobs a run takes, so one run stays well inside a scheduled invocation. */
export const RELAY_JOBS_PER_RUN = 10;
/** Sends a job may revert before it fails for good. */
export const MAX_ATTEMPTS = 3;
/** How long a sent transaction may go without a receipt before the job is read again from the chain. */
export const SENT_STALE_MS = 30 * 60 * 1000;
/** How long a release waits before trying again while its claim has not landed. */
export const RELEASE_RETRY_MS = 10 * 60 * 1000;
/** The registrar signature's deadline from the send. */
export const SEND_DEADLINE_S = 60 * 60;

export interface RelayRun {
  sent: number;
  done: number;
  failed: number;
  waiting: number;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** How long a run holds the lease: well past one run, so a stuck run frees it. */
export const RELAY_LEASE_MS = 5 * 60 * 1000;

export async function runRelay(registry: D1HandleRegistry, chain: AnchorChain, now: number): Promise<RelayRun & { leased: boolean }> {
  const run: RelayRun = { sent: 0, done: 0, failed: 0, waiting: 0 };
  const holder = crypto.randomUUID();
  if (!(await registry.leaseRelay(holder, now, RELAY_LEASE_MS))) return { ...run, leased: false };
  try {
    await relayJobs(registry, chain, now, run);
  } finally {
    await registry.releaseRelay(holder).catch(() => undefined);
  }
  return { ...run, leased: true };
}

async function relayJobs(registry: D1HandleRegistry, chain: AnchorChain, now: number, run: RelayRun): Promise<void> {
  for (const job of await registry.dueJobs(now, RELAY_JOBS_PER_RUN)) {
    try {
      const outcome = job.state === 'sent' ? await settle(registry, chain, job, now) : await send(registry, chain, job, now);
      run[outcome]++;
    } catch (err) {
      // A node error: the job stays as it is for the next run.
      run.waiting++;
      handlesLog({ route: 'relay', job: job.id, kind: job.kind, error: err instanceof Error ? err.name : typeof err });
    }
  }
}

async function fail(registry: D1HandleRegistry, job: AnchorJob, reason: string, now: number): Promise<'failed'> {
  await registry.updateJob(job.id, { state: 'failed', error: reason }, now);
  if (job.kind === 'claim') {
    await registry.dropUnlandedClaim(job.handleId, job.args.owner!);
    if (job.args.renameOf) await registry.restoreRenamed(job.args.renameOf, now);
  }
  handlesLog({ route: 'relay', job: job.id, kind: job.kind, failed: reason });
  return 'failed';
}

/** A revert: tried again next run until `MAX_ATTEMPTS`, then final. */
async function reverted(registry: D1HandleRegistry, job: AnchorJob, reason: string, now: number): Promise<'failed' | 'waiting'> {
  const attempts = job.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) return fail(registry, { ...job, attempts }, reason, now);
  await registry.updateJob(job.id, { state: 'queued', attempts, error: reason, notBefore: now + 60_000 }, now);
  return 'waiting';
}

async function send(registry: D1HandleRegistry, chain: AnchorChain, job: AnchorJob, now: number): Promise<keyof RelayRun> {
  const rec = await chain.record(job.handleId);
  const nowS = Math.floor(now / 1000);
  if (job.kind === 'advance') {
    // Requeued after its receipt went missing: the chain says whether it landed.
    if (same(rec.owner, job.args.owner!)) return followAdvance(registry, job, now);
    return fail(registry, job, 'advance_not_landed', now);
  }
  let txHash: Hex;
  try {
    if (job.kind === 'claim') {
      const { owner, metaAddress, serial, ownerSig } = job.args as Record<string, string>;
      if (same(rec.owner, owner!) && rec.serial === Number(serial)) {
        await registry.markOnChain(job.handleId, owner!, now);
        await registry.updateJob(job.id, { state: 'done' }, now);
        return 'done';
      }
      if (!same(rec.owner, ZERO_ADDRESS)) return fail(registry, job, 'owned', now);
      if (rec.serial + 1 !== Number(serial)) return fail(registry, job, 'serial', now);
      const deadline = BigInt(nowS + SEND_DEADLINE_S);
      const registrarSig = await signAnchor(chain.registrar, chain.chainId, chain.anchor, 'RegistrarClaim', {
        handleId: job.handleId,
        owner,
        serial: BigInt(serial!),
        nonce: rec.nonce,
        deadline,
      });
      txHash = await chain.send({ functionName: 'claim', args: [job.handleId, owner as Hex, metaAddress as Hex, deadline, registrarSig, ownerSig as Hex] });
    } else if (job.kind === 'release') {
      const { owner, deadline, ownerSig } = job.args as Record<string, string>;
      if (same(rec.owner, ZERO_ADDRESS)) {
        // The claim has not landed yet (or the label is already released).
        if (rec.releasedAt > 0) return fail(registry, job, 'released', now);
        await registry.updateJob(job.id, { state: 'queued', notBefore: now + RELEASE_RETRY_MS }, now);
        return 'waiting';
      }
      if (!same(rec.owner, owner!)) return fail(registry, job, 'owner_changed', now);
      if (rec.pendingKind === CHANGE_KIND.Release) {
        await registry.queueApply(job.handleId, rec.pendingReadyAt * 1000, now);
        await registry.updateJob(job.id, { state: 'done' }, now);
        return 'done';
      }
      txHash = await chain.send({ functionName: 'release', args: [job.handleId, BigInt(deadline!), ownerSig as Hex] });
    } else {
      if (same(rec.owner, ZERO_ADDRESS) && rec.releasedAt > 0) {
        await registry.markReleased(job.handleId, rec.releasedAt * 1000, now);
        await registry.updateJob(job.id, { state: 'done' }, now);
        return 'done';
      }
      if (rec.pendingKind !== CHANGE_KIND.Release) return fail(registry, job, 'no_pending_release', now);
      const ripeAt = Math.max(rec.pendingReadyAt, rec.frozenUntil) * 1000;
      if (ripeAt > now) {
        await registry.updateJob(job.id, { state: 'queued', notBefore: ripeAt + 1000 }, now);
        return 'waiting';
      }
      txHash = await chain.send({ functionName: 'applyChange', args: [job.handleId] });
    }
  } catch (err) {
    if (err instanceof AnchorRevert) return reverted(registry, job, err.reason, now);
    throw err;
  }
  await registry.updateJob(job.id, { state: 'sent', txHash }, now);
  handlesLog({ route: 'relay', job: job.id, kind: job.kind, sent: true });
  return 'sent';
}

async function settle(registry: D1HandleRegistry, chain: AnchorChain, job: AnchorJob, now: number): Promise<keyof RelayRun> {
  const status = await chain.receipt(job.txHash!);
  if (status === 'pending') {
    if (now - job.updatedAt < SENT_STALE_MS) return 'waiting';
    // No receipt for half an hour: read the record again on the next send.
    await registry.updateJob(job.id, { state: 'queued' }, now);
    return 'waiting';
  }
  if (status === 'reverted') {
    // An advance's three signatures are good once: it is not sent again.
    if (job.kind === 'advance') return fail(registry, job, 'tx_reverted', now);
    return reverted(registry, job, 'tx_reverted', now);
  }
  if (job.kind === 'advance') return followAdvance(registry, job, now);
  const rec = await chain.record(job.handleId);
  if (job.kind === 'claim') {
    await registry.markOnChain(job.handleId, job.args.owner!, now);
  } else if (job.kind === 'release') {
    await registry.queueApply(job.handleId, rec.pendingReadyAt * 1000, now);
  } else if (rec.releasedAt > 0) {
    await registry.markReleased(job.handleId, rec.releasedAt * 1000, now);
  }
  await registry.updateJob(job.id, { state: 'done' }, now);
  return 'done';
}

/** A mined advance: the row and the key history follow the new key, and a releasing label's release is queued again. */
async function followAdvance(registry: D1HandleRegistry, job: AnchorJob, now: number): Promise<'done'> {
  await registry.settleAdvance(job, now, now + 60_000);
  return 'done';
}
