// Copyright (c) 2026 Cofferdam Inc
// SPDX-License-Identifier: Apache-2.0

/**
 * Self proof intake: payload normalisation, bundle shaping, and the
 * `/v1/self/*` routes against a fake attester binding and an in-memory
 * bundle store (the deployment uses a Durable Object per account).
 */

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { concat, encodePacked, pad, ripemd160, sha256, type Address, type Hex } from 'viem';

import type { Env } from '../src/env.js';
import type { SignBindRequest, SignBindResponse, SignRebindRequest, SignRebindResponse } from '../src/services/attester.js';
import type { BundleStore } from '../src/services/bundleStore.js';
import {
  BIND_BUNDLE_TTL_SECONDS,
  SelfVerifyRequestError,
  accountFromUserContextData,
  buildBindBundle,
  normalizeUserContextData,
  parseSelfVerifyBody,
  toDecimal,
  toSolidityProof,
} from '../src/services/selfBind.js';
import { attesterErrorCode, createSelfRoutes, type BindStatus } from '../src/routes/self.js';
import type { AuthorityCheck } from '../src/services/authorityCheck.js';
import fixtures from './fixtures/sdk-attestations.json';
import { SEPOLIA_DEPLOYMENTS } from '../src/chain/deployments.js';

const ACCOUNT: Address = '0xfa4D920d5592289A1A0F73CA49D626EF8FE4D695';
/** The registry the route pins; the fixture follows the deployments table so a redeploy cannot drift it. */
const REGISTRY: Hex = SEPOLIA_DEPLOYMENTS.NullifierRegistry.address;

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

/** In-memory BundleStore with the Durable Object's semantics (one bundle per account). */
function memoryStore(): BundleStore & { data: Map<string, any> } {
  const data = new Map<string, any>();
  return {
    data,
    async put(bundle) {
      data.set(bundle.account.toLowerCase(), JSON.parse(JSON.stringify(bundle)));
    },
    async get(account) {
      return data.get(account.toLowerCase()) ?? null;
    },
    async delete(account) {
      data.delete(account.toLowerCase());
    },
  };
}

/**
 * Rate-limit binding stub counting per key: `allow[key]` successes for listed
 * keys, `fallback` for the rest, then refusals.
 */
function rateLimit(fallback: number, allow: Record<string, number> = {}): RateLimit & { calls: string[] } {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  return {
    calls,
    async limit({ key }) {
      calls.push(key);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= (allow[key] ?? fallback) };
    },
  };
}

