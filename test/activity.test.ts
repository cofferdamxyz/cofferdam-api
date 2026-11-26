// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/env.js';
import { activityRoutes, requestedToken } from '../src/routes/activity.js';
import {
  checkActivity,
  findActivityToken,
  getActivity,
  portalUrlFor,
  type ActivityToken,
} from '../src/services/activity.js';
import type { LogReader, TransferLog } from '../src/services/activityScan.js';
import type { ActivityStore, StoredTransfer } from '../src/services/activityStore.js';

describe('portalUrlFor', () => {
  const sepolia = 'https://portal.sqd.dev/datasets/base-sepolia';
  const mainnet = 'https://portal.sqd.dev/datasets/base-mainnet';

  it('uses the per-chain default without an override', () => {
    expect(portalUrlFor(84532)).toBe(sepolia);
    expect(portalUrlFor(8453)).toBe(mainnet);
  });

  it('applies the override only to the chain whose dataset it names', () => {
    const cloudSepolia = 'https://cloud.example/portal/datasets/base-sepolia';
    expect(portalUrlFor(84532, cloudSepolia)).toBe(cloudSepolia);
    // The deployed Sepolia value must never serve a mainnet request.
    expect(portalUrlFor(8453, sepolia)).toBe(mainnet);
    expect(portalUrlFor(8453, 'https://cloud.example/portal/datasets/base-mainnet')).toBe(
      'https://cloud.example/portal/datasets/base-mainnet',
    );
  });

  it('falls back to Sepolia for an unknown chain', () => {
    expect(portalUrlFor(1)).toBe(sepolia);
    expect(portalUrlFor(1, mainnet)).toBe(sepolia);
  });
});

const ME = '0x' + 'a'.repeat(40);
const OTHER = '0x' + 'b'.repeat(40);
const MOCK_USDC = '0x8c05Df95F91De2D70e0436B774fc9D1f86FF1f51';
const PBRL = '0x9762f60740142cF11C0F32C6e24cd3e86016C0f2';
const BRS = '0x0000006238e3C7797Ae71827da303560bae1B125';

const sepoliaToken = (address: string) => findActivityToken(84532, address)!;

/** A store that records its reads and serves only what it was given, per token. */
function fakeStore(rows: StoredTransfer[]) {
  const reads: string[] = [];
  const store: ActivityStore = {
    record: () => Promise.reject(new Error('not in these tests')),
    list: (_chainId, _address, token, limit, toBlock) => {
      reads.push(`list:${token}`);
      return Promise.resolve(
        rows
          .filter((r) => r.token === token.toLowerCase() && (toBlock == null || r.blockNumber <= toBlock))
          .sort((a, b) => b.blockNumber - a.blockNumber)
          .slice(0, limit),
      );
    },
    latestBlock: (_chainId, _address, token) => {
      reads.push(`latest:${token}`);
      return Promise.resolve(Math.max(0, ...rows.filter((r) => r.token === token.toLowerCase()).map((r) => r.blockNumber)));
    },
  };
  return { store, reads };
}

function stored(block: number, token: string, value: string): StoredTransfer {
  return { hash: '0x' + block.toString(16).padStart(64, '0'), logIndex: 0, blockNumber: block, timestamp: block, from: OTHER, to: ME, value, token: token.toLowerCase() };
}

/** A log reader per token that remembers which token it was built for. */
function fakeReaders(byToken: Record<string, TransferLog[]>, head: number) {
  const tokens: string[] = [];
  const logReader = (token: ActivityToken): LogReader => {
    tokens.push(token.address);
    const logs = byToken[token.address.toLowerCase()] ?? [];
    return {
      head: () => Promise.resolve(head),
      transfers: (from, to) => Promise.resolve(logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to)),
    };
  };
  return { logReader, tokens };
}

function log(block: number, value: bigint): TransferLog {
  return { hash: '0x' + block.toString(16).padStart(64, '0'), logIndex: 0, blockNumber: block, timestamp: block, from: OTHER, to: ME, value };
}

