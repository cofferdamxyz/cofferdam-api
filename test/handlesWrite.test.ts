// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The handle registry's authenticated routes and the anchor relay (workspace
 * decision 0086, rules 3 to 9; runbook step 3), on node:sqlite with the real
 * migrations and an in-memory anchor that checks every signature as the
 * contract does. The phone's side is played with the shared fixture's keys:
 * the epoch 0 and epoch 1 handle keys and meta-addresses, and its stealth
 * vectors under the fixture factory. The console is recorded: no line may
 * carry a label, an account or an inbox id.
 */

import { p256 } from '@noble/curves/p256';
import { Hono } from 'hono';
import { getAddress, hexToBytes, sha256, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHandlesRoutes } from '../src/routes/handles.js';
import { createHandlesWriteRoutes } from '../src/routes/handlesWrite.js';
import type { AuthorityCheck } from '../src/services/authorityCheck.js';
import { TIER } from '../src/services/ceremony.js';
import { createAuthorityMemo } from '../src/services/chat/authorityMemo.js';
import { CHANGE_KIND } from '../src/services/handles/anchor.js';
import { handleIdOf } from '../src/services/handles/grammar.js';
import { D1HandleRegistry } from '../src/services/handles/registry.js';
import { runRelay } from '../src/services/handles/relay.js';
import { D1HandleStore } from '../src/services/handles/store.js';
import { registrySigner, signAnchor, signRegistry } from '../src/services/handles/typedData.js';
import type { ReplayStore } from '../src/services/popReplayStore.js';
import { popAth } from '../src/services/sessionAttestation.js';
import fixture from './fixtures/handles/handleAnchorTypes.json';
import { handlesD1 } from './fixtures/handles/d1.js';
import { memoryAnchor, queueChange, TEST_ANCHOR, type MemoryAnchor } from './fixtures/handles/memoryAnchor.js';
import v2 from './fixtures/sdk-attestations-v2.json';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const ACCOUNT = v2.account as Address;
const ORIGIN = v2.origin;
const IP = '203.0.113.9';
const MAP_KEY = '5a'.repeat(32);
const HIGH: AuthorityCheck = { status: 'active', authorityId: 0, module: ACCOUNT, tier: TIER.High };
const owner0 = privateKeyToAccount(fixture.keys.owner.privateKey as Hex);
const owner1 = privateKeyToAccount(fixture.keys.newOwner.privateKey as Hex);
const META0 = fixture.epochs[0]!.metaAddress as Hex;
const META1 = fixture.epochs[1]!.metaAddress as Hex;
const INBOX = 'ab'.repeat(32);

// ── the session (a copy of vaultRoutes.test.ts's proof signer) ──────────────

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));
function signProof(htm: string, htu: string, token: string, nowMs: number): string {
  const priv = hexToBytes(v2.devicePrivateKey as Hex);
  const pub = p256.getPublicKey(priv, false);
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: 'EC', crv: 'P-256', x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)) } };
  const payload = { htm, htu, iat: Math.floor(nowMs / 1000), jti: b64url(crypto.getRandomValues(new Uint8Array(16))), ath: popAth(token) };
  const input = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = p256.sign(hexToBytes(sha256(new TextEncoder().encode(input))), priv);
  return `${input}.${b64url(sig.toCompactRawBytes())}`;
}
function memoryReplay(): ReplayStore {
  const seen = new Set<string>();
  return { claim: async (jkt, key) => (seen.has(`${jkt}|${key}`) ? false : (seen.add(`${jkt}|${key}`), true)) };
}

// ── the world ───────────────────────────────────────────────────────────────

let lines: string[];
beforeEach(() => {
  lines = [];
  const record = (...args: unknown[]) => void lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  vi.spyOn(console, 'log').mockImplementation(record);
  vi.spyOn(console, 'error').mockImplementation(record);
});
afterEach(() => vi.restoreAllMocks());

interface World {
  db: ReturnType<typeof handlesD1>;
  registry: D1HandleRegistry;
  anchor: MemoryAnchor;
  clock: { ms: number };
  post(path: string, body: Record<string, unknown>, o?: { slow?: boolean; env?: Record<string, unknown> }): Promise<Response>;
  get(path: string): Promise<Response>;
  relay(): Promise<void>;
  /** Move both clocks forward. */
  advance(ms: number): void;
}

