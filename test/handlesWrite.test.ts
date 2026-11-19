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
import { createHandlesWriteRoutes, REGISTRAR_SENDS_PER_DAY } from '../src/routes/handlesWrite.js';
import { skipsGate } from '../src/services/handles/config.js';
import type { AuthorityCheck } from '../src/services/authorityCheck.js';
import { TIER } from '../src/services/ceremony.js';
import { createAuthorityMemo } from '../src/services/chat/authorityMemo.js';
import { AnchorRevert, CHANGE_KIND, contractRevert } from '../src/services/handles/anchor.js';
import { handleIdOf } from '../src/services/handles/grammar.js';
import { D1HandleRegistry, RegistryConflict } from '../src/services/handles/registry.js';
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
    // The release waits its own delay (60 to 300 s) and for the new label's claim to land.
    w.advance(301_000);
    await w.relay(); // the new claim is sent; the release waits for it
    expect(w.anchor.sent.map((s) => s.functionName)).toEqual(['claim', 'claim']);
    await w.relay(); // the new claim's receipt
    // A second rename within 30 days is refused (asked inside the slow session's life).
    expect(await json(await w.post('/ana-b/rename', body, { slow: true }))).toMatchObject({ error: 'rename_limit' });
    w.advance(601_000);
    await w.relay();
    expect(w.anchor.sent.map((s) => s.functionName)).toEqual(['claim', 'claim', 'release']);
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

// ── review round 1's findings ───────────────────────────────────────────────

