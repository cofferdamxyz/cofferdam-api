// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The cleanup job's SQL against the XMTP backend's schema
 * (libxmtp apps/backend/migrations, backend-8.0.0-rc2). Re-check on every
 * backend bump: an rc schema can change, and XMTP may ship its own pruning.
 *
 * Rules every statement keeps (OPS-001, OPS-002 and the design in the project
 * file xmtp-hosting/message-cleanup-job.md):
 *  - never a row whose expiry_ns is NULL (identity updates, commit-log entries,
 *    commits and proposals are permanent; losing one breaks decryption);
 *  - never a commit or proposal (second guard);
 *  - never before the database clock passes expiry_ns plus a grace period;
 *  - only topic kinds 0 (group message), 1 (welcome), 3 (key package);
 *  - never at or above the push cursor, so a pending push still finds its row
 *    (when push is on);
 *  - never an installation's newest key package, so it stays reachable.
 *
 * Group messages and welcomes are walked in sequence order from a per-kind
 * resume point. Within one kind the retention is one constant, so expiry grows
 * with sequence_id and everything below the resume point is gone. The point
 * only advances past rows that expired at least `$margin` before the cutoff, so
 * publish-order jitter (milliseconds; the publish ceiling is 10 s) can never
 * leave an expired row behind it. A retention change resets the points.
 *
 * Key packages are few (one live per installation) and their "newest" status
 * moves, so they get no resume point: a range scan of the kind-3 topics on the
 * (topic, sequence_id) index each run.
 */

export const KIND_GROUP_MESSAGE = 0;
export const KIND_WELCOME = 1;
export const KIND_KEY_PACKAGE = 3;

/** The database clock, in ns, as the backend stamps it. */
const NOW_NS = `(extract(epoch FROM clock_timestamp()) * 1000000000)::bigint`;

function pushGuard(on: boolean, alias: string): string {
  return on ? `AND ${alias}.sequence_id < (SELECT sequence_id FROM push_cursor WHERE singleton)` : '';
}

/**
 * $1 kind (int), $2 resume (bigint), $3 grace ns (bigint), $4 batch (int),
 * $5 margin ns (bigint). Returns each deleted row's id and whether it expired
 * before cutoff - margin (`settled`), which is what the resume point may pass.
 */
export function sequentialBatch(pushCursorGuard: boolean): string {
  return `WITH cutoff AS (SELECT ${NOW_NS} - $3::bigint AS ns),
doomed AS (
  SELECT e.sequence_id, e.expiry_ns
  FROM envelopes e, cutoff c
  WHERE e.sequence_id > $2::bigint
    AND get_byte(e.topic, 0) = $1::int
    AND e.expiry_ns IS NOT NULL
    AND e.is_commit_or_proposal = false
    AND e.expiry_ns < c.ns
    ${pushGuard(pushCursorGuard, 'e')}
  ORDER BY e.sequence_id
  LIMIT $4::int
  FOR UPDATE OF e SKIP LOCKED
)
DELETE FROM envelopes d
USING doomed, cutoff c
WHERE d.sequence_id = doomed.sequence_id
RETURNING d.sequence_id::text AS sequence_id, (doomed.expiry_ns < c.ns - $5::bigint) AS settled`;
}

/** $1 grace ns (bigint), $2 batch (int). */
export function keyPackageBatch(pushCursorGuard: boolean): string {
  return `WITH doomed AS (
  SELECT e.sequence_id
  FROM envelopes e
  WHERE e.topic >= '\\x03'::bytea AND e.topic < '\\x04'::bytea
    AND e.expiry_ns IS NOT NULL
    AND e.is_commit_or_proposal = false
    AND e.expiry_ns < ${NOW_NS} - $1::bigint
    ${pushGuard(pushCursorGuard, 'e')}
    AND e.sequence_id < (SELECT max(k.sequence_id) FROM envelopes k WHERE k.topic = e.topic)
  ORDER BY e.topic, e.sequence_id
  LIMIT $2::int
  FOR UPDATE OF e SKIP LOCKED
)
DELETE FROM envelopes d
USING doomed
WHERE d.sequence_id = doomed.sequence_id
RETURNING d.sequence_id::text AS sequence_id`;
}
