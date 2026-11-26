// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The two JWTs every CDP Server Wallet request carries (workspace decision
 * 0090; runbook `docs/runbooks/cdp-setup.md`, E1), made with WebCrypto alone:
 * CDP's TypeScript SDK states Node only, so the plane speaks the REST API.
 *
 * - The **bearer JWT** (`Authorization: Bearer`), from the Secret API key: an
 *   Ed25519 key given as base64 of its 32-byte seed then its 32-byte public
 *   key. Header `{ alg: 'EdDSA', kid, typ: 'JWT', nonce }`, claims `sub` (the
 *   key id), `iss: 'cdp'`, `nbf`, `iat`, `exp` two minutes on, and `uris`,
 *   one entry `"<METHOD> <host><path>"`.
 * - The **wallet JWT** (`X-Wallet-Auth`), from the project's Wallet Secret: a
 *   P-256 key given as base64 of its PKCS#8 DER. Header `{ alg: 'ES256', typ:
 *   'JWT' }`, claims `iat`, `nbf`, `jti`, `uris` and, when the body has a
 *   defined value, `reqHash`: SHA-256 hex of the body's JSON with every
 *   object's keys sorted. No `exp`. Only POST, PUT and DELETE under
 *   `/evm/accounts` need it here.
 *
 * Read from CDP's own SDK (coinbase/cdp-sdk `typescript/packages/cdp-sdk/src/
 * auth/utils/jwt.ts`, `hash.ts`, `utils/sortKeys.ts`, `auth/utils/http.ts`) on
 * 2026-11-25. The keys are imported non-extractable and never logged; an error
 * names what is malformed, never a byte of it.
 */

/** A bearer JWT lives two minutes, as the SDK's default. */
export const BEARER_TTL_S = 120;

export class CdpKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CdpKeyError';
  }
}

const enc = new TextEncoder();

function base64ToBytes(b64: string): Uint8Array | null {
  const s = b64.trim();
  if (!s || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlJson(value: unknown): string {
  return base64Url(enc.encode(JSON.stringify(value)));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(n: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(n)));
}

/** The Secret API key's Ed25519 signing key, from base64 of seed ‖ public key (64 bytes). */
export async function importApiKeySecret(secret: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(secret);
  if (!bytes || bytes.length !== 64) throw new CdpKeyError('the CDP API key secret must be base64 of 64 bytes (an Ed25519 key)');
  const jwk: JsonWebKey = { kty: 'OKP', crv: 'Ed25519', d: base64Url(bytes.subarray(0, 32)), x: base64Url(bytes.subarray(32)) };
  try {
    return await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, false, ['sign']);
  } catch {
    throw new CdpKeyError('the CDP API key secret is not an Ed25519 key');
  }
}

/** The Wallet Secret's P-256 signing key, from base64 of its PKCS#8 DER. */
export async function importWalletSecret(secret: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(secret);
  if (!bytes) throw new CdpKeyError('the CDP Wallet Secret must be base64 of a PKCS#8 key');
  try {
    return await crypto.subtle.importKey('pkcs8', bytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  } catch {
    throw new CdpKeyError('the CDP Wallet Secret is not a P-256 PKCS#8 key');
  }
}

/** The JWT's `uris` entry: `"<METHOD> <host><path>"`, the path without its query. */
export function requestUri(method: string, url: URL): string {
  return `${method.toUpperCase()} ${url.host}${url.pathname}`;
}

/** Every object's keys sorted, recursively; arrays keep their order (the SDK's `sortKeys`). */
export function sortKeys(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key]);
  return out;
}

/** The wallet JWT's `reqHash`: SHA-256 hex of the key-sorted body's JSON. */
export async function requestHash(body: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify(sortKeys(body))));
  return hex(new Uint8Array(digest));
}

/** Whether a body carries a `reqHash`: a non-empty object with at least one defined value, as the SDK decides. */
function hashesBody(body: unknown): body is Record<string, unknown> {
  return !!body && typeof body === 'object' && Object.values(body).some((v) => v !== undefined);
}

async function signJwt(header: object, claims: object, key: CryptoKey, algorithm: Parameters<SubtleCrypto['sign']>[0]): Promise<string> {
  const input = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  // ECDSA under WebCrypto signs as r ‖ s (IEEE P1363), which is JWS's ES256 form.
  const sig = await crypto.subtle.sign(algorithm, key, enc.encode(input));
  return `${input}.${base64Url(new Uint8Array(sig))}`;
}

export interface BearerJwtInput {
  keyId: string;
  key: CryptoKey;
  method: string;
  url: URL;
  /** Seconds since the epoch; the tests pin it. */
  now?: number;
}

export function bearerJwt(input: BearerJwtInput): Promise<string> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const header = { alg: 'EdDSA', kid: input.keyId, typ: 'JWT', nonce: randomHex(16) };
  const claims = {
    sub: input.keyId,
    iss: 'cdp',
    uris: [requestUri(input.method, input.url)],
    iat: now,
    nbf: now,
    exp: now + BEARER_TTL_S,
  };
  return signJwt(header, claims, input.key, { name: 'Ed25519' });
}

export interface WalletJwtInput {
  key: CryptoKey;
  method: string;
  url: URL;
  /** The parsed body exactly as sent; its hash binds the token to it. */
  body?: unknown;
  now?: number;
}

export async function walletJwt(input: WalletJwtInput): Promise<string> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { iat: now, nbf: now, jti: randomHex(16), uris: [requestUri(input.method, input.url)] };
  if (hashesBody(input.body)) claims.reqHash = await requestHash(input.body);
  return signJwt({ alg: 'ES256', typ: 'JWT' }, claims, input.key, { name: 'ECDSA', hash: 'SHA-256' });
}

/** Whether a request needs `X-Wallet-Auth`: a write under the EVM accounts API (the SDK's `requiresWalletAuth`, the part the plane uses). */
export function requiresWalletAuth(method: string, url: URL): boolean {
  return ['POST', 'PUT', 'DELETE'].includes(method.toUpperCase()) && /\/evm\/accounts/.test(url.pathname);
}
