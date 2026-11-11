// Copyright (c) 2026 Cofferdam Inc
// SPDX-License-Identifier: Apache-2.0

/**
 * The Vault mirror's routes (workspace decision 0081, item 4; runbook
 * `docs/runbooks/vault-build.md`, step 4) on the in-memory `VaultStore`, with
 * the SDK-made v2 fixture tokens and an independent proof signer: the gate's
 * order, the tiers, the key scheme, the body rules, R2's checksum refusal, the
 * listing's cursor, the wipe, the development tolerance, and no key beside an
 * account in any log line.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { p256 } from '@noble/curves/p256';
import { getAddress, hexToBytes, sha256, type Address, type Hex } from 'viem';

import { createVaultRoutes, redactVaultPath, VAULT_MAX_OBJECT_BYTES, type VaultRouteDeps } from '../src/routes/vault.js';
import type { AuthorityCheck } from '../src/services/authorityCheck.js';
import { TIER } from '../src/services/ceremony.js';
import { createAuthorityMemo } from '../src/services/chat/authorityMemo.js';
import type { ReplayStore } from '../src/services/popReplayStore.js';
import { popAth } from '../src/services/sessionAttestation.js';
import { isChecksumMismatch, R2_BAD_DIGEST, r2VaultStore, type VaultObjectInfo } from '../src/services/vault/store.js';

import { MemoryVaultStore } from './memoryVaultStore.js';
import v1 from './fixtures/sdk-attestations.json';
import v2 from './fixtures/sdk-attestations-v2.json';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const ACCOUNT = v2.account as Address;
const PREFIX = ACCOUNT.toLowerCase();
const OTHER = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' as Address;
const NOW = v2.issuedAt + 1_000;
const ORIGIN = v2.origin;
const fx = v2.tokens.p256;
const IP = '203.0.113.7';
const HIGH: AuthorityCheck = { status: 'active', authorityId: 0, module: ACCOUNT, tier: TIER.High };

// ── helpers: an independent proof signer (a copy of sessionAttestationV2.test.ts's) ──

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

function signProof(opts: { priv?: Hex; htm: string; htu: string; token: string; iat?: number; jti?: string }): string {
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

async function hex256(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

const bytesOf = (s: string) => new TextEncoder().encode(s);

// ── the harness ───────────────────────────────────────────────────────────────

interface Harness {
  store: MemoryVaultStore;
  /** Every limiter call and authority read, in order: `global`, `ip`, `authority`, `account`. */
  events: string[];
  /** The keys each limiter was called with. */
  keys: string[];
  send(
    method: string,
    path: string,
    opts?: {
      token?: string | null;
      body?: BodyInit;
      headers?: Record<string, string>;
      env?: Record<string, unknown>;
      proof?: string | null;
      duplex?: boolean;
    },
  ): Promise<Response>;
}

function harness(
  opts: {
    store?: MemoryVaultStore | null;
    authority?: AuthorityCheck;
    refuse?: 'global' | 'ip' | 'account';
    deps?: Partial<VaultRouteDeps>;
  } = {},
): Harness {
  const store = opts.store === undefined ? new MemoryVaultStore(() => new Date(NOW)) : opts.store;
  const events: string[] = [];
  const keys: string[] = [];
  const limiter = (name: 'global' | 'ip' | 'account') => ({
    limit: async ({ key }: { key: string }) => {
      events.push(name);
      keys.push(key);
      return { success: opts.refuse !== name };
    },
  });
  const replay = memoryReplay();
  const h = new Hono();
  h.route(
    '/v1/vault',
    createVaultRoutes({
      attestationMaxAgeMs: 3_600_000,
      now: () => NOW,
      authorityCheck: async () => {
        events.push('authority');
        return opts.authority ?? HIGH;
      },
      authorityMemo: createAuthorityMemo({ edge: null }),
      store: () => store,
      replayStore: () => replay,
      ...opts.deps,
    }),
  );
  return {
    store: store ?? new MemoryVaultStore(),
    events,
    keys,
    send(method, path, o = {}) {
      const url = `${ORIGIN}${path}`;
      const token = o.token === undefined ? fx.fast : o.token;
      const headers: Record<string, string> = { 'cf-connecting-ip': IP, ...o.headers };
      if (token) {
        headers.authorization = `DPoP ${token}`;
        if (o.proof !== null) headers.dpop = o.proof ?? signProof({ htm: method, htu: url, token });
      }
      const init: RequestInit & { duplex?: 'half' } = { method, headers, body: o.body };
      if (o.duplex) init.duplex = 'half';
      return Promise.resolve(
        h.request(url, init, {
          ENVIRONMENT: 'staging',
          VAULT_GLOBAL_RL: limiter('global'),
          VAULT_IP_RL: limiter('ip'),
          VAULT_RL: limiter('account'),
          ...o.env,
        } as never),
      );
    },
  };
}