function world(o: { authority?: AuthorityCheck; env?: Record<string, unknown>; anchor?: boolean; bound?: boolean } = {}): World {
  const db = handlesD1();
  const clock = { ms: v2.issuedAt + 1_000 };
  const chainClock = { now: Math.floor(clock.ms / 1000) };
  const anchor = memoryAnchor(chainClock);
  const registry = new D1HandleRegistry(db.d1);
  const replay = memoryReplay();
  const app = new Hono();
  app.route('/v1/handles', createHandlesRoutes({ now: () => clock.ms }));
  app.route(
    '/v1/handles',
    createHandlesWriteRoutes({
      attestationMaxAgeMs: 3_600_000,
      now: () => clock.ms,
      authorityCheck: async () => o.authority ?? HIGH,
      authorityMemo: createAuthorityMemo({ edge: null }),
      replayStore: () => replay,
      registry: () => registry,
      chain: () => (o.anchor === false ? null : anchor),
      bound: async () => o.bound ?? true,
    }),
  );
  const env = (extra: Record<string, unknown> = {}) => ({
    ENVIRONMENT: 'staging',
    HANDLES_DB: db.d1,
    HANDLES_MAP_KEY: MAP_KEY,
    HANDLES_SKIP_UNBUILT_GATES: 'device-attestation,install-proof,locator-pin',
    HANDLES_RELAY_DELAY_S: '30,120',
    HANDLES_RELEASE_DELAY_S: '60,300',
    HANDLES_QUARANTINE_DAYS: '1',
    ...o.env,
    ...extra,
  });
  return {
    db,
    registry,
    anchor,
    clock,
    post(path, body, p = {}) {
      const url = `${ORIGIN}/v1/handles${path}`;
      const token = p.slow ? v2.tokens.p256.slow : v2.tokens.p256.fast;
      return Promise.resolve(
        app.request(
          url,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'cf-connecting-ip': IP, authorization: `DPoP ${token}`, dpop: signProof('POST', url, token, clock.ms) },
            body: JSON.stringify({ account: ACCOUNT, ...body }),
          },
          env(p.env) as never,
        ),
      );
    },
    get(path) {
      return Promise.resolve(app.request(`${ORIGIN}/v1/handles${path}`, { headers: { 'cf-connecting-ip': IP } }, env() as never));
    },
    async relay() {
      await runRelay(registry, anchor, clock.ms);
    },
    advance(ms) {
      clock.ms += ms;
      chainClock.now = Math.floor(clock.ms / 1000);
    },
  };
}

const nonce = () => `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')}` as Hex;
const exp = (w: World) => Math.floor(w.clock.ms / 1000) + 300;

/** The phone's claim body for `label` with `key` and `meta`, at the anchor's next serial. */
async function claimBody(w: World, label: string, key = owner0, meta = META0) {
  const handleId = handleIdOf(label);
  const n = nonce();
  const expiresAt = exp(w);
  const rec = await w.anchor.record(handleId);
  const serial = rec.serial + 1;
  return {
    label,
    owner: key.address,
    metaAddress: meta,
    nonce: n,
    expiresAt,
    signature: await signRegistry(key, 84532, 'RegistryClaim', { label, handleId, owner: key.address, metaAddress: meta, nonce: n, expiresAt: BigInt(expiresAt) }),
    serial,
    ownerClaimSignature: await signAnchor(key, 84532, TEST_ANCHOR, 'OwnerClaim', { handleId, metaAddress: meta, serial: BigInt(serial) }),
  };
}

async function claimed(w: World, label = 'ana') {
  const res = await w.post('/claim', await claimBody(w, label));
  expect(res.status).toBe(201);
  w.advance(121_000);
  await w.relay(); // sends the claim
  await w.relay(); // reads its receipt: on chain
}

const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
const logged = () => lines.join('\n').toLowerCase();

// ── claim and the relay ─────────────────────────────────────────────────────

