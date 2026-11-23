/**
 * The attachment token issuer (workspace decision 0093, rule 4): the size classes, the quota's SQL on node:sqlite,
 * the issuer keys, and the route with the SDK-made v2 fixture tokens: a phone-shaped Privacy Pass client (Cloudflare's
 * own) blinds tokens, the route counts and signs them, and the unblinded tokens verify under each class's public key,
 * which `/keys` serves. Over the allowance nothing is signed; past the plane-wide ceiling the account's reservation
 * is given back; no log line carries an account or a token.
 */

import { DatabaseSync } from 'node:sqlite';

import { BlindRSAMode, Client, Issuer, Origin, TokenResponse } from '@cloudflare/privacypass-ts/lib/src/pub_verif_token.js';
import { p256 } from '@noble/curves/p256';
import { Hono } from 'hono';
import { getAddress, hexToBytes, sha256, type Address, type Hex } from 'viem';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAttachmentRoutes, type AttachmentRouteDeps } from '../src/routes/attachments.js';
import {
  ATTACHMENT_ACCOUNT_LIMIT,
  ATTACHMENT_CLASSES,
  ATTACHMENT_EPOCH_ORIGIN,
  ATTACHMENT_ISSUER_NAME,
  classBytes,
  classFor,
  dayOf,
  epochAt,
  epochNotAfter,
  epochNotBefore,
  liveEpochs,
  prepareNext,
  windowStart,
} from '../src/services/attachments/classes.js';
import { IssuerKeysError, loadEpochIssuers, type ClassIssuer, type IssuerKeySource } from '../src/services/attachments/issuer.js';
import {
  dropBefore,
  generateEpochKeys,
  importWrapKey,
  migrateIssuerTables,
  readEpoch,
  unwrapClassKey,
  wrapKeyId,
  writeEpoch,
  type IssuerSql,
} from '../src/services/attachments/issuerKeys.js';
import { migrateQuotaTables, release, reserve, usedInWindow, type QuotaSql, type QuotaStore } from '../src/services/attachments/quotaStore.js';
import type { AuthorityCheck } from '../src/services/authorityCheck.js';
import { TIER } from '../src/services/ceremony.js';
import { createAuthorityMemo } from '../src/services/chat/authorityMemo.js';
import type { ReplayStore } from '../src/services/popReplayStore.js';
import { popAth } from '../src/services/sessionAttestation.js';

import v2 from './fixtures/sdk-attestations-v2.json';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const ACCOUNT = v2.account as Address;
const NOW = v2.issuedAt + 1_000;
const ORIGIN = v2.origin;
const fx = v2.tokens.p256;
const HIGH: AuthorityCheck = { status: 'active', authorityId: 0, module: ACCOUNT, tier: TIER.High };
const MiB = 1024 * 1024;

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
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

function sqlite(): QuotaSql {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query, ...bindings) {
      const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
}

/** The quota objects on node:sqlite, one database per object name, as the Durable Objects keep them. */
function memoryQuota(): QuotaStore & { objects: Map<string, QuotaSql> } {
  const objects = new Map<string, QuotaSql>();
  const of = (name: string) => {
    let sql = objects.get(name);
    if (!sql) {
      sql = sqlite();
      migrateQuotaTables(sql);
      objects.set(name, sql);
    }
    return sql;
  };
  return {
    objects,
    async reserve(account, day, bytes, limit, windowDays) {
      return reserve(of(`account:${account.toLowerCase()}`), day, bytes, limit, windowDays);
    },
    async release(account, day, bytes) {
      release(of(`account:${account.toLowerCase()}`), day, bytes);
    },
    async used(account, day, windowDays) {
      return usedInWindow(of(`account:${account.toLowerCase()}`), day, windowDays);
    },
    async reserveGlobal(day, bytes, ceiling) {
      return reserve(of('plane:attachments'), day, bytes, ceiling, 1);
    },
    async releaseGlobal(day, bytes) {
      release(of('plane:attachments'), day, bytes);
    },
  };
}

const WRAP = Buffer.alloc(32, 7).toString('base64');

