// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * pBRL for the app's Add money on Base Sepolia (workspace decision 0100,
 * question 7): the sandbox identity, the amount parser, the staging-only host
 * check, the sandbox calls against a fake Pods, and the route's gate with the
 * SDK-made v2 fixture tokens. Nothing reaches Pods or a node.
 */

import { p256 } from '@noble/curves/p256';
import { Hono } from 'hono';
import { getAddress, hexToBytes, sha256, type Address, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { createTestnetRoutes, type TestnetRouteDeps } from '../src/routes/testnet.js';
import type { AuthorityCheck } from '../src/services/authorityCheck.js';
import { TIER } from '../src/services/ceremony.js';
import { createAuthorityMemo } from '../src/services/chat/authorityMemo.js';
import {
  MAX_CENTS_PER_REQUEST,
  mintPbrl,
  parseReaisCents,
  PBRL_BASE_SEPOLIA,
  podsSandboxBase,
  sandboxIdentity,
  type MintInput,
  type MintResult,
} from '../src/services/podsSandbox.js';
import type { ReplayStore } from '../src/services/popReplayStore.js';
import { popAth } from '../src/services/sessionAttestation.js';

import v2 from './fixtures/sdk-attestations-v2.json';

const ACCOUNT = v2.account as Address;
const NOW = v2.issuedAt + 1_000;
const ORIGIN = v2.origin;
const fx = v2.tokens.p256;
const HIGH: AuthorityCheck = { status: 'active', authorityId: 0, module: ACCOUNT, tier: TIER.High };
const KEY = 'sandbox-key-for-tests';

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

function signProof(opts: { htm: string; htu: string; token: string }): string {
  const priv = hexToBytes(v2.devicePrivateKey as Hex);
  const pub = p256.getPublicKey(priv, false);
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: 'EC', crv: 'P-256', x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)) } };
  const payload = { htm: opts.htm, htu: opts.htu, iat: Math.floor(NOW / 1000), jti: b64url(crypto.getRandomValues(new Uint8Array(16))), ath: popAth(opts.token) };
  const input = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = p256.sign(hexToBytes(sha256(new TextEncoder().encode(input))), priv);
  return `${input}.${b64url(sig.toCompactRawBytes())}`;
}

function memoryReplay(): ReplayStore {
  const seen = new Map<string, number>();
  return {
    async claim(jkt, key, expiresAt, now) {
      const k = `${jkt}|${key}`;
      if ((seen.get(k) ?? 0) > now) return false;
      seen.set(k, expiresAt);
      return true;
    },
  };
}

// ── the sandbox service ─────────────────────────────────────────────────────

const cpfValid = (cpf: string) => {
  const d = cpf.split('').map(Number);
  const dv = (n: number) => {
    const r = (d.slice(0, n).reduce((s, x, i) => s + x * (n + 1 - i), 0) * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return cpf.length === 11 && dv(9) === d[9] && dv(10) === d[10] && !d.every((x) => x === d[0]);
};

describe('the sandbox identity', () => {
  it('is the same for the same account, in any case, and differs between accounts', async () => {
    const a = await sandboxIdentity(ACCOUNT);
    expect(await sandboxIdentity(ACCOUNT.toLowerCase())).toEqual(a);
    const b = await sandboxIdentity('0x0000000000000000000000000000000000000001');
    expect(b.cpf).not.toBe(a.cpf);
    expect(b.email).not.toBe(a.email);
  });

  it('is synthetic: a CPF with valid check digits, an example.com email, the account as its wallet', async () => {
    for (let i = 0; i < 50; i++) {
      const who = await sandboxIdentity(`0x${i.toString(16).padStart(40, '0')}`);
      expect(cpfValid(who.cpf)).toBe(true);
      expect(who.email).toMatch(/^cofferdam-sandbox-[0-9a-f]{12}@example\.com$/);
    }
    expect((await sandboxIdentity(ACCOUNT)).walletAddress).toBe(ACCOUNT.toLowerCase());
  });
});

describe('the amount and the host', () => {
  it('reads reais with at most two decimals, a comma or a point, up to the request cap', () => {
    expect(parseReaisCents('200')).toBe(20_000);
    expect(parseReaisCents('250,5')).toBe(25_050);
    expect(parseReaisCents('0.01')).toBe(1);
    expect(parseReaisCents(5000)).toBe(MAX_CENTS_PER_REQUEST);
    for (const bad of ['0', '0.001', '5000.01', '-1', '1e3', '', '12.345', null, undefined, {}]) expect(parseReaisCents(bad)).toBeNull();
  });

  it('allows only Pods staging over https', () => {
    expect(podsSandboxBase()).toBe('https://staging-api.pods.finance');
    expect(podsSandboxBase('https://staging-api.pods.finance/')).toBe('https://staging-api.pods.finance');
    for (const bad of ['https://api.pods.finance', 'http://staging-api.pods.finance', 'https://staging-api.pods.finance.evil.test', 'https://staging-api.pods.finance/x', 'nope']) {
      expect(podsSandboxBase(bad)).toBeNull();
    }
  });
});

/** A fake Pods staging: one profile per identity, quotes and confirmations that mint. */
function fakePods(opts: { approved?: boolean; refuse?: { path: string; status: number; code: string } } = {}) {
  const calls: { method: string; path: string; key: string | null; body: unknown }[] = [];
  let approved = opts.approved ?? false;
  let quotes = 0;
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, key: new Headers(init?.headers).get('x-api-key'), body });
    // Workers implements only follow and manual: 'error' throws a TypeError before any request.
    expect(init?.redirect).toBe('manual');
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (opts.refuse && u.pathname === opts.refuse.path) return json(opts.refuse.status, { error: { code: opts.refuse.code } });
    if (u.pathname === '/api/v1/kyc/sumsub-share-token') return json(200, { kycUserId: 'kyc-1' });
    if (u.pathname === '/api/v1/kyc/status') return json(200, { status: approved ? 'approved' : 'pending' });
    if (u.pathname === '/api/v1/kyc/status/sandbox/approved') {
      approved = true;
      return json(200, {});
    }
    if (u.pathname === '/v2/swap/quote') {
      expect(u.searchParams.get('tokenOut')).toBe(PBRL_BASE_SEPOLIA);
      expect(u.searchParams.get('destinationChain')).toBe('base-sepolia');
      return json(200, { quote: { id: `q-${++quotes}` } });
    }
    if (u.pathname === '/v2/swap/status/sandbox/confirmed') return json(200, { destinationTxHash: `0x${String(quotes).padStart(64, '0')}` });
    return json(404, { error: { code: 'NOT_FOUND' } });
  });
  return { f: f as unknown as typeof fetch, calls };
}

