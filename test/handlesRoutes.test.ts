// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The handle registry's public routes through the whole plane (`src/index.ts`):
 * available, lookup and the share links, on node:sqlite with the real
 * migrations, with the console recorded so no line names a handle, a token or
 * an IP (decision 0086, rule 4; runbook step 3's logging rule).
 */

import { getAddress } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import plane from '../src/index.js';
import { createHandshakeRoutes, shareTokenHash, SHARE_LINK_TTL_MS } from '../src/routes/handshake.js';
import { redactHandlePath } from '../src/routes/handles.js';
import { handleIdOf } from '../src/services/handles/grammar.js';
import { D1HandleStore, QUARANTINE_MS } from '../src/services/handles/store.js';
import { handlesD1, insertHandle } from './fixtures/handles/d1.js';
import type { SqliteD1 } from './fixtures/work/d1.js';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const IP = '198.51.100.23';
const OWNER = '0x' + 'cd'.repeat(20);
const META = '0x02' + '11'.repeat(32) + '03' + '22'.repeat(32);

function limiter(deny: (key: string) => boolean = () => false) {
  const keys: string[] = [];
  return { keys, limit: async ({ key }: { key: string }) => (keys.push(key), { success: !deny(key) }) };
}

let lines: string[];
beforeEach(() => {
  lines = [];
  const record = (...args: unknown[]) => void lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  vi.spyOn(console, 'log').mockImplementation(record);
  vi.spyOn(console, 'error').mockImplementation(record);
  vi.spyOn(console, 'warn').mockImplementation(record);
});
afterEach(() => vi.restoreAllMocks());

function world(over: Record<string, unknown> = {}) {
  const db = handlesD1();
  const ip = limiter();
  const global = limiter();
  const env = { ENVIRONMENT: 'staging', HANDLES_DB: db.d1, HANDLES_IP_RL: ip, HANDLES_GLOBAL_RL: global, ...over };
  const get = (path: string, headers: Record<string, string> = {}) => plane.request(path, { headers: { 'cf-connecting-ip': IP, ...headers } }, env as never);
  return { db, env, ip, global, get };
}

/** Every recorded line, for the leak checks. */
const logged = () => lines.join('\n').toLowerCase();

describe('GET /v1/handles/:label/available', () => {
  it('answers free, taken and reserved labels in the stored form, and refuses a malformed one', async () => {
    const w = world();
    insertHandle(w.db, { label: 'ana', handle_id: handleIdOf('ana'), owner: OWNER, meta_address: META });
    const free = await w.get('/v1/handles/@Bob-Smith/available');
    expect(free.status).toBe(200);
    expect(free.headers.get('cache-control')).toBe('no-store');
    expect(await free.json()).toEqual({ ok: true, label: 'bob-smith', available: true });
    expect(await (await w.get('/v1/handles/ana/available')).json()).toEqual({ ok: true, label: 'ana', available: false, reason: 'taken' });
    expect(await (await w.get('/v1/handles/support/available')).json()).toEqual({ ok: true, label: 'support', available: false, reason: 'reserved' });
    for (const bad of ['an', '-ana', 'ana_b', 'xn--ab', '%EF%BD%81na']) {
      const res = await w.get(`/v1/handles/${bad}/available`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('bad_label');
    }
  });

  it('answers a held label as taken until its hold lapses (q20), and a released one until its quarantine ends', async () => {
    const now = Date.now();
    const w = world();
    const held = { state: 'held', serial: null, owner: null, meta_address: null, onchain: 0 };
    insertHandle(w.db, { label: 'held-now', handle_id: handleIdOf('held-now'), identity: 'i1', ...held, held_until: now + 60_000 });
    insertHandle(w.db, { label: 'held-gone', handle_id: handleIdOf('held-gone'), identity: 'i2', ...held, held_until: now - 1 });
    insertHandle(w.db, { label: 'was-ana', handle_id: handleIdOf('was-ana'), identity: 'i3', state: 'quarantined', released_at: now - 1000 });
    insertHandle(w.db, { label: 'long-ago', handle_id: handleIdOf('long-ago'), identity: 'i4', state: 'quarantined', released_at: now - QUARANTINE_MS - 1000 });
    const available = async (label: string) => ((await (await w.get(`/v1/handles/${label}/available`)).json()) as { available: boolean }).available;
    expect(await available('held-now')).toBe(false);
    expect(await available('held-gone')).toBe(true);
    expect(await available('was-ana')).toBe(false);
    expect(await available('long-ago')).toBe(true);
    // A Sepolia anchor deployed with a short quarantine (runbook step 2): the plane follows HANDLES_QUARANTINE_DAYS.
    const short = world({ HANDLES_QUARANTINE_DAYS: '0' });
    insertHandle(short.db, { label: 'was-ana', handle_id: handleIdOf('was-ana'), identity: 'i3', state: 'quarantined', released_at: now - 1000 });
    expect(((await (await short.get('/v1/handles/was-ana/available')).json()) as { available: boolean }).available).toBe(true);
  });
});

describe('GET /v1/handles/:label', () => {
  it('resolves an active handle to its handle id, serial and meta-address, the owner EIP-55', async () => {
    const w = world();
    insertHandle(w.db, { label: 'ana', handle_id: handleIdOf('ana'), owner: OWNER, meta_address: META, serial: 3 });
    const res = await w.get('/v1/handles/Ana');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, label: 'ana', handleId: handleIdOf('ana'), serial: 3, owner: getAddress(OWNER), metaAddress: META, schemeId: 1, onChain: true });
  });

  it('answers a queued claim with its pending owner marked unchecked (q22)', async () => {
    const w = world();
    insertHandle(w.db, { label: 'new-one', handle_id: handleIdOf('new-one'), owner: OWNER, meta_address: META, onchain: 0 });
    expect(await (await w.get('/v1/handles/new-one')).json()).toMatchObject({ ok: true, owner: getAddress(OWNER), onChain: false });
  });

  it('answers held, releasing (q13), quarantined, reserved and unknown labels alike, 404', async () => {
    const w = world();
    insertHandle(w.db, { label: 'held', handle_id: handleIdOf('held'), identity: 'i1', state: 'held', serial: null, owner: null, meta_address: null, onchain: 0, held_until: Date.now() + 60_000 });
    insertHandle(w.db, { label: 'old-ana', handle_id: handleIdOf('old-ana'), identity: 'i2', state: 'releasing' });
    insertHandle(w.db, { label: 'gone', handle_id: handleIdOf('gone'), identity: 'i3', state: 'quarantined', released_at: 1 });
    insertHandle(w.db, { label: 'kept', handle_id: handleIdOf('kept'), identity: 'i4', state: 'reserved', serial: null, owner: null, meta_address: null });
    const unknown = await (await w.get('/v1/handles/nobody')).text();
    for (const label of ['held', 'old-ana', 'gone', 'kept', 'support']) {
      const res = await w.get(`/v1/handles/${label}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(unknown);
    }
  });

  it('answers 503 while HANDLES_DB is unbound, and 429 past the brake or the per-IP ceiling, on its own keys', async () => {
    const unbound = world({ HANDLES_DB: undefined });
    expect(await (await unbound.get('/v1/handles/ana')).json()).toEqual({ ok: false, error: 'handles_db_unprovisioned' });
    const w = world();
    await w.get('/v1/handles/ana');
    expect(w.global.keys).toEqual(['handles:global']);
    expect(w.ip.keys).toEqual([`handles-ip:${IP}`]);
    const busy = world({ HANDLES_IP_RL: limiter(() => true) });
    expect((await busy.get('/v1/handles/ana/available')).status).toBe(429);
    const brake = world({ HANDLES_GLOBAL_RL: limiter(() => true) });
    expect((await brake.get('/v1/handles/ana')).status).toBe(429);
    // A limiter that throws is a brake that failed, not a gate: the request goes on.
    const broken = world({ HANDLES_IP_RL: { limit: async () => Promise.reject(new Error('down')) } });
    expect((await broken.get('/v1/handles/ana/available')).status).toBe(200);
  });

  it('logs no handle and no IP: the request line and its own lines', async () => {
    const w = world();
    insertHandle(w.db, { label: 'secret-name', handle_id: handleIdOf('secret-name'), owner: OWNER, meta_address: META });
    await w.get('/v1/handles/secret-name');
    await w.get('/v1/handles/secret-name/available');
    await w.get('/v1/handles/%73ecret-name/available');
    await w.get('/v1/handles/unknown-name');
    expect(lines.length).toBeGreaterThan(4);
    expect(logged()).not.toContain('secret-name');
    expect(logged()).not.toContain('unknown-name');
    expect(logged()).not.toContain(IP);
    expect(logged()).not.toContain(OWNER.slice(2));
    expect(logged()).toContain('/v1/handles/:label/available');
  });
});

describe('/v1/handshake/links', () => {
  const post = (w: ReturnType<typeof world>, body: Uint8Array, headers: Record<string, string> = {}) =>
    plane.request(
      '/v1/handshake/links',
      { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.byteLength), 'cf-connecting-ip': IP, ...headers }, body },
      w.env as never,
    );

  it('stores the ciphertext under a fresh 128-bit token, keeps only its hash, and gives it once', async () => {
    const w = world();
    const half = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
    const res = await post(w, half);
    expect(res.status).toBe(201);
    const { token, expiresAt } = (await res.json()) as { token: string; expiresAt: number };
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(expiresAt).toBeGreaterThan(Date.now() + SHARE_LINK_TTL_MS - 60_000);
    const stored = w.db.sqlite.prepare('SELECT token_hash FROM share_links').all() as { token_hash: string }[];
    expect(stored).toEqual([{ token_hash: await shareTokenHash(token) }]);
    // A HEAD never spends the one fetch.
    expect((await plane.request(`/v1/handshake/links/${token}`, { method: 'HEAD' }, w.env as never)).status).toBe(405);
    const first = await w.get(`/v1/handshake/links/${token}`);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('application/octet-stream');
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(half);
    const second = await w.get(`/v1/handshake/links/${token}`);
    expect(second.status).toBe(404);
    expect(await second.json()).toEqual({ ok: false, error: 'not_found' });
    // Two links never share a token.
    const a = ((await (await post(w, Uint8Array.of(1))).json()) as { token: string }).token;
    const b = ((await (await post(w, Uint8Array.of(1))).json()) as { token: string }).token;
    expect(a).not.toBe(b);
  });

  it('refuses a missing length, an empty or oversized body, a body short of its length, and a malformed token', async () => {
    const w = world();
    const noLength = await plane.request('/v1/handshake/links', { method: 'POST', body: new Uint8Array(4) }, w.env as never);
    expect(noLength.status).toBe(411);
    expect((await post(w, new Uint8Array(0))).status).toBe(400);
    expect((await post(w, new Uint8Array(2049))).status).toBe(413);
    expect((await post(w, new Uint8Array(2048))).status).toBe(201);
    expect((await post(w, new Uint8Array(10), { 'content-length': '20' })).status).toBe(400);
    expect((await post(w, new Uint8Array(10), { 'content-length': 'ten' })).status).toBe(411);
    for (const bad of ['short', 'A'.repeat(23), 'A'.repeat(21) + '!']) expect((await w.get(`/v1/handshake/links/${encodeURIComponent(bad)}`)).status).toBe(400);
  });

  it('answers nothing for an expired link', async () => {
    const db = handlesD1();
    let now = 1_000;
    const draws = [Uint8Array.from({ length: 16 }, () => 7)];
    const h = createHandshakeRoutes({ store: () => new D1HandleStore(db.d1), now: () => now, randomBytes: () => draws[0]! });
    const env = { HANDLES_DB: db.d1 };
    const put = await h.request('/links', { method: 'POST', headers: { 'content-length': '3' }, body: Uint8Array.of(1, 2, 3) }, env as never);
    const { token } = (await put.json()) as { token: string };
    expect(token).toBe('BwcHBwcHBwcHBwcHBwcHBw');
    now += SHARE_LINK_TTL_MS;
    expect((await h.request(`/links/${token}`, {}, env as never)).status).toBe(404);
  });

  it('refuses uploads past the ceiling of live links, which a fetch frees, and counts them with triggers', async () => {
    const db = handlesD1();
    const h = createHandshakeRoutes({ store: () => new D1HandleStore(db.d1, 2), now: () => 1 });
    const env = { HANDLES_DB: db.d1 };
    const send = () => h.request('/links', { method: 'POST', headers: { 'content-length': '1' }, body: Uint8Array.of(1) }, env as never);
    const first = (await (await send()).json()) as { token: string };
    expect((await send()).status).toBe(201);
    const full = await send();
    expect(full.status).toBe(503);
    expect(await full.json()).toEqual({ ok: false, error: 'share_links_full', retryAfterSeconds: 3600 });
    expect((await h.request(`/links/${first.token}`, {}, env as never)).status).toBe(200);
    expect((await send()).status).toBe(201);
    expect(db.sqlite.prepare("SELECT n FROM handles_counters WHERE name = 'share_links'").get()).toEqual({ n: 2 });
  });

  it('puts an upload through its own, lower limits first, so uploads never spend the fetches’ brake', async () => {
    const putIp = limiter();
    const putGlobal = limiter(() => true);
    const w = world({ HANDSHAKE_PUT_IP_RL: putIp, HANDSHAKE_PUT_GLOBAL_RL: putGlobal });
    expect((await post(w, Uint8Array.of(1))).status).toBe(429);
    expect(putIp.keys).toEqual([`handshake-put-ip:${IP}`]);
    expect(putGlobal.keys).toEqual(['handshake-put:global']);
    expect(w.global.keys).toEqual([]);
    expect(w.ip.keys).toEqual([]);
    expect((await w.get('/v1/handshake/links/AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404);
    // A stored upload spends the upload limits alone, never the fetches' keys.
    const open = world({ HANDSHAKE_PUT_IP_RL: limiter(), HANDSHAKE_PUT_GLOBAL_RL: limiter() });
    expect((await post(open, Uint8Array.of(1))).status).toBe(201);
    expect(open.global.keys).toEqual([]);
    expect(open.ip.keys).toEqual([]);
  });

  it('draws again when a token is taken, and answers 503 rather than reuse one', async () => {
    const db = handlesD1();
    const same = Uint8Array.from({ length: 16 }, () => 9);
    const h = createHandshakeRoutes({ store: () => new D1HandleStore(db.d1), now: () => 1, randomBytes: () => same });
    const env = { HANDLES_DB: db.d1 };
    const send = () => h.request('/links', { method: 'POST', headers: { 'content-length': '1' }, body: Uint8Array.of(1) }, env as never);
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(503);
  });

  it('keeps no IP and logs no token, on its own limiter keys', async () => {
    const w = world();
    const { token } = (await (await post(w, Uint8Array.of(5, 6))).json()) as { token: string };
    await w.get(`/v1/handshake/links/${token}`);
    // The fetch counts on the reads' keys; the upload's own bindings are unbound in this world.
    expect(w.ip.keys).toEqual([`handshake-ip:${IP}`]);
    expect(w.global.keys).toEqual(['handshake:global']);
    expect(logged()).not.toContain(token.toLowerCase());
    expect(logged()).not.toContain(IP);
    expect(logged()).toContain('/v1/handshake/links/:token');
    const tables = JSON.stringify((w.db as SqliteD1).sqlite.prepare('SELECT * FROM share_links').all());
    expect(tables).not.toContain(IP);
  });
});

describe('redactHandlePath', () => {
  it('cuts the label, any query and a token out of a request line, and keeps known route words', () => {
    expect(redactHandlePath('<-- GET /v1/handles/ana')).toBe('<-- GET /v1/handles/:label');
    expect(redactHandlePath('--> GET /v1/handles/ana/available 200 3ms')).toBe('--> GET /v1/handles/:label/available 200 3ms');
    expect(redactHandlePath('<-- GET /v1/handles/ana/inbox?x=ana')).toBe('<-- GET /v1/handles/:label/inbox');
    expect(redactHandlePath('<-- GET /v1/handles/search?q=ana')).toBe('<-- GET /v1/handles/:label');
    expect(redactHandlePath('<-- GET /v1/handles/ana/x/ana')).toBe('<-- GET /v1/handles/:label/…');
    expect(redactHandlePath('<-- GET /v1/handles/%61na/available')).toBe('<-- GET /v1/handles/:label/available');
    // Nothing of an encoded space, newline or slash in a label survives, nor a doubled slash before it.
    expect(redactHandlePath('<-- GET /v1/handles/ana%20smith/available')).toBe('<-- GET /v1/handles/:label/available');
    expect(redactHandlePath('<-- GET /v1/handles/ana%0Asmith/available')).toBe('<-- GET /v1/handles/:label/available');
    expect(redactHandlePath('<-- GET /v1/handles/ana%2Fsmith')).toBe('<-- GET /v1/handles/:label/…');
    expect(redactHandlePath('<-- GET /v1/handles//ana')).toBe('<-- GET /v1/handles/:label');
    expect(redactHandlePath('<-- GET /v1//handles/ana')).toBe('<-- GET /v1/handles/:label');
    expect(redactHandlePath('<-- GET /v1/handles/%E0%A4%A')).toBe('<-- GET /v1/handles/:label');
    expect(redactHandlePath('<-- GET //v1/handshake//links/AAAAAAAAAAAAAAAAAAAAAA')).toBe('<-- GET /v1/handshake/links/:token');
    expect(redactHandlePath('<-- GET /v1/handshake/links/AAAAAAAAAAAAAAAAAAAAAA')).toBe('<-- GET /v1/handshake/links/:token');
    expect(redactHandlePath('<-- POST /v1/handshake/links')).toBe('<-- POST /v1/handshake/links');
    expect(redactHandlePath('<-- GET /v1/chat/usage')).toBe('<-- GET /v1/chat/usage');
  });
});
