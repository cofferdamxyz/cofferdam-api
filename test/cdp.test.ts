// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

// The plane's CDP Server Wallet client (workspace decision 0090; runbook
// cdp-setup.md, E1) against a fake CDP that checks what the real one checks:
// the bearer JWT under the API key's Ed25519 public key, the wallet JWT under
// the Wallet Secret's P-256 public key, and `reqHash` against the body sent.

import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { parseTransaction, serializeTransaction, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeAll, describe, expect, it } from 'vitest';

import { bearerJwt, CdpKeyError, importApiKeySecret, requestHash, requiresWalletAuth, sortKeys } from '../src/services/cdp/auth.js';
import {
  CdpApiError,
  cdpCredentialsOf,
  cdpNetworkOf,
  CdpResponseError,
  createCdpClient,
  newIdempotencyKey,
  type CdpCredentials,
} from '../src/services/cdp/client.js';

const KEY_ID = 'organizations/test/apiKeys/plane';
const NOW = 1_800_000_000;
// A throwaway key standing in for the CDP account's enclave key.
const ACCOUNT = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const TX_HASH = `0x${'ab'.repeat(32)}` as Hex;

const b64 = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64');
const fromB64Url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const decodePart = (s: string) => JSON.parse(fromB64Url(s).toString('utf8')) as Record<string, unknown>;

let creds: CdpCredentials;
let apiPublic: CryptoKey;
let walletPublic: CryptoKey;

beforeAll(async () => {
  const ed = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const edJwk = (await crypto.subtle.exportKey('jwk', ed.privateKey)) as JsonWebKey;
  const seedAndPublic = Buffer.concat([fromB64Url(edJwk.d!), fromB64Url(edJwk.x!)]);
  const ec = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  creds = { apiKeyId: KEY_ID, apiKeySecret: b64(seedAndPublic), walletSecret: b64((await crypto.subtle.exportKey('pkcs8', ec.privateKey)) as ArrayBuffer) };
  apiPublic = ed.publicKey;
  walletPublic = ec.publicKey;
});

async function verifyJwt(token: string, key: CryptoKey, algorithm: Parameters<SubtleCrypto['verify']>[0]) {
  const [h, c, s] = token.split('.');
  const ok = await crypto.subtle.verify(algorithm, key, fromB64Url(s!), new TextEncoder().encode(`${h}.${c}`));
  return { ok, header: decodePart(h!), claims: decodePart(c!) };
}

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fake CDP: records each request, checks both JWTs, then answers with `reply`. */
function fakeCdp(reply: (req: Seen) => Promise<Response> | Response) {
  const seen: Seen[] = [];
  const problems: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: Seen = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    seen.push(req);
    const url = new URL(req.url);
    const uri = `${req.method} ${url.host}${url.pathname}`;
    const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const b = await verifyJwt(bearer, apiPublic, { name: 'Ed25519' });
    if (!b.ok) problems.push('bearer signature');
    if (b.header.alg !== 'EdDSA' || b.header.kid !== KEY_ID || b.header.typ !== 'JWT' || !/^[0-9a-f]{32}$/.test(String(b.header.nonce))) problems.push('bearer header');
    if (b.claims.sub !== KEY_ID || b.claims.iss !== 'cdp' || b.claims.iat !== NOW || b.claims.nbf !== NOW || b.claims.exp !== NOW + 120) problems.push('bearer claims');
    if (JSON.stringify(b.claims.uris) !== JSON.stringify([uri])) problems.push('bearer uris');
    const walletAuth = req.headers['x-wallet-auth'];
    if (walletAuth) {
      const w = await verifyJwt(walletAuth, walletPublic, { name: 'ECDSA', hash: 'SHA-256' });
      if (!w.ok) problems.push('wallet signature');
      if (w.header.alg !== 'ES256' || w.header.typ !== 'JWT' || 'kid' in w.header) problems.push('wallet header');
      if (w.claims.iat !== NOW || w.claims.nbf !== NOW || 'exp' in w.claims || !/^[0-9a-f]{32}$/.test(String(w.claims.jti))) problems.push('wallet claims');
      if (JSON.stringify(w.claims.uris) !== JSON.stringify([uri])) problems.push('wallet uris');
      // CDP's side: the hash of the body it received, keys sorted, by an independent SHA-256.
      const expected = req.body ? createHash('sha256').update(JSON.stringify(sortKeys(JSON.parse(req.body)))).digest('hex') : undefined;
      if (w.claims.reqHash !== expected) problems.push('wallet reqHash');
    }
    return reply(req);
  }) as typeof fetch;
  return { seen, problems, fetchFn };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const TYPED = {
  domain: { name: 'CofferdamHandleAnchor', version: '1', chainId: 84532n, verifyingContract: '0x1111111111111111111111111111111111111111' as Address },
  types: { Hold: [{ name: 'handleId', type: 'bytes32' }, { name: 'until', type: 'uint64' }] },
  primaryType: 'Hold' as const,
  message: { handleId: `0x${'12'.repeat(32)}` as Hex, until: 1_800_100_000n },
};