describe('mintPbrl', () => {
  const input = (f: typeof fetch, cents: number): MintInput => ({ apiKey: KEY, base: 'https://staging-api.pods.finance', account: ACCOUNT, cents, fetch: f });

  it('approves the profile once, then one quote and confirmation per R$1,000', async () => {
    const pods = fakePods();
    const r = await mintPbrl(input(pods.f, 250_050));
    expect(r).toEqual({ ok: true, mintedCents: 250_050, txHashes: [expect.any(String), expect.any(String), expect.any(String)] });
    const quotes = pods.calls.filter((c) => c.path === '/v2/swap/quote');
    expect(quotes).toHaveLength(3);
    expect(pods.calls.filter((c) => c.path === '/api/v1/kyc/status/sandbox/approved')).toHaveLength(1);
    expect(pods.calls.every((c) => c.key === KEY)).toBe(true);
    const confirms = pods.calls.filter((c) => c.path === '/v2/swap/status/sandbox/confirmed');
    expect(confirms.every((c) => (c.body as { kycUserId: string }).kycUserId === 'kyc-1')).toBe(true);
  });

  it('reuses an approved profile without approving it again', async () => {
    const pods = fakePods({ approved: true });
    expect((await mintPbrl(input(pods.f, 100))).ok).toBe(true);
    expect(pods.calls.some((c) => c.path === '/api/v1/kyc/status/sandbox/approved')).toBe(false);
  });

  it('names a wallet another profile holds, and passes any other refusal on by its code with what was minted', async () => {
    const linked = fakePods({ refuse: { path: '/api/v1/kyc/sumsub-share-token', status: 409, code: 'KYC_WALLET_ALREADY_LINKED' } });
    expect(await mintPbrl(input(linked.f, 100))).toEqual({ ok: false, error: 'wallet_linked_elsewhere', code: 'KYC_WALLET_ALREADY_LINKED', mintedCents: 0, txHashes: [] });
    const limit = fakePods({ refuse: { path: '/v2/swap/quote', status: 422, code: 'LIMIT_EXCEEDED' } });
    expect(await mintPbrl(input(limit.f, 100))).toMatchObject({ ok: false, error: 'pods_refused', code: 'LIMIT_EXCEEDED', mintedCents: 0 });
  });

  it('refuses a redirect without following it, so the key goes nowhere else', async () => {
    const calls: string[] = [];
    const f = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/api' } });
    }) as unknown as typeof fetch;
    expect(await mintPbrl(input(f, 100))).toMatchObject({ ok: false, error: 'pods_refused', code: 'REDIRECT', mintedCents: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('staging-api.pods.finance');
  });

  it('answers unreachable when the request itself fails', async () => {
    const f = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    expect(await mintPbrl(input(f, 100))).toMatchObject({ ok: false, error: 'pods_unreachable' });
  });
});

// ── the route ───────────────────────────────────────────────────────────────

