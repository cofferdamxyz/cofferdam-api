// Copyright (c) 2026 Cofferdam Inc
// SPDX-License-Identifier: Apache-2.0

/**
 * Self proof intake: payload normalisation, bundle shaping, and the
 * `/v1/self/*` routes against a fake attester binding and an in-memory KV.
 */

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { concat, encodePacked, pad, ripemd160, sha256, type Address, type Hex } from 'viem';

import type { Env } from '../src/env.js';
import type { SignBindRequest, SignBindResponse } from '../src/services/attester.js';
import {
  BIND_BUNDLE_TTL_SECONDS,
  BindBundleStore,
  SelfVerifyRequestError,
  accountFromUserContextData,
  buildBindBundle,
  normalizeUserContextData,
  parseSelfVerifyBody,
  toDecimal,
  toSolidityProof,
} from '../src/services/selfBind.js';
import { attesterErrorCode, createSelfRoutes, type BindStatus } from '../src/routes/self.js';
import fixtures from './fixtures/sdk-attestations.json';

const ACCOUNT: Address = '0xfa4D920d5592289A1A0F73CA49D626EF8FE4D695';
const REGISTRY: Hex = '0x2843F55C9E1491a6d47F65f041E68F96E3aeB3d4';

function userContextData(account: Address, destChainId = 42220n): Hex {
  return concat([encodePacked(['uint256'], [destChainId]), pad(account, { size: 32 })]);
}

/** A relayer-shaped body: bare-hex userContextData, decimal strings elsewhere. */
function relayerBody(account: Address = ACCOUNT, overrides: Record<string, unknown> = {}) {
  const ctx = userContextData(account);
  const signals = new Array<string>(21).fill('0');
  signals[7] = '777'; // nullifier
  signals[8] = '1'; // attestation id
  signals[9] = '1028250853844545477525675497463046671568825934242895532070630707193360198082';
  signals[20] = BigInt(ripemd160(sha256(ctx))).toString();
  return {
    attestationId: 1,
    proof: {
      a: ['11', '12'],
      b: [
        ['21', '22'],
        ['23', '24'],
      ],
      c: ['31', '32'],
    },
    publicSignals: signals,
    userContextData: ctx.slice(2),
    ...overrides,
  };
}

function signedFor(req: SignBindRequest): SignBindResponse {
  return {
    attesterAddress: '0x2dFDdE621680A270cC01E8D9D729f25a46Bdae59',
    messageHash: `0x${'ab'.repeat(32)}`,
    signature: `0x${'cd'.repeat(65)}`,
    chainId: '84532',
    registry: req.registry,
    account: req.account,
    userContextData: req.userContextData,
    gate: 'celo',
    celo: {
      chainId: '42220',
      registry: '0x37F5CB8cB1f6B00aa768D8aA99F1A9289802A968',
      merkleRoot: req.pubSignals[9]!,
      proofDate: '2026-10-10',
    },
  };
}

/** Enough of KVNamespace for the store: get(key,'json') / put(key, value, {expirationTtl}) / delete. */
function memoryKv() {
  const data = new Map<string, { value: string; ttl?: number }>();
  const kv = {
    async get(key: string, type?: string) {
      const hit = data.get(key);
      if (!hit) return null;
      return type === 'json' ? JSON.parse(hit.value) : hit.value;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      data.set(key, { value, ttl: opts?.expirationTtl });
    },
    async delete(key: string) {
      data.delete(key);
    },
  };
  return { kv: kv as unknown as KVNamespace, data };
}