/** The issuer object's SQL on node:sqlite, making epochs with Node's WebCrypto, as `AttachmentIssuerDO` does. */
function memoryIssuerKeys(secret = WRAP): IssuerKeySource & { sql: IssuerSql; made: number[]; secret: string } {
  const sql = sqlite() as IssuerSql;
  migrateIssuerTables(sql);
  const made: number[] = [];
  const self = {
    sql,
    made,
    secret,
    async epochKeys(epoch: number) {
      const id = await wrapKeyId(self.secret);
      const stored = readEpoch(sql, epoch, id);
      if (stored) return stored;
      made.push(epoch);
      return writeEpoch(sql, await generateEpochKeys(epoch, await importWrapKey(self.secret), id));
    },
    async storedEpoch(epoch: number) {
      return readEpoch(sql, epoch, await wrapKeyId(self.secret));
    },
  };
  return self;
}

const DAY = 86_400_000;
/** Ten days into epoch 1. */
const AT = epochNotBefore(1) + 10 * DAY;
const keySource = memoryIssuerKeys();
let issuers: ClassIssuer[] = [];

beforeAll(async () => {
  issuers = await loadEpochIssuers(keySource, WRAP, epochAt(AT), { allowJsSigning: true });
}, 120_000);

afterEach(() => vi.restoreAllMocks());

describe('size classes and epochs', () => {
  it('pads up to the smallest class that holds the bytes, none past 10 MiB', () => {
    expect(classFor(0)).toBe(0);
    expect(classFor(64 * 1024)).toBe(0);
    expect(classFor(64 * 1024 + 1)).toBe(1);
    expect(classFor(10 * MiB)).toBe(ATTACHMENT_CLASSES.length - 1);
    expect(classFor(10 * MiB + 1)).toBeNull();
    expect(classBytes(4)).toBe(MiB);
    expect(() => classBytes(9)).toThrow();
  });

  it('reads a 30-day window ending on a day', () => {
    expect(dayOf(Date.UTC(2026, 10, 23, 23, 59))).toBe('2026-11-23');
    expect(windowStart('2026-11-23', 30)).toBe('2026-10-25');
    expect(windowStart('2026-03-01', 1)).toBe('2026-03-01');
  });

  it('starts an epoch every 27 days, each live 30, overlapping 3, and prepares the next 3 days ahead', () => {
    expect(epochAt(ATTACHMENT_EPOCH_ORIGIN)).toBe(0);
    expect(epochAt(ATTACHMENT_EPOCH_ORIGIN - 1)).toBe(0);
    expect(epochNotAfter(0) - epochNotBefore(0)).toBe(30 * DAY);
    expect(epochNotBefore(1) - epochNotBefore(0)).toBe(27 * DAY);
    expect(liveEpochs(epochNotBefore(1) + DAY)).toEqual([1, 0]);
    expect(liveEpochs(epochNotAfter(0))).toEqual([1]);
    expect(liveEpochs(ATTACHMENT_EPOCH_ORIGIN)).toEqual([0]);
    expect(prepareNext(epochNotBefore(2) - 3 * DAY - 1)).toBe(false);
    expect(prepareNext(epochNotBefore(2) - 3 * DAY)).toBe(true);
  });
});

describe('the quota SQL, on node:sqlite', () => {
  it('reserves within the limit, refuses past it, forgets days before the window and gives back', () => {
    const sql = sqlite();
    migrateQuotaTables(sql);
    expect(reserve(sql, '2026-10-01', 40 * MiB, 50 * MiB, 30)).toEqual({ ok: true, used: 40 * MiB });
    expect(reserve(sql, '2026-10-20', 10 * MiB, 50 * MiB, 30)).toEqual({ ok: true, used: 50 * MiB });
    expect(reserve(sql, '2026-10-20', 1, 50 * MiB, 30)).toEqual({ ok: false, used: 50 * MiB });
    // 2026-10-01 leaves the window on 2026-10-31.
    expect(reserve(sql, '2026-10-31', 40 * MiB, 50 * MiB, 30)).toEqual({ ok: true, used: 50 * MiB });
    expect(sql.exec('SELECT day FROM days ORDER BY day').toArray().map((r) => r.day)).toEqual(['2026-10-20', '2026-10-31']);
    release(sql, '2026-10-31', 40 * MiB);
    release(sql, '2026-10-31', 1);
    expect(usedInWindow(sql, '2026-10-31', 30)).toBe(10 * MiB);
    expect(() => reserve(sql, 'nope', 1, 1, 1)).toThrow();
    expect(() => reserve(sql, '2026-10-31', 0, 1, 1)).toThrow();
  });
});

