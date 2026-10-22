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
  recoverMessageAddress,
  sha256,
  type Address,
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

/**
 * What a gate needs from a verified passkey session, whichever version carried
 * it: v1 bearer envelopes and v2 device-bound ones both satisfy it.
 */
export type PasskeySession = Omit<SessionAttestation, 'v' | 'sig'>;

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
  checkFreshnessAndPins(att, opts);

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

/** Freshness (`maxAgeMs`, 60 s of future skew) and the optional field pins, shared by both envelopes. */
function checkFreshnessAndPins(fields: SessionAttestationFields, opts: VerifyOptions): void {
  const maxAgeMs = opts.maxAgeMs ?? 0;
  const now = opts.now ?? Date.now();
  if (maxAgeMs > 0 && (now - fields.issuedAt > maxAgeMs || fields.issuedAt - now > 60_000)) {
    throw new SessionAttestationExpiredError(
      `session attestation is stale or clock-skewed (issuedAt=${fields.issuedAt}, now=${now}).`,
    );
  }

  const expect = opts.expect;
  if (expect) {
    for (const key of ['scope', 'appPseudonym', 'accountAddress', 'chainId'] as const) {
      const want = expect[key];
      if (want === undefined) continue;
      const got = fields[key];
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
}

// ── the Managed lane's envelope: `csa-sess1.<base64url(json)>.<0x sig>` ─────

/** Prefix of the SDK's session-lane envelope (`NativeAccountProvider.signSessionModeAttestation`). */
export const SESSION_SIGNER_PREFIX = 'csa-sess1.';

export interface SessionSignerAttestation {
  fields: SessionAttestationFields;
  /** The EIP-191 signer recovered from the envelope: the `SessionKeyAuthority` key. */
  signer: Address;
}

/**
 * Decode and verify the Managed lane's envelope. The SDK signs
 * `keccak256(utf8(JSON.stringify(fields)))` with the server-held session signer
 * through `signMessage` (EIP-191 over those 32 bytes). Applies the same
 * freshness and pins as `verifySessionAttestation` and returns the recovered
 * signer; the caller decides whether that signer is an authority on the account.
 */
export async function decodeAndVerifySessionSignerAttestation(
  token: unknown,
  opts: VerifyOptions = {},
): Promise<SessionSignerAttestation> {
  if (typeof token !== 'string' || !token.startsWith(SESSION_SIGNER_PREFIX)) {
    throw new SessionAttestationDecodeError('not a Cofferdam session-signer attestation token.');
  }
  const parts = token.slice(SESSION_SIGNER_PREFIX.length).split('.');
  const [payload, sig] = parts;
  if (parts.length !== 2 || !payload || !sig || !/^0x[0-9a-fA-F]{130}$/.test(sig)) {
    throw new SessionAttestationDecodeError('session-signer attestation must be csa-sess1.<payload>.<0x sig>.');
  }
  let bytes: Uint8Array;
  let parsed: unknown;
  try {
    bytes = base64urlToBytes(payload);
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SessionAttestationDecodeError('session-signer attestation payload is not valid base64url JSON.');
  }
  const fields = assertSessionFields(parsed);
  checkFreshnessAndPins(fields, opts);
  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message: { raw: keccak256(bytes) }, signature: sig as Hex });
  } catch {
    throw new SessionAttestationVerificationError('session-signer attestation signature is not recoverable.');
  }
  return { fields, signer: getAddress(signer) };
}

// ── v2: device-bound, tiered, expiring (workspace decision 0055) ─────────────
//
// Mirrors cofferdam-sdk identity/sessionAttestation.ts (v2) and identity/popProof.ts
// byte for byte: the same digest layout and the same proof checks. The fixed
// vector in test/sessionAttestation.test.ts is the SDK's, asserted on both sides.

/** Wire-format version of the device-bound envelope. */
export const SESSION_ATTESTATION_V2 = 2;

const DIGEST_DOMAIN_V2 = 'cofferdam-session-attestation-v2';

