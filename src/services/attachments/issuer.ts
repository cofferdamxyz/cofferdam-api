// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The attachment token issuer (workspace decision 0093, rule 4): Privacy Pass publicly verifiable tokens (token type
 * 2, RSABSSA-SHA384-PSS-Deterministic, 2048-bit keys), one issuer key per size class and epoch (`classes.ts`), through
 * Cloudflare's `@cloudflare/privacypass-ts`. The plane signs a blinded message it cannot read, so no record here ties
 * an account to the token it later spends at the gate.
 *
 * The keys come from `AttachmentIssuerDO` (`issuerKeys.ts`), wrapped; they are unwrapped in memory and imported as
 * non-extractable `RSA-RAW` keys, Cloudflare's native raw RSA. Where `RSA-RAW` is missing the issuer refuses to load,
 * unless the caller allows the library's JavaScript private-key path (non-CRT, not constant-time), which only the
 * tests do: on a signing oracle reachable from the network that path would leak timing.
 *
 * Every blind signature is checked against the public key before it leaves (RFC 9474 §4.3, steps 3 and 4, against a
 * fault that would leak the key), and every request is read whole: exactly a token request for this key size, its
 * blinded message below the modulus.
 */

import { BLIND_RSA, BlindRSAMode, Issuer, TokenRequest, getPublicKeyBytes } from '@cloudflare/privacypass-ts/lib/src/pub_verif_token.js';

import type { AttachmentIssuerDO } from '../attachmentIssuerDO.js';
import { ATTACHMENT_CLASSES, ATTACHMENT_ISSUER_NAME, epochNotAfter, epochNotBefore, type AttachmentClass } from './classes.js';
import { IssuerKeysError, importWrapKey, unwrapClassKey, type StoredClassKey } from './issuerKeys.js';

export { IssuerKeysError } from './issuerKeys.js';

const RSA_PSS = { name: 'RSA-PSS', hash: 'SHA-384' } as const;
const MODULUS_BYTES = 256;
/** A serialized TokenRequest for 2048-bit keys: token type (2), truncated key id (1), blinded message (256). */
export const TOKEN_REQUEST_BYTES = 3 + MODULUS_BYTES;
const F4 = 'AQAB';

export interface ClassIssuer {
  epoch: number;
  class: AttachmentClass;
  notBefore: number;
  notAfter: number;
  issuer: Issuer;
  publicKey: CryptoKey;
  /** The key as a token carries it (RSASSA-PSS SubjectPublicKeyInfo), for the app and the gate. */
  publicKeyBytes: Uint8Array;
  /** SHA-256 of `publicKeyBytes`; a request names its key by the last byte. */
  tokenKeyId: Uint8Array;
  n: bigint;
  e: bigint;
}

/** Where the wrapped keys come from: `AttachmentIssuerDO`, or the tests' store. */
export interface IssuerKeySource {
  /** The epoch's keys, made on first ask. */
  epochKeys(epoch: number): Promise<StoredClassKey[]>;
  /** The epoch's keys if they were ever made. */
  storedEpoch(epoch: number): Promise<StoredClassKey[] | null>;
}

export class DurableIssuerKeySource implements IssuerKeySource {
  constructor(private readonly namespace: DurableObjectNamespace<AttachmentIssuerDO>) {}
  private stub() {
    return this.namespace.getByName('issuer');
  }
  async epochKeys(epoch: number): Promise<StoredClassKey[]> {
    return (await this.stub().epochKeys(epoch)) as StoredClassKey[];
  }
  async storedEpoch(epoch: number): Promise<StoredClassKey[] | null> {
    return ((await this.stub().storedEpoch(epoch)) as StoredClassKey[] | null) ?? null;
  }
}

export interface IssuerOptions {
  /** Let a key that will not import as `RSA-RAW` sign through the library's JavaScript path. Tests only. */
  allowJsSigning?: boolean;
}

function bigintOf(b64url: string): bigint {
  const bin = atob(b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4));
  let hex = '';
  for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
  return BigInt(`0x${hex || '0'}`);
}

