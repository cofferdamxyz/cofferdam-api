// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { ACTIVITY_TOKENS, isWebhookFedToken } from '../src/services/activity.js';
import {
  insertTransfer,
  latestTransferBlock,
  listTransfers,
  migrateActivityTable,
  parseCdpTransfer,
  recordAddresses,
  verifyCdpSignature,
  type ActivitySql,
  type StoredTransfer,
} from '../src/services/activityStore.js';

const SECRET = 'whsec_test_secret';
const MOCK_USDC = '0x8c05Df95F91De2D70e0436B774fc9D1f86FF1f51';
const PBRL = '0x9762f60740142cF11C0F32C6e24cd3e86016C0f2';
/** The route's predicate: the table's webhook-fed tokens. */
const tokenFor = isWebhookFedToken;

async function sign(body: string, t: number, secret = SECRET): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${body}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `t=${t},v0=${hex},h=content-type x-event-id,v1=deadbeef`;
}

const event = {
  block_number: 48172596,
  contract_address: MOCK_USDC.toLowerCase(),
  event_name: 'Transfer',
  event_signature: 'Transfer(address,address,uint256)',
  log_index: 3,
  network: 'base-sepolia',
  parameters: {
    from: '0x0000000000000000000000000000000000000000',
    to: '0xBB5238708557943AF8348eDc7ffAaca15C751c53',
    value: '500000000',
  },
  timestamp: '2026-10-15T23:10:00Z',
  transaction_from: '0x' + '1'.repeat(40),
  transaction_to: MOCK_USDC,
  transaction_hash: '0x' + 'ab'.repeat(32),
};

describe('verifyCdpSignature', () => {
  const body = JSON.stringify(event);
  const now = 1_792_000_000;

  it('accepts a v0 signature over {t}.{body}', async () => {
    expect(await verifyCdpSignature(body, await sign(body, now), SECRET, now)).toBe(true);
  });

  it('refuses a changed body, a wrong secret, a missing header and a stale timestamp', async () => {
    const header = await sign(body, now);
    expect(await verifyCdpSignature(body + ' ', header, SECRET, now)).toBe(false);
    expect(await verifyCdpSignature(body, await sign(body, now, 'other'), SECRET, now)).toBe(false);
    expect(await verifyCdpSignature(body, null, SECRET, now)).toBe(false);
    expect(await verifyCdpSignature(body, header, SECRET, now + 301)).toBe(false);
    expect(await verifyCdpSignature(body, header, SECRET, now - 301)).toBe(false);
  });
});

describe('parseCdpTransfer', () => {
  it('decodes a MockUSDC Transfer at the top level or under data', () => {
    for (const payload of [event, { id: 'e1', type: 'onchain.activity.detected', data: event }]) {
      const parsed = parseCdpTransfer(payload, tokenFor);
      expect(parsed?.chainId).toBe(84532);
      expect(parsed?.transfer).toMatchObject({
        blockNumber: 48172596,
        logIndex: 3,
        to: '0xbb5238708557943af8348edc7ffaaca15c751c53',
        value: '500000000',
        timestamp: Date.parse('2026-10-15T23:10:00Z') / 1000,
      });
    }
  });

  it('ignores other contracts, networks and events, and unsafe amounts', () => {
    expect(parseCdpTransfer({ ...event, contract_address: '0x' + 'c'.repeat(40) }, tokenFor)).toBeNull();
    expect(parseCdpTransfer({ ...event, network: 'ethereum-mainnet' }, tokenFor)).toBeNull();
    expect(parseCdpTransfer({ ...event, event_name: 'Approval' }, tokenFor)).toBeNull();
    expect(parseCdpTransfer({ ...event, parameters: { ...event.parameters, value: 2 ** 60 } }, tokenFor)).toBeNull();
    expect(parseCdpTransfer({ ...event, parameters: { ...event.parameters, value: 637064239 } }, tokenFor)?.transfer.value).toBe('637064239');
  });

  it('accepts a webhook-fed token of the table and ignores the others, pBRL included', () => {
    expect(parseCdpTransfer(event, tokenFor)?.transfer.token).toBe(MOCK_USDC.toLowerCase());
    // pBRL is in the table but no webhook feeds it: ignored until its flag flips.
    expect(parseCdpTransfer({ ...event, contract_address: PBRL.toLowerCase() }, tokenFor)).toBeNull();
    // Mainnet USDC is not webhook-fed either.
    expect(parseCdpTransfer({ ...event, network: 'base-mainnet', contract_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }, tokenFor)).toBeNull();
    // Once a token is marked webhook-fed, the parser takes it as it is.
    const withPbrl = (chainId: number, contract: string) => tokenFor(chainId, contract) || (chainId === 84532 && contract === PBRL.toLowerCase());
    expect(parseCdpTransfer({ ...event, contract_address: PBRL }, withPbrl)?.transfer.token).toBe(PBRL.toLowerCase());
  });

  it('records a mint for the recipient only, a payment for both sides', () => {
    const mint = parseCdpTransfer(event, tokenFor)!.transfer;
    expect(recordAddresses(mint)).toEqual(['0xbb5238708557943af8348edc7ffaaca15c751c53']);
    const pay = parseCdpTransfer({ ...event, parameters: { ...event.parameters, from: '0x' + 'd'.repeat(40) } }, tokenFor)!.transfer;
    expect(recordAddresses(pay).sort()).toEqual(['0x' + 'd'.repeat(40), '0xbb5238708557943af8348edc7ffaaca15c751c53'].sort());
  });
});

