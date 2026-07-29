// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-side verifier for the `SignInResponse.attestation` envelope emitted by
 * `@cofferdam/sdk` (`NativeAccountProvider.signIn`).
 *
 * **MUST stay byte-compatible with**
 * `cofferdam-sdk/packages/core/src/identity/sessionAttestation.ts`
 * (the digest preimage, `csa1:` token format, and `p256` / `webauthn`
 * verification rules). This is the same cross-repo duplication pattern as
 * `services/attester.ts` — the SDK is not yet published to npm, and this Worker
 * uses `viem` + `@noble/curves` (Workers-native) rather than the SDK's `ethers`
 * stack. A future `@cofferdam/sdk/attestation` subpath export will absorb this.
 *
 * The attestation is a passkey-signed envelope binding the security-relevant
 * sign-in fields `(scope, appPseudonym, accountAddress, chainId, verified,
 * issuedAt)` plus the signing public key `(qx, qy)`. Verifying it proves the
 * session was authorised by the holder of that passkey — not forged or replayed
 * by a party that merely observed an `appPseudonym` / `accountAddress`.
 *
 * Verifying the signature is necessary but not sufficient on its own: the caller
 * should also confirm the public key is an active authority on `accountAddress`
 * on-chain (see `routes/session.ts`'s optional `checkOnChain`).
 */

import { p256 } from '@noble/curves/p256';
import {
  concatHex,
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  hexToBytes,
  keccak256,
  sha256,
  type Hex,
} from 'viem';

/** Wire-format version of the session-attestation envelope. */
export const SESSION_ATTESTATION_VERSION = 1;

/** Token prefix so a consumer can cheaply reject non-Cofferdam attestations. */
const PREFIX = 'csa1:';

/** Domain separator mixed into the signed digest (prevents cross-protocol reuse). */
const DIGEST_DOMAIN = 'cofferdam-session-attestation-v1';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;

/** A P-256 public key as two 0x-prefixed 32-byte hex coordinates. */
export interface P256PublicKey {
  /** Affine x coordinate (`qx`). */
  qx: Hex;
  /** Affine y coordinate (`qy`). */
  qy: Hex;
}

/** Signature scheme of the envelope `sig`. */
export type AttestationScheme = 'p256' | 'webauthn';

/** The sign-in fields the passkey commits to (everything but the sig). */
export interface SessionAttestationFields {
  scope: string;
  appPseudonym: string;
  accountAddress: string;
  chainId: number;
  verified: boolean;
  issuedAt: number;
}

/** A full, self-contained session attestation (the decoded `attestation` string). */
export interface SessionAttestation extends SessionAttestationFields {
  v: number;
  alg: AttestationScheme;
  publicKey: P256PublicKey;
  /** Raw 64-byte `r || s` for `p256`; `abi.encode(WebAuthnAuth)` for `webauthn`. */
  sig: Hex;
}

/** Base class for every session-attestation failure. */
export class SessionAttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The token was not a well-formed Cofferdam session attestation. */
export class SessionAttestationDecodeError extends SessionAttestationError {}

/** The attestation is older than `maxAgeMs` (or clock-skewed into the future). */
export class SessionAttestationExpiredError extends SessionAttestationError {}

/** The signature failed, or a presented field did not match `expect`. */
export class SessionAttestationVerificationError extends SessionAttestationError {}

// ── base64url (mirrors cofferdam-sdk webauthn.ts, no atob/Buffer) ────────────

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64urlToBytes(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9\-_+/]/g, '');
  const lookup = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) lookup[B64_ALPHABET.charCodeAt(i)] = i;
  lookup['+'.charCodeAt(0)] = 62;
  lookup['/'.charCodeAt(0)] = 63;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = lookup[clean.charCodeAt(i)] ?? -1;
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function bytesToBase64url(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    buffer = (buffer << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += B64_ALPHABET[(buffer >> bits) & 0x3f]!;
    }
  }
  if (bits > 0) out += B64_ALPHABET[(buffer << (6 - bits)) & 0x3f]!;
  return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ── digest + signature verification ──────────────────────────────────────────

/**
 * The 32-byte digest the passkey signs (and a verifier recomputes). Commits to a
 * domain separator + every attested field + the signing public key. Byte-for-byte
 * identical to the SDK's `sessionAttestationDigest` (same ABI layout + keccak256).
 */