/** The audience of tokens the plane accepts. */
export const CSA_AUDIENCE_PLANE = 'cofferdam-plane';

/** Fast: everyday features. Slow: one security-critical action. */
export type SessionTier = 'fast' | 'slow';

/** The longest lifetime the plane accepts for each tier. */
export const SESSION_TIER_MAX_LIFETIME_MS: Readonly<Record<SessionTier, number>> = {
  fast: 24 * 60 * 60 * 1000,
  slow: 10 * 60 * 1000,
};

const JKT_RE = /^[A-Za-z0-9_-]{43}$/;
const JTI_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** How far a proof's `iat` may sit from the plane's clock, in seconds. */
export const POP_MAX_SKEW_S = 60;

/** A decoded v2 envelope (`cnf.jkt` names the device key). */
export interface SessionAttestationV2 extends SessionAttestationFields {
  v: 2;
  alg: AttestationScheme;
  publicKey: P256PublicKey;
  expiresAt: number;
  aud: string;
  tier: SessionTier;
  cnf: { jkt: string };
  sig: Hex;
}

/** The 32-byte digest the passkey signs for a v2 envelope. */
export function sessionAttestationV2Digest(
  f: SessionAttestationFields & { expiresAt: number; aud: string; tier: SessionTier; jkt: string },
  publicKey: P256PublicKey,
): Uint8Array {
  const jkt = base64urlToBytes(f.jkt);
  if (jkt.length !== 32) throw new SessionAttestationDecodeError('jkt must be a 32-byte thumbprint.');
  const encoded = encodeAbiParameters(
    [
      { type: 'string' },
      { type: 'string' },
      { type: 'string' },
      { type: 'address' },
      { type: 'uint256' },
      { type: 'bool' },
      { type: 'uint64' },
      { type: 'uint64' },
      { type: 'string' },
      { type: 'string' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'bytes32' },
    ],
    [
      DIGEST_DOMAIN_V2,
      f.scope,
      f.appPseudonym,
      getAddress(f.accountAddress),
      BigInt(f.chainId),
      f.verified,
      BigInt(f.issuedAt),
      BigInt(f.expiresAt),
      f.aud,
      f.tier,
      bytesToHex32(jkt),
      publicKey.qx,
      publicKey.qy,
    ],
  );
  return hexToBytes(keccak256(encoded));
}

function bytesToHex32(b: Uint8Array): Hex {
  let out = '0x';
  for (const byte of b) out += byte.toString(16).padStart(2, '0');
  return out as Hex;
}

/** The version of a `csa1:` token (1 or 2), without verifying it. */
export function sessionAttestationVersion(token: unknown): number {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) {
    throw new SessionAttestationDecodeError('not a Cofferdam session-attestation token.');
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64urlToBytes(token.slice(PREFIX.length))));
    return typeof parsed?.v === 'number' ? parsed.v : 0;
  } catch {
    throw new SessionAttestationDecodeError('session-attestation payload is not valid base64url JSON.');
  }
}