/** `node:sqlite` behind the slice of `ctx.storage.sql` the record uses. */
function sqlite(): ActivitySql {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query, ...bindings) {
      const rows = db.prepare(query).all(...(bindings as (string | number | null)[])) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
}

function transfer(block: number, token: string, logIndex = 0): StoredTransfer {
  return {
    hash: '0x' + block.toString(16).padStart(64, '0'),
    logIndex,
    blockNumber: block,
    timestamp: block,
    from: '0x' + 'd'.repeat(40),
    to: '0x' + 'e'.repeat(40),
    value: '1000000',
    token: token.toLowerCase(),
  };
}

describe('the record’s SQL, on node:sqlite', () => {
  it('lists and dates per token: a USDC row never answers for pBRL', () => {
    const sql = sqlite();
    migrateActivityTable(sql);
    expect(insertTransfer(sql, transfer(100, MOCK_USDC))).toBe(true);
    expect(insertTransfer(sql, transfer(100, MOCK_USDC))).toBe(false);
    expect(insertTransfer(sql, transfer(90, PBRL))).toBe(true);

    expect(listTransfers(sql, MOCK_USDC, 10, null).map((t) => t.blockNumber)).toEqual([100]);
    expect(listTransfers(sql, PBRL, 10, null).map((t) => [t.blockNumber, t.token])).toEqual([[90, PBRL.toLowerCase()]]);
    expect(latestTransferBlock(sql, MOCK_USDC)).toBe(100);
    expect(latestTransferBlock(sql, PBRL)).toBe(90);
    expect(listTransfers(sql, PBRL, 10, 89)).toEqual([]);
  });

  it('keeps serving rows written before reads were per token', () => {
    const sql = sqlite();
    // The table as the object created it before this change: same columns, the old index only.
    sql.exec(
      `CREATE TABLE transfers (id TEXT PRIMARY KEY, hash TEXT NOT NULL, log_index INTEGER NOT NULL, block INTEGER NOT NULL,
         ts INTEGER NOT NULL, from_addr TEXT NOT NULL, to_addr TEXT NOT NULL, value TEXT NOT NULL, token TEXT NOT NULL)`,
    );
    const old = transfer(200, MOCK_USDC);
    sql.exec(
      'INSERT INTO transfers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      `${old.hash}:0`, old.hash, 0, 200, 200, old.from, old.to, old.value, MOCK_USDC.toLowerCase(),
    );
    migrateActivityTable(sql);
    expect(listTransfers(sql, MOCK_USDC.toUpperCase().replace('0X', '0x'), 10, null).map((t) => t.blockNumber)).toEqual([200]);
    expect(listTransfers(sql, PBRL, 10, null)).toEqual([]);
  });

  it('the table names one webhook-fed token, MockUSDC, on Base Sepolia', () => {
    const fed = Object.entries(ACTIVITY_TOKENS).flatMap(([chainId, tokens]) =>
      tokens.filter((t) => t.webhookFed).map((t) => `${chainId}:${t.address}`),
    );
    expect(fed).toEqual([`84532:${MOCK_USDC}`]);
  });
});