/** A put of `bytes` with its length and, unless `sha` is null, its SHA-256. */
async function put(t: Harness, path: string, bytes: Uint8Array, o: { sha?: string | null; token?: string | null; env?: Record<string, unknown> } = {}) {
  const sha = o.sha === undefined ? await hex256(bytes) : o.sha;
  return t.send('PUT', path, {
    token: o.token,
    env: o.env,
    body: bytes,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength), ...(sha ? { 'x-cofferdam-sha256': sha } : {}) },
  });
}

const obj = (kind: string, id: string, account: string = ACCOUNT) => `/v1/vault/${account}/objects/${kind}/${id}`;

// ── the gate ─────────────────────────────────────────────────────────────────

describe('the Vault gate', () => {
  it('runs the global brake, the per-IP ceiling, the High check, then the per-account bucket', async () => {
    const t = harness();
    const res = await put(t, obj('documents', 'doc-1'), bytesOf('sealed'));
    expect(res.status).toBe(200);
    expect(t.events).toEqual(['global', 'ip', 'authority', 'account']);
    expect(t.keys).toEqual(['vault:global', `vault-ip:${IP}`, `vault:${PREFIX}`]);
  });

  it('answers 429 when the global brake refuses, before the IP ceiling, the session or the account', async () => {
    const t = harness({ refuse: 'global' });
    const res = await t.send('GET', obj('documents', 'doc-1'));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'rate_limited' });
    expect(t.events).toEqual(['global']);
  });

  it('answers 429 when the per-IP ceiling refuses, before the session or the account', async () => {
    const t = harness({ refuse: 'ip' });
    const res = await t.send('GET', obj('documents', 'doc-1'));
    expect(res.status).toBe(429);
    expect(t.events).toEqual(['global', 'ip']);
  });

  it('answers 429 when the per-account bucket refuses, after the gate passed', async () => {
    const t = harness({ refuse: 'account' });
    const res = await t.send('GET', obj('documents', 'doc-1'));
    expect(res.status).toBe(429);
    expect(t.events).toEqual(['global', 'ip', 'authority', 'account']);
    expect(t.store.calls).toEqual([]);
  });

  it("refuses a token for account A on account B's path with 401 attestation_rejected, counting no account", async () => {
    const t = harness();
    const res = await put(t, obj('documents', 'doc-1', OTHER), bytesOf('sealed'));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'attestation_rejected' });
    expect(t.events).toEqual(['global', 'ip']);
    expect(t.store.objects.size).toBe(0);
  });

  it('refuses a missing token outside development with 401 attestation_required', async () => {
    const t = harness();
    const res = await t.send('GET', obj('documents', 'doc-1'), { token: null });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'attestation_required' });
    expect(t.events).not.toContain('account');
  });

  it('refuses a v2 token without its proof, and a replayed proof', async () => {
    const t = harness();
    const bare = await t.send('GET', obj('documents', 'doc-1'), { proof: null });
    expect(bare.status).toBe(401);
    expect(await bare.json()).toMatchObject({ error: 'proof_required' });
    const url = `${ORIGIN}${obj('documents', 'doc-1')}`;
    const proof = signProof({ htm: 'GET', htu: url, token: fx.fast });
    expect((await t.send('GET', obj('documents', 'doc-1'), { proof })).status).toBe(404);
    const again = await t.send('GET', obj('documents', 'doc-1'), { proof });
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ error: 'proof_rejected' });
  });

  it("refuses a proof signed for another object's URL", async () => {
    const t = harness();
    const proof = signProof({ htm: 'GET', htu: `${ORIGIN}${obj('documents', 'doc-2')}`, token: fx.fast });
    const res = await t.send('GET', obj('documents', 'doc-1'), { proof });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'proof_rejected' });
  });

  it('answers the High check as the chat does, with reason authority: 401 for a key that is not an active High, account_not_deployed included', async () => {
    for (const [authority, why] of [
      [{ status: 'not_found' }, 'not_found'],
      [{ status: 'account_not_deployed' }, 'account_not_deployed'],
      [{ status: 'active', authorityId: 2, module: ACCOUNT, tier: 1 }, 'authority 2 is not High'],
    ] as [AuthorityCheck, string][]) {
      const t = harness({ authority });
      const res = await t.send('GET', obj('documents', 'doc-1'));
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string; reason?: string; message: string };
      expect(body.error).toBe('attestation_rejected');
      // The app renews no session for a refused account.
      expect(body.reason).toBe('authority');
      expect(body.message).toContain(`(${why})`);
      expect(t.events).not.toContain('account');
    }
  });

  it('answers 503 authority_check_unavailable when Base cannot be read', async () => {
    const t = harness({ authority: { status: 'check_failed', message: 'rpc down' } });
    const res = await t.send('GET', obj('documents', 'doc-1'));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'authority_check_unavailable' });
    expect(t.events).not.toContain('account');
  });

  it('remembers a passed High check, so a second request does not read Base', async () => {
    const t = harness();
    await t.send('GET', obj('documents', 'doc-1'));
    await t.send('GET', obj('documents', 'doc-1'));
    expect(t.events.filter((e) => e === 'authority')).toHaveLength(1);
  });

  it('answers 503 vault_unprovisioned when VAULT is not bound', async () => {
    const t = harness({ store: null, deps: { store: () => null } });
    const res = await t.send('GET', obj('documents', 'doc-1'));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'vault_unprovisioned' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses a malformed account with 400 bad_account', async () => {
    const t = harness();
    const res = await t.send('GET', '/v1/vault/0x1234/objects/documents/doc-1');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_account' });
  });
});