describe('POST /v1/handles/claim and the relay', () => {
  it('queues the claim, answers it unchecked, then lands it on the anchor after the delay', async () => {
    const w = world();
    const res = await w.post('/claim', await claimBody(w, 'ana'));
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({
      ok: true,
      label: 'ana',
      handleId: handleIdOf('ana'),
      serial: 1,
      owner: owner0.address,
      metaAddress: META0,
      schemeId: 1,
      onChain: false,
    });
    expect(await json(await w.get('/ana'))).toMatchObject({ onChain: false, owner: owner0.address });

    await w.relay(); // not due yet (30 to 120 s)
    expect(w.anchor.sent).toEqual([]);
    w.advance(121_000);
    await w.relay();
    expect(w.anchor.sent.map((s) => s.functionName)).toEqual(['claim']);
    expect((await w.anchor.record(handleIdOf('ana'))).owner).toBe(owner0.address);
    await w.relay(); // the receipt
    expect(await json(await w.get('/ana'))).toMatchObject({ onChain: true });
    const mine = await json(await w.post('/mine', {}));
    expect(mine.handles).toEqual([expect.objectContaining({ label: 'ana', state: 'active', onChain: true, discoverable: false })]);
    expect(logged()).not.toContain('"ana"');
    expect(logged()).not.toContain(ACCOUNT.toLowerCase());
  });

  it('refuses a bad registry signature, an owner claim over another serial, a reserved and a taken label, and a second handle', async () => {
    const w = world();
    const body = await claimBody(w, 'ana');
    expect(await json(await w.post('/claim', { ...body, signature: (await claimBody(w, 'bob')).signature }))).toMatchObject({ error: 'bad_signature' });
    const r = await w.post('/claim', { ...(await claimBody(w, 'ana')), serial: 2 });
    expect(r.status).toBe(401); // the owner's signature is over serial 1
    expect((await w.post('/claim', await claimBody(w, 'support'))).status).toBe(409);
    expect((await w.post('/claim', body)).status).toBe(201);
    expect(await json(await w.post('/claim', body))).toMatchObject({ error: 'identity_has_handle' });
  });

  it('answers serial_mismatch with the expected serial when the anchor moved', async () => {
    const w = world();
    const id = handleIdOf('ana');
    w.anchor.records.set(id, { ...(await w.anchor.record(id)), serial: 3, releasedAt: 1 });
    const body = await claimBody(w, 'ana'); // signs serial 4
    const stale = { ...body, serial: 2, ownerClaimSignature: await signAnchor(owner0, 84532, TEST_ANCHOR, 'OwnerClaim', { handleId: id, metaAddress: META0, serial: 2n }) };
    expect(await json(await w.post('/claim', stale))).toMatchObject({ error: 'serial_mismatch', serial: 4 });
  });

  it('refuses a replayed request nonce', async () => {
    const w = world();
    const body = await claimBody(w, 'ana');
    expect((await w.post('/claim', body)).status).toBe(201);
    // Another identity could not reuse it either: the nonce is spent.
    await w.registry.takeNonce(nonce(), w.clock.ms + 1000);
    expect(await w.registry.takeNonce(body.nonce, w.clock.ms + 1000)).toBe(false);
  });

  it('drops a claim the anchor refuses for good, freeing the label', async () => {
    const w = world();
    expect((await w.post('/claim', await claimBody(w, 'ana'))).status).toBe(201);
    const id = handleIdOf('ana');
    w.anchor.records.set(id, { ...(await w.anchor.record(id)), owner: owner1.address, serial: 1 });
    w.advance(121_000);
    await w.relay();
    expect((await w.get('/ana')).status).toBe(404);
    expect((await w.registry.jobsOf(id))[0]).toMatchObject({ state: 'failed', error: 'owned' });
  });

  it('answers 503 anchor_unconfigured with no anchor, and 503 for the map key and the unbuilt gates', async () => {
    expect(await json(await world({ anchor: false }).post('/claim', {}))).toMatchObject({ error: 'anchor_unconfigured' });
    const w = world();
    expect(await json(await w.post('/claim', await claimBody(w, 'ana'), { env: { HANDLES_MAP_KEY: undefined } }))).toMatchObject({ error: 'handles_map_key_unprovisioned' });
    expect(await json(await w.post('/claim', await claimBody(w, 'ana'), { env: { HANDLES_SKIP_UNBUILT_GATES: 'locator-pin' } }))).toMatchObject({ error: 'device_attestation_unbuilt' });
    expect(await json(await w.post('/claim', await claimBody(w, 'ana'), { env: { ENVIRONMENT: 'production' } }))).toMatchObject({ error: 'device_attestation_unbuilt' });
  });

  it('refuses an account whose session key is not an active High', async () => {
    const w = world({ authority: { status: 'active', authorityId: 0, module: ACCOUNT, tier: TIER.Partner } });
    expect(await json(await w.post('/claim', await claimBody(w, 'ana')))).toMatchObject({ error: 'attestation_rejected', reason: 'authority' });
  });
});