describe('the issuer keys', () => {
  it('keeps each private key wrapped, bound to its epoch and class, and one set per epoch', async () => {
    const stored = readEpoch(keySource.sql, epochAt(AT), await wrapKeyId(WRAP))!;
    expect(stored).toHaveLength(ATTACHMENT_CLASSES.length);
    const wrap = await importWrapKey(WRAP);
    const pkcs8 = await unwrapClassKey(stored[2]!, wrap);
    expect(pkcs8.length).toBeGreaterThan(1000);
    // The same bytes under another class or epoch, or another wrap key, do not unwrap.
    await expect(unwrapClassKey({ ...stored[2]!, class: 3 }, wrap)).rejects.toThrow(IssuerKeysError);
    await expect(unwrapClassKey(stored[2]!, await importWrapKey(Buffer.alloc(32, 8).toString('base64')))).rejects.toThrow(IssuerKeysError);
    expect(JSON.stringify(stored)).not.toContain(Buffer.from(pkcs8).toString('base64').slice(0, 40));
    // A second maker's set never replaces the first.
    expect(writeEpoch(keySource.sql, stored.map((k) => ({ ...k, n: 'x' })))[0]!.n).toBe(stored[0]!.n);
    await expect(importWrapKey('short')).rejects.toThrow(/32 bytes|base64/);
  });

  it('drops epochs whose tokens are dead', async () => {
    const sql = sqlite() as IssuerSql;
    migrateIssuerTables(sql);
    const stored = readEpoch(keySource.sql, epochAt(AT), await wrapKeyId(WRAP))!;
    writeEpoch(sql, stored.map((k) => ({ ...k, epoch: 0 })));
    writeEpoch(sql, stored);
    dropBefore(sql, 1);
    const id = await wrapKeyId(WRAP);
    expect(readEpoch(sql, 0, id)).toBeNull();
    expect(readEpoch(sql, 1, id)).not.toBeNull();
  });

  it('refuses to sign through the JavaScript private-key path unless told to (Node has no RSA-RAW)', async () => {
    await expect(loadEpochIssuers(keySource, WRAP, epochAt(AT))).rejects.toThrow(/RSA-RAW/);
    expect(issuers.map((i) => i.class)).toEqual([...ATTACHMENT_CLASSES.keys()]);
    expect(new Set(issuers.map((i) => b64url(i.tokenKeyId))).size).toBe(ATTACHMENT_CLASSES.length);
  });
});

// ── the route ───────────────────────────────────────────────────────────────

function harness(opts: { quota?: QuotaStore | null; authority?: AuthorityCheck; now?: number; deps?: Partial<AttachmentRouteDeps> } = {}) {
  const quota = opts.quota === undefined ? memoryQuota() : opts.quota;
  const replay = memoryReplay();
  const h = new Hono();
  h.route(
    '/v1/messages/attachments',
    createAttachmentRoutes({
      attestationMaxAgeMs: 3_600_000,
      // The session's checks run at the fixture's time; the epochs at AT.
      now: () => NOW,
      authorityCheck: async () => opts.authority ?? HIGH,
      authorityMemo: createAuthorityMemo({ edge: null }),
      quota: () => quota,
      keys: () => ({ source: keySource, wrapSecret: WRAP }),
      allowJsSigning: true,
      replayStore: () => replay,
      ...opts.deps,
    }),
  );
  const send = (method: string, path: string, body?: unknown, token: string | null = fx.fast) => {
    const url = `${ORIGIN}${path}`;
    const headers: Record<string, string> = { 'cf-connecting-ip': '203.0.113.7', 'content-type': 'application/json' };
    if (token) {
      headers.authorization = `DPoP ${token}`;
      headers.dpop = signProof({ htm: method, htu: url, token });
    }
    return h.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, { ENVIRONMENT: 'staging' } as never);
  };
  return { quota, send };
}