// ── the tiers and the development tolerance ─────────────────────────────────

describe('tiers and the development tolerance', () => {
  it('refuses a fast token on DELETE / with 401 step_up_required, deleting nothing', async () => {
    const t = harness();
    await put(t, obj('documents', 'doc-1'), bytesOf('sealed'));
    const res = await t.send('DELETE', `/v1/vault/${ACCOUNT}`, { token: fx.fast });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'step_up_required', requiredTier: 'slow' });
    expect(t.store.objects.size).toBe(1);
  });

  it('takes a v1 bearer token for an hour on the fast routes and ten minutes on the wipe', async () => {
    const at = (ms: number) => harness({ deps: { now: () => v1.fields.issuedAt + ms } });
    const token = v1.p256.token;
    const late = at(11 * 60_000);
    expect((await late.send('POST', `/v1/vault/${ACCOUNT}/list`, { token, proof: null })).status).toBe(200);
    const wipe = await late.send('DELETE', `/v1/vault/${ACCOUNT}`, { token, proof: null });
    expect(wipe.status).toBe(401);
    expect(await wipe.json()).toMatchObject({ error: 'attestation_rejected' });
    expect((await at(60_000).send('DELETE', `/v1/vault/${ACCOUNT}`, { token, proof: null })).status).toBe(200);
    const off = await at(60_000).send('POST', `/v1/vault/${ACCOUNT}/list`, { token, proof: null, env: { CSA1_V1_ACCEPTED: 'false' } });
    expect(off.status).toBe(401);
  });

  it('reads Base live for the wipe, never the five-minute memory a fast route filled', async () => {
    const t = harness();
    expect((await t.send('POST', `/v1/vault/${ACCOUNT}/list`, { token: fx.slow })).status).toBe(200);
    expect((await t.send('POST', `/v1/vault/${ACCOUNT}/list`, { token: fx.slow })).status).toBe(200);
    expect(t.events.filter((e) => e === 'authority')).toHaveLength(1);
    expect((await t.send('DELETE', `/v1/vault/${ACCOUNT}`, { token: fx.slow })).status).toBe(200);
    expect(t.events.filter((e) => e === 'authority')).toHaveLength(2);
  });

  it('takes a slow token on the fast routes', async () => {
    const t = harness();
    expect((await put(t, obj('documents', 'doc-1'), bytesOf('sealed'), { token: fx.slow })).status).toBe(200);
  });

  it('tolerates a missing token only under ENVIRONMENT development, with the prefix from the path, lower-cased', async () => {
    const checksummed = getAddress(OTHER);
    const dev = harness();
    const res = await put(dev, obj('documents', 'doc-1', checksummed), bytesOf('sealed'), { token: null, env: { ENVIRONMENT: 'development' } });
    expect(res.status).toBe(200);
    expect([...dev.store.objects.keys()]).toEqual([`${OTHER.toLowerCase()}/documents/doc-1.bin`]);
    expect(dev.events).toEqual(['global', 'ip', 'account']);

    for (const ENVIRONMENT of ['staging', 'production']) {
      const t = harness();
      const refused = await put(t, obj('documents', 'doc-1', checksummed), bytesOf('sealed'), { token: null, env: { ENVIRONMENT } });
      expect(refused.status).toBe(401);
      expect(await refused.json()).toMatchObject({ error: 'attestation_required' });
      expect(t.store.objects.size).toBe(0);
    }
  });

  it('does not tolerate a wrong token under development', async () => {
    const t = harness();
    const res = await put(t, obj('documents', 'doc-1', OTHER), bytesOf('sealed'), { env: { ENVIRONMENT: 'development' } });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'attestation_rejected' });
  });

  it('keys an object under the attested address, lower-cased, whatever the path spells', async () => {
    const t = harness();
    const res = await put(t, obj('documents', 'doc-1', getAddress(ACCOUNT)), bytesOf('sealed'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, key: `${PREFIX}/documents/doc-1.bin`, size: 6 });
  });
});