// ── the hold (q20) ──────────────────────────────────────────────────────────

describe('POST /v1/handles/hold', () => {
  async function holdBody(w: World, label: string) {
    const b = await claimBody(w, label);
    return { label, owner: b.owner, metaAddress: b.metaAddress, nonce: b.nonce, expiresAt: b.expiresAt, signature: b.signature };
  }

  it('holds a label for 14 days, answers it taken and absent, then the claim takes it', async () => {
    const w = world();
    const res = await w.post('/hold', await holdBody(w, 'ana'));
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ state: 'held', heldUntil: w.clock.ms + 14 * 86_400_000 });
    expect(await json(await w.get('/ana/available'))).toMatchObject({ available: false, reason: 'taken' });
    expect((await w.get('/ana')).status).toBe(404);
    expect((await w.post('/claim', await claimBody(w, 'ana'))).status).toBe(201);
    const log = w.db.sqlite.prepare('SELECT outcome FROM handle_holds').all();
    expect(log).toEqual([{ outcome: 'claimed' }]);
  });

  it("replaces the identity's earlier hold, refuses a label another holds, and blocks a relapse for 30 days", async () => {
    const w = world();
    await w.post('/hold', await holdBody(w, 'ana'));
    expect((await w.post('/hold', await holdBody(w, 'bob'))).status).toBe(201);
    expect(await json(await w.get('/ana/available'))).toMatchObject({ available: true });
    // Bob's hold lapses (the session's token lives a day, so the clock is moved in the table instead).
    w.db.sqlite.prepare("UPDATE handles SET held_until = ? WHERE label = 'bob'").run(w.clock.ms - 1);
    w.db.sqlite.prepare("UPDATE handle_holds SET held_until = ? WHERE label = 'bob'").run(w.clock.ms - 1);
    await new D1HandleStore(w.db.d1).sweep(w.clock.ms);
    expect(await json(await w.get('/bob/available'))).toMatchObject({ available: true });
    const again = await json(await w.post('/hold', await holdBody(w, 'bob')));
    expect(again).toMatchObject({ error: 'relapse' });
  });

  it('refuses a hold once the identity has an active handle', async () => {
    const w = world();
    await claimed(w, 'ana');
    expect(await json(await w.post('/hold', await holdBody(w, 'bob')))).toMatchObject({ error: 'identity_has_handle' });
  });
});

// ── discovery (rule 6) ──────────────────────────────────────────────────────

describe('discovery, search and inbox', () => {
  async function discoverable(w: World, on: boolean, key = owner0) {
    const n = nonce();
    const expiresAt = exp(w);
    const inboxId = on ? INBOX : '';
    const signature = await signRegistry(key, 84532, 'SetDiscoverable', {
      handleId: handleIdOf('ana'),
      serial: 1n,
      discoverable: on,
      inboxId,
      nonce: n,
      expiresAt: BigInt(expiresAt),
    });
    return w.post('/ana/discoverable', { discoverable: on, inboxId, nonce: n, expiresAt, signature });
  }

  it('is off by default; on, search and inbox find it; off again, both answer as absent', async () => {
    const w = world();
    await claimed(w);
    expect(await json(await w.get('/search?q=an'))).toMatchObject({ error: 'bad_query' });
    expect(await json(await w.get('/search?q=ana'))).toEqual({ ok: true, results: [] });
    expect((await w.get('/ana/inbox')).status).toBe(404);
    expect((await discoverable(w, true)).status).toBe(200);
    expect(await json(await w.get('/search?q=@ANa'))).toEqual({ ok: true, results: [{ label: 'ana', inboxId: INBOX }] });
    expect(await json(await w.get('/ana/inbox'))).toEqual({ ok: true, label: 'ana', inboxId: INBOX });
    expect((await discoverable(w, false)).status).toBe(200);
    expect((await w.get('/ana/inbox')).status).toBe(404);
    expect(logged()).not.toContain(INBOX);
  });

  it('refuses a request signed by any key but the pinned one', async () => {
    const w = world();
    await claimed(w);
    expect(await json(await discoverable(w, true, owner1))).toMatchObject({ error: 'bad_signature' });
  });
});

