// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { fromB64, fromB64Url, toB64, utf8 } from '../../xmtp/push-relay/src/b64.js';
import { encryptHint, hintKeys } from '../../xmtp/push-relay/src/hint.js';
import relay, { handleDelivery, type Env } from '../../xmtp/push-relay/src/index.js';
import { classifyApns, classifyFcm, resetProviderCaches } from '../../xmtp/push-relay/src/providers.js';
import { loadKeyRing, seal, unseal, type DeliveryRecord } from '../../xmtp/push-relay/src/seal.js';
import { verifyWebhook } from '../../xmtp/push-relay/src/webhook.js';

const SEAL_KEYS = JSON.stringify({ '1': toB64(new Uint8Array(32).fill(1)), '2': toB64(new Uint8Array(32).fill(2)) });
const NOW = 1_800_000_000;
const APNS_TOKEN = 'ab'.repeat(32);
const GROUP_TOPIC = toB64(new Uint8Array([0, ...new Array(16).fill(5)]));
const WELCOME_TOPIC = toB64(new Uint8Array([1, ...new Array(32).fill(6)]));

function record(over: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return { platform: 'ios', token: APNS_TOKEN, signingKey: new Uint8Array(32).fill(7), apnsEnv: 'production', ...over };
}

/** What the XMTP backend's http.rs sends: Standard Webhooks over the raw key. */
async function backendWebhook(key: Uint8Array, body: string, ts = NOW, id = 'msg_1'): Promise<Headers> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, utf8.encode(`${id}.${ts}.${body}`)));
  return new Headers({
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': String(ts),
    'webhook-signature': `v1,${toB64(sig)}`,
  });
}

async function pem(key: CryptoKey): Promise<string> {
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', key)) as ArrayBuffer);
  return `-----BEGIN PRIVATE KEY-----\n${toB64(der)}\n-----END PRIVATE KEY-----\n`;
}

async function env(): Promise<Env> {
  const ec = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const rsa = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  return {
    SEAL_KEYS,
    SEAL_KID_CURRENT: '1',
    PUBLIC_BASE_URL: 'https://push.cofferdam.xyz',
    APNS_KEY_P8: await pem(ec.privateKey),
    APNS_KEY_ID: 'KEY1234567',
    APNS_TEAM_ID: '4DCX2H37VW',
    APNS_BUNDLE_ID: 'xyz.cofferdam.app',
    FCM_SERVICE_ACCOUNT: JSON.stringify({
      project_id: 'cofferdam-test',
      client_email: 'relay@cofferdam-test.iam.gserviceaccount.com',
      private_key: await pem(rsa.privateKey),
    }),
  };
}

interface Call {
  url: string;
  init: RequestInit;
}
function fakeFetch(answers: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const host = new URL(url).host;
    const answer = answers[host];
    if (!answer) throw new Error(`unexpected ${url}`);
    return answer();
  };
  return { calls, fetcher };
}

const post = (url: string, body: string, headers?: Headers) => new Request(url, { method: 'POST', body, headers });

beforeEach(() => resetProviderCaches());