function harness(opts: { env?: Record<string, unknown>; authority?: AuthorityCheck; mint?: TestnetRouteDeps['mint'] } = {}) {
  const replay = memoryReplay();
  const mint = vi.fn(opts.mint ?? (async (i: MintInput): Promise<MintResult> => ({ ok: true, mintedCents: i.cents, txHashes: ['0xabc'] })));
  const h = new Hono();
  h.route(
    '/v1/testnet',
    createTestnetRoutes({
      attestationMaxAgeMs: 3_600_000,
      now: () => NOW,
      authorityCheck: async () => opts.authority ?? HIGH,
      authorityMemo: createAuthorityMemo({ edge: null }),
      mint,
      replayStore: () => replay,
    }),
  );
  const env = { ENVIRONMENT: 'staging', PODS_SANDBOX_API_KEY: KEY, ...opts.env };
  const send = (body: unknown, token: string | null = fx.fast, extra: Record<string, string> = {}) => {
    const url = `${ORIGIN}/v1/testnet/brs/mint`;
    const headers: Record<string, string> = { 'content-type': 'application/json', ...extra };
    if (token) {
      headers.authorization = `DPoP ${token}`;
      headers.dpop = signProof({ htm: 'POST', htu: url, token });
    }
    return h.request(url, { method: 'POST', headers, body: JSON.stringify(body) }, env as never);
  };
  return { send, mint };
}

describe('POST /v1/testnet/brs/mint', () => {
  it('mints to the session account and answers the token, its decimals and the transactions', async () => {
    const { send, mint } = harness();
    const res = await send({ account: ACCOUNT, amount: '200' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, token: PBRL_BASE_SEPOLIA, decimals: 18, requestedCents: 20_000, mintedCents: 20_000, txHashes: ['0xabc'] });
    expect(mint).toHaveBeenCalledWith({ apiKey: KEY, base: 'https://staging-api.pods.finance', account: getAddress(ACCOUNT), cents: 20_000 });
  });

  it('is not there in production, and unavailable without the staging key or with another host', async () => {
    expect((await harness({ env: { ENVIRONMENT: 'production' } }).send({ account: ACCOUNT, amount: '1' })).status).toBe(404);
    expect((await harness({ env: { PODS_SANDBOX_API_KEY: undefined } }).send({ account: ACCOUNT, amount: '1' })).status).toBe(503);
    const other = harness({ env: { PODS_API_BASE_URL: 'https://api.pods.finance' } });
    expect((await other.send({ account: ACCOUNT, amount: '1' })).status).toBe(503);
    expect(other.mint).not.toHaveBeenCalled();
  });

  it('runs the global brake and the per-IP ceiling before the body, the session or Pods', async () => {
    const refusing = { limit: async () => ({ success: false }) };
    const global = harness({ env: { BRS_MINT_GLOBAL_RL: refusing } });
    expect((await global.send({ account: ACCOUNT, amount: '1' })).status).toBe(429);
    const perIp = harness({ env: { BRS_MINT_IP_RL: refusing } });
    const res = await perIp.send({ account: 'not-even-an-address', amount: 'x' }, null, { 'cf-connecting-ip': '203.0.113.9' });
    expect(res.status).toBe(429);
    expect(global.mint).not.toHaveBeenCalled();
    expect(perIp.mint).not.toHaveBeenCalled();
  });

  it('refuses a bad body or amount before the session, and no session at all', async () => {
    const { send, mint } = harness();
    expect((await send({ account: 'nope', amount: '1' })).status).toBe(400);
    expect(await (await send({ account: ACCOUNT, amount: '5000.01' })).json()).toMatchObject({ error: 'bad_amount' });
    expect((await send({ account: ACCOUNT, amount: '1' }, null)).status).toBe(401);
    expect(mint).not.toHaveBeenCalled();
  });

  it('refuses another account than the session names, and an account without an active High', async () => {
    const { send, mint } = harness();
    expect((await send({ account: '0x0000000000000000000000000000000000000001', amount: '1' })).status).toBe(401);
    const notHigh = harness({ authority: { status: 'not_found' } });
    expect((await notHigh.send({ account: ACCOUNT, amount: '1' })).status).toBe(401);
    expect(mint).not.toHaveBeenCalled();
    expect(notHigh.mint).not.toHaveBeenCalled();
  });

  it('answers 409 for a wallet another profile holds and 502 for any other refusal, with what was minted', async () => {
    const linked = harness({ mint: async () => ({ ok: false, error: 'wallet_linked_elsewhere', code: 'KYC_WALLET_ALREADY_LINKED', mintedCents: 0, txHashes: [] }) });
    expect((await linked.send({ account: ACCOUNT, amount: '1' })).status).toBe(409);
    const half = harness({ mint: async () => ({ ok: false, error: 'pods_refused', code: 'LIMIT_EXCEEDED', mintedCents: 100_000, txHashes: ['0x1'] }) });
    const res = await half.send({ account: ACCOUNT, amount: '2000' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ mintedCents: 100_000, txHashes: ['0x1'], code: 'LIMIT_EXCEEDED' });
  });

  it('logs the outcome and the amount, never the account or the key', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    try {
      await harness().send({ account: ACCOUNT, amount: '3' });
    } finally {
      spy.mockRestore();
    }
    const all = lines.join('\n');
    expect(all).toContain('brs_mint');
    expect(all.toLowerCase()).not.toContain(ACCOUNT.toLowerCase().slice(2));
    expect(all).not.toContain(KEY);
  });
});
