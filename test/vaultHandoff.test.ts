// Copyright (c) 2026 Cofferdam Inc
// SPDX-License-Identifier: Apache-2.0

/**
 * The device-link ceremony's relay (workspace decision 0081, step 5; runbook
 * `docs/runbooks/vault-build.md`): `VaultHandoffDO` on a fake storage, then the
 * two handover routes on `DurableHandoffStore` over a fake namespace of those
 * objects, with the SDK-made v2 fixture tokens and an independent proof
 * signer. Put behind the slow tier, take once, 410 on the second, the alarm
 * deletes, a fast token on put refused, another account's take answered as
 * empty with the blob kept for the right one, and no key hash or account in
 * any log line.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { p256 } from '@noble/curves/p256';
import { getAddress, hexToBytes, sha256, type Address, type Hex } from 'viem';

import { createVaultRoutes, redactVaultPath, VAULT_HANDOVER_MAX_BYTES, VAULT_HANDOVER_TTL_MS, type VaultRouteDeps } from '../src/routes/vault.js';
import type { AuthorityCheck } from '../src/services/authorityCheck.js';
import { TIER } from '../src/services/ceremony.js';
import { createAuthorityMemo } from '../src/services/chat/authorityMemo.js';
import type { ReplayStore } from '../src/services/popReplayStore.js';
import { popAth } from '../src/services/sessionAttestation.js';
import { VaultHandoffDO, type HandoffEntry } from '../src/services/vaultHandoffDO.js';
import { DurableHandoffStore, type HandoffStore } from '../src/services/vaultHandoffStore.js';

import { MemoryVaultStore } from './memoryVaultStore.js';
import v2 from './fixtures/sdk-attestations-v2.json';

// The class under test needs its `ctx`; the route files' mock has no constructor.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));

const ACCOUNT = v2.account as Address;
const PREFIX = ACCOUNT.toLowerCase();
const OTHER = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' as Address;
const NOW = v2.issuedAt + 1_000;
const ORIGIN = v2.origin;
const fx = v2.tokens.p256;
const IP = '203.0.113.7';
const HIGH: AuthorityCheck = { status: 'active', authorityId: 0, module: ACCOUNT, tier: TIER.High };

/** A key hash as the app makes it: base64url of 32 bytes, 43 characters. */
const KEY_HASH = 'Kq3_mZ8-1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2w';
const BLOB = Uint8Array.from({ length: 125 }, (_, i) => (i * 7 + 3) & 0xff);

// ── a fake Durable Object storage and namespace ─────────────────────────────

