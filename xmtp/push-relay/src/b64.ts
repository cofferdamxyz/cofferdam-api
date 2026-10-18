// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/** Strict base64 helpers (no atob tolerance for junk), for the relay and its tests. */

const STD = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const URL_SAFE = /^[A-Za-z0-9_-]*$/;

export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function toB64Url(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64(text: string): Uint8Array | null {
  if (!STD.test(text)) return null;
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function fromB64Url(text: string): Uint8Array | null {
  if (!URL_SAFE.test(text) || text.length % 4 === 1) return null;
  const std = text.replace(/-/g, '+').replace(/_/g, '/');
  return fromB64(std + '='.repeat((4 - (std.length % 4)) % 4));
}

export const utf8 = new TextEncoder();
export const fromUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison of two byte strings. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