describe('review round 1', () => {
  it('takes only a contract revert for the contract refusing; a node error is rethrown and leaves the job queued', async () => {
    expect(contractRevert(new Error('fetch failed'))).toBeNull();
    const w = world();
    expect((await w.post('/claim', await claimBody(w, 'ana'))).status).toBe(201);
    const send = w.anchor.send.bind(w.anchor);
    w.anchor.send = async () => {
      throw new Error('HTTP request failed: 503');
    };
    w.advance(121_000);
    for (let i = 0; i < 5; i++) await w.relay();
    const [job] = await w.registry.jobsOf(handleIdOf('ana'));
    expect(job).toMatchObject({ state: 'queued', attempts: 0 });
    expect(await json(await w.get('/ana'))).toMatchObject({ onChain: false });
    w.anchor.send = send;
    w.advance(61_000); // the node error pushed the job back a minute
    await w.relay();
    await w.relay();
    expect(await json(await w.get('/ana'))).toMatchObject({ onChain: true });
  });

  it('gives the old label back when a rename\'s claim fails for good', async () => {
    const w = world();
    await claimed(w);
    const n = nonce();
    const expiresAt = exp(w);
    const claim = await claimBody(w, 'ana-b', owner1, META1);
    const message = { handleId: handleIdOf('ana'), serial: 1n, newLabel: 'ana-b', newHandleId: handleIdOf('ana-b'), newOwner: owner1.address, newMetaAddress: META1, nonce: n, expiresAt: BigInt(expiresAt) };
    const res = await w.post(
      '/ana/rename',
      {
        newLabel: 'ana-b',
        newOwner: owner1.address,
        newMetaAddress: META1,
        nonce: n,
        expiresAt,
        signature: await signRegistry(owner0, 84532, 'RenameHandle', message),
        claim: { nonce: claim.nonce, expiresAt: claim.expiresAt, signature: claim.signature, serial: claim.serial, ownerClaimSignature: claim.ownerClaimSignature },
        ...(await releaseSig(w, 'ana')),
      },
      { slow: true },
    );
    expect(res.status).toBe(201);
    // Someone else's key owns the new label on chain before the relay sends.
    const id = handleIdOf('ana-b');
    w.anchor.records.set(id, { ...(await w.anchor.record(id)), owner: getAddress('0x' + '77'.repeat(20)), serial: 1 });
    w.advance(121_000);
    await w.relay();
    expect((await w.get('/ana-b')).status).toBe(404);
    expect(await json(await w.get('/ana'))).toMatchObject({ owner: owner0.address, onChain: true });
    // Cancelled while queued, or failed when its turn came after the claim's failure: never sent.
    const [release] = (await w.registry.jobsOf(handleIdOf('ana'))).filter((j) => j.kind === 'release');
    expect(['cancelled', 'failed']).toContain(release!.state);
    expect(w.anchor.sent.map((s) => s.functionName)).toEqual(['claim']);
  });

  it('refuses unfreeze after a veto even once the record advanced to another key', async () => {
    const w = world();
    await claimed(w);
    const id = handleIdOf('ana');
    queueChange(w.anchor, id, owner1.address);
    expect((await w.post('/ana/hold-record', { op: 'veto' }, { slow: true })).status).toBe(200);
    let rec = await w.anchor.record(id);
    const deadline = Math.floor(w.clock.ms / 1000) + 600;
    const fields = { handleId: id, newMetaAddress: META1, nonce: rec.nonce, deadline: BigInt(deadline) };
    expect(
      (
        await w.post(
          '/ana/advance',
          {
            newOwner: owner1.address,
            newMetaAddress: META1,
            deadline,
            ownerSignature: await signAnchor(owner0, 84532, TEST_ANCHOR, 'Advance', { ...fields, newOwner: owner1.address }),
            newOwnerSignature: await signAnchor(owner1, 84532, TEST_ANCHOR, 'AdvanceAccept', { ...fields, previousOwner: owner0.address }),
          },
          { slow: true },
        )
      ).status,
    ).toBe(200);
    rec = await w.anchor.record(id);
    const ownerSignature = await signAnchor(owner1, 84532, TEST_ANCHOR, 'Unfreeze', { handleId: id, frozenUntil: BigInt(rec.frozenUntil), nonce: rec.nonce, deadline: BigInt(deadline) });
    expect(await json(await w.post('/ana/unfreeze', { frozenUntil: rec.frozenUntil, deadline, ownerSignature }, { slow: true }))).toMatchObject({ error: 'vetoed' });
  });

  it('vetoes a change on a releasing label, and an advance to the release key queues its release again', async () => {
    const w = world();
    await claimed(w);
    const id = handleIdOf('ana');
    const n = nonce();
    const expiresAt = exp(w);
    const signature = await signRegistry(owner0, 84532, 'ReleaseHandle', { handleId: id, serial: 1n, nonce: n, expiresAt: BigInt(expiresAt) });
    expect((await w.post('/ana/release', { nonce: n, expiresAt, signature, ...(await releaseSig(w, 'ana')) }, { slow: true })).status).toBe(200);
    // A removed phone with the old key cancels the queued release and queues a transfer (q13).
    queueChange(w.anchor, id, getAddress('0x' + '66'.repeat(20)));
    expect((await w.post('/ana/hold-record', { op: 'veto' }, { slow: true })).status).toBe(200);
    // The phrase phone moves the old record to the release key (here owner1) and signs its release at the nonce the advance leaves.
    const rec = await w.anchor.record(id);
    const deadline = Math.floor(w.clock.ms / 1000) + 600;
    const fields = { handleId: id, newMetaAddress: META1, nonce: rec.nonce, deadline: BigInt(deadline) };
    const anchorDeadline = Math.floor(w.clock.ms / 1000) + 9 * 86_400;
    const res = await w.post(
      '/ana/advance',
      {
        newOwner: owner1.address,
        newMetaAddress: META1,
        deadline,
        ownerSignature: await signAnchor(owner0, 84532, TEST_ANCHOR, 'Advance', { ...fields, newOwner: owner1.address }),
        newOwnerSignature: await signAnchor(owner1, 84532, TEST_ANCHOR, 'AdvanceAccept', { ...fields, previousOwner: owner0.address }),
        anchorDeadline,
        releaseSignature: await signAnchor(owner1, 84532, TEST_ANCHOR, 'Release', { handleId: id, nonce: rec.nonce + 1n, deadline: BigInt(anchorDeadline) }),
      },
      { slow: true },
    );
    expect(res.status).toBe(200);
    const releases = (await w.registry.jobsOf(id)).filter((j) => j.kind === 'release');
    expect(releases.at(-1)).toMatchObject({ state: 'queued', args: expect.objectContaining({ owner: owner1.address.toLowerCase() }) });
    // The freeze from the veto must lapse before the release can be queued on chain.
    w.anchor.records.set(id, { ...(await w.anchor.record(id)), frozenUntil: 0 });
    w.advance(121_000);
    await w.relay();
    expect((await w.anchor.record(id)).pendingKind).toBe(CHANGE_KIND.Release);
  });

  it('moves the row only once the advance is mined: a late receipt answers 202 and the relay settles it', async () => {
    const w = world();
    await claimed(w);
    const id = handleIdOf('ana');
    const rec = await w.anchor.record(id);
    const deadline = Math.floor(w.clock.ms / 1000) + 600;
    const fields = { handleId: id, newMetaAddress: META1, nonce: rec.nonce, deadline: BigInt(deadline) };
    const wait = w.anchor.waitReceipt.bind(w.anchor);
    w.anchor.waitReceipt = async () => 'pending';
    const res = await w.post(
      '/ana/advance',
      {
        newOwner: owner1.address,
        newMetaAddress: META1,
        deadline,
        ownerSignature: await signAnchor(owner0, 84532, TEST_ANCHOR, 'Advance', { ...fields, newOwner: owner1.address }),
        newOwnerSignature: await signAnchor(owner1, 84532, TEST_ANCHOR, 'AdvanceAccept', { ...fields, previousOwner: owner0.address }),
      },
      { slow: true },
    );
    w.anchor.waitReceipt = wait;
    expect(res.status).toBe(202);
    expect((await w.registry.row('ana'))!.owner).toBe(owner0.address.toLowerCase());
    await w.relay();
    expect((await w.registry.row('ana'))!.owner).toBe(owner1.address.toLowerCase());
  });

  it('follows an owner change the chain applied without the plane, before checking a signature', async () => {
    const w = world();
    await claimed(w);
    const id = handleIdOf('ana');
    w.anchor.records.set(id, { ...(await w.anchor.record(id)), owner: owner1.address, metaAddress: META1 });
    const n = nonce();
    const expiresAt = exp(w);
    const signature = await signRegistry(owner1, 84532, 'SetDiscoverable', { handleId: id, serial: 1n, discoverable: true, inboxId: INBOX, nonce: n, expiresAt: BigInt(expiresAt) });
    expect((await w.post('/ana/discoverable', { discoverable: true, inboxId: INBOX, nonce: n, expiresAt, signature })).status).toBe(200);
    expect(await json(await w.get('/ana'))).toMatchObject({ owner: owner1.address, metaAddress: META1 });
  });

  it('caps the registrar-paid sends on one record per day', async () => {
    const w = world();
    await claimed(w);
    const id = handleIdOf('ana');
    expect((await w.post('/ana/hold-record', { op: 'hold' }, { slow: true })).status).toBe(200);
    for (let i = 1; i < REGISTRAR_SENDS_PER_DAY; i++) expect((await w.post('/ana/hold-record', { op: 'renew' }, { slow: true })).status).toBe(200);
    expect(await json(await w.post('/ana/hold-record', { op: 'renew' }, { slow: true }))).toMatchObject({ error: 'registrar_limit' });
    expect((await w.anchor.record(id)).frozenUntil).toBeGreaterThan(0);
  });

  it('lets an identity hold its own held label again', async () => {
    const w = world();
    const b = await claimBody(w, 'ana');
    const hold = { label: 'ana', owner: b.owner, metaAddress: b.metaAddress, nonce: b.nonce, expiresAt: b.expiresAt, signature: b.signature };
    expect((await w.post('/hold', hold)).status).toBe(201);
    const b2 = await claimBody(w, 'ana');
    expect((await w.post('/hold', { ...hold, nonce: b2.nonce, signature: b2.signature })).status).toBe(201);
  });

  it('bounds the watched addresses per identity and in all, in the insert itself', async () => {
    const w = world();
    const watch = (address: string, identity: string, perIdentity: number, ceiling: number, perIdentityPerDay = 100) =>
      w.registry.watch({ address: address as Address, identity, handleId: handleIdOf('ana'), source: 'self', sealed: new Uint8Array(40), now: 1, perIdentity, perIdentityPerDay, ceiling });
    expect(await watch('0x' + '01'.repeat(20), 'i1', 1, 10)).toBe('added');
    expect(await watch('0x' + '01'.repeat(20), 'i1', 1, 10)).toBe('ours');
    expect(await watch('0x' + '01'.repeat(20), 'i2', 1, 10)).toBe('theirs');
    expect(await watch('0x' + '02'.repeat(20), 'i1', 1, 10)).toBe('limit');
    expect(await watch('0x' + '03'.repeat(20), 'i3', 5, 1)).toBe('full');
    expect(await watch('0x' + '04'.repeat(20), 'i4', 5, 10, 0)).toBe('limit');
    expect(contractRevert(new AnchorRevert('X'))).toBeNull();
  });
});