interface FakeStorage {
  data: Map<string, unknown>;
  alarm: number | null;
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/** Values are structured-cloned in and out, as the real storage does. */
function fakeStorage(): FakeStorage {
  const s: FakeStorage = {
    data: new Map(),
    alarm: null,
    get: async <T,>(key: string) => (s.data.has(key) ? (structuredClone(s.data.get(key)) as T) : undefined),
    put: async (key, value) => void s.data.set(key, structuredClone(value)),
    delete: async (key) => s.data.delete(key),
    deleteAll: async () => s.data.clear(),
    getAlarm: async () => s.alarm,
    setAlarm: async (at) => void (s.alarm = at),
    deleteAlarm: async () => void (s.alarm = null),
  };
  return s;
}

function handoffDO(storage = fakeStorage()) {
  const object = new VaultHandoffDO({ storage } as never, {} as never);
  return { object, storage };
}

/** A namespace whose `getByName` hands out one object per name, kept across calls. */
function fakeNamespace() {
  const objects = new Map<string, ReturnType<typeof handoffDO>>();
  const names: string[] = [];
  return {
    objects,
    names,
    getByName(name: string) {
      names.push(name);
      if (!objects.has(name)) objects.set(name, handoffDO());
      return objects.get(name)!.object;
    },
  };
}

// ── the object ──────────────────────────────────────────────────────────────

describe('VaultHandoffDO', () => {
  const EXPIRES = NOW + VAULT_HANDOVER_TTL_MS;

  it('takes once, then answers taken until the alarm', async () => {
    const { object, storage } = handoffDO();
    expect(await object.put(PREFIX, BLOB, EXPIRES, NOW)).toBe('stored');
    expect(storage.alarm).toBe(EXPIRES);
    const first = await object.take(PREFIX, NOW + 1);
    expect(first.status).toBe('ok');
    expect(first.status === 'ok' && [...first.blob]).toEqual([...BLOB]);
    expect(await object.take(PREFIX, NOW + 2)).toEqual({ status: 'taken' });
    // The tombstone holds no bytes, and the alarm stays armed to delete it.
    expect(storage.data.get(`slot:${PREFIX}`)).toEqual({ blob: null, taken: true, expiresAt: EXPIRES } satisfies HandoffEntry);
    expect(storage.alarm).toBe(EXPIRES);
  });

  it('answers pending to an empty object', async () => {
    const { object } = handoffDO();
    expect(await object.take(PREFIX, NOW)).toEqual({ status: 'pending' });
  });

  it("answers another account's take as pending, and keeps the blob for the right one", async () => {
    const { object } = handoffDO();
    await object.put(PREFIX, BLOB, EXPIRES, NOW);
    expect(await object.take(OTHER.toLowerCase(), NOW)).toEqual({ status: 'pending' });
    expect((await object.take(PREFIX, NOW)).status).toBe('ok');
    // A tombstone reads as empty to another account too.
    expect(await object.take(OTHER.toLowerCase(), NOW)).toEqual({ status: 'pending' });
  });

  it("puts another account's blob in its own slot, never blocking this account's put", async () => {
    const { object } = handoffDO();
    expect(await object.put(OTHER.toLowerCase(), Uint8Array.of(9), EXPIRES, NOW)).toBe('stored');
    expect(await object.put(PREFIX, BLOB, EXPIRES, NOW)).toBe('stored');
    const mine = await object.take(PREFIX, NOW);
    expect(mine.status === 'ok' && [...mine.blob]).toEqual([...BLOB]);
  });

  it('answers exists to a second put by the same account, live or taken', async () => {
    const { object } = handoffDO();
    await object.put(PREFIX, BLOB, EXPIRES, NOW);
    expect(await object.put(PREFIX, Uint8Array.of(1), EXPIRES, NOW)).toBe('exists');
    await object.take(PREFIX, NOW);
    expect(await object.put(PREFIX, Uint8Array.of(1), EXPIRES, NOW)).toBe('exists');
  });

  it('the alarm deletes: a take after it answers pending', async () => {
    const { object, storage } = handoffDO();
    await object.put(PREFIX, BLOB, EXPIRES, NOW);
    await object.alarm();
    expect(storage.data.size).toBe(0);
    expect(await object.take(PREFIX, NOW)).toEqual({ status: 'pending' });
  });

  it('answers pending to an expired slot before the alarm fires, and deletes it', async () => {
    const { object, storage } = handoffDO();
    await object.put(PREFIX, BLOB, EXPIRES, NOW);
    expect(await object.take(PREFIX, EXPIRES)).toEqual({ status: 'pending' });
    expect(storage.data.size).toBe(0);
  });

  it('never pulls the alarm earlier than a live slot', async () => {
    const { object, storage } = handoffDO();
    await object.put(PREFIX, BLOB, EXPIRES, NOW);
    await object.put(OTHER.toLowerCase(), BLOB, EXPIRES - 60_000, NOW);
    expect(storage.alarm).toBe(EXPIRES);
    await object.put('0x' + 'ee'.repeat(20), BLOB, EXPIRES + 60_000, NOW);
    expect(storage.alarm).toBe(EXPIRES + 60_000);
  });
});

describe('DurableHandoffStore', () => {
  it('names one object per key hash and account, so another account reaches an empty one', async () => {
    const ns = fakeNamespace();
    const store = new DurableHandoffStore(ns as never);
    expect(await store.put(KEY_HASH, PREFIX, BLOB, NOW + 1_000, NOW)).toBe('stored');
    expect(await store.take(KEY_HASH, OTHER.toLowerCase(), NOW)).toEqual({ status: 'pending' });
    expect((await store.take(KEY_HASH, PREFIX, NOW)).status).toBe('ok');
    expect(await store.take(KEY_HASH, PREFIX, NOW)).toEqual({ status: 'taken' });
    expect(new Set(ns.names)).toEqual(new Set([`${KEY_HASH}:${PREFIX}`, `${KEY_HASH}:${OTHER.toLowerCase()}`]));
  });
});

// ── the routes ──────────────────────────────────────────────────────────────

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

function signProof(opts: { htm: string; htu: string; token: string }): string {
  const priv = hexToBytes(v2.devicePrivateKey as Hex);
  const pub = p256.getPublicKey(priv, false);
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: 'EC', crv: 'P-256', x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)) } };
  const payload = {
    htm: opts.htm,
    htu: opts.htu,
    iat: Math.floor(NOW / 1000),
    jti: b64url(crypto.getRandomValues(new Uint8Array(16))),
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

interface SendOpts {
  token?: string | null;
  body?: BodyInit;
  headers?: Record<string, string>;
  env?: Record<string, unknown>;
}

function harness(opts: { handoff?: HandoffStore | null; vault?: 'bound' | 'unbound'; deps?: Partial<VaultRouteDeps> } = {}) {
  const ns = fakeNamespace();
  const handoff = opts.handoff === undefined ? new DurableHandoffStore(ns as never) : opts.handoff;
  const events: string[] = [];
  const limiter = (name: string) => ({
    limit: async () => {
      events.push(name);
      return { success: true };
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
        return HIGH;
      },
      authorityMemo: createAuthorityMemo({ edge: null }),
      store: () => (opts.vault === 'unbound' ? null : new MemoryVaultStore(() => new Date(NOW))),
      replayStore: () => replay,
      handoffStore: () => handoff,
      ...opts.deps,
    }),
  );
  const send = (method: string, path: string, o: SendOpts = {}) => {
    const url = `${ORIGIN}${path}`;
    const token = o.token === undefined ? fx.fast : o.token;
    const headers: Record<string, string> = { 'cf-connecting-ip': IP, ...o.headers };
    if (token) {
      headers.authorization = `DPoP ${token}`;
      headers.dpop = signProof({ htm: method, htu: url, token });
    }
    // A stream body needs `duplex`, as a phone's chunked upload would send it.
    const init: RequestInit & { duplex?: 'half' } = { method, headers, body: o.body };
    if (o.body instanceof ReadableStream) init.duplex = 'half';
    return Promise.resolve(
      h.request(url, init, {
        ENVIRONMENT: 'staging',
        VAULT_GLOBAL_RL: limiter('global'),
        VAULT_IP_RL: limiter('ip'),
        VAULT_RL: limiter('account'),
        ...o.env,
      } as never),
    );
  };
  /** The old phone's put: the slow token, the length and the checksum. */
  const put = async (bytes: Uint8Array = BLOB, o: SendOpts & { sha?: string | null; account?: string; keyHash?: string } = {}) =>
    send('PUT', handover(o.keyHash, o.account), {
      token: o.token === undefined ? fx.slow : o.token,
      env: o.env,
      body: bytes,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.byteLength),
        ...(o.sha === null ? {} : { 'x-cofferdam-sha256': o.sha ?? (await hex256(bytes)) }),
        ...o.headers,
      },
    });
  return { ns, events, send, put };
}