// ── the key scheme ───────────────────────────────────────────────────────────

describe('the key scheme', () => {
  it('takes the four kinds and the fixed ids, appending .bin', async () => {
    const t = harness();
    const id43 = b64url(crypto.getRandomValues(new Uint8Array(32)));
    expect(id43).toHaveLength(43);
    for (const [kind, id] of [
      ['documents', 'row_123-abc'],
      ['db', 'vault-v1'],
      ['db', 'key-v1'],
      ['contacts', 'v1'],
      ['prf', id43],
      ['documents', 'x'.repeat(96)],
    ]) {
      expect((await put(t, obj(kind!, id!), bytesOf(`${kind}/${id}`))).status).toBe(200);
    }
    expect([...t.store.objects.keys()].sort()).toEqual(
      [
        `${PREFIX}/documents/row_123-abc.bin`,
        `${PREFIX}/db/vault-v1.bin`,
        `${PREFIX}/db/key-v1.bin`,
        `${PREFIX}/contacts/v1.bin`,
        `${PREFIX}/prf/${id43}.bin`,
        `${PREFIX}/documents/${'x'.repeat(96)}.bin`,
      ].sort(),
    );
  });

  it('refuses another kind with 400 bad_kind, and an id outside the charset with 400 bad_id, before any limiter', async () => {
    const t = harness();
    const kind = await t.send('GET', obj('keys', 'doc-1'));
    expect(kind.status).toBe(400);
    expect(await kind.json()).toMatchObject({ error: 'bad_kind' });
    for (const id of ['vault.v1', 'x'.repeat(97), 'a%2Fb', 'a%2E%2E', 'caf%C3%A9', 'a%20b']) {
      const res = await t.send('GET', obj('documents', id));
      expect(res.status, id).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'bad_id' });
    }
    expect(t.events).toEqual([]);
  });
});