// ── review round 2's findings ───────────────────────────────────────────────

async function renameAnaToB(w: World) {
  const n = nonce();
  const expiresAt = exp(w);
  const claim = await claimBody(w, 'ana-b', owner1, META1);
  const message = { handleId: handleIdOf('ana'), serial: 1n, newLabel: 'ana-b', newHandleId: handleIdOf('ana-b'), newOwner: owner1.address, newMetaAddress: META1, nonce: n, expiresAt: BigInt(expiresAt) };
  const res = await w.post(
    '/ana/rename',
    {
      newLabel: 'ana-b',
      newOwner: owner1.address,
      newMetaAddress: META1,
      nonce: n,
      expiresAt,
      signature: await signRegistry(owner0, 84532, 'RenameHandle', message),
      claim: { nonce: claim.nonce, expiresAt: claim.expiresAt, signature: claim.signature, serial: claim.serial, ownerClaimSignature: claim.ownerClaimSignature },
      ...(await releaseSig(w, 'ana')),
    },
    { slow: true },
  );
  expect(res.status).toBe(201);
}

describe('review round 2', () => {
  it("keeps a rename's release after the new claim when the old label is advanced to the release key", async () => {
    const w = world();
    await claimed(w);
    await renameAnaToB(w);
    const id = handleIdOf('ana');
    const before = (await w.registry.jobsOf(id)).find((j) => j.kind === 'release' && j.state === 'queued')!;
    const rec = await w.anchor.record(id);
    const deadline = Math.floor(w.clock.ms / 1000) + 600;
    const fields = { handleId: id, newMetaAddress: META0, nonce: rec.nonce, deadline: BigInt(deadline) };
    const releaseKey = privateKeyToAccount(('0x' + '42'.repeat(32)) as Hex);
    const anchorDeadline = Math.floor(w.clock.ms / 1000) + 9 * 86_400;
    const res = await w.post(
      '/ana/advance',
      {
        newOwner: releaseKey.address,
        newMetaAddress: META0,
        deadline,
        ownerSignature: await signAnchor(owner0, 84532, TEST_ANCHOR, 'Advance', { ...fields, newOwner: releaseKey.address }),
        newOwnerSignature: await signAnchor(releaseKey, 84532, TEST_ANCHOR, 'AdvanceAccept', { ...fields, previousOwner: owner0.address }),
        anchorDeadline,
        releaseSignature: await signAnchor(releaseKey, 84532, TEST_ANCHOR, 'Release', { handleId: id, nonce: rec.nonce + 1n, deadline: BigInt(anchorDeadline) }),
      },
      { slow: true },
    );
    expect(res.status).toBe(200);
    const after = (await w.registry.jobsOf(id)).filter((j) => j.kind === 'release' && j.state === 'queued');
    expect(after).toHaveLength(1);
    expect(after[0]!.args).toMatchObject({ owner: releaseKey.address.toLowerCase(), afterClaim: handleIdOf('ana-b') });
    expect(after[0]!.notBefore).toBe(before.notBefore);
    // The new claim fails for good: the old label stays, its release never sent.
    const idB = handleIdOf('ana-b');
    w.anchor.records.set(idB, { ...(await w.anchor.record(idB)), owner: getAddress('0x' + '77'.repeat(20)), serial: 1 });
    w.advance(301_000);
    await w.relay();
    await w.relay();
    expect(w.anchor.sent.filter((s) => s.functionName === 'release')).toEqual([]);
    expect((await w.registry.row('ana'))!.state).toBe('active');
  });

  it("sends a rename's release once the new claim landed, even if the new label was released since", async () => {
    const w = world();
    await claimed(w);
    await renameAnaToB(w);
    w.advance(121_000);
    await w.relay();
    await w.relay(); // ana-b on chain
    w.db.sqlite.prepare("UPDATE handles SET state = 'releasing' WHERE label = 'ana-b'").run();
    // Past the release's draw (60 to 300 s) and its 10-minute recheck if it ran before the claim landed.
    w.advance(601_000);
    await w.relay();
    expect(w.anchor.sent.map((s) => s.functionName)).toContain('release');
  });

  it('counts a veto against unfreeze only for the holding it was made in, and not when the simulation refused it', async () => {
    const w = world();
    await claimed(w);
    const id = handleIdOf('ana');
    expect(await w.registry.vetoed(id, 1)).toBe(false);
    await w.registry.recordFreeze(id, 'veto', owner0.address, 1, w.clock.ms);
    expect(await w.registry.vetoed(id, 1)).toBe(true);
    expect(await w.registry.vetoed(id, 2)).toBe(false);
    // A veto whose call the simulation refuses (nothing pending any more) is not counted.
    const id2 = handleIdOf('ana');
    w.db.sqlite.prepare('DELETE FROM handle_freezes').run();
    queueChange(w.anchor, id2, owner1.address);
    const cancel = w.anchor.send.bind(w.anchor);
    w.anchor.send = async (call) => {
      if (call.functionName === 'veto') throw new AnchorRevert('NoPendingChange');
      return cancel(call);
    };
    expect(await json(await w.post('/ana/hold-record', { op: 'veto' }, { slow: true }))).toMatchObject({ error: 'anchor_refused', reason: 'NoPendingChange' });
    expect(await w.registry.vetoed(id2, 1)).toBe(false);
  });

  it('settles only the advance whose receipt the route read', async () => {
    const w = world();
    await claimed(w);
    const id = handleIdOf('ana');
    await w.registry.queueAdvance(id, { owner: owner1.address, metaAddress: META1 }, ('0x' + 'aa'.repeat(32)) as Hex, w.clock.ms);
    await w.registry.queueAdvance(id, { owner: getAddress('0x' + '55'.repeat(20)), metaAddress: META0 }, ('0x' + 'bb'.repeat(32)) as Hex, w.clock.ms);
    await w.registry.settleAdvanceTx(id, ('0x' + 'aa'.repeat(32)) as Hex, w.clock.ms);
    expect((await w.registry.row('ana'))!.owner).toBe(owner1.address.toLowerCase());
    expect((await w.registry.jobsOf(id)).filter((j) => j.kind === 'advance').map((j) => j.state)).toEqual(['done', 'sent']);
  });

  it('registers addresses only for a handle on chain', async () => {
    const w = world();
    expect((await w.post('/claim', await claimBody(w, 'ana'))).status).toBe(201);
    const v = fixture.stealth.vectors[0]!;
    const n = nonce();
    const expiresAt = exp(w);
    const signature = await signRegistry(owner0, 84532, 'RegisterAddress', {
      handleId: handleIdOf('ana'),
      serial: 1n,
      account: getAddress(v.account),
      ephemeralPublicKey: v.ephemeralPublicKey as Hex,
      sharedSecretHash: v.sharedSecretHash as Hex,
      metaAddress: META0,
      nonce: n,
      expiresAt: BigInt(expiresAt),
    });
    const res = await w.post('/ana/self', { address: v.account, ephemeralPublicKey: v.ephemeralPublicKey, sharedSecretHash: v.sharedSecretHash, metaAddress: META0, nonce: n, expiresAt, signature });
    expect(await json(res)).toMatchObject({ error: 'not_on_chain' });
  });

  it('honours the skip list only in development and staging', () => {
    const skip = 'device-attestation,install-proof,locator-pin';
    expect(skipsGate({ ENVIRONMENT: 'staging', HANDLES_SKIP_UNBUILT_GATES: skip } as never, 'locator-pin')).toBe(true);
    expect(skipsGate({ ENVIRONMENT: 'development', HANDLES_SKIP_UNBUILT_GATES: skip } as never, 'locator-pin')).toBe(true);
    for (const e of ['production', 'prod', 'mainnet', '', undefined]) {
      expect(skipsGate({ ENVIRONMENT: e, HANDLES_SKIP_UNBUILT_GATES: skip } as never, 'locator-pin')).toBe(false);
    }
  });

  it('refuses a rename whose old row a concurrent release already moved (the batch guard)', async () => {
    const w = world();
    await claimed(w);
    const row = (await w.registry.row('ana'))!;
    w.db.sqlite.prepare("UPDATE handles SET state = 'releasing' WHERE label = 'ana'").run();
    const b = await claimBody(w, 'ana-b', owner1, META1);
    await expect(
      w.registry.rename({
        oldHandleId: row.handleId as Hex,
        claim: {
          label: 'ana-b',
          handleId: handleIdOf('ana-b'),
          identity: row.identity,
          installTag: 'x',
          serial: 1,
          owner: owner1.address,
          metaAddress: META1,
          ownerClaimSignature: b.ownerClaimSignature,
          relayAt: w.clock.ms,
          now: w.clock.ms,
          quarantineMs: 1,
        },
        release: { owner: owner0.address, deadline: '1', ownerSig: '0x00', relayAt: w.clock.ms },
      }),
    ).rejects.toEqual(new RegistryConflict('changed'));
    expect(await w.registry.row('ana-b')).toBeNull();
    expect(w.db.sqlite.prepare('SELECT COUNT(*) AS n FROM batch_guard').get()).toEqual({ n: 0 });
  });
});