const handover = (keyHash = KEY_HASH, account: string = ACCOUNT) => `/v1/vault/${account}/handover/${keyHash}`;

describe('PUT /v1/vault/:account/handover/:keyHash', () => {
  it('puts behind the slow tier, reading Base live, into the attested account\'s slot', async () => {
    const t = harness();
    const res = await t.put();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(t.events).toEqual(['global', 'ip', 'authority', 'account']);
    const { storage } = t.ns.objects.get(`${KEY_HASH}:${PREFIX}`)!;
    expect([...storage.data.keys()]).toEqual([`slot:${PREFIX}`]);
    expect((storage.data.get(`slot:${PREFIX}`) as HandoffEntry).expiresAt).toBe(NOW + VAULT_HANDOVER_TTL_MS);
  });

  it('refuses a fast token with 401 step_up_required, before the High check, storing nothing', async () => {
    const t = harness();
    const res = await t.put(BLOB, { token: fx.fast });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'step_up_required', requiredTier: 'slow' });
    expect(t.events).toEqual(['global', 'ip']);
    expect(t.ns.objects.size).toBe(0);
  });

  it('answers 409 handover_exists to a second put by the same account, reading Base live each time', async () => {
    const t = harness();
    expect((await t.put()).status).toBe(200);
    const again = await t.put(Uint8Array.of(1, 2, 3));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'handover_exists' });
    expect(t.events.filter((e) => e === 'authority')).toHaveLength(2);
  });

  it('refuses a body without content-length with 411 length_required, storing nothing', async () => {
    const t = harness();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(BLOB);
        c.close();
      },
    });
    const res = await t.send('PUT', handover(), { token: fx.slow, body: stream, headers: { 'transfer-encoding': 'chunked' } });
    expect(res.status).toBe(411);
    expect(await res.json()).toMatchObject({ error: 'length_required' });
    expect(t.ns.objects.size).toBe(0);
  });

  it('refuses a content-length over 4 KiB with 413 object_too_large, storing nothing', async () => {
    const t = harness();
    const res = await t.put(new Uint8Array(VAULT_HANDOVER_MAX_BYTES + 1));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'object_too_large', maxBytes: 4096 });
    expect(t.ns.objects.size).toBe(0);
    expect((await t.put(new Uint8Array(VAULT_HANDOVER_MAX_BYTES).fill(1))).status).toBe(200);
  });

  it('refuses an empty body or one shorter than its content-length with 400 bad_length', async () => {
    const t = harness();
    const empty = await t.put(new Uint8Array(0), { sha: null });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: 'bad_length' });
    const short = await t.put(BLOB, { sha: null, headers: { 'content-length': '200' } });
    expect(short.status).toBe(400);
    expect(await short.json()).toMatchObject({ error: 'bad_length' });
    expect(t.ns.objects.size).toBe(0);
  });

  it('checks the optional checksum: 400 bad_checksum, 400 checksum_mismatch, or none at all', async () => {
    const t = harness();
    const bad = await t.put(BLOB, { sha: 'abc' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'bad_checksum' });
    const wrong = await t.put(BLOB, { sha: await hex256(Uint8Array.of(1)) });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: 'checksum_mismatch' });
    expect(t.ns.objects.size).toBe(0);
    expect((await t.put(BLOB, { sha: (await hex256(BLOB)).toUpperCase() })).status).toBe(200);
  });

  it('answers 503 vault_unavailable when the relay throws, naming the error only', async () => {
    const t = harness({
      handoff: {
        put: () => Promise.reject(Object.assign(new Error(`storage failed for ${PREFIX}`), { name: 'DurableObjectError' })),
        take: () => Promise.reject(new Error('unused')),
      },
    });
    const res = await t.put();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'vault_unavailable', name: 'DurableObjectError' });
  });
});

