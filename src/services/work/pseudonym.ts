// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The account's Work pseudonym (workspace `docs/product/engine.md`, Recall;
 * decisions 0019 and 0060): what a listing record is keyed by in D1, beside
 * the profile id, and what recall keeps one listing per. The plane derives it
 * on every request from the account the session is pinned to, so nothing
 * stored beside a listing names the account.
 *
 * It is HMAC-SHA-256 of the lower-case account under the plane secret
 * `WORK_PSEUDONYM_KEY`, not a plain hash: account addresses are public on
 * Base, so anyone holding a record or a listing id (a hash of the pseudonym
 * and the profile id, answered only to its owner; a hirer sees neither)
 * could hash guessed addresses and match them. Without the key neither can
 * be rebuilt.
 *
 * The key must outlive the listings. A new key gives every account a new
 * pseudonym and strands every published listing under the old one, beyond
 * reach of its owner's toggle, and no listing can be re-keyed in place, since
 * no record holds its account: a rotation takes every listing (record and
 * vector) down first and the phones publish again (no tool does that yet),
 * never a quiet swap. The pseudonym follows the account address, not the
 * identity: a new account generation (decision 0025) has its own, so its
 * listings are published again from it.
 */

/** The shortest key the routes accept: `openssl rand -base64 32` prints 44 characters. */
export const PSEUDONYM_KEY_MIN_CHARS = 32;

/** Domain separation, versioned: a second use of the key never shares its outputs. */
const PSEUDONYM_DOMAIN = 'cofferdam-work-pseudonym-v1';

/** `WORK_PSEUDONYM_KEY`, or null when it is unset or too short to be a key. */
export function pseudonymKey(raw: string | undefined): string | null {
  return typeof raw === 'string' && raw.length >= PSEUDONYM_KEY_MIN_CHARS ? raw : null;
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The account's Work pseudonym under `key`: `P` and 43 base64url characters, the same for any casing of the address. */
export async function workPseudonym(key: string, account: string): Promise<string> {
  const enc = new TextEncoder();
  const hmac = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', hmac, enc.encode(`${PSEUDONYM_DOMAIN}\u0000${account.toLowerCase()}`));
  return `P${base64url(new Uint8Array(mac))}`;
}