describe('auth', () => {
  it('hashes the body with its keys sorted at every depth, arrays in order', async () => {
    const body = { b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } };
    expect(JSON.stringify(sortKeys(body))).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
    expect(await requestHash(body)).toBe(createHash('sha256').update('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}').digest('hex'));
  });

  it('asks for the wallet JWT only on writes under the EVM accounts API', () => {
    const u = (p: string) => new URL(`https://api.cdp.coinbase.com/platform${p}`);
    expect(requiresWalletAuth('POST', u('/v2/evm/accounts/0xabc/send/transaction'))).toBe(true);
    expect(requiresWalletAuth('post', u('/v2/evm/accounts/0xabc/sign/typed-data'))).toBe(true);
    expect(requiresWalletAuth('GET', u('/v2/evm/accounts/by-name/relayer'))).toBe(false);
    expect(requiresWalletAuth('POST', u('/v2/data/webhooks'))).toBe(false);
  });

  it('refuses malformed keys by name, never echoing them', async () => {
    await expect(importApiKeySecret('not base64!')).rejects.toThrow(CdpKeyError);
    await expect(importApiKeySecret(b64(new Uint8Array(32)))).rejects.toThrow(/64 bytes/);
    const err = await importApiKeySecret('c2VjcmV0LXRoYXQtbXVzdC1ub3QtbGVhaw==').catch((e: Error) => e);
    expect(String(err)).not.toContain('c2VjcmV0');
    const client = createCdpClient({ ...creds, walletSecret: b64(new Uint8Array(40)) }, { fetch: fakeCdp(() => json({})).fetchFn });
    await expect(client.getAccountByName('relayer')).rejects.toThrow(/P-256/);
  });

  it('makes a fresh nonce per bearer token', async () => {
    const key = await importApiKeySecret(creds.apiKeySecret);
    const url = new URL('https://api.cdp.coinbase.com/platform/v2/evm/accounts/by-name/relayer');
    const [a, b] = await Promise.all([bearerJwt({ keyId: KEY_ID, key, method: 'GET', url }), bearerJwt({ keyId: KEY_ID, key, method: 'GET', url })]);
    expect(decodePart(a.split('.')[0]!).nonce).not.toBe(decodePart(b.split('.')[0]!).nonce);
  });
});

describe('credentials', () => {
  it('needs all three secrets', () => {
    expect(cdpCredentialsOf({ CDP_API_KEY_ID: 'k', CDP_API_KEY_SECRET: 's', CDP_WALLET_SECRET: ' w ' })).toEqual({ apiKeyId: 'k', apiKeySecret: 's', walletSecret: 'w' });
    expect(cdpCredentialsOf({ CDP_API_KEY_ID: 'k', CDP_API_KEY_SECRET: 's' })).toBeNull();
    expect(cdpCredentialsOf({ CDP_API_KEY_ID: '', CDP_API_KEY_SECRET: 's', CDP_WALLET_SECRET: 'w' })).toBeNull();
  });

  it('names only Base and Base Sepolia', () => {
    expect(cdpNetworkOf(8453)).toBe('base');
    expect(cdpNetworkOf(84532)).toBe('base-sepolia');
    expect(cdpNetworkOf(1)).toBeNull();
  });
});

