// Copyright (c) 2026 Cofferdam Inc
// SPDX-License-Identifier: Apache-2.0

/** The ceremony co-sign gate (decision 0016) against fakes, and its route. */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { concat, keccak256, pad, type Address, type Hex } from 'viem';

import type { Env } from '../src/env.js';
import { createCeremonyRoutes } from '../src/routes/ceremony.js';
import {
  ACTION_ENROLL_FIRST_HIGH,
  CeremonyRequestError,
  TIER,
  ZERO_WORD,
  issueFirstHighAttestation,
  parseFirstHighBody,
  partnerIdOf,
  type AccountSnapshot,
  type CeremonyDeps,
  type FirstHighRequest,
} from '../src/services/ceremony.js';
import type { SignCeremonyRequest, SignCeremonyResponse } from '../src/services/attester.js';

const ACCOUNT: Address = '0x80967a159A00dcabe2DeAF86b68249acfc45C265';
const HIGH_MODULE: Address = '0xd62c4deDeD3E2fEF52c8733aa1c899C7714a87C5';
const MODULE_REGISTRY: Address = '0x5b437804978116fECe00DC1c983C9aDa24d4A8Ad';
const CEREMONY_REGISTRY: Address = '0x44A2B59d5D39f773C2e65469e0Dd3217E53823Af';
const PARTNER_MODULE: Address = '0xf1a9E1c2411DeaBA6F45630754dB1824779eC129';
const ATTESTER: Address = '0xC912bFE0AD345035606182c23495b6883AA0934D';
const PARTNER_ID: Hex = keccak256(new TextEncoder().encode('offshoresync'));
const CHALLENGE: Hex = `0x${'ab'.repeat(32)}`;
const CONFIG: Hex = `0x${'01'.repeat(32)}${'02'.repeat(32)}`;
const ASSERTION: Hex = `0x${'cd'.repeat(200)}`;
const NOW = 1_760_000_000;

/** `abi.encode(qx, qy, rpIdHash, partnerId, partnerSigner)`: 160 bytes. */
const partnerConfig = (): Hex =>
  concat([`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`, `0x${'33'.repeat(32)}`, PARTNER_ID, pad(ACCOUNT, { size: 32 })]);

const pins = { chainId: 84532n, moduleRegistry: MODULE_REGISTRY, ceremonyRegistry: CEREMONY_REGISTRY, highModule: HIGH_MODULE };

function snapshot(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    upgradeLocked: false,
    nonce: 3n,
    moduleRegistry: MODULE_REGISTRY,
    ceremonyRegistry: CEREMONY_REGISTRY,
    challenge: CHALLENGE,
    signer: { module: PARTNER_MODULE, tier: TIER.Partner, active: true, config: partnerConfig() },
    ...overrides,
  };
}

function fakeSign(seen: SignCeremonyRequest[], hash: Hex = `0x${'ee'.repeat(32)}`) {
  return async (req: SignCeremonyRequest): Promise<SignCeremonyResponse> => {
    seen.push(req);
    return {
      attesterAddress: ATTESTER,
      messageHash: hash,
      signature: `0x${'ff'.repeat(65)}`,
      chainId: req.chainId,
      account: req.account,
      action: req.action,
      nonce: req.nonce,
      notBefore: req.notBefore,
      expiry: req.expiry,
    };
  };
}

function deps(overrides: Partial<CeremonyDeps> = {}, seen: SignCeremonyRequest[] = []): CeremonyDeps {
  return {
    pins,
    readAccount: async () => snapshot(),
    verifyAssertion: async () => true,
    onChainCeremonyHash: async () => `0x${'ee'.repeat(32)}`,
    sign: fakeSign(seen),
    now: () => NOW,
    ...overrides,
  };
}

const request = (overrides: Partial<FirstHighRequest> = {}): FirstHighRequest => ({
  account: ACCOUNT,
  signerId: 0n,
  highModule: HIGH_MODULE,
  highConfig: CONFIG,
  highAssertion: ASSERTION,
  ...overrides,
});

async function codeOf(p: Promise<unknown>): Promise<[string, number]> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(CeremonyRequestError);
    const e = err as CeremonyRequestError;
    return [e.code, e.status];
  }
  throw new Error('expected a throw');
}

describe('parseFirstHighBody', () => {
  it('parses a good body and defaults the High module', () => {
    const r = parseFirstHighBody({ account: ACCOUNT.toLowerCase(), signerId: '1', highConfig: CONFIG, highAssertion: ASSERTION }, HIGH_MODULE);
    expect(r).toEqual({ account: ACCOUNT, signerId: 1n, highModule: HIGH_MODULE, highConfig: CONFIG, highAssertion: ASSERTION });
  });
  it('rejects malformed bodies', () => {
    const good = { account: ACCOUNT, signerId: 0, highConfig: CONFIG, highAssertion: ASSERTION };
    expect(() => parseFirstHighBody(null, HIGH_MODULE)).toThrow(/JSON object/);
    expect(() => parseFirstHighBody({ ...good, account: 'nope' }, HIGH_MODULE)).toThrow(/address/);
    expect(() => parseFirstHighBody({ ...good, signerId: -1 }, HIGH_MODULE)).toThrow(/signerId/);
    expect(() => parseFirstHighBody({ ...good, highConfig: '0x1234' }, HIGH_MODULE)).toThrow(/64 bytes/);
    expect(() => parseFirstHighBody({ ...good, highAssertion: '0x' }, HIGH_MODULE)).toThrow(/non-empty/);
    expect(() => parseFirstHighBody({ ...good, highAssertion: `0x${'00'.repeat(5000)}` }, HIGH_MODULE)).toThrow(/too large/);
  });
});