function harness(opts: {
  store?: BundleStore | null;
  environment?: Env['ENVIRONMENT'];
  signBind?: (req: SignBindRequest) => Promise<SignBindResponse>;
  signRebind?: (req: SignRebindRequest) => Promise<SignRebindResponse>;
  bindStatus?: BindStatus;
  rebindEpoch?: () => Promise<bigint>;
  now?: number;
  verifyLimit?: RateLimit;
  pickupLimit?: RateLimit;
  /** What the on-chain authority check answers for a presented token (default: an active High). */
  authorityCheck?: AuthorityCheck;
} = {}) {
  const signBind = vi.fn(opts.signBind ?? (async (req: SignBindRequest) => signedFor(req)));
  const signRebind = vi.fn(
    opts.signRebind ?? (async (req: SignRebindRequest) => ({ ...signedFor(req), epoch: req.epoch })),
  );
  const env = {
    ENVIRONMENT: opts.environment ?? 'development',
    BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
    ATTESTER: { signBind, signRebind } as unknown as Env['ATTESTER'],
    SELF_VERIFY_RL: opts.verifyLimit,
    SELF_PICKUP_RL: opts.pickupLimit,
  } as unknown as Env;
  const store = opts.store === undefined ? null : opts.store;
  const app = new Hono<{ Bindings: Env }>();
  app.route(
    '/v1/self',
    createSelfRoutes({
      bindStatus: async () => opts.bindStatus ?? { kind: 'unbound' },
      rebindEpoch: opts.rebindEpoch ?? (async () => 0n),
      now: () => opts.now ?? 1_760_000_000_000,
      attestationMaxAgeMs: 10 * 60 * 1000,
      store: () => store,
      authorityCheck: async () =>
        opts.authorityCheck ?? { status: 'active', authorityId: 0, module: ACCOUNT, tier: 3 },
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
  return { app, env, signBind, signRebind, call, post };
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

  it('gives the bundle the TTL window the Durable Object alarm enforces', () => {
    const req = parseSelfVerifyBody(relayerBody());
    const now = 1_760_000_000_000;
    const bundle = buildBindBundle(
      req,
      signedFor({ registry: REGISTRY, account: req.account, pubSignals: req.publicSignals, userContextData: req.userContextData }),
      now,
    );
    expect(bundle.expiresAt - bundle.createdAt).toBe(BIND_BUNDLE_TTL_SECONDS * 1000);
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
    const h = harness({ store: memoryStore() });
    expect((await h.post('{nope')).json.code).toBe('invalid_json');
    const bad = await h.post(relayerBody(ACCOUNT, { attestationId: 2 }));
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ status: 'error', result: false, code: 'unsupported_attestation_id' });
    expect(h.signBind).not.toHaveBeenCalled();
  });

  it('refuses already-bound accounts and nullifiers before the attester', async () => {
    const a = harness({ store: memoryStore(), bindStatus: { kind: 'account_already_bound', nullifier: '5' } });
    const ra = await a.post(relayerBody());
    expect(ra.status).toBe(409);
    expect(ra.json.code).toBe('account_already_bound');
    expect(a.signBind).not.toHaveBeenCalled();

    // A passport bound to another account is the recovery case (decision 0022):
    // the attester co-signs a rebind bound to the registry epoch instead.
    const other: Address = '0x000000000000000000000000000000000000dEaD';
    const n = harness({
      store: memoryStore(),
      bindStatus: { kind: 'nullifier_already_bound', boundAccount: other },
      rebindEpoch: async () => 2n,
    });
    const rn = await n.post(relayerBody());
    expect(rn.status).toBe(200);
    expect(rn.json).toMatchObject({ status: 'success', result: true, kind: 'rebind' });
    expect(n.signBind).not.toHaveBeenCalled();
    expect(n.signRebind).toHaveBeenCalledTimes(1);
    expect(n.signRebind.mock.calls[0]?.[0]).toMatchObject({ epoch: '2' });
  });

  it('answers 503 when the registry epoch cannot be read for a rebind', async () => {
    const other: Address = '0x000000000000000000000000000000000000dEaD';
    const n = harness({
      store: memoryStore(),
      bindStatus: { kind: 'nullifier_already_bound', boundAccount: other },
      rebindEpoch: async () => { throw new Error('rpc down'); },
    });
    const rn = await n.post(relayerBody());
    expect(rn.status).toBe(503);
    expect(rn.json).toMatchObject({ code: 'registry_unavailable', retryable: true });
    expect(n.signRebind).not.toHaveBeenCalled();
  });

  it('maps attester rejections to 400 with the attester code, RPC trouble to 503', async () => {
    const rejected = harness({
      store: memoryStore(),
      signBind: async () => {
        // Exactly what the runtime hands the caller over the service binding.
        throw new Error('AttesterError: CELO_ROOT_UNKNOWN: identity-commitment root 1 was never published');
      },
    });
    const r1 = await rejected.post(relayerBody());
    expect(r1.status).toBe(400);
    expect(r1.json).toMatchObject({ status: 'error', result: false, code: 'CELO_ROOT_UNKNOWN', retryable: false });

    const flaky = harness({
      store: memoryStore(),
      signBind: async () => {
        throw new Error('CELO_RPC_UNAVAILABLE: Celo read failed: timeout');
      },
    });
    const r2 = await flaky.post(relayerBody());
    expect(r2.status).toBe(503);
    expect(r2.json.retryable).toBe(true);

    const misconfigured = harness({
      store: memoryStore(),
      signBind: async () => {
        throw new Error('BAD_SELF_HUB_VAR: SELF_HUB_ADDRESS var is malformed');
      },
    });
    expect((await misconfigured.post(relayerBody())).status).toBe(500);
  });

  it('signs, stores the Solidity-ordered bundle and answers in Self success shape', async () => {
    const store = memoryStore();
    const { data } = store;
    const h = harness({ store });
    const { status, json } = await h.post(relayerBody());
    expect(status).toBe(200);
    expect(json).toMatchObject({ status: 'success', result: true, account: ACCOUNT, nullifier: '777' });
    expect(json.celo.proofDate).toBe('2026-10-10');

    expect(h.signBind).toHaveBeenCalledTimes(1);
    const sent = h.signBind.mock.calls[0]![0] as SignBindRequest;
    expect(sent.registry).toBe(REGISTRY);
    expect(sent.account).toBe(ACCOUNT);
    expect(sent.userContextData).toBe(userContextData(ACCOUNT).toLowerCase());

    const stored = data.get(ACCOUNT.toLowerCase())!;
    expect(stored.proof.b).toEqual([
      ['22', '21'],
      ['24', '23'],
    ]);
    expect(stored.attesterSig).toBe(`0x${'cd'.repeat(65)}`);
  });

  it('rate-limits per account and globally in Self error shape, and never calls the attester when limited', async () => {
    // Per account: the global key is generous, the account key allows one.
    const rl = rateLimit(1, { 'verify:all': 100 });
    const perAccount = harness({ store: memoryStore(), verifyLimit: rl });
    expect((await perAccount.post(relayerBody())).status).toBe(200);
    const second = await perAccount.post(relayerBody());
    expect(second.status).toBe(429);
    expect(second.json).toMatchObject({ status: 'error', result: false, code: 'rate_limited' });
    expect(perAccount.signBind).toHaveBeenCalledTimes(1);
    expect(rl.calls).toEqual([
      'verify:all',
      `verify:${ACCOUNT.toLowerCase()}`,
      'verify:nullifier:777',
      'verify:all',
      `verify:${ACCOUNT.toLowerCase()}`,
    ]);

    // Per nullifier (decision 0022): the same passport again is braked even when the account key allows it.
    const perNullifier = rateLimit(1, { 'verify:all': 100, [`verify:${ACCOUNT.toLowerCase()}`]: 100 });
    const braked = harness({ store: memoryStore(), verifyLimit: perNullifier });
    expect((await braked.post(relayerBody())).status).toBe(200);
    const sprayed = await braked.post(relayerBody());
    expect(sprayed.status).toBe(429);
    expect(sprayed.json).toMatchObject({ code: 'rate_limited', message: 'too many proofs for this passport; retry shortly' });
    expect(braked.signBind).toHaveBeenCalledTimes(1);

    // Global brake: refused before the body is even parsed.
    const global = harness({ store: memoryStore(), verifyLimit: rateLimit(0) });
    expect((await global.post(relayerBody())).status).toBe(429);
    expect(global.signBind).not.toHaveBeenCalled();
  });
});