function bigintFromBytes(bytes: Uint8Array): bigint {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return BigInt(`0x${hex || '0'}`);
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

async function importClass(stored: StoredClassKey, wrapKey: CryptoKey, opts: IssuerOptions): Promise<ClassIssuer> {
  if (stored.e !== F4) throw new IssuerKeysError(`epoch ${stored.epoch} class ${stored.class}: exponent is not 65537`);
  const publicKey = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: stored.n, e: stored.e }, RSA_PSS, true, ['verify']);
  if ((publicKey.algorithm as { modulusLength?: number }).modulusLength !== MODULUS_BYTES * 8) {
    throw new IssuerKeysError(`epoch ${stored.epoch} class ${stored.class}: key is not 2048 bits`);
  }
  const pkcs8 = await unwrapClassKey(stored, wrapKey);
  let privateKey: CryptoKey | null;
  let supportsRSARAW = true;
  try {
    privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSA-RAW', hash: 'SHA-384' }, false, ['sign']).catch(() => null);
    if (!privateKey) {
      // Tell a runtime without RSA-RAW from a key that does not import at all.
      const pss = await crypto.subtle.importKey('pkcs8', pkcs8, RSA_PSS, true, ['sign']).catch(() => null);
      if (!pss) throw new IssuerKeysError(`epoch ${stored.epoch} class ${stored.class}: the private key does not import`);
      if (!opts.allowJsSigning) throw new IssuerKeysError('RSA-RAW is not available: refusing the JavaScript private-key path');
      supportsRSARAW = false;
      privateKey = pss;
    }
  } finally {
    pkcs8.fill(0);
  }
  const issuer = new Issuer(BlindRSAMode.PSS, ATTACHMENT_ISSUER_NAME, privateKey, publicKey, { supportsRSARAW });
  const publicKeyBytes = await getPublicKeyBytes(publicKey);
  const tokenKeyId = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKeyBytes));
  return {
    epoch: stored.epoch,
    class: stored.class,
    notBefore: epochNotBefore(stored.epoch),
    notAfter: epochNotAfter(stored.epoch),
    issuer,
    publicKey,
    publicKeyBytes,
    tokenKeyId,
    n: bigintOf(stored.n),
    e: bigintOf(stored.e),
  };
}

const cache = new Map<string, Promise<ClassIssuer[]>>();

/**
 * One epoch's issuers, every class, imported once per isolate, epoch and wrap secret. `stored` passes keys already
 * read (the previous epoch, which is never made on demand).
 */
export function loadEpochIssuers(
  source: IssuerKeySource,
  wrapSecret: string,
  epoch: number,
  opts: IssuerOptions = {},
  stored?: StoredClassKey[],
): Promise<ClassIssuer[]> {
  const key = `${epoch}:${opts.allowJsSigning ? 'js' : 'raw'}:${wrapSecret}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const loading = (async () => {
    const wrapKey = await importWrapKey(wrapSecret);
    const keys = stored ?? (await source.epochKeys(epoch));
    if (keys.length !== ATTACHMENT_CLASSES.length) throw new IssuerKeysError(`epoch ${epoch} has ${keys.length} keys`);
    return Promise.all(keys.map((k) => importClass(k, wrapKey, opts)));
  })();
  cache.set(key, loading);
  loading.catch(() => cache.delete(key));
  return loading;
}

export class TokenRequestError extends Error {
  override readonly name = 'TokenRequestError';
  constructor(
    readonly index: number,
    readonly reason: 'malformed' | 'wrong_key',
  ) {
    super(`token request ${index}: ${reason}`);
  }
}

/**
 * Checks each request is whole and belongs to its class's key before anything is signed or counted. The caller has
 * checked the body names the current epoch; the key id comes before the range, so a request under another key reads
 * `wrong_key`, never `malformed`.
 */
export function readTokenRequests(issuers: ClassIssuer[], requests: { class: AttachmentClass; request: Uint8Array }[]): TokenRequest[] {
  return requests.map((r, i) => {
    if (r.request.length !== TOKEN_REQUEST_BYTES) throw new TokenRequestError(i, 'malformed');
    let req: TokenRequest;
    try {
      req = TokenRequest.deserialize(BLIND_RSA, r.request);
    } catch {
      throw new TokenRequestError(i, 'malformed');
    }
    const issuer = issuers[r.class]!;
    const keyId = issuer.tokenKeyId;
    if (req.truncatedTokenKeyId !== keyId[keyId.length - 1]) throw new TokenRequestError(i, 'wrong_key');
    if (bigintFromBytes(req.blindedMsg) >= issuer.n) throw new TokenRequestError(i, 'malformed');
    return req;
  });
}

export class SelfCheckError extends Error {
  override readonly name = 'SelfCheckError';
}

/** Blind signatures, one per request, in order, each checked against its public key: the serialized responses. */
export async function issueTokens(issuers: ClassIssuer[], classes: AttachmentClass[], requests: TokenRequest[]): Promise<Uint8Array[]> {
  return Promise.all(
    requests.map(async (req, i) => {
      const issuer = issuers[classes[i]!]!;
      const response = await issuer.issuer.issue(req);
      if (modPow(bigintFromBytes(response.blindSig), issuer.e, issuer.n) !== bigintFromBytes(req.blindedMsg)) {
        throw new SelfCheckError('a blind signature failed its own check');
      }
      return response.serialize();
    }),
  );
}