describe('GET /v1/vault/:account/handover/:keyHash', () => {
  it('answers 404 handover_pending before the put, on the fast tier', async () => {
    const t = harness();
    const res = await t.send('GET', handover());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'handover_pending' });
    expect(t.events).toEqual(['global', 'ip', 'authority', 'account']);
  });

  it('takes once, then answers 410 handover_taken', async () => {
    const t = harness();
    await t.put();
    const first = await t.send('GET', handover());
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('application/octet-stream');
    expect(first.headers.get('content-length')).toBe('125');
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect([...new Uint8Array(await first.arrayBuffer())]).toEqual([...BLOB]);
    const second = await t.send('GET', handover());
    expect(second.status).toBe(410);
    expect(await second.json()).toEqual({ ok: false, error: 'handover_taken' });
  });

  it("answers another account's take with 404 handover_pending, and the blob is still there for the right one", async () => {
    const t = harness();
    await t.put();
    // The development tolerance is the one way to hold another account's prefix with the single-account fixtures.
    const other = await t.send('GET', handover(KEY_HASH, getAddress(OTHER)), { token: null, env: { ENVIRONMENT: 'development' } });
    expect(other.status).toBe(404);
    expect(await other.json()).toMatchObject({ error: 'handover_pending' });
    const mine = await t.send('GET', handover());
    expect(mine.status).toBe(200);
    expect([...new Uint8Array(await mine.arrayBuffer())]).toEqual([...BLOB]);
  });

  it('refuses HEAD with 405 before the gate, and the blob stays', async () => {
    const t = harness();
    await t.put();
    const events = t.events.length;
    const head = await t.send('HEAD', handover());
    expect(head.status).toBe(405);
    expect(t.events).toHaveLength(events);
    expect((await t.send('GET', handover())).status).toBe(200);
  });

  it('pins the take to the token: a fast token for the account cannot read another path account', async () => {
    const t = harness();
    await t.put();
    const res = await t.send('GET', handover(KEY_HASH, getAddress(OTHER)));
    expect(res.status).toBe(401);
    expect((await t.send('GET', handover())).status).toBe(200);
  });
});