// ── the objects ──────────────────────────────────────────────────────────────

describe('PUT, GET, HEAD and DELETE', () => {
  let t: Harness;
  beforeEach(() => {
    t = harness();
  });

  it('round-trips the bytes, GET streaming them as octet-stream under no-store', async () => {
    const bytes = crypto.getRandomValues(new Uint8Array(1_000));
    const putRes = await put(t, obj('documents', 'doc-1'), bytes);
    expect(putRes.status).toBe(200);
    const answer = (await putRes.json()) as { ok: boolean; key: string; size: number; etag: string };
    expect(answer).toMatchObject({ ok: true, key: `${PREFIX}/documents/doc-1.bin`, size: 1_000 });
    expect(answer.etag).toBeTruthy();
    expect(putRes.headers.get('cache-control')).toBe('no-store');

    const got = await t.send('GET', obj('documents', 'doc-1'));
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('application/octet-stream');
    expect(got.headers.get('cache-control')).toBe('no-store');
    expect(got.headers.get('content-length')).toBe('1000');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
  });

  it('answers 404 not_found under no-store for a missing object', async () => {
    const res = await t.send('GET', obj('documents', 'nope'));
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });

  it('answers HEAD with the size and no body, without reading the bytes', async () => {
    await put(t, obj('db', 'vault-v1'), bytesOf('snapshot'));
    const res = await t.send('HEAD', obj('db', 'vault-v1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('');
    expect(t.store.calls).toEqual(['put', 'head']);
    expect((await t.send('HEAD', obj('db', 'key-v1'))).status).toBe(404);
  });

  it('deletes one object, and answers ok for one already gone', async () => {
    await put(t, obj('documents', 'doc-1'), bytesOf('a'));
    await put(t, obj('documents', 'doc-2'), bytesOf('b'));
    expect((await t.send('DELETE', obj('documents', 'doc-1'))).status).toBe(200);
    expect([...t.store.objects.keys()]).toEqual([`${PREFIX}/documents/doc-2.bin`]);
    expect((await t.send('DELETE', obj('documents', 'doc-1'))).status).toBe(200);
  });

  it('refuses a body without content-length (chunked) with 411 length_required, reading nothing', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytesOf('sealed'));
        c.close();
      },
    });
    const res = await t.send('PUT', obj('documents', 'doc-1'), { body: stream, duplex: true, headers: { 'transfer-encoding': 'chunked' } });
    expect(res.status).toBe(411);
    expect(await res.json()).toMatchObject({ error: 'length_required' });
    expect(t.store.calls).toEqual([]);
  });

  it('refuses a content-length over 64 MiB with 413 object_too_large, reading nothing', async () => {
    const res = await t.send('PUT', obj('documents', 'doc-1'), {
      body: bytesOf('x'),
      headers: { 'content-length': String(VAULT_MAX_OBJECT_BYTES + 1) },
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'object_too_large', maxBytes: 64 * 1024 * 1024 });
    expect(t.store.calls).toEqual([]);
  });

  it('puts without a checksum, and refuses a malformed one with 400 bad_checksum', async () => {
    expect((await put(t, obj('documents', 'doc-1'), bytesOf('sealed'), { sha: null })).status).toBe(200);
    const res = await put(t, obj('documents', 'doc-2'), bytesOf('sealed'), { sha: 'abc' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_checksum' });
  });

  it("maps R2's checksum refusal to 400 checksum_mismatch, so the app does not retry the same bytes", async () => {
    const wrong = await hex256(bytesOf('other bytes'));
    const res = await put(t, obj('documents', 'doc-1'), bytesOf('sealed'), { sha: wrong });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'checksum_mismatch' });
    expect(t.store.objects.size).toBe(0);
    // An upper-case hex checksum of the right bytes passes.
    const right = (await hex256(bytesOf('sealed'))).toUpperCase();
    expect((await put(t, obj('documents', 'doc-1'), bytesOf('sealed'), { sha: right })).status).toBe(200);
  });

  it('answers any other store failure with 503 vault_unavailable and the error name only', async () => {
    t.store.failWith = Object.assign(new Error(`get: We encountered an internal error. ${PREFIX}/documents/doc-1.bin (10001)`), { name: 'R2Error' });
    const res = await t.send('GET', obj('documents', 'doc-1'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'vault_unavailable', name: 'R2Error' });
  });
});