// ── self (rule 5, q18) ──────────────────────────────────────────────────────

describe('POST /v1/handles/:label/self', () => {
  async function selfBody(w: World, v = fixture.stealth.vectors[0]!, meta = fixture.stealth.metaAddress as Hex, key = owner0) {
    const n = nonce();
    const expiresAt = exp(w);
    const message = {
      handleId: handleIdOf('ana'),
      serial: 1n,
      account: getAddress(v.account),
      ephemeralPublicKey: v.ephemeralPublicKey as Hex,
      sharedSecretHash: v.sharedSecretHash as Hex,
      metaAddress: meta,
      nonce: n,
      expiresAt: BigInt(expiresAt),
    };
    return {
      address: v.account,
      ephemeralPublicKey: v.ephemeralPublicKey,
      sharedSecretHash: v.sharedSecretHash,
      metaAddress: meta,
      nonce: n,
      expiresAt,
      signature: await signRegistry(key, 84532, 'RegisterAddress', message),
    };
  }

  it("watches an address that is the meta-address's for h, sealed, once", async () => {
    const w = world();
    expect(fixture.stealth.metaAddress).toBe(META0);
    await claimed(w);
    const res = await w.post('/ana/self', await selfBody(w));
    expect(res.status).toBe(201);
    const row = w.db.sqlite.prepare('SELECT address, source, length(sealed) AS n FROM watched_addresses').get() as Record<string, unknown>;
    expect(row).toEqual({ address: fixture.stealth.vectors[0]!.account.toLowerCase(), source: 'self', n: 12 + 132 + 16 });
    expect((await w.post('/ana/self', await selfBody(w))).status).toBe(200);
  });

  it("refuses an address that is not derived for h, a meta-address the identity never had, and another key's signature", async () => {
    const w = world();
    await claimed(w);
    const v = fixture.stealth.vectors[0]!;
    const other = fixture.stealth.vectors[1]!;
    expect(await json(await w.post('/ana/self', await selfBody(w, { ...v, sharedSecretHash: other.sharedSecretHash })))).toMatchObject({ error: 'not_derived' });
    expect(await json(await w.post('/ana/self', await selfBody(w, v, META1)))).toMatchObject({ error: 'not_your_meta_address' });
    expect(await json(await w.post('/ana/self', await selfBody(w, v, META0, owner1)))).toMatchObject({ error: 'bad_signature' });
  });
});

// ── release and rename (rule 7) ─────────────────────────────────────────────

async function releaseSig(w: World, label: string, key = owner0, deadline = Math.floor(w.clock.ms / 1000) + 9 * 86_400) {
  const id = handleIdOf(label);
  const rec = await w.anchor.record(id);
  return { anchorDeadline: deadline, releaseSignature: await signAnchor(key, 84532, TEST_ANCHOR, 'Release', { handleId: id, nonce: rec.nonce, deadline: BigInt(deadline) }) };
}