// ── review round 3's findings ───────────────────────────────────────────────

describe('review round 3', () => {
  it("re-signs a releasing label's queued release around a veto, and the release goes out once the freeze ends", async () => {
    const w = world();
    await claimed(w);
    await renameAnaToB(w);
    w.advance(121_000);
    await w.relay();
    await w.relay(); // ana-b on chain
    const id = handleIdOf('ana');
    // A removed phone queues a transfer of the releasing label; the user vetoes it and signs the release again.
    queueChange(w.anchor, id, getAddress('0x' + '66'.repeat(20)));
    const rec = await w.anchor.record(id);
    const anchorDeadline = Math.floor(w.clock.ms / 1000) + 30 * 86_400;
    const res = await w.post(
      '/ana/hold-record',
      {
        op: 'veto',
        anchorDeadline,
        releaseSignature: await signAnchor(owner0, 84532, TEST_ANCHOR, 'Release', { handleId: id, nonce: rec.nonce + 1n, deadline: BigInt(anchorDeadline) }),
      },
      { slow: true },
    );
    expect(await json(res)).toMatchObject({ ok: true, release: 'requeued' });
    const queued = (await w.registry.jobsOf(id)).filter((j) => j.kind === 'release' && j.state === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.args.afterClaim).toBe(handleIdOf('ana-b'));
    // The relay waits out the freeze, then sends the release.
    w.anchor.records.set(id, { ...(await w.anchor.record(id)), frozenUntil: w.anchor.clock.now + 60 });
    w.advance(601_000);
    await w.relay();
    expect(w.anchor.sent.filter((c) => c.functionName === 'release')).toHaveLength(1);
  });

  it('cancels the stale release when a veto carries no new signature, and /release works on the frozen releasing label', async () => {
    const w = world();
    await claimed(w);
    await renameAnaToB(w);
    const id = handleIdOf('ana');
    queueChange(w.anchor, id, getAddress('0x' + '66'.repeat(20)));
    expect(await json(await w.post('/ana/hold-record', { op: 'veto' }, { slow: true }))).toMatchObject({ ok: true, release: 'resign' });
    expect((await w.registry.jobsOf(id)).filter((j) => j.kind === 'release' && j.state === 'queued')).toEqual([]);
    const n = nonce();
    const expiresAt = exp(w);
    const signature = await signRegistry(owner0, 84532, 'ReleaseHandle', { handleId: id, serial: 1n, nonce: n, expiresAt: BigInt(expiresAt) });
    const rec = await w.anchor.record(id);
    const anchorDeadline = rec.frozenUntil + 9 * 86_400;
    const releaseSignature = await signAnchor(owner0, 84532, TEST_ANCHOR, 'Release', { handleId: id, nonce: rec.nonce, deadline: BigInt(anchorDeadline) });
    expect((await w.post('/ana/release', { nonce: n, expiresAt, signature, anchorDeadline, releaseSignature }, { slow: true })).status).toBe(200);
  });

  it('refuses a rename or a release while an advance is unmined', async () => {
    const w = world();
    await claimed(w);
    const id = handleIdOf('ana');
    await w.registry.queueAdvance(id, { owner: owner1.address, metaAddress: META1 }, ('0x' + 'cc'.repeat(32)) as Hex, w.clock.ms);
    const n = nonce();
    const expiresAt = exp(w);
    const signature = await signRegistry(owner0, 84532, 'ReleaseHandle', { handleId: id, serial: 1n, nonce: n, expiresAt: BigInt(expiresAt) });
    expect(await json(await w.post('/ana/release', { nonce: n, expiresAt, signature, ...(await releaseSig(w, 'ana')) }, { slow: true }))).toMatchObject({ error: 'advance_pending' });
  });
});