// ── the listing and the wipe ─────────────────────────────────────────────────

async function seed(store: MemoryVaultStore, keys: string[]) {
  for (const k of keys) await store.put(k, bytesOf(k));
  store.calls.length = 0;
}

describe('POST /list and DELETE /', () => {
  const mine = ['documents/a', 'documents/b', 'documents/c', 'db/vault-v1', 'db/key-v1'].map((k) => `${PREFIX}/${k}.bin`);
  const theirs = [`${OTHER}/documents/a.bin`, `${PREFIX}x/documents/a.bin`];

  it('lists the prefix page by page with the cursor in the JSON body, and nothing of another prefix', async () => {
    const store = new MemoryVaultStore(() => new Date(NOW), 2);
    await seed(store, [...mine, ...theirs]);
    const t = harness({ store });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const res = await t.send('POST', `/v1/vault/${ACCOUNT}/list`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cursor ? { cursor } : {}),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = (await res.json()) as { ok: true; objects: { key: string; size: number; uploaded: string }[]; cursor?: string };
      for (const o of body.objects) {
        expect(o.size).toBe(bytesOf(o.key).byteLength);
        expect(o.uploaded).toBe(new Date(NOW).toISOString());
        seen.push(o.key);
      }
      cursor = body.cursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen.sort()).toEqual([...mine].sort());
  });

  it('takes an empty body as the first page, and refuses another shape with 400 bad_request', async () => {
    const t = harness();
    await seed(t.store, mine);
    const empty = await t.send('POST', `/v1/vault/${ACCOUNT}/list`);
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { objects: unknown[] }).objects).toHaveLength(5);
    for (const body of ['[1]', '{"cursor":5}', '{"prefix":"0x"}', 'not json', '{"cursor":""}']) {
      const res = await t.send('POST', `/v1/vault/${ACCOUNT}/list`, { body });
      expect(res.status, body).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'bad_request' });
    }
  });

  it('wipes the whole prefix on a slow token, in list and delete loops, and nothing else', async () => {
    const store = new MemoryVaultStore(() => new Date(NOW), 2);
    await seed(store, [...mine, ...theirs]);
    const t = harness({ store });
    const res = await t.send('DELETE', `/v1/vault/${ACCOUNT}`, { token: fx.slow });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: 5 });
    expect([...store.objects.keys()].sort()).toEqual([...theirs].sort());
    expect(store.calls).toEqual(['list', 'delete', 'list', 'delete', 'list', 'delete']);
    expect(t.events).toEqual(['global', 'ip', 'authority', 'account']);
  });
});

// ── R2's checksum error, through the R2 adapter ──────────────────────────────