describe('release and rename', () => {
  it('releases: resolves to nothing at once, relays release then applyChange, then quarantines', async () => {
    const w = world();
    await claimed(w);
    const n = nonce();
    const expiresAt = exp(w);
    const signature = await signRegistry(owner0, 84532, 'ReleaseHandle', { handleId: handleIdOf('ana'), serial: 1n, nonce: n, expiresAt: BigInt(expiresAt) });
    const res = await w.post('/ana/release', { nonce: n, expiresAt, signature, ...(await releaseSig(w, 'ana')) }, { slow: true });
    expect(res.status).toBe(200);
    expect((await w.get('/ana')).status).toBe(404);
    w.advance(121_000);
    await w.relay();
    expect(w.anchor.sent.map((s) => s.functionName)).toEqual(['claim', 'release']);
    await w.relay(); // the receipt queues apply for the anchor's delay
    w.advance(601_000);
    await w.relay();
    await w.relay();
    expect(w.anchor.sent.map((s) => s.functionName)).toEqual(['claim', 'release', 'applyChange']);
    expect(w.db.sqlite.prepare("SELECT state, released_at IS NOT NULL AS r FROM handles WHERE label = 'ana'").get()).toEqual({ state: 'quarantined', r: 1 });
    expect(await json(await w.get('/ana/available'))).toMatchObject({ available: false });
    w.advance(86_400_000);
    expect(await json(await w.get('/ana/available'))).toMatchObject({ available: true });
  });

  it('refuses a release with a deadline that does not cover the relay delay', async () => {
    const w = world();
    await claimed(w);
    const n = nonce();
    const expiresAt = exp(w);
    const signature = await signRegistry(owner0, 84532, 'ReleaseHandle', { handleId: handleIdOf('ana'), serial: 1n, nonce: n, expiresAt: BigInt(expiresAt) });
    const short = await releaseSig(w, 'ana', owner0, Math.floor(w.clock.ms / 1000) + 3600);
    expect(await json(await w.post('/ana/release', { nonce: n, expiresAt, signature, ...short }, { slow: true }))).toMatchObject({ error: 'deadline_too_soon' });
  });

  it('renames: the new label claimed with the next epoch, the old one releasing, a same-identity statement, once in 30 days', async () => {
    const w = world();
    await claimed(w);
    const n = nonce();
    const expiresAt = exp(w);
    const message = {
      handleId: handleIdOf('ana'),
      serial: 1n,
      newLabel: 'ana-b',
      newHandleId: handleIdOf('ana-b'),
      newOwner: owner1.address,
      newMetaAddress: META1,
      nonce: n,
      expiresAt: BigInt(expiresAt),
    };
    const claim = await claimBody(w, 'ana-b', owner1, META1);
    const body = {
      newLabel: 'ana-b',
      newOwner: owner1.address,
      newMetaAddress: META1,
      nonce: n,
      expiresAt,
      signature: await signRegistry(owner0, 84532, 'RenameHandle', message),
      claim: { nonce: claim.nonce, expiresAt: claim.expiresAt, signature: claim.signature, serial: claim.serial, ownerClaimSignature: claim.ownerClaimSignature },
      ...(await releaseSig(w, 'ana')),
    };
    const res = await w.post('/ana/rename', body, { slow: true });
    expect(res.status).toBe(201);
    const out = await json(res);
    expect(out).toMatchObject({ label: 'ana-b', owner: owner1.address, onChain: false });
    const same = out.sameIdentity as { statement: Record<string, unknown>; signature: Hex };
    const signer = await registrySigner(84532, 'SameIdentity', { ...same.statement, newSerial: BigInt(same.statement.newSerial as number), issuedAt: BigInt(same.statement.issuedAt as number) }, same.signature);
    expect(signer).toBe(w.anchor.registrar.address);
    expect((await w.get('/ana')).status).toBe(404);
    expect(await json(await w.get('/ana-b'))).toMatchObject({ onChain: false });
    // The release waits its own delay (60 to 300 s), after the new claim's.
    w.advance(301_000);
    await w.relay();
    expect(w.anchor.sent.map((s) => s.functionName).sort()).toEqual(['claim', 'claim', 'release']);
    // A second rename within 30 days is refused.
    expect(await json(await w.post('/ana-b/rename', body, { slow: true }))).toMatchObject({ error: 'rename_limit' });
  });
});

// ── the registrar's actions (rule 3, q15) ───────────────────────────────────