describe('partnerIdOf', () => {
  it('reads word 3 of a Partner config and zero for Managed', () => {
    expect(partnerIdOf(TIER.Partner, partnerConfig())).toBe(PARTNER_ID);
    expect(partnerIdOf(TIER.LowManaged, `0x${'00'.repeat(20)}`)).toBe(ZERO_WORD);
    expect(() => partnerIdOf(TIER.Partner, CONFIG)).toThrow(CeremonyRequestError);
  });
});

describe('issueFirstHighAttestation', () => {
  it('co-signs a Partner account with the account challenge, nonce and a ten-minute window', async () => {
    const seen: SignCeremonyRequest[] = [];
    const out = await issueFirstHighAttestation(deps({}, seen), request());
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      chainId: '84532',
      account: ACCOUNT,
      action: 'enroll-first-high',
      newKeyHash: keccak256(CONFIG),
      partnerId: PARTNER_ID,
      nonce: '3',
      notBefore: String(NOW - 60),
      expiry: String(NOW + 600),
    });
    expect(out).toMatchObject({
      account: ACCOUNT,
      signerId: '0',
      nonce: '3',
      challenge: CHALLENGE,
      highModule: HIGH_MODULE,
      newKeyHash: keccak256(CONFIG),
      partnerId: PARTNER_ID,
      attesterAddress: ATTESTER,
      ceremonyHash: `0x${'ee'.repeat(32)}`,
    });
    expect(out.attestation).toEqual({ notBefore: String(NOW - 60), expiry: String(NOW + 600), signature: `0x${'ff'.repeat(65)}` });
  });

  it('uses a zero partnerId for a Managed signer', async () => {
    const seen: SignCeremonyRequest[] = [];
    const managed = snapshot({ signer: { module: PARTNER_MODULE, tier: TIER.LowManaged, active: true, config: `0x${'00'.repeat(20)}` } });
    await issueFirstHighAttestation(deps({ readAccount: async () => managed }, seen), request());
    expect(seen[0]?.partnerId).toBe(ZERO_WORD);
  });

  it('refuses everything the contract would refuse, before touching the attester', async () => {
    const seen: SignCeremonyRequest[] = [];
    expect(await codeOf(issueFirstHighAttestation(deps({}, seen), request({ highModule: PARTNER_MODULE })))).toEqual(['high_module_not_allowed', 409]);
    expect(
      await codeOf(
        issueFirstHighAttestation(
          deps({ readAccount: async () => { throw new CeremonyRequestError('account_not_deployed', 'no code', 404); } }, seen),
          request(),
        ),
      ),
    ).toEqual(['account_not_deployed', 404]);
    expect(
      await codeOf(issueFirstHighAttestation(deps({ readAccount: async () => snapshot({ moduleRegistry: ACCOUNT }) }, seen), request())),
    ).toEqual(['not_a_cofferdam_account', 409]);
    expect(
      await codeOf(issueFirstHighAttestation(deps({ readAccount: async () => snapshot({ upgradeLocked: true }) }, seen), request())),
    ).toEqual(['high_already_exists', 409]);
    const high = snapshot({ signer: { module: HIGH_MODULE, tier: TIER.High, active: true, config: CONFIG } });
    expect(await codeOf(issueFirstHighAttestation(deps({ readAccount: async () => high }, seen), request()))).toEqual(['signer_not_eligible', 409]);
    const inactive = snapshot({ signer: { ...snapshot().signer, active: false } });
    expect(await codeOf(issueFirstHighAttestation(deps({ readAccount: async () => inactive }, seen), request()))).toEqual(['signer_not_eligible', 409]);
    expect(await codeOf(issueFirstHighAttestation(deps({ verifyAssertion: async () => false }, seen), request()))).toEqual(['assertion_invalid', 422]);
    expect(seen).toHaveLength(0);
  });

  it('fails closed when the attester hash differs from the account ceremonyHash', async () => {
    expect(
      await codeOf(issueFirstHighAttestation(deps({ onChainCeremonyHash: async () => `0x${'dd'.repeat(32)}` }), request())),
    ).toEqual(['ceremony_hash_mismatch', 500]);
  });
});

describe('POST /v1/ceremony/first-high', () => {
  const env = {} as unknown as Env;
  const app = (issue: (env: Env, req: FirstHighRequest) => Promise<unknown>) => {
    const h = new Hono<{ Bindings: Env }>();
    h.route('/v1/ceremony', createCeremonyRoutes({ issue: issue as never }));
    return h;
  };
  const post = (h: ReturnType<typeof app>, body: unknown) =>
    h.request('/v1/ceremony/first-high', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, env);
  const body = { account: ACCOUNT, signerId: 0, highConfig: CONFIG, highAssertion: ASSERTION };

  it('answers 200 with the attestation', async () => {
    const h = app(async (_e, req) => issueFirstHighAttestation(deps(), req));
    const res = await post(h, body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, account: ACCOUNT, nonce: '3', attestation: { expiry: String(NOW + 600) } });
  });
  it('maps bad bodies, gate refusals and attester failures', async () => {
    const h = app(async (_e, req) => issueFirstHighAttestation(deps({ readAccount: async () => snapshot({ upgradeLocked: true }) }), req));
    expect((await post(h, { ...body, account: 'x' })).status).toBe(400);
    const conflict = await post(h, body);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: 'high_already_exists' });
    const rejected = app(async () => { throw new Error('WRONG_CHAIN_ID: attester is pinned to chain 8453'); });
    const res = await post(rejected, body);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'attester_rejected' });
    const noKey = app(async () => { throw new Error('BAD_ATTESTER_KEY: CEREMONY_ATTESTER_PRIVATE_KEY secret is missing'); });
    expect((await post(noKey, body)).status).toBe(503);
  });
});
