// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Attachment size classes and limits (workspace decision 0093). A phone pads each encrypted attachment up to a class
 * and spends a blind token of that class; tokens and the per-account count are in class bytes, so no total matches a
 * single object's exact size. The values are the analysis's proposal (0093 open question 8) until the founder rules.
 */

const KiB = 1024;
const MiB = 1024 * KiB;

/** The classes, smallest first: an index into this list is a token's class. */
export const ATTACHMENT_CLASSES = [64 * KiB, 128 * KiB, 256 * KiB, 512 * KiB, 1 * MiB, 2 * MiB, 4 * MiB, 8 * MiB, 10 * MiB] as const;

export type AttachmentClass = number;

/** What one account may be granted over the rolling window, in class bytes (rule 2: 50 MB). */
export const ATTACHMENT_ACCOUNT_LIMIT = 50 * MiB;

/** The window in days, the objects' lifetime in R2 (rule 2). */
export const ATTACHMENT_WINDOW_DAYS = 30;

/** What every account together may be granted in one UTC day, in class bytes (0093 open question 8: 1 GiB). */
export const ATTACHMENT_DAILY_CEILING = 1024 * MiB;

/** The most tokens one request asks for. */
export const ATTACHMENT_MAX_TOKENS_PER_REQUEST = 8;

/**
 * Issuer key epochs (the founder's ruling of 2026-11-23: 30-day epochs). A new epoch starts every 27 days and its keys
 * live 30, so two epochs overlap for 3 days; the plane signs with the current epoch only, and the gate accepts a token
 * of any epoch still live. A token therefore dies at most 30 days after its epoch began, so no account hoards: an
 * object live now was uploaded in the last 30 days with a token issued at most 30 days before that, which bounds what
 * an account holds in the bucket at about twice its allowance, plus R2's lifecycle lag (about the allowance in steady
 * use). A token bought late in an epoch dies within days but counts for 30, so the app buys late-epoch tokens sparingly.
 */
export const ATTACHMENT_EPOCH_ORIGIN = Date.UTC(2026, 10, 1);
export const ATTACHMENT_EPOCH_STEP_DAYS = 27;
export const ATTACHMENT_EPOCH_LIFE_DAYS = 30;
/** How long before the next epoch starts its keys are made, so no request waits on key generation. */
export const ATTACHMENT_EPOCH_PREPARE_DAYS = 3;
const DAY_MS = 86_400_000;

/** The epoch whose keys sign at `ms`. */
export function epochAt(ms: number): number {
  return Math.max(0, Math.floor((ms - ATTACHMENT_EPOCH_ORIGIN) / (ATTACHMENT_EPOCH_STEP_DAYS * DAY_MS)));
}

export function epochNotBefore(epoch: number): number {
  return ATTACHMENT_EPOCH_ORIGIN + epoch * ATTACHMENT_EPOCH_STEP_DAYS * DAY_MS;
}

export function epochNotAfter(epoch: number): number {
  return epochNotBefore(epoch) + ATTACHMENT_EPOCH_LIFE_DAYS * DAY_MS;
}

/** The epochs whose tokens a gate accepts at `ms`, newest first: the current one and, during the overlap, the one before. */
export function liveEpochs(ms: number): number[] {
  const current = epochAt(ms);
  return current > 0 && ms < epochNotAfter(current - 1) ? [current, current - 1] : [current];
}

/** Whether the next epoch's keys should be made now. */
export function prepareNext(ms: number): boolean {
  return ms >= epochNotBefore(epochAt(ms) + 1) - ATTACHMENT_EPOCH_PREPARE_DAYS * DAY_MS;
}

/** The name a token's challenge carries for this issuer; the gate checks it too. */
export const ATTACHMENT_ISSUER_NAME = 'attachments.cofferdam.xyz';

export function isAttachmentClass(c: unknown): c is AttachmentClass {
  return typeof c === 'number' && Number.isInteger(c) && c >= 0 && c < ATTACHMENT_CLASSES.length;
}

/** The bytes a class stands for. */
export function classBytes(c: AttachmentClass): number {
  if (!isAttachmentClass(c)) throw new Error(`no attachment class ${String(c)}`);
  return ATTACHMENT_CLASSES[c]!;
}

/** The smallest class that holds `bytes`, or null over the largest. */
export function classFor(bytes: number): AttachmentClass | null {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const i = ATTACHMENT_CLASSES.findIndex((c) => bytes <= c);
  return i === -1 ? null : i;
}

/** A UTC day as stored, `YYYY-MM-DD`. */
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The first day of the window that ends on `day`, inclusive. */
export function windowStart(day: string, windowDays: number): string {
  const start = Date.parse(`${day}T00:00:00Z`) - (windowDays - 1) * 86_400_000;
  return dayOf(start);
}