/** What a phone does: one Cloudflare client per token, its request blinded under the class's current key. */
async function blinded(classes: number[], keys: ClassIssuer[] = current()) {
  const challenge = new Origin(BlindRSAMode.PSS).createTokenChallenge(ATTACHMENT_ISSUER_NAME, new Uint8Array(0));
  return Promise.all(
    classes.map(async (c) => {
      const client = new Client(BlindRSAMode.PSS);
      const request = await client.createTokenRequest(challenge, keys[c]!.publicKeyBytes);
      return { class: c, client, request: b64url(request.serialize()) };
    }),
  );
}

/** The fixture's own epoch's issuers: the route signs with the epoch at NOW. */
let nowIssuers: ClassIssuer[] = [];
const current = () => nowIssuers;
beforeAll(async () => {
  nowIssuers = await loadEpochIssuers(keySource, WRAP, epochAt(NOW), { allowJsSigning: true });
}, 120_000);

const tokensBody = (wallet: { class: number; request: string }[]) => ({
  account: ACCOUNT,
  epoch: epochAt(NOW),
  requests: wallet.map(({ class: c, request }) => ({ class: c, request })),
});

describe('the token route', () => {
  it('serves the live epochs with each class key and its dates, cached no later than the next epoch', async () => {
    const res = await harness().send('GET', '/v1/messages/attachments/keys', undefined, null);
    expect(res.status).toBe(200);
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')![1]);
    expect(maxAge).toBeLessThanOrEqual(Math.min(3600, (epochNotBefore(epochAt(NOW) + 1) - NOW) / 1000));
    const body = (await res.json()) as {
      current: number;
      epochs: { epoch: number; notBefore: string; notAfter: string; classes: { bytes: number; publicKey: string }[] }[];
    };
    expect(body.current).toBe(epochAt(NOW));
    const now = body.epochs.find((e) => e.epoch === epochAt(NOW))!;
    expect(Date.parse(now.notAfter) - Date.parse(now.notBefore)).toBe(30 * DAY);
    expect(now.classes.map((c) => c.bytes)).toEqual([...ATTACHMENT_CLASSES]);
    expect(now.classes[3]!.publicKey).toBe(b64url(current()[3]!.publicKeyBytes));
  });

  it('lists the next epoch once made and the previous one during the overlap, and makes the next only near it', async () => {
    // A wrap secret of its own, so the isolate cache holds nothing of this source yet.
    const secret = Buffer.alloc(32, 5).toString('base64');
    const source = memoryIssuerKeys(secret);
    const routes = harness({ deps: { now: () => clock, keys: () => ({ source, wrapSecret: secret }) } });
    let clock = 0;
    const at = (ms: number) => {
      clock = ms;
      return routes.send('GET', '/v1/messages/attachments/keys', undefined, null);
    };
    const read = async (ms: number) => ((await (await at(ms)).json()) as { epochs: { epoch: number }[] }).epochs.map((e) => e.epoch);
    // Mid epoch 1: only epoch 1, and nothing prepared.
    expect(await read(epochNotBefore(1) + 10 * DAY)).toEqual([1]);
    expect(source.made).toEqual([1]);
    // Two days before epoch 2: epoch 2 is made in the background, then listed.
    await read(epochNotBefore(2) - 2 * DAY);
    await vi.waitFor(async () => expect(await source.storedEpoch(2)).not.toBeNull(), { timeout: 30_000, interval: 100 });
    expect(await read(epochNotBefore(2) - 2 * DAY + 6 * 60 * 1000)).toEqual([2, 1]);
    // In the overlap: epoch 2 current, epoch 1 still live.
    expect(await read(epochNotBefore(2) + DAY)).toEqual([2, 1]);
    // Once epoch 1 dies, only epoch 2.
    expect(await read(epochNotAfter(1) + 1)).toEqual([2]);
  }, 120_000);

  it('makes an epoch again under a replaced wrap key, so issuance never stalls', async () => {
    const source = memoryIssuerKeys();
    const first = await source.epochKeys(1);
    source.secret = Buffer.alloc(32, 9).toString('base64');
    const again = await source.epochKeys(1);
    expect(again[0]!.n).not.toBe(first[0]!.n);
    expect(await loadEpochIssuers(source, source.secret, 1, { allowJsSigning: true })).toHaveLength(ATTACHMENT_CLASSES.length);
  }, 60_000);

  it('counts the classes and signs blind; each token verifies under its class key and no other', async () => {
    const t = harness();
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(String(line)));
    const wallet = await blinded([0, 4, 8]);
    const res = await t.send('POST', '/v1/messages/attachments/tokens', tokensBody(wallet));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { epoch: number; responses: string[]; used: number };
    expect(body.epoch).toBe(epochAt(NOW));
    expect(body.used).toBe(classBytes(0) + classBytes(4) + classBytes(8));
    const origin = new Origin(BlindRSAMode.PSS);
    for (const [i, w] of wallet.entries()) {
      const token = await w.client.finalize(TokenResponse.deserialize(Buffer.from(body.responses[i]!, 'base64url')));
      expect(await origin.verify(token, current()[w.class]!.publicKey)).toBe(true);
      expect(await origin.verify(token, current()[(w.class + 1) % 9]!.publicKey)).toBe(false);
    }
    const all = logs.join('\n');
    expect(all).not.toContain(ACCOUNT.toLowerCase().slice(2));
    expect(all).not.toContain(getAddress(ACCOUNT).slice(2));
    for (const w of wallet) expect(all).not.toContain(w.request.slice(0, 24));
  }, 60_000);

  it('signs nothing past the allowance and says how much is used', async () => {
    const t = harness();
    const day = dayOf(NOW);
    await t.quota!.reserve(ACCOUNT, day, ATTACHMENT_ACCOUNT_LIMIT - classBytes(0), ATTACHMENT_ACCOUNT_LIMIT, 30);
    const res = await t.send('POST', '/v1/messages/attachments/tokens', tokensBody(await blinded([1])));
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: 'attachment_quota', used: ATTACHMENT_ACCOUNT_LIMIT - classBytes(0) });
    expect(await t.quota!.used(ACCOUNT, day, 30)).toBe(ATTACHMENT_ACCOUNT_LIMIT - classBytes(0));
  });

  it('gives the account its reservation back at the ceiling, when the ceiling cannot be read, and when signing fails', async () => {
    const day = dayOf(NOW);
    const full = harness();
    await full.quota!.reserveGlobal(day, 1024 * MiB, 1024 * MiB);
    const ceiling = await full.send('POST', '/v1/messages/attachments/tokens', tokensBody(await blinded([2])));
    expect(ceiling.status).toBe(503);
    expect(await ceiling.json()).toMatchObject({ error: 'attachment_ceiling' });
    expect(await full.quota!.used(ACCOUNT, day, 30)).toBe(0);

    const broken = memoryQuota();
    broken.reserveGlobal = () => Promise.reject(new Error('object reset'));
    const down = harness({ quota: broken });
    expect((await down.send('POST', '/v1/messages/attachments/tokens', tokensBody(await blinded([2])))).status).toBe(503);
    expect(await broken.used(ACCOUNT, day, 30)).toBe(0);

    const t = harness();
    vi.spyOn(Issuer.prototype, 'issue').mockRejectedValueOnce(new Error('fault'));
    const res = await t.send('POST', '/v1/messages/attachments/tokens', tokensBody(await blinded([3])));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'attachment_sign_failed' });
    expect(await t.quota!.used(ACCOUNT, day, 30)).toBe(0);
  });

  it('refuses a signature that fails its own check, and answers 503 when the account cannot be counted or a release fails', async () => {
    const day = dayOf(NOW);
    const t = harness();
    vi.spyOn(Issuer.prototype, 'issue').mockResolvedValueOnce(new TokenResponse(new Uint8Array(256).fill(1)));
    const res = await t.send('POST', '/v1/messages/attachments/tokens', tokensBody(await blinded([3])));
    expect(await res.json()).toMatchObject({ error: 'attachment_sign_failed' });
    expect(await t.quota!.used(ACCOUNT, day, 30)).toBe(0);

    const down = memoryQuota();
    down.reserve = () => Promise.reject(new Error('object reset'));
    expect(await (await harness({ quota: down }).send('POST', '/v1/messages/attachments/tokens', tokensBody(await blinded([0])))).json()).toMatchObject({
      error: 'attachment_quota_unavailable',
    });

    const stuck = memoryQuota();
    stuck.releaseGlobal = () => Promise.reject(new Error('object reset'));
    vi.spyOn(Issuer.prototype, 'issue').mockRejectedValueOnce(new Error('fault'));
    const failed = await harness({ quota: stuck }).send('POST', '/v1/messages/attachments/tokens', tokensBody(await blinded([0])));
    expect(await failed.json()).toMatchObject({ error: 'attachment_sign_failed' });
    expect(await stuck.used(ACCOUNT, day, 30)).toBe(0);
  });

  it('refuses a request under another class key, or with extra bytes, before counting anything', async () => {
    const t = harness();
    const [w] = await blinded([5]);
    // Another class whose key id differs in the byte a request carries (keys are random per run; 1 in 256 share it).
    const last = (c: number) => current()[c]!.tokenKeyId.at(-1);
    const other = [...ATTACHMENT_CLASSES.keys()].find((c) => c !== 5 && last(c) !== last(5))!;
    const wrong = await t.send('POST', '/v1/messages/attachments/tokens', { account: ACCOUNT, epoch: epochAt(NOW), requests: [{ class: other, request: w!.request }] });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: 'bad_token_request', index: 0, reason: 'wrong_key' });
    const longer = `${w!.request}AAAA`;
    expect((await t.send('POST', '/v1/messages/attachments/tokens', { account: ACCOUNT, epoch: epochAt(NOW), requests: [{ class: 5, request: longer }] })).status).toBe(400);
    // A blinded message at or above the modulus is not a blinded token.
    const raw = Buffer.from(w!.request, 'base64url');
    raw.fill(0xff, 3);
    const big = await t.send('POST', '/v1/messages/attachments/tokens', { account: ACCOUNT, epoch: epochAt(NOW), requests: [{ class: 5, request: raw.toString('base64url') }] });
    expect(await big.json()).toMatchObject({ error: 'bad_token_request', reason: 'malformed' });
    expect(await t.quota!.used(ACCOUNT, dayOf(NOW), 30)).toBe(0);
  });

  it('refuses a bad body, another account, a missing session, a refused authority and missing or broken keys', async () => {
    const [w] = await blinded([0]);
    const one = { account: ACCOUNT, epoch: epochAt(NOW), requests: [{ class: 0, request: w!.request }] };
    const post = (body: unknown, o: Parameters<typeof harness>[0] = {}, token?: string | null) =>
      harness(o).send('POST', '/v1/messages/attachments/tokens', body, token);
    expect((await post({ ...one, requests: [] })).status).toBe(400);
    expect((await post({ ...one, requests: Array(9).fill(one.requests[0]) })).status).toBe(400);
    expect((await post({ ...one, requests: [{ class: 9, request: w!.request }] })).status).toBe(400);
    expect((await post({ ...one, epoch: undefined })).status).toBe(400);
    expect(await (await post({ ...one, epoch: epochAt(NOW) + 1 })).json()).toMatchObject({ error: 'stale_epoch', epoch: epochAt(NOW) });
    expect((await post({ ...one, account: '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd' })).status).toBe(401);
    expect((await post(one, {}, null)).status).toBe(401);
    expect((await post(one, { authority: { ...HIGH, tier: TIER.Partner } })).status).toBe(401);
    expect(await (await post(one, { quota: null })).json()).toMatchObject({ error: 'attachment_quota_unprovisioned' });
    expect(await (await post(one, { deps: { keys: () => null } })).json()).toMatchObject({ error: 'attachment_issuer_unprovisioned' });
    const broken = { deps: { keys: () => ({ source: keySource, wrapSecret: 'not a key' }) } };
    expect(await (await post(one, broken)).json()).toMatchObject({ error: 'attachment_issuer_unavailable' });
    expect(await (await harness(broken).send('GET', '/v1/messages/attachments/keys', undefined, null)).json()).toMatchObject({
      error: 'attachment_issuer_unavailable',
    });
  });
});