describe('getAccountByName', () => {
  it('reads the address with a bearer JWT and no wallet JWT', async () => {
    const cdp = fakeCdp(() => json({ address: ACCOUNT.address.toLowerCase(), name: 'relayer', policies: ['pol-1'] }));
    const client = createCdpClient(creds, { fetch: cdp.fetchFn, now: () => NOW });
    expect(await client.getAccountByName('relayer')).toEqual({ address: ACCOUNT.address, name: 'relayer', policies: ['pol-1'] });
    expect(cdp.problems).toEqual([]);
    expect(cdp.seen[0]!.method).toBe('GET');
    expect(cdp.seen[0]!.url).toBe('https://api.cdp.coinbase.com/platform/v2/evm/accounts/by-name/relayer');
    expect(cdp.seen[0]!.headers['x-wallet-auth']).toBeUndefined();
  });

  it('refuses a bad name before any request', async () => {
    const cdp = fakeCdp(() => json({}));
    const client = createCdpClient(creds, { fetch: cdp.fetchFn });
    await expect(client.getAccountByName('../policies')).rejects.toThrow(CdpResponseError);
    expect(cdp.seen).toHaveLength(0);
  });
});

describe('signTypedData', () => {
  it('sends the typed data with EIP712Domain, bigints as strings, and returns a signature that recovers to the account', async () => {
    const cdp = fakeCdp(async (req) => {
      const body = JSON.parse(req.body!) as { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };
      expect(body.types.EIP712Domain).toEqual([
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ]);
      expect(body.domain.chainId).toBe(84532);
      expect(body.message.until).toBe('1800100000');
      expect(body.primaryType).toBe('Hold');
      return json({ signature: await ACCOUNT.signTypedData(TYPED) });
    });
    const client = createCdpClient(creds, { fetch: cdp.fetchFn, now: () => NOW });
    const sig = await client.signTypedData(ACCOUNT.address, TYPED);
    expect(sig).toBe(await ACCOUNT.signTypedData(TYPED));
    expect(cdp.problems).toEqual([]);
    expect(cdp.seen[0]!.url).toBe(`https://api.cdp.coinbase.com/platform/v2/evm/accounts/${ACCOUNT.address}/sign/typed-data`);
    expect(cdp.seen[0]!.headers['x-wallet-auth']).toBeDefined();
  });

  it('signs a definition with no domain, and one that already lists EIP712Domain', async () => {
    const bare = { types: TYPED.types, primaryType: 'Hold' as const, message: TYPED.message };
    const listed = { ...TYPED, types: { ...TYPED.types, EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] } };
    for (const def of [bare, listed]) {
      const cdp = fakeCdp(async (req) => {
        const body = JSON.parse(req.body!) as { domain: unknown; types: { EIP712Domain: unknown } };
        expect(Array.isArray(body.types.EIP712Domain)).toBe(true);
        return json({ signature: await ACCOUNT.signTypedData(def as typeof TYPED) });
      });
      const client = createCdpClient(creds, { fetch: cdp.fetchFn, now: () => NOW });
      expect(await client.signTypedData(ACCOUNT.address, def)).toBe(await ACCOUNT.signTypedData(def as typeof TYPED));
      expect(cdp.problems).toEqual([]);
    }
  });

  it('refuses a signature made by another key', async () => {
    const other = privateKeyToAccount(`0x${'22'.repeat(32)}`);
    const cdp = fakeCdp(async () => json({ signature: await other.signTypedData(TYPED) }));
    const client = createCdpClient(creds, { fetch: cdp.fetchFn });
    await expect(client.signTypedData(ACCOUNT.address, TYPED)).rejects.toThrow(/another key/);
  });

  it('refuses a malformed definition before any request', async () => {
    const cdp = fakeCdp(() => json({}));
    const client = createCdpClient(creds, { fetch: cdp.fetchFn });
    const bad = { ...TYPED, message: { handleId: '0x12', until: 1n } };
    await expect(client.signTypedData(ACCOUNT.address, bad)).rejects.toThrow();
    expect(cdp.seen).toHaveLength(0);
  });

  it('refuses an answer of the wrong shape', async () => {
    const client = createCdpClient(creds, { fetch: fakeCdp(() => json({ signature: '0x1234' })).fetchFn });
    await expect(client.signTypedData(ACCOUNT.address, TYPED)).rejects.toThrow(CdpResponseError);
  });
});

