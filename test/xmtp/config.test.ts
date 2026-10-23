// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BACKEND_ENV_NAMES, containerEnv, envFingerprint } from '../../xmtp/backend/src/containerEnv.js';
import { openUpstream } from '../../xmtp/backend/src/socket.js';

const root = join(__dirname, '../../xmtp');
const toml = readFileSync(join(root, 'backend/backend.toml'), 'utf8');
const live = toml.replace(/#.*$/gm, '');
const jsonc = (p: string) =>
  JSON.parse(
    readFileSync(join(root, p), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,(\s*[}\]])/g, '$1'),
  );

/** `key = value` lines of one TOML table, without a TOML library. */
function table(name: string): Record<string, string> {
  const m = new RegExp(`^\\[${name.replace(/\./g, '\\.')}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(live);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^\s*("?[^=\s]+"?)\s*=\s*(.+?)\s*$/.exec(line);
    if (kv) out[kv[1]!.replace(/"/g, '')] = kv[2]!.replace(/^"|"$/g, '');
  }
  return out;
}

describe('backend.toml (decisions 0039, 0040, 0042)', () => {
  it('names exactly the variables the container is given', () => {
    const refs = [...live.matchAll(/"env:([A-Z0-9_]+)"/g)].map((m) => m[1]).sort();
    expect([...new Set(refs)]).toEqual([...BACKEND_ENV_NAMES].sort());
  });

  it('keeps the server blind', () => {
    expect(table('server').request_logger).toBe('false');
    expect(table('server').identifier).toBe('xyz.cofferdam.xmtp');
    expect(table('telemetry').metrics_listen).toBe('');
    expect(table('auth').enabled).toBe('true');
    expect(Object.keys(table('auth.api_keys'))).toEqual(['cofferdam-app']);
  });

  it('lets phones register only the relay, never a raw APNs or FCM token', () => {
    expect(live).not.toMatch(/^\[push\.apns\]/m);
    expect(live).not.toMatch(/^\[push\.fcm\]/m);
    expect(table('push.http').allowed_domains).toBe('["push.cofferdam.xyz"]');
    expect(table('push.http').allow_private_addresses).toBe('false');
  });

  it('serves Base Sepolia and Base for the passkey account', () => {
    expect(Object.keys(table('chains')).sort()).toEqual(['eip155:8453', 'eip155:84532']);
  });

  it('agrees with the cleanup job on retention', () => {
    const r = table('retention');
    const vars = jsonc('cleanup/wrangler.jsonc').vars;
    expect(vars.RETENTION_GROUP_MESSAGE_SECONDS).toBe(r.group_message_seconds);
    expect(vars.RETENTION_WELCOME_SECONDS).toBe(r.welcome_seconds);
    expect(vars.RETENTION_KEY_PACKAGE_SECONDS).toBe(r.key_package_seconds);
    expect(table('attachments').retention_seconds).toBe(r.group_message_seconds);
  });

  it('logs nothing from the backend Worker and exposes no URL', () => {
    const cfg = jsonc('backend/wrangler.jsonc');
    expect(cfg.observability.enabled).toBe(false);
    expect(cfg.workers_dev).toBe(false);
    expect(cfg.routes).toBeUndefined();
    expect(cfg.vars.INGRESS).toBe('off');
    for (const f of readdirSync(join(root, 'backend/src'))) {
      expect(readFileSync(join(root, 'backend/src', f), 'utf8'), f).not.toMatch(/console\./);
    }
  });
});

describe('the container environment', () => {
  const full = {
    XMTP_DATABASE_URL: 'postgresql://u:p@ep-x.us-east-2.aws.neon.tech/xmtp?sslmode=require',
    XMTP_APP_API_KEY: 'k'.repeat(48),
    XMTP_RPC_BASE_SEPOLIA: 'https://sepolia.base.org',
    XMTP_RPC_BASE: 'https://mainnet.base.org',
    XMTP_R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    XMTP_R2_ACCESS_KEY_ID: 'id',
    XMTP_R2_SECRET_ACCESS_KEY: 'secret',
  };
  it('names what is missing', () => {
    expect(() => containerEnv({ ...full, XMTP_APP_API_KEY: undefined })).toThrow(/XMTP_APP_API_KEY/);
  });
  it('refuses a transaction pooler', () => {
    expect(() =>
      containerEnv({ ...full, XMTP_DATABASE_URL: 'postgresql://u:p@ep-x-pooler.us-east-2.aws.neon.tech/xmtp' }),
    ).toThrow(/direct endpoint/);
    expect(() => containerEnv({ ...full, XMTP_DATABASE_URL: 'postgresql://u:p@aws.connect.psdb.cloud:6432/xmtp' })).toThrow(
      /direct endpoint/,
    );
  });
  it('refuses sslrootcert=system, which sqlx reads as a file path', () => {
    expect(() =>
      containerEnv({ ...full, XMTP_DATABASE_URL: 'postgresql://u:p@aws-us-east-1-5.pg.psdb.cloud:5432/postgres?sslmode=verify-full&sslrootcert=system' }),
    ).toThrow(/sslrootcert=system/);
    expect(() => containerEnv({ ...full, XMTP_DATABASE_URL: 'postgresql://u:p@aws-us-east-1-5.pg.psdb.cloud:5432/postgres?sslmode=verify-full' })).not.toThrow();
  });
  it('passes a complete set through', () => {
    expect(containerEnv(full)).toEqual(full);
  });
});

describe('the ingress splice', () => {
  it('retries the container port while it boots, then gives up at the deadline', async () => {
    let attempts = 0;
    const sock = (ok: boolean) =>
      ({ opened: ok ? Promise.resolve({}) : Promise.reject(new Error('refused')) }) as unknown as Socket;
    const opened = await openUpstream(() => sock(++attempts >= 3), 10_000, async () => undefined);
    expect(attempts).toBe(3);
    expect(opened).toBeDefined();
    attempts = 0;
    await expect(openUpstream(() => sock(false), 1_000, async () => undefined)).rejects.toThrow('refused');
  });
});

describe('envFingerprint', () => {
  it('ignores key order and changes when any value changes', async () => {
    const a = await envFingerprint({ XMTP_DATABASE_URL: 'postgresql://a', XMTP_APP_API_KEY: 'k' });
    expect(await envFingerprint({ XMTP_APP_API_KEY: 'k', XMTP_DATABASE_URL: 'postgresql://a' })).toBe(a);
    expect(await envFingerprint({ XMTP_DATABASE_URL: 'postgresql://b', XMTP_APP_API_KEY: 'k' })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain('postgresql');
  });
});