/** Parse a v2 token into a structurally valid envelope. Does not verify it. */
export function decodeSessionAttestationV2(token: unknown): SessionAttestationV2 {
  if (typeof token !== 'string' || !token.startsWith(PREFIX)) {
    throw new SessionAttestationDecodeError('not a Cofferdam session-attestation token.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64urlToBytes(token.slice(PREFIX.length))));
  } catch {
    throw new SessionAttestationDecodeError('session-attestation payload is not valid base64url JSON.');
  }
  const o = (parsed ?? {}) as Record<string, unknown>;
  if (o.v !== SESSION_ATTESTATION_V2) {
    throw new SessionAttestationDecodeError(`expected a v2 session attestation, got ${String(o.v)}.`);
  }
  const base = assertWellFormed({ ...o, v: SESSION_ATTESTATION_VERSION });
  const cnf = o.cnf as Record<string, unknown> | undefined;
  if (!cnf || typeof cnf.jkt !== 'string' || !JKT_RE.test(cnf.jkt)) {
    throw new SessionAttestationDecodeError('session-attestation cnf.jkt is missing or malformed.');
  }
  if (typeof o.expiresAt !== 'number' || !Number.isFinite(o.expiresAt) || o.expiresAt <= 0) {
    throw new SessionAttestationDecodeError('session-attestation expiresAt is missing or invalid.');
  }
  if (typeof o.aud !== 'string' || o.aud.length === 0) {
    throw new SessionAttestationDecodeError('session-attestation aud is missing.');
  }
  if (o.tier !== 'fast' && o.tier !== 'slow') {
    throw new SessionAttestationDecodeError('session-attestation tier must be fast or slow.');
  }
  const { v: _v, ...fields } = base;
  return {
    v: SESSION_ATTESTATION_V2,
    ...fields,
    expiresAt: o.expiresAt,
    aud: o.aud,
    tier: o.tier,
    cnf: { jkt: cnf.jkt },
  };
}

/**
 * Verify a v2 envelope: the tier's lifetime cap, not expired, not issued in the
 * future (60 s of skew), the audience, the optional pins and the passkey
 * signature. Device possession is a separate check (`verifyPopProof`).
 */
export function verifySessionAttestationV2(
  att: SessionAttestationV2,
  opts: { audience?: string; expect?: SessionAttestationExpectation; now?: number } = {},
): void {
  const now = opts.now ?? Date.now();
  const cap = SESSION_TIER_MAX_LIFETIME_MS[att.tier];
  if (att.expiresAt <= att.issuedAt || att.expiresAt - att.issuedAt > cap) {
    throw new SessionAttestationVerificationError(`a ${att.tier} session attestation may live at most ${cap} ms.`);
  }
  if (now >= att.expiresAt || att.issuedAt - now > 60_000) {
    throw new SessionAttestationExpiredError(
      `session attestation is expired or clock-skewed (issuedAt=${att.issuedAt}, expiresAt=${att.expiresAt}, now=${now}).`,
    );
  }
  const audience = opts.audience ?? CSA_AUDIENCE_PLANE;
  if (att.aud !== audience) {
    throw new SessionAttestationVerificationError(`session attestation aud mismatch (expected ${audience}, got ${att.aud}).`);
  }
  checkFreshnessAndPins(att, { expect: opts.expect });
  const digest = sessionAttestationV2Digest({ ...att, jkt: att.cnf.jkt }, att.publicKey);
  const ok =
    att.alg === 'webauthn'
      ? verifyWebAuthnAssertion(att.sig, digest, att.publicKey)
      : verifyP256Digest(att.publicKey, digest, att.sig);
  if (!ok) {
    throw new SessionAttestationVerificationError('session attestation signature failed: not signed by the presented passkey.');
  }
}

/** Convenience: decode + verify a v2 token. */
export function decodeAndVerifySessionAttestationV2(
  token: unknown,
  opts?: { audience?: string; expect?: SessionAttestationExpectation; now?: number },
): SessionAttestationV2 {
  const att = decodeSessionAttestationV2(token);
  verifySessionAttestationV2(att, opts);
  return att;
}

/** A proof that failed to decode or verify. */
export class PopProofError extends SessionAttestationError {}

/** RFC 7638 thumbprint of a P-256 public key. */
export function jwkThumbprint(pub: P256PublicKey): string {
  const x = bytesToBase64url(hexToBytes(pub.qx));
  const y = bytesToBase64url(hexToBytes(pub.qy));
  return bytesToBase64url(hexToBytes(sha256(new TextEncoder().encode(`{"crv":"P-256","kty":"EC","x":"${x}","y":"${y}"}`))));
}

/** The URL a proof names: origin and path, without query or fragment. */
export function popHtu(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

/** `ath` for a token: base64url(SHA-256(token)). */
export function popAth(token: string): string {
  return bytesToBase64url(hexToBytes(sha256(new TextEncoder().encode(token))));
}

/**
 * Check a proof against the request and the token it accompanies. Returns the
 * signing key's thumbprint and the proof's `jti`; the caller compares the
 * thumbprint with the token's `cnf.jkt` and records the `jti` once.
 */
export function verifyPopProof(
  proof: unknown,
  expect: { token: string; htm: string; htu: string; now?: number; maxSkewS?: number },
): { jkt: string; jti: string; iat: number } {
  const parts = typeof proof === 'string' ? proof.split('.') : [];
  if (parts.length !== 3) throw new PopProofError('a proof is a compact JWS (three parts).');
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(base64urlToBytes(parts[0]!)));
    payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(parts[1]!)));
  } catch {
    throw new PopProofError('proof header or payload is not base64url JSON.');
  }
  if (header.typ !== 'dpop+jwt' || header.alg !== 'ES256') {
    throw new PopProofError('proof must be typ dpop+jwt, alg ES256.');
  }
  const jwk = header.jwk as Record<string, unknown> | undefined;
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || 'd' in jwk) {
    throw new PopProofError('proof jwk must be a public P-256 key.');
  }
  const x = base64urlToBytes(jwk.x);
  const y = base64urlToBytes(jwk.y);
  if (x.length !== 32 || y.length !== 32) throw new PopProofError('proof jwk coordinates must be 32 bytes.');
  const pub: P256PublicKey = { qx: bytesToHex32(x), qy: bytesToHex32(y) };

  const sig = base64urlToBytes(parts[2]!);
  const digest = hexToBytes(sha256(new TextEncoder().encode(`${parts[0]}.${parts[1]}`)));
  let valid = false;
  try {
    valid = sig.length === 64 && p256.verify(sig, digest, hexToBytes(concatHex(['0x04', pub.qx, pub.qy])), { lowS: false });
  } catch {
    valid = false;
  }
  if (!valid) throw new PopProofError('proof signature failed.');

  const { htm, htu, iat, jti, ath } = payload;
  if (typeof htm !== 'string' || htm !== expect.htm.toUpperCase()) {
    throw new PopProofError('proof htm does not match the request method.');
  }
  if (typeof htu !== 'string' || htu !== popHtu(expect.htu)) {
    throw new PopProofError('proof htu does not match the request URL.');
  }
  const nowS = Math.floor((expect.now ?? Date.now()) / 1000);
  if (typeof iat !== 'number' || !Number.isInteger(iat) || Math.abs(nowS - iat) > (expect.maxSkewS ?? POP_MAX_SKEW_S)) {
    throw new PopProofError('proof iat is missing or outside the allowed window.');
  }
  if (typeof jti !== 'string' || !JTI_RE.test(jti)) {
    throw new PopProofError('proof jti must be 16 to 64 base64url characters.');
  }
  if (typeof ath !== 'string' || ath !== popAth(expect.token)) {
    throw new PopProofError('proof ath does not match the session token.');
  }
  return { jkt: jwkThumbprint(pub), jti, iat };
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
  const fields = assertSessionFields(o);
  if (typeof o.sig !== 'string' || !o.sig.startsWith('0x')) {
    throw new SessionAttestationDecodeError('session-attestation sig is missing.');
  }
  return {
    v: SESSION_ATTESTATION_VERSION,
    alg: o.alg,
    publicKey: { qx: pk.qx as Hex, qy: pk.qy as Hex },
    ...fields,
    sig: o.sig as Hex,
  };
}

/** The six signed sign-in fields, as both envelopes carry them. */
function assertSessionFields(p: unknown): SessionAttestationFields {
  if (!p || typeof p !== 'object') {
    throw new SessionAttestationDecodeError('session-attestation payload is not an object.');
  }
  const o = p as Record<string, unknown>;
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
  return {
    scope: o.scope,
    appPseudonym: o.appPseudonym,
    accountAddress: o.accountAddress,
    chainId: o.chainId,
    verified: o.verified,
    issuedAt: o.issuedAt,
  };
}