describe('activity tokens', () => {
  it('no token: Sepolia USDC from the store, 6 decimals, as before', async () => {
    const { store, reads } = fakeStore([stored(1_000, MOCK_USDC, '2500000'), stored(990, PBRL, '1')]);
    const { logReader, tokens } = fakeReaders({}, 1_010);
    const r = await getActivity(undefined, ME, 1, undefined, 84532, { store, indexFromBlock: 500, logReader });
    expect(reads).toEqual([`list:${MOCK_USDC}`, `latest:${MOCK_USDC}`]);
    expect(tokens).toEqual([]);
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0]).toMatchObject({ blockNumber: 1_000, value: '2500000', valueFormatted: 2.5, tokenAddress: MOCK_USDC.toLowerCase(), direction: 'in' });
    expect(r.headBlock).toBe(1_000);
    const check = await checkActivity(undefined, ME, 999, 84532, { store, indexFromBlock: 500, logReader });
    expect(check).toEqual({ hasNew: true, latestBlock: 1_000 });
  });

  it('pBRL on Sepolia: scanned, never read from the store, 18 decimals', async () => {
    const { store, reads } = fakeStore([stored(1_000, MOCK_USDC, '2500000')]);
    const { logReader, tokens } = fakeReaders({ [PBRL.toLowerCase()]: [log(995, 1_500_000_000_000_000_000n)] }, 1_010);
    const token = sepoliaToken(PBRL);
    const r = await getActivity(undefined, ME, 10, undefined, 84532, { store, indexFromBlock: 500, logReader, token }, undefined);
    expect(reads).toEqual([]);
    expect(tokens.every((t) => t === PBRL)).toBe(true);
    expect(r.transactions).toHaveLength(1);
    // The USDC row in the store never shows up in a pBRL answer.
    expect(r.transactions[0]).toMatchObject({ blockNumber: 995, value: '1500000000000000000', valueFormatted: 1.5, tokenAddress: PBRL.toLowerCase() });
    expect(r.headBlock).toBe(1_010);

    const check = await checkActivity(undefined, ME, 990, 84532, { store, indexFromBlock: 500, logReader, token });
    expect(reads).toEqual([]);
    expect(check).toEqual({ hasNew: true, latestBlock: 1_010 });
  });

  it('BRS on mainnet: Portal queries the BRS contract and formats with its decimals', async () => {
    const bodies: Array<{ logs: Array<{ address: string[] }> }> = [];
    const padded = '0x' + ME.slice(2).padStart(64, '0');
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/timestamps/')) return Promise.resolve(new Response(JSON.stringify({ block_number: 100 })));
      bodies.push(JSON.parse(String(init?.body)) as { logs: Array<{ address: string[] }> });
      if (bodies.length > 1) return Promise.resolve(new Response(null, { status: 204 }));
      const block = {
        header: { number: 150, timestamp: 1_800_000_000 },
        logs: [{ address: BRS.toLowerCase(), topics: ['0x', '0x' + OTHER.slice(2).padStart(64, '0'), padded], data: '0x' + (12_340_000n).toString(16), logIndex: 1, transactionHash: '0x' + 'cd'.repeat(32) }],
      };
      return Promise.resolve(new Response(JSON.stringify(block) + '\n'));
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const r = await getActivity(undefined, ME, 10, undefined, 8453, { token: findActivityToken(8453, BRS)! });
      expect(bodies[0]!.logs.map((l) => l.address)).toEqual([[BRS.toLowerCase()], [BRS.toLowerCase()]]);
      expect(r.transactions[0]).toMatchObject({ value: '12340000', valueFormatted: 12.34, tokenAddress: BRS.toLowerCase(), direction: 'in' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the route answers 400 unsupported_token for a token off the chain’s table, before any read', async () => {
    const env = {} as Env;
    for (const q of [
      `token=${'0x' + 'c'.repeat(40)}`,
      `token=${BRS}`, // mainnet's BRS is not a Sepolia token
      `chainId=8453&token=${PBRL}`, // nor pBRL a mainnet one
      'token=pBRL',
    ]) {
      for (const path of ['/', '/check']) {
        const res = await activityRoutes.request(`${path}?address=${ME}&${q}`, undefined, env);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ ok: false, error: 'unsupported_token' });
      }
    }
  });

  it('requestedToken: absent is the chain’s USDC; any case of a table address is that token', () => {
    expect(requestedToken(84532, undefined)?.address).toBe(MOCK_USDC);
    expect(requestedToken(8453, undefined)?.symbol).toBe('USDC');
    expect(requestedToken(84532, PBRL.toUpperCase().replace('0X', '0x'))).toMatchObject({ address: PBRL, decimals: 18 });
    expect(requestedToken(8453, BRS)).toMatchObject({ address: BRS, decimals: 6 });
    expect(requestedToken(84532, BRS)).toBeNull();
  });
});

describe('POST /webhooks/cdp', () => {
  const SECRET = 'whsec_test_secret';

  async function sign(body: string, t: number): Promise<string> {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${body}`)));
    return `t=${t},v0=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  }

  it('records a webhook-fed token’s transfer for both sides and ignores pBRL’s', async () => {
    const recorded: Array<[string, string]> = [];
    const namespace = {
      getByName: (name: string) => ({
        record: (t: StoredTransfer) => {
          recorded.push([name, t.token]);
          return Promise.resolve(true);
        },
      }),
    };
    const env = { CDP_WEBHOOK_SECRET: SECRET, ACTIVITY_DO: namespace } as unknown as Env;
    const base = {
      block_number: 1_000,
      event_name: 'Transfer',
      log_index: 0,
      network: 'base-sepolia',
      parameters: { from: OTHER, to: ME, value: '1000000' },
      timestamp: '2026-11-26T12:00:00Z',
      transaction_hash: '0x' + 'ab'.repeat(32),
    };
    const body = JSON.stringify([
      { ...base, contract_address: MOCK_USDC.toLowerCase() },
      { ...base, log_index: 1, contract_address: PBRL.toLowerCase() },
    ]);
    const res = await activityRoutes.request(
      '/webhooks/cdp',
      { method: 'POST', body, headers: { 'x-hook0-signature': await sign(body, Math.floor(Date.now() / 1000)) } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recorded: 2, ignored: 1 });
    expect(recorded.map(([name]) => name).sort()).toEqual([`84532:${ME}`, `84532:${OTHER}`]);
    expect(recorded.every(([, token]) => token === MOCK_USDC.toLowerCase())).toBe(true);
  });
});
