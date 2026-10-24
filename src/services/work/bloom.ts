// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The listing's Bloom filter over its canonical tokens (workspace
 * `docs/product/engine.md`, Recall and the Bloom gate, E3): 2,048 bits and
 * seven hashes, 344 characters of base64 in the listing's Vectorize metadata,
 * so the gate needs no D1 read. Membership only: it can say a token may be
 * there (a false positive, rare at listing sizes) or is surely not, which is
 * why certificates are confirmed against the exact token list (E10).
 *
 * The hashes are two seeded FNV-1a 32-bit hashes of the token's UTF-8 bytes,
 * combined by double hashing (Kirsch and Mitzenmacher): bit_i = h1 + i·h2.
 * Tokens come from the registry, never from free text, so a hash an attacker
 * could aim does not matter here.
 */

export const BLOOM_BITS = 2048;
export const BLOOM_HASHES = 7;

const encoder = new TextEncoder();

function fnv1a(bytes: Uint8Array, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The bit positions of a token. */
export function bloomBits(token: string): number[] {
  const bytes = encoder.encode(token);
  const h1 = fnv1a(bytes, 0);
  const h2 = fnv1a(bytes, 0x5bd1e995) | 1;
  const bits: number[] = [];
  for (let i = 0; i < BLOOM_HASHES; i++) bits.push(((h1 + Math.imul(i, h2)) >>> 0) % BLOOM_BITS);
  return bits;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array | null {
  try {
    const s = atob(b64);
    if (s.length !== BLOOM_BITS / 8) return null;
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The filter of a token set, as base64. */
export function bloomOf(tokens: Iterable<string>): string {
  const bytes = new Uint8Array(BLOOM_BITS / 8);
  for (const t of tokens) for (const bit of bloomBits(t)) bytes[bit >> 3]! |= 1 << (bit & 7);
  return toBase64(bytes);
}

/** A probe for many filters: the token's bits, computed once. */
export interface BloomProbe {
  token: string;
  bits: number[];
}

export function bloomProbe(token: string): BloomProbe {
  return { token, bits: bloomBits(token) };
}

/** Whether the filter may hold the token; a filter that does not parse holds nothing (fail closed). */
export function bloomHas(filter: string, probe: BloomProbe): boolean {
  const bytes = fromBase64(filter);
  if (!bytes) return false;
  return probe.bits.every((bit) => ((bytes[bit >> 3]! >> (bit & 7)) & 1) === 1);
}