describe('the handover gate', () => {
  it('refuses a malformed key hash with 400 bad_key_hash before any limiter', async () => {
    const t = harness();
    for (const bad of ['short', 'Kq3_mZ8-1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2', 'Kq3_mZ8-1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2w=', 'Kq3_mZ8+1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1uV2w']) {
      const res = await t.send('GET', handover(encodeURIComponent(bad)));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'bad_key_hash' });
      expect((await t.put(BLOB, { keyHash: encodeURIComponent(bad) })).status).toBe(400);
    }
    expect(t.events).toEqual([]);
  });

  it('answers 503 handover_unprovisioned when VAULT_HANDOFF_DO is not bound, before any limiter', async () => {
    const t = harness({ handoff: null });
    const get = await t.send('GET', handover());
    expect(get.status).toBe(503);
    expect(await get.json()).toEqual({ ok: false, error: 'handover_unprovisioned' });
    expect((await t.put()).status).toBe(503);
    expect(t.events).toEqual([]);
  });

  it('works with the bucket unbound, and the mirror still answers vault_unprovisioned', async () => {
    const t = harness({ vault: 'unbound' });
    expect((await t.put()).status).toBe(200);
    expect((await t.send('GET', handover())).status).toBe(200);
    const list = await t.send('POST', `/v1/vault/${ACCOUNT}/list`);
    expect(list.status).toBe(503);
    expect(await list.json()).toMatchObject({ error: 'vault_unprovisioned' });
  });

  it('redacts the account and the key hash from the request logger', () => {
    expect(redactVaultPath(`<-- PUT /v1/vault/${ACCOUNT}/handover/${KEY_HASH}`)).toBe('<-- PUT /v1/vault/:account/handover/:keyHash');
    expect(redactVaultPath(`--> GET /v1/vault/${ACCOUNT}/handover/${KEY_HASH} 404 2ms`)).toBe('--> GET /v1/vault/:account/handover/:keyHash 404 2ms');
    expect(redactVaultPath(`<-- GET /v1/vault/${ACCOUNT}/handover/${KEY_HASH}?x=1`)).toBe('<-- GET /v1/vault/:account/handover/:keyHash');
  });
});

// ── no key hash or account in any log line, through the whole plane ─────────

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

  beforeEach(() => {
    lines.length = 0;
  });

  afterAll(() => {
    for (const [m, d] of originals) if (d) Object.defineProperty(console, m, d);
  });

  it('writes no line carrying a key hash or an account, on a put, a take, a refusal or a relay failure', async () => {
    const ns = fakeNamespace();
    const env = { ENVIRONMENT: 'development', BASE_SEPOLIA_RPC_URL: 'http://127.0.0.1:9/never-read', VAULT_HANDOFF_DO: ns };
    const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} };
    const go = (method: string, path: string, init: RequestInit = {}, e: Record<string, unknown> = env) =>
      Promise.resolve(app.fetch(new Request(`https://plane.test${path}`, { method, ...init }), e, ctx));
    const putInit = { body: BLOB, headers: { 'content-length': String(BLOB.byteLength) } };

    expect((await go('GET', handover())).status).toBe(404);
    expect((await go('PUT', handover(), putInit)).status).toBe(200);
    expect((await go('PUT', handover(), putInit)).status).toBe(409);
    expect((await go('HEAD', handover())).status).toBe(405);
    expect((await go('GET', handover())).status).toBe(200);
    expect((await go('GET', handover())).status).toBe(410);
    const failing = {
      getByName: () => ({
        take: () => Promise.reject(Object.assign(new Error(`${KEY_HASH} ${PREFIX}`), { name: 'DurableObjectError' })),
      }),
    };
    expect((await go('GET', handover(), {}, { ...env, VAULT_HANDOFF_DO: failing })).status).toBe(503);

    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('\n').toLowerCase();
    expect(all).not.toContain(KEY_HASH.toLowerCase());
    expect(all).not.toContain(KEY_HASH.slice(0, 12).toLowerCase());
    expect(all).not.toContain(PREFIX);
    expect(all).not.toContain(PREFIX.slice(2, 18));
    expect(lines.some((l) => l.includes('"kind":"vault"') && l.includes('"op":"handover_take"') && l.includes('"error":"DurableObjectError"'))).toBe(true);
    expect(lines).toContain('<-- PUT /v1/vault/:account/handover/:keyHash');
  });
});