describe('GET /v1/self/bind-bundle/:account', () => {
  const fx = fixtures.p256;
  const fxAccount = fixtures.fields.accountAddress as Address;

  it('refuses a valid token whose key is not an active High authority on the account', async () => {
    const store = memoryStore();
    const issuedAt = fixtures.fields.issuedAt as number;
    await harness({ store }).post(relayerBody(fxAccount));
    const bearer = { headers: { authorization: `Bearer ${fx.token}` } };
    const at = (check: AuthorityCheck) =>
      harness({ store, environment: 'staging', now: issuedAt + 5_000, authorityCheck: check });

    const stranger = await at({ status: 'not_found' }).call(`/v1/self/bind-bundle/${fxAccount}`, bearer);
    expect(stranger.status).toBe(401);
    expect(stranger.json.error).toBe('attestation_rejected');
    expect(stranger.json.message).toMatch(/authority/);

    const partner = await at({ status: 'active', authorityId: 1, module: ACCOUNT, tier: 4 }).call(
      `/v1/self/bind-bundle/${fxAccount}`,
      bearer,
    );
    expect(partner.status).toBe(401);

    const undeployed = await at({ status: 'account_not_deployed' }).call(`/v1/self/bind-bundle/${fxAccount}`, bearer);
    expect(undeployed.status).toBe(401);

    const rpcDown = await at({ status: 'check_failed', message: 'rpc down' }).call(
      `/v1/self/bind-bundle/${fxAccount}`,
      bearer,
    );
    expect(rpcDown.status).toBe(503);
    expect(rpcDown.json.error).toBe('authority_check_unavailable');
    expect(store.data.size).toBe(1);
  });

  it('validates the address and reports missing bundles', async () => {
    const h = harness({ store: memoryStore() });
    expect((await h.call('/v1/self/bind-bundle/nope')).status).toBe(400);
    const missing = await h.call(`/v1/self/bind-bundle/${ACCOUNT}`);
    expect(missing.status).toBe(404);
    expect(missing.json.error).toBe('bind_bundle_not_found');
  });

  it('refuses and drops a bundle once the registry shows the account bound', async () => {
    const store = memoryStore();
    const { data } = store;
    await harness({ store }).post(relayerBody());
    expect(data.size).toBe(1);
    const bound = harness({ store, bindStatus: { kind: 'account_already_bound', nullifier: '777' } });
    const res = await bound.call(`/v1/self/bind-bundle/${ACCOUNT}`);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: 'account_already_bound', nullifier: '777' });
    expect(data.size).toBe(0);
  });

  it('serves a stored bundle without a token in development only', async () => {
    const store = memoryStore();
    const dev = harness({ store });
    await dev.post(relayerBody());
    const ok = await dev.call(`/v1/self/bind-bundle/${ACCOUNT}`);
    expect(ok.status).toBe(200);
    expect(ok.json.bundle).toMatchObject({ account: ACCOUNT, nullifier: '777' });

    const staging = harness({ store, environment: 'staging' });
    const denied = await staging.call(`/v1/self/bind-bundle/${ACCOUNT}`);
    expect(denied.status).toBe(401);
    expect(denied.json.error).toBe('attestation_required');
  });

  it('rate-limits pickups per account', async () => {
    const store = memoryStore();
    await harness({ store }).post(relayerBody());
    const h = harness({ store, pickupLimit: rateLimit(1) });
    expect((await h.call(`/v1/self/bind-bundle/${ACCOUNT}`)).status).toBe(200);
    const limited = await h.call(`/v1/self/bind-bundle/${ACCOUNT}`);
    expect(limited.status).toBe(429);
    expect(limited.json.error).toBe('rate_limited');
  });

  it('accepts a csa1 attestation pinned to the account and rejects others', async () => {
    const store = memoryStore();
    const issuedAt = fixtures.fields.issuedAt as number;
    const h = harness({ store, environment: 'staging', now: issuedAt + 5_000 });
    await harness({ store }).post(relayerBody(fxAccount));

    const ok = await h.call(`/v1/self/bind-bundle/${fxAccount}`, {
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.bundle.account.toLowerCase()).toBe(fxAccount.toLowerCase());

    // Same valid token, different account → the accountAddress pin fails.
    await harness({ store }).post(relayerBody(ACCOUNT));
    const wrongAccount = await h.call(`/v1/self/bind-bundle/${ACCOUNT}`, {
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(wrongAccount.status).toBe(401);
    expect(wrongAccount.json.error).toBe('attestation_rejected');

    // Stale token (issued long before `now`).
    const stale = harness({ store, environment: 'staging', now: issuedAt + 11 * 60 * 1000 });
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
