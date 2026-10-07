// Copyright (c) 2026 Cofferdam Inc
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end verification of the `@cofferdam/sdk` session attestation against
 * this Worker's verifier.
 *
 * The fixtures in `fixtures/sdk-attestations.json` are REAL tokens produced by
 * the SDK's `NativeAccountProvider.signIn()` path (ethers + the in-repo software
 * signers), captured via `cofferdam-sdk/packages/core/scripts/gen-attestation-fixtures.mjs`.
 * Verifying them here with the Worker's `viem` + `@noble/curves` implementation
 * proves the two codecs are byte-compatible — the whole point of the cross-repo
 * duplication called out in `services/sessionAttestation.ts`.
 *
 * We exercise BOTH signature schemes (`p256` and `webauthn`), the field-pin
 * (`expect`) and freshness (`maxAgeMs`) gates, tamper rejection, and the HTTP
 * surface (`POST /v1/session/verify-attestation`) end to end.
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { sessionRoutes } from '../src/routes/session.js';
import {
  decodeAndVerifySessionAttestation,
  decodeSessionAttestation,
  encodePasskeyConfig,
  SessionAttestationDecodeError,
  SessionAttestationExpiredError,
  SessionAttestationVerificationError,
  type AttestationScheme,
} from '../src/services/sessionAttestation.js';

import fixtures from './fixtures/sdk-attestations.json';

type SchemeFixture = {
  alg: AttestationScheme;
  publicKey: { qx: string; qy: string };
  token: string;
};

const SCHEMES: ReadonlyArray<[string, SchemeFixture]> = [
  ['p256', fixtures.p256 as SchemeFixture],
  ['webauthn', fixtures.webauthn as SchemeFixture],
];

const { fields } = fixtures;
// `issuedAt` is fixed in the committed fixtures; pin "now" relative to it so the
// freshness assertions stay deterministic regardless of when the suite runs.
const NOW = fields.issuedAt + 1_000;

describe('session attestation verifier (cross-repo, real SDK tokens)', () => {
  for (const [label, fx] of SCHEMES) {
    describe(label, () => {
      it('decodes + verifies an SDK-signed token', () => {
        const att = decodeAndVerifySessionAttestation(fx.token, { now: NOW });
        expect(att.alg).toBe(fx.alg);
        expect(att.publicKey).toEqual(fx.publicKey);
        expect(att.scope).toBe(fields.scope);
        expect(att.appPseudonym).toBe(fields.appPseudonym);
        expect(att.accountAddress.toLowerCase()).toBe(fields.accountAddress.toLowerCase());
        expect(att.chainId).toBe(fields.chainId);
        expect(att.verified).toBe(fields.verified);
        expect(att.issuedAt).toBe(fields.issuedAt);
      });

      it('verifies against pinned expectations', () => {
        expect(() =>
          decodeAndVerifySessionAttestation(fx.token, {
            now: NOW,
            expect: {
              scope: fields.scope,
              appPseudonym: fields.appPseudonym,
              accountAddress: fields.accountAddress.toUpperCase(),
              chainId: fields.chainId,
            },
          }),
        ).not.toThrow();
      });

      it('rejects a mismatched expectation', () => {
        expect(() =>
          decodeAndVerifySessionAttestation(fx.token, { now: NOW, expect: { scope: 'other-app' } }),
        ).toThrow(SessionAttestationVerificationError);
        expect(() =>
          decodeAndVerifySessionAttestation(fx.token, {
            now: NOW,
            expect: { accountAddress: '0x' + 'cd'.repeat(20) },
          }),
        ).toThrow(SessionAttestationVerificationError);
      });

      it('enforces freshness only when maxAgeMs is set', () => {
        // 2x past the bound → stale.
        const stale = fields.issuedAt + 10 * 60_000;
        expect(() =>
          decodeAndVerifySessionAttestation(fx.token, { now: stale, maxAgeMs: 5 * 60_000 }),
        ).toThrow(SessionAttestationExpiredError);
        // Default (no maxAgeMs) skips freshness but still verifies the signature.
        expect(() => decodeAndVerifySessionAttestation(fx.token, { now: stale })).not.toThrow();
      });

      it('rejects a tampered field (signature breaks)', () => {
        const att = decodeSessionAttestation(fx.token);
        const tampered = { ...att, accountAddress: '0x' + 'cd'.repeat(20) };
        expect(() =>
          decodeAndVerifySessionAttestation(reencode(tampered), { now: NOW }),
        ).toThrow(SessionAttestationVerificationError);
      });

      it('rejects a swapped signature scheme', () => {
        const att = decodeSessionAttestation(fx.token);
        const swapped = { ...att, alg: att.alg === 'p256' ? 'webauthn' : 'p256' };
        expect(() =>
          decodeAndVerifySessionAttestation(reencode(swapped), { now: NOW }),
        ).toThrow(SessionAttestationVerificationError);
      });

      it('derives the on-chain passkey config blob from the verified key', () => {
        const att = decodeSessionAttestation(fx.token);
        const config = encodePasskeyConfig(att.publicKey);
        // abi.encode(bytes32 qx, bytes32 qy) → 64 bytes → 0x + 128 hex chars.
        expect(config).toBe(`${fx.publicKey.qx}${fx.publicKey.qy.slice(2)}`);
      });
    });
  }

  it('rejects malformed tokens at decode time', () => {
    expect(() => decodeSessionAttestation('not-a-cofferdam-token')).toThrow(
      SessionAttestationDecodeError,
    );
    expect(() => decodeSessionAttestation('csa1:%%%not-base64%%%')).toThrow(
      SessionAttestationDecodeError,
    );
  });
});

