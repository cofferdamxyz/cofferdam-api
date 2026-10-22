// Copyright (c) 2026 Cofferdam Inc
// SPDX-License-Identifier: Apache-2.0

/**
 * `csa1:` v2 on the plane (workspace decision 0055): the SDK's fixed vector and
 * real SDK-made tokens and proofs (`fixtures/sdk-attestations-v2.json`, from
 * cofferdam-sdk's `gen-attestation-v2-fixtures.mjs`) verified by this Worker's
 * own viem/@noble code; the session gate's rules; the replay cache's SQL on
 * node:sqlite; and the chat route end to end.
 */

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { p256 } from '@noble/curves/p256';
import { hexToBytes, sha256, type Address, type Hex } from 'viem';

import { createChatRoutes, type ChatRouteDeps } from '../src/routes/chat.js';
import { sessionRoutes } from '../src/routes/session.js';
import type { AuthorityCheck } from '../src/services/authorityCheck.js';
import { createAuthorityMemo } from '../src/services/chat/authorityMemo.js';
import { claimOnce, migrateReplayTable, type ReplaySql, type ReplayStore } from '../src/services/popReplayStore.js';
import {
  CSA_AUDIENCE_PLANE,
  decodeAndVerifySessionAttestationV2,
  decodeSessionAttestationV2,
  jwkThumbprint,
  popAth,
  sessionAttestationV2Digest,
  verifyPopProof,
  PopProofError,
  SessionAttestationExpiredError,
  SessionAttestationVerificationError,
} from '../src/services/sessionAttestation.js';
import { checkSession, isRefusal, type SessionGateInput, type SessionGateOptions } from '../src/services/sessionGate.js';

import v1 from './fixtures/sdk-attestations.json';
import v2 from './fixtures/sdk-attestations-v2.json';

const ACCOUNT = v2.account as Address;
const NOW = v2.issuedAt + 1_000;
const ORIGIN = v2.origin;

// ── helpers: an independent proof signer (noble + viem, not the SDK) ─────────

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

function signProof(opts: {
  priv?: Hex;
  htm: string;
  htu: string;
  token: string;
  iat?: number;
  jti?: string;
}): string {
  const priv = hexToBytes(opts.priv ?? (v2.devicePrivateKey as Hex));
  const pub = p256.getPublicKey(priv, false);
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: 'EC', crv: 'P-256', x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)) } };
  const payload = {
    htm: opts.htm,
    htu: opts.htu,
    iat: opts.iat ?? Math.floor(NOW / 1000),
    jti: opts.jti ?? b64url(crypto.getRandomValues(new Uint8Array(16))),
    ath: popAth(opts.token),
  };
  const input = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = p256.sign(hexToBytes(sha256(new TextEncoder().encode(input))), priv);
  return `${input}.${b64url(sig.toCompactRawBytes())}`;
}

function memoryReplay(): ReplayStore & { keys: string[] } {
  const seen = new Map<string, number>();
  const keys: string[] = [];
  return {
    keys,
    async claim(jkt, key, expiresAt, now) {
      keys.push(`${jkt}|${key}`);
      const k = `${jkt}|${key}`;
      if ((seen.get(k) ?? 0) > now) return false;
      seen.set(k, expiresAt);
      return true;
    },
  };
}

// ── the cross-repo vector ────────────────────────────────────────────────────

describe('cross-repo vector (cofferdam-sdk test/sessionAttestationV2.test.ts)', () => {
  it('computes the same RFC 7638 thumbprint and v2 digest as the SDK', () => {
    const device = { qx: '0x7135fa4fd93a09dce98bbf681b4bfcf50e7c0d6354e62afb0bff2a3429617865', qy: '0xed4c1f02ddb9023ee56a557e515d6a9dc66c11f220960de594334df588776724' } as const;
    const passkey = { qx: '0x53893fab71902b7b55efa2b1d9fdc7f054921ecfda6bc8099dcae74f16232857', qy: '0x60f179319b73586046253adcab8b5be3ac177f7b3b2b7f018bfc6b0d22eb49a7' } as const;
    const jkt = jwkThumbprint(device);
    expect(jkt).toBe('wn8-axFKnOFEnnaYJBgkGYUyDjm328I-jp-j7aegW-k');
    const digest = sessionAttestationV2Digest(
      {
        scope: 'cofferdam-app',
        appPseudonym: 'pseudo-1',
        accountAddress: '0x' + 'ab'.repeat(20),
        chainId: 84532,
        verified: true,
        issuedAt: 1_800_000_000_000,
        expiresAt: 1_800_000_000_000 + 60 * 60 * 1000,
        aud: CSA_AUDIENCE_PLANE,
        tier: 'fast',
        jkt,
      },
      passkey,
    );
    expect(b64url(digest)).toBe(b64url(hexToBytes('0xe2e1be400f26d5af47276a7aca381905e52d779e10fef262745fe766c262ab64')));
  });
});