describe('sealing', () => {
  it('round-trips, and opens only under its own key ring', async () => {
    const ring = await loadKeyRing(SEAL_KEYS);
    const sealed = await seal(record(), ring, 1);
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    const opened = await unseal(sealed, ring);
    expect(opened?.token).toBe(APNS_TOKEN);
    expect(opened?.signingKey).toEqual(new Uint8Array(32).fill(7));
    expect(await unseal(sealed, await loadKeyRing(JSON.stringify({ '1': toB64(new Uint8Array(32).fill(9)) })))).toBeNull();
    expect(await unseal(sealed, await loadKeyRing(JSON.stringify({ '2': toB64(new Uint8Array(32).fill(2)) })))).toBeNull();
  });

  it('refuses a tampered blob', async () => {
    const ring = await loadKeyRing(SEAL_KEYS);
    const raw = fromB64Url(await seal(record(), ring, 1))!;
    raw[20]! ^= 1;
    const { toB64Url } = await import('../../xmtp/push-relay/src/b64.js');
    expect(await unseal(toB64Url(raw), ring)).toBeNull();
  });

  it('keeps the delivery URL far under the backend limit (2,048) for a long FCM token', async () => {
    const res = await relay.fetch(
      post(
        'https://push.cofferdam.xyz/v1/seal',
        JSON.stringify({ v: 1, platform: 'android', token: 'f'.repeat(300), signingKey: toB64(new Uint8Array(32)) }),
      ),
      await env(),
    );
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url.startsWith('https://push.cofferdam.xyz/v1/d/')).toBe(true);
    expect(url.length).toBeLessThan(800);
    expect(url).not.toContain('ffff');
  });

  it('rejects what is not a token, a key or a platform', async () => {
    const e = await env();
    const bad = [
      { v: 1, platform: 'ios', token: 'not-hex', signingKey: toB64(new Uint8Array(32)) },
      { v: 1, platform: 'android', token: 'tok-ok-123', signingKey: toB64(new Uint8Array(8)) },
      { v: 1, platform: 'web', token: 'tok-ok-123', signingKey: toB64(new Uint8Array(32)) },
      { v: 2, platform: 'android', token: 'tok-ok-123', signingKey: toB64(new Uint8Array(32)) },
    ];
    for (const b of bad) {
      expect((await relay.fetch(post('https://push.cofferdam.xyz/v1/seal', JSON.stringify(b)), e)).status).toBe(400);
    }
  });
});