function harness(opts: {
  kv?: KVNamespace;
  environment?: Env['ENVIRONMENT'];
  signBind?: (req: SignBindRequest) => Promise<SignBindResponse>;
  bindStatus?: BindStatus;
  now?: number;
} = {}) {
  const signBind = vi.fn(opts.signBind ?? (async (req: SignBindRequest) => signedFor(req)));
  const env = {
    ENVIRONMENT: opts.environment ?? 'development',
    BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
    ATTESTER: { signBind } as unknown as Env['ATTESTER'],
    BIND_BUNDLES: opts.kv,
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.route(
    '/v1/self',
    createSelfRoutes({
      bindStatus: async () => opts.bindStatus ?? { kind: 'unbound' },
      now: () => opts.now ?? 1_760_000_000_000,
      attestationMaxAgeMs: 10 * 60 * 1000,
    }),
  );
  const call = async (path: string, init?: RequestInit) => {
    const res = await app.request(path, init, env);
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  const post = (body: unknown) =>
    call('/v1/self/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { app, env, signBind, call, post };
}

describe('toDecimal', () => {
  it('accepts decimal, 0x hex, bare hex and safe integers', () => {
    expect(toDecimal('255', 'x')).toBe('255');
    expect(toDecimal('0xff', 'x')).toBe('255');
    expect(toDecimal('ff', 'x')).toBe('255');
    expect(toDecimal(255, 'x')).toBe('255');
    expect(toDecimal(255n, 'x')).toBe('255');
  });

  it('rejects garbage, negatives and values beyond uint256', () => {
    for (const bad of ['-1', '1.5', 'zz', '', -1, 1.5, {}, (1n << 256n).toString()]) {
      expect(() => toDecimal(bad, 'x')).toThrow(SelfVerifyRequestError);
    }
  });
});

describe('userContextData helpers', () => {
  it('normalises bare and prefixed hex to 0x lower-case', () => {
    const ctx = userContextData(ACCOUNT);
    expect(normalizeUserContextData(ctx.slice(2).toUpperCase())).toBe(ctx.toLowerCase());
    expect(normalizeUserContextData(ctx)).toBe(ctx.toLowerCase());
  });

  it('rejects short, odd or non-hex input', () => {
    for (const bad of ['abc', '0x12', 'zz'.repeat(64), 42]) {
      expect(() => normalizeUserContextData(bad)).toThrow(SelfVerifyRequestError);
    }
  });

  it('recovers the account and refuses non-address user ids', () => {
    expect(accountFromUserContextData(normalizeUserContextData(userContextData(ACCOUNT)))).toBe(ACCOUNT);
    const uuidLike = concat([encodePacked(['uint256'], [42220n]), `0x${'11'.repeat(32)}`]) as Hex;
    expect(() => accountFromUserContextData(uuidLike)).toThrowError(/SelfApp.userId must be the AA address/);
  });
});

describe('parseSelfVerifyBody', () => {
  it('normalises a relayer payload', () => {
    const req = parseSelfVerifyBody(relayerBody());
    expect(req.attestationId).toBe(1);
    expect(req.account).toBe(ACCOUNT);
    expect(req.nullifier).toBe('777');
    expect(req.userContextData.startsWith('0x')).toBe(true);
    expect(req.proof.b).toEqual([
      ['21', '22'],
      ['23', '24'],
    ]);
  });

  it('accepts attestationId as a string and hex signals', () => {
    const body = relayerBody();
    (body.publicSignals as string[])[9] = 'ff';
    const req = parseSelfVerifyBody({ ...body, attestationId: '1' });
    expect(req.publicSignals[9]).toBe('255');
  });

  it('rejects other document types, malformed proofs and signal counts', () => {
    const code = (b: unknown) => {
      try {
        parseSelfVerifyBody(b);
      } catch (e) {
        return (e as SelfVerifyRequestError).code;
      }
      return 'no-throw';
    };
    expect(code(relayerBody(ACCOUNT, { attestationId: 2 }))).toBe('unsupported_attestation_id');
    expect(code(relayerBody(ACCOUNT, { proof: { a: ['1'], b: [], c: [] } }))).toBe('bad_proof');
    expect(code(relayerBody(ACCOUNT, { publicSignals: ['1'] }))).toBe('bad_public_signals');
    expect(code(relayerBody(ACCOUNT, { userContextData: '1234' }))).toBe('bad_user_context');
    expect(code(null)).toBe('bad_request');
  });
});

describe('toSolidityProof / buildBindBundle', () => {
  it('swaps each b pair and nothing else', () => {
    const req = parseSelfVerifyBody(relayerBody());
    const sol = toSolidityProof(req.proof);
    expect(sol).toEqual({
      a: ['11', '12'],
      b: [
        ['22', '21'],
        ['24', '23'],
      ],
      c: ['31', '32'],
    });
  });

  it('shapes the bundle with the swapped proof, attester fields and TTL window', () => {
    const req = parseSelfVerifyBody(relayerBody());
    const signed = signedFor({
      registry: REGISTRY,
      account: req.account,
      pubSignals: req.publicSignals,
      userContextData: req.userContextData,
    });
    const now = 1_760_000_000_000;
    const bundle = buildBindBundle(req, signed, now);
    expect(bundle).toMatchObject({
      version: 1,
      account: ACCOUNT,
      chainId: '84532',
      registry: REGISTRY,
      nullifier: '777',
      attesterSig: signed.signature,
      celo: signed.celo,
      createdAt: now,
      expiresAt: now + BIND_BUNDLE_TTL_SECONDS * 1000,
    });
    expect(bundle.proof.b[0]).toEqual(['22', '21']);
  });

  it('stores and reads bundles by lower-cased account with the TTL', async () => {
    const { kv, data } = memoryKv();
    const store = new BindBundleStore(kv);
    const req = parseSelfVerifyBody(relayerBody());
    const bundle = buildBindBundle(
      req,
      signedFor({ registry: REGISTRY, account: req.account, pubSignals: req.publicSignals, userContextData: req.userContextData }),
    );
    await store.put(bundle);
    expect([...data.keys()]).toEqual([`bind:${ACCOUNT.toLowerCase()}`]);
    expect(data.get(`bind:${ACCOUNT.toLowerCase()}`)?.ttl).toBe(BIND_BUNDLE_TTL_SECONDS);
    expect(await store.get(ACCOUNT)).toEqual(bundle);
    await store.delete(ACCOUNT);
    expect(await store.get(ACCOUNT)).toBeNull();
  });
});

describe('attesterErrorCode', () => {
  it('reads the code whether or not the runtime prefixed the error name', () => {
    expect(attesterErrorCode(new Error('CELO_ROOT_UNKNOWN: root 1 was never published'))).toBe('CELO_ROOT_UNKNOWN');
    expect(attesterErrorCode(new Error('AttesterError: CELO_OFAC_ROOTS_STALE: re-prove'))).toBe('CELO_OFAC_ROOTS_STALE');
    expect(attesterErrorCode(new Error('Error: REGISTRY_NOT_ALLOWED: pinned registry is 0x…'))).toBe(
      'REGISTRY_NOT_ALLOWED',
    );
    expect(attesterErrorCode(new Error('network connection lost'))).toBe('attester_rpc_failed');
    expect(attesterErrorCode(new Error('Error: fetch failed'))).toBe('attester_rpc_failed');
  });
});

describe('POST /v1/self/verify', () => {
  it('answers 503 in Self error shape when the store is unprovisioned, without calling the attester', async () => {
    const h = harness();
    const { status, json } = await h.post(relayerBody());
    expect(status).toBe(503);
    expect(json).toMatchObject({ status: 'error', result: false, code: 'bind_store_unprovisioned' });
    expect(h.signBind).not.toHaveBeenCalled();
  });

  it('rejects non-JSON and malformed payloads with 400', async () => {
    const h = harness({ kv: memoryKv().kv });
    expect((await h.post('{nope')).json.code).toBe('invalid_json');
    const bad = await h.post(relayerBody(ACCOUNT, { attestationId: 2 }));
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ status: 'error', result: false, code: 'unsupported_attestation_id' });
    expect(h.signBind).not.toHaveBeenCalled();
  });

  it('refuses already-bound accounts and nullifiers before the attester', async () => {
    const a = harness({ kv: memoryKv().kv, bindStatus: { kind: 'account_already_bound', nullifier: '5' } });
    const ra = await a.post(relayerBody());
    expect(ra.status).toBe(409);
    expect(ra.json.code).toBe('account_already_bound');
    expect(a.signBind).not.toHaveBeenCalled();

    const other: Address = '0x000000000000000000000000000000000000dEaD';
    const n = harness({ kv: memoryKv().kv, bindStatus: { kind: 'nullifier_already_bound', boundAccount: other } });
    const rn = await n.post(relayerBody());
    expect(rn.status).toBe(409);
    expect(rn.json).toMatchObject({ code: 'nullifier_already_bound', boundAccount: other });
  });

  it('maps attester rejections to 400 with the attester code, RPC trouble to 503', async () => {
    const rejected = harness({
      kv: memoryKv().kv,
      signBind: async () => {
        // Exactly what the runtime hands the caller over the service binding.
        throw new Error('AttesterError: CELO_ROOT_UNKNOWN: identity-commitment root 1 was never published');
      },
    });
    const r1 = await rejected.post(relayerBody());
    expect(r1.status).toBe(400);
    expect(r1.json).toMatchObject({ status: 'error', result: false, code: 'CELO_ROOT_UNKNOWN', retryable: false });

    const flaky = harness({
      kv: memoryKv().kv,
      signBind: async () => {
        throw new Error('CELO_RPC_UNAVAILABLE: Celo read failed: timeout');
      },
    });
    const r2 = await flaky.post(relayerBody());
    expect(r2.status).toBe(503);
    expect(r2.json.retryable).toBe(true);

    const misconfigured = harness({
      kv: memoryKv().kv,
      signBind: async () => {
        throw new Error('BAD_SELF_HUB_VAR: SELF_HUB_ADDRESS var is malformed');
      },
    });
    expect((await misconfigured.post(relayerBody())).status).toBe(500);
  });

  it('signs, stores the Solidity-ordered bundle and answers in Self success shape', async () => {
    const { kv, data } = memoryKv();
    const h = harness({ kv });
    const { status, json } = await h.post(relayerBody());
    expect(status).toBe(200);
    expect(json).toMatchObject({ status: 'success', result: true, account: ACCOUNT, nullifier: '777' });
    expect(json.celo.proofDate).toBe('2026-10-10');

    expect(h.signBind).toHaveBeenCalledTimes(1);
    const sent = h.signBind.mock.calls[0]![0] as SignBindRequest;
    expect(sent.registry).toBe(REGISTRY);
    expect(sent.account).toBe(ACCOUNT);
    expect(sent.userContextData).toBe(userContextData(ACCOUNT).toLowerCase());

    const stored = JSON.parse(data.get(`bind:${ACCOUNT.toLowerCase()}`)!.value);
    expect(stored.proof.b).toEqual([
      ['22', '21'],
      ['24', '23'],
    ]);
    expect(stored.attesterSig).toBe(`0x${'cd'.repeat(65)}`);
  });
});

describe('GET /v1/self/bind-bundle/:account', () => {
  const fx = fixtures.p256;
  const fxAccount = fixtures.fields.accountAddress as Address;

  it('validates the address and reports missing bundles', async () => {
    const h = harness({ kv: memoryKv().kv });
    expect((await h.call('/v1/self/bind-bundle/nope')).status).toBe(400);
    const missing = await h.call(`/v1/self/bind-bundle/${ACCOUNT}`);
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe('bind_bundle_not_found');
  });

  it('serves a stored bundle without a token in development only', async () => {
    const { kv } = memoryKv();
    const dev = harness({ kv });
    await dev.post(relayerBody());
    const ok = await dev.call(`/v1/self/bind-bundle/${ACCOUNT}`);
    expect(ok.status).toBe(200);
    expect(ok.json.bundle).toMatchObject({ account: ACCOUNT, nullifier: '777' });

    const staging = harness({ kv, environment: 'staging' });
    const denied = await staging.call(`/v1/self/bind-bundle/${ACCOUNT}`);
    expect(denied.status).toBe(401);
    expect(denied.json.error).toBe('attestation_required');
  });

  it('accepts a csa1 attestation pinned to the account and rejects others', async () => {
    const { kv } = memoryKv();
    const issuedAt = fixtures.fields.issuedAt as number;
    const h = harness({ kv, environment: 'staging', now: issuedAt + 5_000 });
    await harness({ kv }).post(relayerBody(fxAccount));

    const ok = await h.call(`/v1/self/bind-bundle/${fxAccount}`, {
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.bundle.account.toLowerCase()).toBe(fxAccount.toLowerCase());

    // Same valid token, different account → the accountAddress pin fails.
    await harness({ kv }).post(relayerBody(ACCOUNT));
    const wrongAccount = await h.call(`/v1/self/bind-bundle/${ACCOUNT}`, {
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(wrongAccount.status).toBe(401);
    expect(wrongAccount.json.error).toBe('attestation_rejected');

    // Stale token (issued long before `now`).
    const stale = harness({ kv, environment: 'staging', now: issuedAt + 11 * 60 * 1000 });
    expect(
      (await stale.call(`/v1/self/bind-bundle/${fxAccount}`, { headers: { authorization: `Bearer ${fx.token}` } }))
        .status,
    ).toBe(401);

    // Garbage token.
    expect(
      (await h.call(`/v1/self/bind-bundle/${fxAccount}`, { headers: { authorization: 'Bearer csa1:zzz' } })).status,
    ).toBe(401);
  });
});
