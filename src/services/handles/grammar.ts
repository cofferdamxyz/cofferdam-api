// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The handle grammar and the handle id, as the plane reads them (workspace
 * decision 0086, rule 2; decision 0029 (1)).
 *
 * A handle's stored form is an ENS label normalised with ENSIP-15: `a–z`,
 * `0–9` and the hyphen, 3 to 64 characters, no hyphen at either end, and no
 * `--` in places three and four (ENSIP-15 refuses `xn--`-style labels). That
 * form is all ASCII, and ENSIP-15 leaves such a label unchanged, so the plane
 * needs no normaliser: it accepts the stored form only (a leading `@` dropped
 * and ASCII upper case folded), and the phone normalises anything else before
 * it asks (cofferdam-app `handleGrammar.ts`, `toHandle`).
 *
 * DUPLICATION, to remove: the shared validator and `handleId` move to
 * cofferdam-sdk `identity/handle.ts` (runbook step 0 and step 1), which the
 * plane does not import (it depends on no `@cofferdam/sdk` package, as
 * `sessionAttestation.ts` mirrors the SDK byte for byte). Until it does, the
 * vectors in `test/handlesGrammar.test.ts` pin the same rules, and the SDK's
 * shared fixture `handles-0086.json` is to be copied into
 * `test/fixtures/handles/` and read there once that branch lands.
 */

import { keccak256, stringToBytes } from 'viem';

export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 64;

const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** The prefix of the handle id's preimage (rule 2), frozen once used. */
export const HANDLE_ID_PREFIX = 'cofferdam-handle-v1:';

/** Whether `label` is a handle in its stored form. */
export function isStoredHandle(label: unknown): label is string {
  return (
    typeof label === 'string' &&
    label.length >= HANDLE_MIN_LENGTH &&
    label.length <= HANDLE_MAX_LENGTH &&
    LABEL.test(label) &&
    label.slice(2, 4) !== '--'
  );
}

/**
 * The stored form of what a caller typed, or null: a leading `@` dropped and
 * ASCII upper case folded, then the stored form's rules. Anything outside
 * ASCII is refused rather than normalised here (see the module comment).
 */
export function readHandle(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.startsWith('@') ? input.slice(1) : input;
  if (!/^[\x21-\x7e]+$/.test(raw)) return null;
  const label = raw.toLowerCase();
  return isStoredHandle(label) ? label : null;
}

/** `keccak256("cofferdam-handle-v1:" ‖ label)` over the label's UTF-8 bytes (rule 2), lower-case hex. */
export function handleIdOf(label: string): `0x${string}` {
  return keccak256(stringToBytes(`${HANDLE_ID_PREFIX}${label}`));
}