// ── real SDK tokens and proofs ───────────────────────────────────────────────

describe('SDK-made v2 tokens and proofs', () => {
  for (const scheme of ['p256', 'webauthn'] as const) {
    const fx = v2.tokens[scheme];
    it(`verifies the ${scheme} fast and slow tokens and their proofs`, () => {
      const fast = decodeAndVerifySessionAttestationV2(fx.fast, { now: NOW, expect: { accountAddress: ACCOUNT } });
      expect(fast).toMatchObject({ tier: 'fast', alg: scheme, cnf: { jkt: v2.jkt } });
      const slow = decodeAndVerifySessionAttestationV2(fx.slow, { now: NOW });
      expect(slow.tier).toBe('slow');
      expect(verifyPopProof(fx.proofs.chat, { token: fx.fast, htm: 'POST', htu: `${ORIGIN}/v1/chat`, now: NOW }).jkt).toBe(v2.jkt);
      expect(verifyPopProof(fx.proofs.usage, { token: fx.fast, htm: 'GET', htu: `${ORIGIN}/v1/chat/usage?account=${ACCOUNT}`, now: NOW }).jkt).toBe(v2.jkt);
    });
  }

  it('refuses expired, wrong-audience and tampered tokens, and mismatched proofs', () => {
    const fx = v2.tokens.p256;
    expect(() => decodeAndVerifySessionAttestationV2(fx.slow, { now: v2.issuedAt + 10 * 60 * 1000 })).toThrow(SessionAttestationExpiredError);
    expect(() => decodeAndVerifySessionAttestationV2(fx.fast, { now: NOW, audience: 'partner-x' })).toThrow(SessionAttestationVerificationError);
    const att = decodeSessionAttestationV2(fx.fast);
    const forged = 'csa1:' + b64urlJson({ ...att, tier: 'slow', expiresAt: att.issuedAt + 60_000 });
    expect(() => decodeAndVerifySessionAttestationV2(forged, { now: NOW })).toThrow(SessionAttestationVerificationError);
    expect(() => verifyPopProof(fx.proofs.chat, { token: fx.slow, htm: 'POST', htu: `${ORIGIN}/v1/chat`, now: NOW })).toThrow(PopProofError);
    expect(() => verifyPopProof(fx.proofs.chat, { token: fx.fast, htm: 'GET', htu: `${ORIGIN}/v1/chat`, now: NOW })).toThrow(PopProofError);
    expect(() => verifyPopProof(fx.proofs.chat, { token: fx.fast, htm: 'POST', htu: `${ORIGIN}/v1/chat`, now: NOW + 120_000 })).toThrow(PopProofError);
  });
});

// ── the gate ─────────────────────────────────────────────────────────────────

describe('checkSession', () => {
  const fx = v2.tokens.p256;
  const url = `${ORIGIN}/v1/chat`;
  const input = (over: Partial<SessionGateInput> = {}): SessionGateInput => ({
    env: { ENVIRONMENT: 'staging' } as never,
    authorization: `DPoP ${fx.fast}`,
    proof: signProof({ htm: 'POST', htu: url, token: fx.fast }),
    method: 'POST',
    url,
    ...over,
  });
  const opts = (over: Partial<SessionGateOptions> = {}): SessionGateOptions => ({
    account: ACCOUNT,
    requiredTier: 'fast',
    v1MaxAgeMs: 60 * 60 * 1000,
    now: NOW,
    replay: memoryReplay(),
    ...over,
  });

  it('grants a fast token with its proof, and refuses the same proof again', async () => {
    const replay = memoryReplay();
    const req = input();
    const first = await checkSession(req, opts({ replay }));
    expect(isRefusal(first)).toBe(false);
    if (!isRefusal(first)) expect(first).toMatchObject({ tier: 'fast', session: { accountAddress: ACCOUNT } });
    const again = await checkSession(req, opts({ replay }));
    expect(again).toMatchObject({ status: 401, body: { error: 'proof_rejected' } });
    expect(replay.keys[0]).toMatch(new RegExp(`^${v2.jkt}\\|jti:`));
  });

  it('asks for a step-up on a slow route, and grants the slow token there', async () => {
    expect(await checkSession(input(), opts({ requiredTier: 'slow' }))).toMatchObject({
      status: 401,
      body: { error: 'step_up_required', requiredTier: 'slow' },
    });
    const slow = input({ authorization: `DPoP ${fx.slow}`, proof: signProof({ htm: 'POST', htu: url, token: fx.slow }) });
    const granted = await checkSession(slow, opts({ requiredTier: 'slow' }));
    expect(isRefusal(granted)).toBe(false);
  });

  it('refuses a missing proof, a proof by another key and a token for another account', async () => {
    expect(await checkSession(input({ proof: undefined }), opts())).toMatchObject({ body: { error: 'proof_required' } });
    const stranger = signProof({ priv: `0x${'11'.repeat(32)}`, htm: 'POST', htu: url, token: fx.fast });
    expect(await checkSession(input({ proof: stranger }), opts())).toMatchObject({ body: { error: 'proof_rejected' } });
    expect(await checkSession(input(), opts({ account: `0x${'cd'.repeat(20)}` as Address }))).toMatchObject({
      body: { error: 'attestation_rejected' },
    });
  });

  it('answers 503 rather than skip the replay check outside development', async () => {
    expect(await checkSession(input(), opts({ replay: null }))).toMatchObject({
      status: 503,
      body: { error: 'replay_store_unavailable' },
    });
    const dev = await checkSession(input({ env: { ENVIRONMENT: 'development' } as never }), opts({ replay: null }));
    expect(isRefusal(dev)).toBe(false);
  });

  it('accepts a v1 bearer token until CSA1_V1_ACCEPTED is "false"', async () => {
    const legacy = input({ authorization: `Bearer ${v1.p256.token}`, proof: undefined });
    const at = { now: v1.fields.issuedAt + 1_000, account: v1.fields.accountAddress as Address };
    const granted = await checkSession(legacy, opts(at));
    expect(granted).toMatchObject({ tier: 'legacy' });
    const off = await checkSession({ ...legacy, env: { ENVIRONMENT: 'staging', CSA1_V1_ACCEPTED: 'false' } as never }, opts(at));
    expect(off).toMatchObject({ status: 401, body: { error: 'attestation_rejected' } });
  });
});