describe('the backend webhook', () => {
  it("matches libxmtp's own fixed signature vector (http/tests.rs)", async () => {
    // signature(&[7; 32], "fixed-id", "1700000000", body) == "v1,IszeBLRjxb7spJ5RLi+KW0w/aK3Buioq9E6jl3MKWZw="
    const body = utf8.encode('{"topic":"AQID","sequence_id":"9007199254740993","recipient_id":"0101"}');
    const headers = new Headers({
      'webhook-id': 'fixed-id',
      'webhook-timestamp': '1700000000',
      'webhook-signature': 'v1,IszeBLRjxb7spJ5RLi+KW0w/aK3Buioq9E6jl3MKWZw=',
    });
    const r = await verifyWebhook(headers, body, new Uint8Array(32).fill(7), 1700000000);
    // The signature passes; the vector's 3-byte topic is not a real topic.
    expect(r).toEqual({ ok: false, reason: 'topic' });
    const forged = new Headers(headers);
    forged.set('webhook-signature', 'v1,AAAA' + 'IszeBLRjxb7spJ5RLi+KW0w/aK3Buioq9E6jl3MK');
    expect(await verifyWebhook(forged, body, new Uint8Array(32).fill(7), 1700000000)).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it('refuses stale timestamps and junk sequence ids', async () => {
    const key = new Uint8Array(32).fill(7);
    const body = JSON.stringify({ topic: GROUP_TOPIC, sequence_id: '42', recipient_id: '00' });
    const old = await backendWebhook(key, body, NOW - 301);
    expect(await verifyWebhook(old, utf8.encode(body), key, NOW)).toEqual({ ok: false, reason: 'timestamp' });
    const junk = JSON.stringify({ topic: GROUP_TOPIC, sequence_id: '4.2', recipient_id: '00' });
    expect(await verifyWebhook(await backendWebhook(key, junk), utf8.encode(junk), key, NOW)).toEqual({
      ok: false,
      reason: 'sequence_id',
    });
  });
});

describe('delivery', () => {
  async function deliver(rec: DeliveryRecord, answers: Record<string, () => Response>, topic = GROUP_TOPIC) {
    const e = await env();
    const sealed = await seal(rec, await loadKeyRing(SEAL_KEYS), 1);
    const body = JSON.stringify({ topic, sequence_id: '9007199254740993', recipient_id: 'ab'.repeat(32) });
    const req = post(`https://push.cofferdam.xyz/v1/d/${sealed}`, body, await backendWebhook(rec.signingKey, body));
    const ff = fakeFetch(answers);
    const res = await handleDelivery(req, e, sealed, ff.fetcher, NOW);
    return { res, calls: ff.calls };
  }

  it('sends iOS an APNs alert the extension can rewrite, with the hint encrypted for the device', async () => {
    const rec = record();
    const { res, calls } = await deliver(rec, { 'api.push.apple.com': () => new Response(null, { status: 200 }) });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`https://api.push.apple.com/3/device/${APNS_TOKEN}`);
    const h = call.init.headers as Record<string, string>;
    expect(h['apns-push-type']).toBe('alert');
    expect(h['apns-topic']).toBe('xyz.cofferdam.app');
    expect(h['apns-collapse-id']).toMatch(/^[0-9a-f]{32}$/);
    expect(h.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const payload = JSON.parse(call.init.body as string);
    expect(payload.aps['mutable-content']).toBe(1);
    expect(payload.aps.alert.body).toBe('New message');
    // Apple sees no topic and no sequence id.
    expect(call.init.body as string).not.toContain(GROUP_TOPIC);
    expect(call.init.body as string).not.toContain('9007199254740993');
    // The phone, holding only its signing key, opens the hint.
    const raw = fromB64Url(payload.c)!;
    const { aes } = await hintKeys(rec.signingKey);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, aes, raw.subarray(12));
    expect(JSON.parse(new TextDecoder().decode(pt))).toEqual({ t: GROUP_TOPIC, s: '9007199254740993' });
  });

  it('uses the sandbox host for development builds', async () => {
    const { res, calls } = await deliver(record({ apnsEnv: 'sandbox' }), {
      'api.sandbox.push.apple.com': () => new Response(null, { status: 200 }),
    });
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toContain('api.sandbox.push.apple.com');
  });

  it('answers 410 when Apple drops the token, so the backend deletes the recipient', async () => {
    const { res } = await deliver(record(), {
      'api.push.apple.com': () => Response.json({ reason: 'Unregistered' }, { status: 410 }),
    });
    expect(res.status).toBe(410);
  });

  it('sends Android an FCM data message with only the encrypted hint', async () => {
    const rec = record({ platform: 'android', token: 'fcm-token-abc123' });
    const { res, calls } = await deliver(
      rec,
      {
        'oauth2.googleapis.com': () => Response.json({ access_token: 'ya29.test', expires_in: 3599 }),
        'fcm.googleapis.com': () => Response.json({ name: 'projects/cofferdam-test/messages/1' }),
      },
      WELCOME_TOPIC,
    );
    expect(res.status).toBe(200);
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['oauth2.googleapis.com', 'fcm.googleapis.com']);
    const msg = JSON.parse(calls[1]!.init.body as string).message;
    expect(msg.token).toBe('fcm-token-abc123');
    expect(Object.keys(msg.data)).toEqual(['c']);
    expect(msg.android.priority).toBe('HIGH');
    expect(calls[1]!.init.body as string).not.toContain(WELCOME_TOPIC);
  });

  it('routes the iOS fallback through FCM with an APNs alert block', async () => {
    const { res, calls } = await deliver(record({ platform: 'ios-fcm', token: 'fcm-ios-token-1' }), {
      'oauth2.googleapis.com': () => Response.json({ access_token: 'ya29.test', expires_in: 3599 }),
      'fcm.googleapis.com': () => Response.json({}),
    });
    expect(res.status).toBe(200);
    const msg = JSON.parse(calls[1]!.init.body as string).message;
    expect(msg.apns.payload.aps['mutable-content']).toBe(1);
    expect(msg.data).toBeUndefined();
  });

  it('answers 401 to a bad signature and 410 to a URL no key opens', async () => {
    const e = await env();
    const sealed = await seal(record(), await loadKeyRing(SEAL_KEYS), 1);
    const body = JSON.stringify({ topic: GROUP_TOPIC, sequence_id: '1', recipient_id: '00' });
    const wrongKey = await backendWebhook(new Uint8Array(32).fill(8), body);
    const none = fakeFetch({});
    expect((await handleDelivery(post('https://x/v1/d/s', body, wrongKey), e, sealed, none.fetcher, NOW)).status).toBe(
      401,
    );
    const gone = await seal(record(), await loadKeyRing(JSON.stringify({ '9': toB64(new Uint8Array(32)) })), 9);
    const sig = await backendWebhook(record().signingKey, body);
    expect((await handleDelivery(post('https://x/v1/d/s', body, sig), e, gone, none.fetcher, NOW)).status).toBe(410);
    expect(none.calls).toHaveLength(0);
  });

  it('two deliveries of one message share a collapse id; two messages do not', async () => {
    const key = new Uint8Array(32).fill(3);
    const a = await encryptHint(key, { topic: fromB64(GROUP_TOPIC)!, sequenceId: '10' });
    const b = await encryptHint(key, { topic: fromB64(GROUP_TOPIC)!, sequenceId: '10' });
    const c = await encryptHint(key, { topic: fromB64(GROUP_TOPIC)!, sequenceId: '11' });
    expect(a.collapseId).toBe(b.collapseId);
    expect(a.c).not.toBe(b.c);
    expect(c.collapseId).not.toBe(a.collapseId);
  });

  it('classifies provider answers the way the backend expects', () => {
    expect(classifyApns(400, 'BadDeviceToken')).toBe('gone');
    expect(classifyApns(429, 'TooManyRequests')).toBe('retry');
    expect(classifyApns(403, 'InvalidProviderToken')).toBe('retry');
    expect(classifyApns(400, 'PayloadTooLarge')).toBe('rejected');
    expect(classifyFcm(404, 'UNREGISTERED')).toBe('gone');
    expect(classifyFcm(503, 'UNAVAILABLE')).toBe('retry');
  });
});