export function sessionAttestationDigest(
  f: SessionAttestationFields,
  publicKey: P256PublicKey,
): Uint8Array {
  const encoded = encodeAbiParameters(
    [
      { type: 'string' },
      { type: 'string' },
      { type: 'string' },
      { type: 'address' },
      { type: 'uint256' },
      { type: 'bool' },
      { type: 'uint64' },
      { type: 'bytes32' },
      { type: 'bytes32' },
    ],
    [
      DIGEST_DOMAIN,
      f.scope,
      f.appPseudonym,
      // Normalise to a checksummed address for viem's encoder; the 20 encoded
      // bytes are case-independent, so the digest matches the SDK's ethers output.
      getAddress(f.accountAddress),
      BigInt(f.chainId),
      f.verified,
      BigInt(f.issuedAt),
      publicKey.qx,
      publicKey.qy,
    ],
  );
  return hexToBytes(keccak256(encoded));
}

/** Verify a raw 64-byte `r || s` P-256 signature over `digest`. Never throws. */
function verifyP256Digest(pub: P256PublicKey, digest: Uint8Array, signature: Hex): boolean {
  try {
    const sig = hexToBytes(signature);
    const point = hexToBytes(concatHex(['0x04', pub.qx, pub.qy]));
    return p256.verify(sig, digest, point);
  } catch {
    return false;
  }
}

/**
 * Verify a WebAuthn assertion blob (`abi.encode(WebAuthnAuth)`) over the expected
 * 32-byte `challenge`. Mirrors the SDK's `verifyWebAuthnAssertion` and the
 * on-chain `WebAuthnPasskeyAuthority`: confirms `type == "webauthn.get"`, the
 * embedded challenge equals `base64url(challenge)`, and the P-256 signature over
 * `sha256(authenticatorData || sha256(clientDataJSON))` validates. Never throws.
 */
function verifyWebAuthnAssertion(blob: Hex, challenge: Uint8Array, pub: P256PublicKey): boolean {
  let decoded: readonly [Hex, Hex, bigint, bigint, Hex, string];
  try {
    decoded = decodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'bytes' },
        { type: 'string' },
      ],
      blob,
    ) as readonly [Hex, Hex, bigint, bigint, Hex, string];
  } catch {
    return false;
  }

  const [r, s, , , authenticatorDataHex, clientDataJSON] = decoded;

  let parsed: { type?: unknown; challenge?: unknown };
  try {
    parsed = JSON.parse(clientDataJSON) as { type?: unknown; challenge?: unknown };
  } catch {
    return false;
  }
  if (parsed.type !== 'webauthn.get') return false;
  if (parsed.challenge !== bytesToBase64url(challenge)) return false;

  try {
    const authenticatorData = hexToBytes(authenticatorDataHex);
    const clientDataHash = hexToBytes(sha256(new TextEncoder().encode(clientDataJSON)));
    const messageHash = hexToBytes(sha256(concatBytes(authenticatorData, clientDataHash)));
    const sig = hexToBytes(concatHex([r, s]));
    const point = hexToBytes(concatHex(['0x04', pub.qx, pub.qy]));
    return p256.verify(sig, messageHash, point);
  } catch {
    return false;
  }
}

// ── decode + verify ──────────────────────────────────────────────────────────

/**
 * Parse an `attestation` token into a structurally-valid `SessionAttestation`.
 * Throws `SessionAttestationDecodeError` on any malformation. Does NOT verify
 * the signature — call `verifySessionAttestation`.
 */
export function decodeSessionAttestation(token: unknown): SessionAttestation {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) {
    throw new SessionAttestationDecodeError('not a Cofferdam session-attestation token.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64urlToBytes(token.slice(PREFIX.length))));
  } catch {
    throw new SessionAttestationDecodeError('session-attestation payload is not valid base64url JSON.');
  }
  return assertWellFormed(parsed);
}

/** Fields a verifier may pin so a captured attestation cannot be re-pointed. */
export type SessionAttestationExpectation = Partial<
  Pick<SessionAttestationFields, 'scope' | 'appPseudonym' | 'accountAddress' | 'chainId'>
>;

export interface VerifyOptions {
  expect?: SessionAttestationExpectation;
  /** Reject attestations older than this (ms). 0/undefined skips the check. */
  maxAgeMs?: number;
  now?: number;
}

/**
 * Verify a decoded attestation: optional freshness + optional `expect` field pins
 * + the passkey signature over exactly these fields. Throws on any failure. On
 * success the payload is trustworthy: the holder of `publicKey` signed precisely
 * this `(scope, appPseudonym, accountAddress, …)`.
 */