describe('sendTransaction', () => {
  const TO = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address; // EntryPoint v0.7
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('sends an unsigned EIP-1559 transaction on the named network under the idempotency key', async () => {
    const cdp = fakeCdp(() => json({ transactionHash: TX_HASH }));
    const client = createCdpClient(creds, { fetch: cdp.fetchFn, now: () => NOW });
    const key = newIdempotencyKey();
    expect(key).toMatch(UUID_V4);
    const sent = await client.sendTransaction(ACCOUNT.address, { network: 'base-sepolia', transaction: { to: TO, data: '0x765e827f', value: 0n }, idempotencyKey: key });
    expect(sent).toEqual({ transactionHash: TX_HASH, idempotencyKey: key });
    expect(cdp.problems).toEqual([]);
    const req = cdp.seen[0]!;
    expect(req.url).toBe(`https://api.cdp.coinbase.com/platform/v2/evm/accounts/${ACCOUNT.address}/send/transaction`);
    expect(req.headers['x-idempotency-key']).toBe(key);
    const body = JSON.parse(req.body!) as { network: string; transaction: Hex };
    expect(body.network).toBe('base-sepolia');
    const tx = parseTransaction(body.transaction);
    expect(tx.type).toBe('eip1559');
    expect(tx.to?.toLowerCase()).toBe(TO.toLowerCase());
    expect(tx.chainId).toBe(84532);
    // Left out, the nonce, fees and gas encode as empty fields, which CDP fills (its SDK sends them the same way).
    expect([tx.nonce, tx.gas, tx.maxFeePerGas]).toEqual([0, undefined, undefined]);
  });

  it('resends a timed-out send under the same key', async () => {
    let calls = 0;
    const cdp = fakeCdp(() => {
      calls += 1;
      if (calls === 1) throw new DOMException('The operation timed out.', 'TimeoutError');
      return json({ transactionHash: TX_HASH });
    });
    const client = createCdpClient(creds, { fetch: cdp.fetchFn, now: () => NOW });
    const input = { network: 'base' as const, transaction: { to: TO }, idempotencyKey: newIdempotencyKey() };
    const err = (await client.sendTransaction(ACCOUNT.address, input).catch((e: unknown) => e)) as CdpApiError;
    expect([err.status, err.errorType, err.retryable]).toEqual([0, 'timeout', true]);
    await client.sendTransaction(ACCOUNT.address, input);
    expect(cdp.seen.map((r) => r.headers['x-idempotency-key'])).toEqual([input.idempotencyKey, input.idempotencyKey]);
    expect(cdp.seen[0]!.body).toBe(cdp.seen[1]!.body);
  });

  it('takes an RLP-encoded EIP-1559 transaction, and refuses another type, a malformed one or a key that is not a UUID v4', async () => {
    const cdp = fakeCdp(() => json({ transactionHash: TX_HASH }));
    const client = createCdpClient(creds, { fetch: cdp.fetchFn, now: () => NOW });
    const key = '5f0c2a8e-3b1d-4c6e-9a7f-0d2b4e6f8a1c';
    const raw = serializeTransaction({ type: 'eip1559', chainId: 8453, to: TO, data: '0x765e827f' });
    await client.sendTransaction(ACCOUNT.address, { network: 'base', transaction: raw, idempotencyKey: key });
    expect(cdp.seen[0]!.headers['x-idempotency-key']).toBe(key);
    expect((JSON.parse(cdp.seen[0]!.body!) as { transaction: Hex }).transaction).toBe(raw);
    const legacy = serializeTransaction({ type: 'legacy', chainId: 8453, to: TO, gasPrice: 1n });
    await expect(client.sendTransaction(ACCOUNT.address, { network: 'base', transaction: raw, idempotencyKey: 'again' })).rejects.toThrow(/UUID/);
    await expect(client.sendTransaction(ACCOUNT.address, { network: 'base', transaction: '0x1234' as Hex, idempotencyKey: key })).rejects.toThrow(/EIP-1559/);
    await expect(client.sendTransaction(ACCOUNT.address, { network: 'base', transaction: legacy, idempotencyKey: key })).rejects.toThrow(/EIP-1559/);
    await expect(client.sendTransaction(ACCOUNT.address, { network: 'base', transaction: '0x02f' as Hex, idempotencyKey: key })).rejects.toThrow(/EIP-1559/);
    expect(cdp.seen).toHaveLength(1);
  });

  it("carries CDP's error type and correlation id, and keeps its message out of every log of the error", async () => {
    const cdp = fakeCdp(() => json({ errorType: 'policy_violation', errorMessage: `rejected: to ${TO}`, correlationId: 'corr-1' }, 403));
    const client = createCdpClient(creds, { fetch: cdp.fetchFn });
    const err = (await client.sendTransaction(ACCOUNT.address, { network: 'base', transaction: { to: TO }, idempotencyKey: newIdempotencyKey() }).catch((e: unknown) => e)) as CdpApiError;
    expect(err).toBeInstanceOf(CdpApiError);
    expect([err.status, err.errorType, err.correlationId, err.retryable]).toEqual([403, 'policy_violation', 'corr-1', false]);
    expect(err.errorMessage).toContain(TO);
    for (const logged of [err.message, JSON.stringify(err), inspect(err), String(err)]) expect(logged.toLowerCase()).not.toContain(TO.toLowerCase());
  });

  it('maps a rate limit, an answer without an error body and no answer as retryable', async () => {
    const send = (fetchFn: typeof fetch) =>
      createCdpClient(creds, { fetch: fetchFn })
        .sendTransaction(ACCOUNT.address, { network: 'base', transaction: { to: TO }, idempotencyKey: newIdempotencyKey() })
        .then(
          () => {
            throw new Error('the send should have failed');
          },
          (e: unknown) => e as CdpApiError,
        );
    const limited = await send(fakeCdp(() => json({ errorType: 'rate_limit_exceeded', errorMessage: 'slow down' }, 429)).fetchFn);
    expect([limited.errorType, limited.retryable]).toEqual(['rate_limit_exceeded', true]);
    const down = await send(fakeCdp(() => new Response('upstream', { status: 503 })).fetchFn);
    expect([down.errorType, down.retryable]).toEqual(['service_unavailable', true]);
    const gone = await send((async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    expect([gone.status, gone.errorType, gone.retryable]).toEqual([0, 'network_error', true]);
  });

  it('never puts a secret in a request beyond its signed tokens', async () => {
    const cdp = fakeCdp(() => json({ transactionHash: TX_HASH }));
    const client = createCdpClient(creds, { fetch: cdp.fetchFn });
    await client.sendTransaction(ACCOUNT.address, { network: 'base', transaction: { to: TO }, idempotencyKey: newIdempotencyKey() });
    const wire = JSON.stringify(cdp.seen);
    for (const secret of [creds.apiKeySecret, creds.walletSecret]) expect(wire).not.toContain(secret);
  });
});