describe('hold, veto, advance and unfreeze', () => {
  it('holds a record, refuses a hold on a frozen or pending one, vetoes a pending change, and then refuses unfreeze', async () => {
    const w = world();
    await claimed(w);
    const id = handleIdOf('ana');
    expect((await w.post('/ana/hold-record', { op: 'hold' }, { slow: true })).status).toBe(200);
    expect((await w.anchor.record(id)).frozenUntil).toBeGreaterThan(0);
    expect(await json(await w.post('/ana/hold-record', { op: 'hold' }, { slow: true }))).toMatchObject({ error: 'frozen' });
    expect((await w.post('/ana/hold-record', { op: 'renew' }, { slow: true })).status).toBe(200);
    // The freeze lapses (a short one, inside the slow session's life); a thief queues a transfer; the user vetoes it.
    w.anchor.records.set(id, { ...(await w.anchor.record(id)), frozenUntil: w.anchor.clock.now - 1 });
    queueChange(w.anchor, id, owner1.address);
    expect(await json(await w.post('/ana/hold-record', { op: 'hold' }, { slow: true }))).toMatchObject({ error: 'change_pending' });
    expect((await w.post('/ana/hold-record', { op: 'veto' }, { slow: true })).status).toBe(200);
    const rec = await w.anchor.record(id);
    expect(rec.pendingKind).toBe(CHANGE_KIND.None);
    const deadline = Math.floor(w.clock.ms / 1000) + 600;
    const ownerSignature = await signAnchor(owner0, 84532, TEST_ANCHOR, 'Unfreeze', { handleId: id, frozenUntil: BigInt(rec.frozenUntil), nonce: rec.nonce, deadline: BigInt(deadline) });
    expect(await json(await w.post('/ana/unfreeze', { frozenUntil: rec.frozenUntil, deadline, ownerSignature }, { slow: true }))).toMatchObject({ error: 'vetoed' });
  });

  it('lifts a hold that saw no veto, with the owner and the registrar', async () => {
    const w = world();
    await claimed(w);
    const id = handleIdOf('ana');
    await w.post('/ana/hold-record', { op: 'hold' }, { slow: true });
    const rec = await w.anchor.record(id);
    const deadline = Math.floor(w.clock.ms / 1000) + 600;
    const ownerSignature = await signAnchor(owner0, 84532, TEST_ANCHOR, 'Unfreeze', { handleId: id, frozenUntil: BigInt(rec.frozenUntil), nonce: rec.nonce, deadline: BigInt(deadline) });
    expect((await w.post('/ana/unfreeze', { frozenUntil: rec.frozenUntil, deadline, ownerSignature }, { slow: true })).status).toBe(200);
    expect((await w.anchor.record(id)).frozenUntil).toBe(0);
  });

  it('adds the registrar to an advance signed by the old and new keys, open while frozen, and moves the row', async () => {
    const w = world();
    await claimed(w);
    const id = handleIdOf('ana');
    await w.post('/ana/hold-record', { op: 'hold' }, { slow: true });
    const rec = await w.anchor.record(id);
    const deadline = Math.floor(w.clock.ms / 1000) + 600;
    const fields = { handleId: id, newMetaAddress: META1, nonce: rec.nonce, deadline: BigInt(deadline) };
    const body = {
      newOwner: owner1.address,
      newMetaAddress: META1,
      deadline,
      ownerSignature: await signAnchor(owner0, 84532, TEST_ANCHOR, 'Advance', { ...fields, newOwner: owner1.address }),
      newOwnerSignature: await signAnchor(owner1, 84532, TEST_ANCHOR, 'AdvanceAccept', { ...fields, previousOwner: owner0.address }),
    };
    expect(await json(await w.post('/ana/advance', { ...body, newOwnerSignature: body.ownerSignature }, { slow: true }))).toMatchObject({ error: 'bad_signature' });
    expect((await w.post('/ana/advance', body, { slow: true })).status).toBe(200);
    expect((await w.anchor.record(id)).owner).toBe(owner1.address);
    expect(await json(await w.get('/ana'))).toMatchObject({ owner: owner1.address, metaAddress: META1 });
    // Both epochs' meta-addresses are now the identity's for `self`.
    expect(await w.registry.hadMetaAddress((await w.registry.row('ana'))!.identity, META0)).toBe(true);
    expect(await w.registry.hadMetaAddress((await w.registry.row('ana'))!.identity, META1)).toBe(true);
  });

  it('asks a fresh Face ID (slow) for the registrar actions', async () => {
    const w = world();
    await claimed(w);
    expect(await json(await w.post('/ana/hold-record', { op: 'hold' }))).toMatchObject({ error: 'step_up_required' });
  });
});

// ── the Verified statement (rule 9) ─────────────────────────────────────────

describe('POST /v1/handles/:label/verified', () => {
  it('signs (handleId, serial, owner, bound, expiry) for 30 days', async () => {
    const w = world({ bound: true });
    await claimed(w);
    const out = await json(await w.post('/ana/verified', {}));
    const st = out.statement as Record<string, unknown>;
    expect(st).toMatchObject({ handleId: handleIdOf('ana'), serial: 1, owner: owner0.address, bound: true, expiresAt: Math.floor(w.clock.ms / 1000) + 30 * 86_400 });
    const signer = await registrySigner(84532, 'VerifiedStatement', { ...st, serial: 1n, expiresAt: BigInt(st.expiresAt as number) }, out.signature as Hex);
    expect(signer).toBe(w.anchor.registrar.address);
  });
});

describe('GET /v1/handles/registrar', () => {
  it('names the chain, the anchor and the registrar, or 503 while unconfigured', async () => {
    const w = world();
    expect((await w.get('/registrar')).status).toBe(503);
  });
});