describe('the relay keeps nothing', () => {
  const dir = join(__dirname, '../../xmtp/push-relay');
  it('has no console call in its source', () => {
    for (const f of readdirSync(join(dir, 'src'))) {
      expect(readFileSync(join(dir, 'src', f), 'utf8'), f).not.toMatch(/console\./);
    }
  });
  it('declares no storage binding and keeps logs off', () => {
    const cfg = readFileSync(join(dir, 'wrangler.jsonc'), 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    for (const binding of ['kv_namespaces', 'd1_databases', 'r2_buckets', 'durable_objects', 'analytics_engine', 'queues']) {
      expect(cfg).not.toContain(binding);
    }
    expect(cfg).toMatch(/"observability":\s*\{\s*"enabled":\s*false\s*\}/);
    expect(cfg).toMatch(/"logpush":\s*false/);
  });
});

describe('the hint vector shared with the app', () => {
  // cofferdam-app src/lib/push.test.ts opens the same vector with @noble/ciphers.
  const VECTOR = {
    key: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
    topic: 'AKurq6urq6urq6urq6urq6s=',
    seq: '42',
    c: 'BwcHBwcHBwcHBwcHEBkDTN4DqgQNZoyXKJVAFwY42G9VPKNYuQS2m1T66rQ0yQkhQsLugiDD-yCAdECBbqApLBPEK99H',
    collapseId: 'c1e6a363a454bd41ff5f6539cf8da467',
  };

  it('opens with the relay keys and yields the same collapse id', async () => {
    const key = fromB64(VECTOR.key)!;
    const { aes } = await hintKeys(key);
    const raw = fromB64Url(VECTOR.c)!;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, aes, raw.subarray(12));
    expect(JSON.parse(new TextDecoder().decode(plain))).toEqual({ t: VECTOR.topic, s: VECTOR.seq });
    const sealed = await encryptHint(key, { topic: fromB64(VECTOR.topic)!, sequenceId: VECTOR.seq });
    expect(sealed.collapseId).toBe(VECTOR.collapseId);
  });
});