/** An R2Bucket over the memory store, answering R2's shapes (what `r2VaultStore` reads). */
function fakeBucket(mem: MemoryVaultStore): R2Bucket {
  const r2 = (i: VaultObjectInfo) => ({ key: i.key, size: i.size, httpEtag: i.etag, etag: i.etag.replace(/"/g, ''), uploaded: i.uploaded });
  return {
    async put(key: string, value: ReadableStream<Uint8Array> | Uint8Array, opts?: R2PutOptions) {
      return r2(await mem.put(key, value, { sha256: opts?.sha256 as string | undefined }));
    },
    async get(key: string) {
      const o = await mem.get(key);
      return o ? { ...r2(o), body: o.body } : null;
    },
    async head(key: string) {
      const o = await mem.head(key);
      return o ? r2(o) : null;
    },
    async delete(keys: string | string[]) {
      await mem.delete(Array.isArray(keys) ? keys : [keys]);
    },
    async list(opts: R2ListOptions) {
      const p = await mem.list({ prefix: opts.prefix ?? '', cursor: opts.cursor });
      return { objects: p.objects.map(r2), truncated: Boolean(p.cursor), cursor: p.cursor, delimitedPrefixes: [] };
    },
  } as unknown as R2Bucket;
}

describe("R2's checksum refusal", () => {
  it('is recognised by its v4 code, and by the message workerd formats when the code is missing', () => {
    expect(R2_BAD_DIGEST).toBe(10037);
    expect(isChecksumMismatch(Object.assign(new Error('put: whatever'), { name: 'R2Error', code: 10037 }))).toBe(true);
    expect(isChecksumMismatch(new Error('put: The SHA-256 checksum you specified did not match what we received. (10037)'))).toBe(true);
    expect(isChecksumMismatch(Object.assign(new Error('put: We encountered an internal error. (10001)'), { code: 10001 }))).toBe(false);
    expect(isChecksumMismatch('10037')).toBe(false);
  });

  it('passes x-cofferdam-sha256 to R2PutOptions.sha256 through the R2 adapter, and maps the refusal', async () => {
    const mem = new MemoryVaultStore(() => new Date(NOW));
    const t = harness({ deps: { store: () => r2VaultStore(fakeBucket(mem)) } });
    const bad = await put(t, obj('documents', 'doc-1'), bytesOf('sealed'), { sha: await hex256(bytesOf('x')) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'checksum_mismatch' });
    const good = await put(t, obj('documents', 'doc-1'), bytesOf('sealed'));
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({ key: `${PREFIX}/documents/doc-1.bin`, size: 6 });
  });
});

// ── no key beside an account in any log line, through the whole plane ──────

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

describe('the logs', () => {
  const lines: string[] = [];
  const originals = new Map<(typeof CONSOLE_METHODS)[number], PropertyDescriptor | undefined>();
  let app: { fetch(req: Request, env: unknown, ctx: unknown): Response | Promise<Response> };

  beforeAll(async () => {
    for (const m of CONSOLE_METHODS) {
      originals.set(m, Object.getOwnPropertyDescriptor(console, m));
      console[m] = (...args: unknown[]) => void lines.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    }
    app = (await import('../src/index.js')).default;
  });

  afterAll(() => {
    for (const [m, d] of originals) if (d) Object.defineProperty(console, m, d);
  });

  it('redacts the account and the id from the request logger', () => {
    expect(redactVaultPath(`<-- PUT /v1/vault/${ACCOUNT}/objects/documents/Secret-Id-9`)).toBe('<-- PUT /v1/vault/:account/objects/documents/:id');
    expect(redactVaultPath(`--> POST /v1/vault/${ACCOUNT}/list 200 3ms`)).toBe('--> POST /v1/vault/:account/list 200 3ms');
    expect(redactVaultPath(`--> DELETE /v1/vault/${ACCOUNT} 401 1ms`)).toBe('--> DELETE /v1/vault/:account 401 1ms');
    expect(redactVaultPath(`<-- GET /v1/vault/${ACCOUNT}/objects/${ACCOUNT}/x?y=1`)).toBe('<-- GET /v1/vault/:account/objects/:kind/:id');
    expect(redactVaultPath('<-- POST /v1/chat')).toBe('<-- POST /v1/chat');
    // The router matches the decoded path, so an encoded one is redacted the same.
    expect(redactVaultPath(`<-- GET /v1/%76ault/${ACCOUNT}/objects/documents/Secret`)).toBe('<-- GET /v1/vault/:account/objects/documents/:id');
    expect(redactVaultPath(`<-- GET /v1/vault/${ACCOUNT}/objects/documents/%53ecret 200`)).toBe('<-- GET /v1/vault/:account/objects/documents/:id 200');
  });

  it('writes no line carrying an account or an object id, on success, refusal or store failure', async () => {
    const mem = new MemoryVaultStore(() => new Date(NOW));
    const ID = 'Secret-Doc-Id-K9P2';
    const env = { ENVIRONMENT: 'development', BASE_SEPOLIA_RPC_URL: 'http://127.0.0.1:9/never-read', VAULT: fakeBucket(mem) };
    const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} };
    const go = (method: string, path: string, init: RequestInit = {}) =>
      Promise.resolve(app.fetch(new Request(`https://plane.test${path}`, { method, ...init }), env, ctx));
    lines.length = 0;

    const bytes = bytesOf('sealed bytes');
    expect(
      (await go('PUT', obj('documents', ID), { body: bytes, headers: { 'content-length': String(bytes.byteLength), 'x-cofferdam-sha256': await hex256(bytes) } })).status,
    ).toBe(200);
    expect(
      (await go('PUT', obj('documents', ID), { body: bytes, headers: { 'content-length': String(bytes.byteLength), 'x-cofferdam-sha256': await hex256(bytesOf('x')) } })).status,
    ).toBe(400);
    expect((await go('GET', obj('documents', ID))).status).toBe(200);
    expect((await go('HEAD', obj('documents', ID))).status).toBe(200);
    expect((await go('POST', `/v1/vault/${ACCOUNT}/list`)).status).toBe(200);
    mem.failWith = Object.assign(new Error(`get: internal error on ${PREFIX}/documents/${ID}.bin (10001)`), { name: 'R2Error' });
    expect((await go('GET', obj('documents', ID))).status).toBe(503);
    mem.failWith = null;
    expect((await go('DELETE', obj('documents', ID))).status).toBe(200);
    expect((await go('DELETE', `/v1/vault/${ACCOUNT}`)).status).toBe(200);

    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('\n').toLowerCase();
    expect(all).not.toContain(ID.toLowerCase());
    expect(all).not.toContain(PREFIX);
    expect(all).not.toContain(PREFIX.slice(2, 18));
    expect(lines.some((l) => l.includes('"kind":"vault"') && l.includes('"op":"get"') && l.includes('"error":"R2Error"'))).toBe(true);
    expect(lines).toContain('<-- PUT /v1/vault/:account/objects/documents/:id');
  });

  it('lists the six Vault routes in the GET / inventory', async () => {
    const res = await app.fetch(new Request('https://plane.test/'), { ENVIRONMENT: 'staging' }, {});
    const body = (await res.json()) as { routes: { method: string; path: string }[] };
    const vault = body.routes.filter((r) => r.path.startsWith('/v1/vault/')).map((r) => `${r.method} ${r.path}`);
    expect(vault).toEqual([
      'PUT /v1/vault/:account/objects/:kind/:id',
      'GET /v1/vault/:account/objects/:kind/:id',
      'HEAD /v1/vault/:account/objects/:kind/:id',
      'DELETE /v1/vault/:account/objects/:kind/:id',
      'POST /v1/vault/:account/list',
      'DELETE /v1/vault/:account',
    ]);
  });
});