// ── the replay cache's SQL ───────────────────────────────────────────────────

describe('the replay cache SQL, on node:sqlite', () => {
  function sqlite(): ReplaySql {
    const db = new DatabaseSync(':memory:');
    return {
      exec(query, ...bindings) {
        const rows = db.prepare(query).all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows };
      },
    };
  }

  it('claims a key once until it lapses, and sweeps lapsed rows', () => {
    const sql = sqlite();
    migrateReplayTable(sql);
    migrateReplayTable(sql);
    expect(claimOnce(sql, 'jti:a', 2_000, 1_000)).toBe(true);
    expect(claimOnce(sql, 'jti:a', 2_500, 1_500)).toBe(false);
    expect(claimOnce(sql, 'jti:a', 4_000, 2_000)).toBe(true);
    expect(claimOnce(sql, 'jti:b', 3_000, 2_000)).toBe(true);
    expect(claimOnce(sql, 'jti:c', 9_000, 5_000)).toBe(true);
    expect(sql.exec('SELECT key FROM seen ORDER BY key').toArray().map((r) => r.key)).toEqual(['jti:c']);
  });
});

// ── the chat route, end to end ───────────────────────────────────────────────

describe('POST /v1/chat with csa1 v2', () => {
  const fx = v2.tokens.p256;
  const HIGH: AuthorityCheck = { status: 'active', authorityId: 0, module: ACCOUNT, tier: 3 };

  function send(deps: Partial<ChatRouteDeps>, headers: Record<string, string>) {
    const h = new Hono();
    h.route(
      '/v1/chat',
      createChatRoutes({
        attestationMaxAgeMs: 3_600_000,
        now: () => NOW,
        authorityCheck: async () => HIGH,
        authorityMemo: createAuthorityMemo({ edge: null }),
        inference: () => null,
        ...deps,
      }),
    );
    return h.request(
      '/v1/chat',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ account: ACCOUNT, messages: [{ role: 'user', text: 'hi' }] }),
      },
      { ENVIRONMENT: 'staging' } as never,
    );
  }

  it('passes the gate with an SDK-made fast token and proof, and refuses the proof replayed', async () => {
    const replay = memoryReplay();
    const headers = { authorization: `DPoP ${fx.fast}`, dpop: fx.proofs.chat };
    const first = await send({ replayStore: () => replay }, headers);
    // Past the gate, an unbound Workers AI answers 503; the gate itself refuses with 401.
    expect(first.status).not.toBe(401);
    const replayed = await send({ replayStore: () => replay }, headers);
    expect(replayed.status).toBe(401);
    expect(await replayed.json()).toMatchObject({ error: 'proof_rejected' });
  });

  it('refuses a v2 token without its proof', async () => {
    const res = await send({ replayStore: () => memoryReplay() }, { authorization: `DPoP ${fx.fast}` });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'proof_required' });
  });
});

describe('POST /v1/session/verify-attestation with csa1 v2', () => {
  it('verifies the envelope and reports its tier, expiry and device key', async () => {
    const h = new Hono();
    h.route('/v1/session', sessionRoutes);
    const res = await h.request('/v1/session/verify-attestation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attestation: v2.tokens.webauthn.fast, expect: { accountAddress: ACCOUNT } }),
    });
    // The fixture is from 2025: the verifier's clock says it has expired, which proves the expiry check runs.
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'attestation_expired' });
  });
});