describe('POST /v1/session/verify-attestation', () => {
  const app = new Hono();
  app.route('/v1/session', sessionRoutes);

  async function post(body: unknown) {
    const res = await app.request('/v1/session/verify-attestation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  for (const [label, fx] of SCHEMES) {
    it(`accepts a valid ${label} attestation and returns claims`, async () => {
      const { status, json } = await post({ attestation: fx.token });
      expect(status).toBe(200);
      expect(json.ok).toBe(true);
      const claims = json.claims as Record<string, unknown>;
      expect(claims.scope).toBe(fields.scope);
      expect(claims.appPseudonym).toBe(fields.appPseudonym);
      expect(claims.chainId).toBe(fields.chainId);
      expect(claims.alg).toBe(fx.alg);
      expect(claims.publicKey).toEqual(fx.publicKey);
      // Without checkOnChain there is no authority block.
      expect(json.authority).toBeUndefined();
    });

    it(`honours expect pins for ${label}`, async () => {
      const { status, json } = await post({
        attestation: fx.token,
        expect: { scope: 'wrong-scope' },
      });
      expect(status).toBe(400);
      expect(json.ok).toBe(false);
      expect(json.error).toBe('verification_failed');
    });
  }

  it('rejects a missing/invalid attestation field', async () => {
    const { status, json } = await post({ attestation: 123 });
    expect(status).toBe(400);
    expect(json.error).toBe('bad_attestation');
  });

  it('rejects a malformed token', async () => {
    const { status, json } = await post({ attestation: 'csa1:not-base64-json' });
    expect(status).toBe(400);
    expect(json.error).toBe('malformed_attestation');
  });

  it('rejects an expired attestation when maxAgeMs is set', async () => {
    const { status, json } = await post({ attestation: fixtures.p256.token, maxAgeMs: 1 });
    expect(status).toBe(400);
    expect(json.error).toBe('attestation_expired');
  });

  it('rejects invalid JSON bodies', async () => {
    const res = await app.request('/v1/session/verify-attestation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_json');
  });
});

/** Re-encode a (possibly tampered) decoded attestation back into a `csa1:` token. */
function reencode(att: unknown): string {
  const json = JSON.stringify(att);
  const b64 = Buffer.from(json, 'utf8').toString('base64url');
  return `csa1:${b64}`;
}