export function verifySessionAttestation(att: SessionAttestation, opts: VerifyOptions = {}): void {
  const maxAgeMs = opts.maxAgeMs ?? 0;
  const now = opts.now ?? Date.now();
  if (maxAgeMs > 0 && (now - att.issuedAt > maxAgeMs || att.issuedAt - now > 60_000)) {
    throw new SessionAttestationExpiredError(
      `session attestation is stale or clock-skewed (issuedAt=${att.issuedAt}, now=${now}).`,
    );
  }

  const expect = opts.expect;
  if (expect) {
    for (const key of ['scope', 'appPseudonym', 'accountAddress', 'chainId'] as const) {
      const want = expect[key];
      if (want === undefined) continue;
      const got = att[key];
      const matches =
        key === 'accountAddress'
          ? String(got).toLowerCase() === String(want).toLowerCase()
          : got === want;
      if (!matches) {
        throw new SessionAttestationVerificationError(
          `session attestation ${key} mismatch (expected ${String(want)}, got ${String(got)}).`,
        );
      }
    }
  }

  const digest = sessionAttestationDigest(att, att.publicKey);
  const ok =
    att.alg === 'webauthn'
      ? verifyWebAuthnAssertion(att.sig, digest, att.publicKey)
      : verifyP256Digest(att.publicKey, digest, att.sig);
  if (!ok) {
    throw new SessionAttestationVerificationError(
      'session attestation signature failed: not signed by the presented passkey.',
    );
  }
}

/** Convenience: decode + verify in one call, returning the trusted payload. */
export function decodeAndVerifySessionAttestation(
  token: unknown,
  opts?: VerifyOptions,
): SessionAttestation {
  const att = decodeSessionAttestation(token);
  verifySessionAttestation(att, opts);
  return att;
}

/** `abi.encode(bytes32 qx, bytes32 qy)` — the on-chain passkey authority config blob. */
export function encodePasskeyConfig(pub: P256PublicKey): Hex {
  return encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [pub.qx, pub.qy]);
}

function assertWellFormed(p: unknown): SessionAttestation {
  if (!p || typeof p !== 'object') {
    throw new SessionAttestationDecodeError('session-attestation payload is not an object.');
  }
  const o = p as Record<string, unknown>;
  if (o.v !== SESSION_ATTESTATION_VERSION) {
    throw new SessionAttestationDecodeError(
      `unsupported session-attestation version ${String(o.v)} (expected ${SESSION_ATTESTATION_VERSION}).`,
    );
  }
  if (o.alg !== 'p256' && o.alg !== 'webauthn') {
    throw new SessionAttestationDecodeError(`unsupported session-attestation alg ${String(o.alg)}.`);
  }
  const pk = o.publicKey as Record<string, unknown> | undefined;
  if (
    !pk ||
    typeof pk.qx !== 'string' ||
    typeof pk.qy !== 'string' ||
    !HEX32_RE.test(pk.qx) ||
    !HEX32_RE.test(pk.qy)
  ) {
    throw new SessionAttestationDecodeError('session-attestation publicKey (qx/qy) is malformed.');
  }
  if (typeof o.scope !== 'string' || o.scope.length === 0) {
    throw new SessionAttestationDecodeError('session-attestation scope is missing.');
  }
  if (typeof o.appPseudonym !== 'string' || o.appPseudonym.length === 0) {
    throw new SessionAttestationDecodeError('session-attestation appPseudonym is missing.');
  }
  if (typeof o.accountAddress !== 'string' || !ADDRESS_RE.test(o.accountAddress)) {
    throw new SessionAttestationDecodeError('session-attestation accountAddress is not an address.');
  }
  if (typeof o.chainId !== 'number' || !Number.isInteger(o.chainId) || o.chainId <= 0) {
    throw new SessionAttestationDecodeError('session-attestation chainId is missing or invalid.');
  }
  if (typeof o.verified !== 'boolean') {
    throw new SessionAttestationDecodeError('session-attestation verified flag is missing.');
  }
  if (typeof o.issuedAt !== 'number' || !Number.isFinite(o.issuedAt) || o.issuedAt <= 0) {
    throw new SessionAttestationDecodeError('session-attestation issuedAt is missing or invalid.');
  }
  if (typeof o.sig !== 'string' || !o.sig.startsWith('0x')) {
    throw new SessionAttestationDecodeError('session-attestation sig is missing.');
  }
  return {
    v: SESSION_ATTESTATION_VERSION,
    alg: o.alg,
    publicKey: { qx: pk.qx as Hex, qy: pk.qy as Hex },
    scope: o.scope,
    appPseudonym: o.appPseudonym,
    accountAddress: o.accountAddress,
    chainId: o.chainId,
    verified: o.verified,
    issuedAt: o.issuedAt,
    sig: o.sig as Hex,
  };
}
