// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { parseCdpTransfer, recordAddresses, verifyCdpSignature } from '../src/services/activityStore.js';

const SECRET = 'whsec_test_secret';
const MOCK_USDC = '0x8c05Df95F91De2D70e0436B774fc9D1f86FF1f51';
const tokenFor = (chainId: number) => (chainId === 84532 ? MOCK_USDC : null);

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

  it('records a mint for the recipient only, a payment for both sides', () => {
    const mint = parseCdpTransfer(event, tokenFor)!.transfer;
    expect(recordAddresses(mint)).toEqual(['0xbb5238708557943af8348edc7ffaaca15c751c53']);
    const pay = parseCdpTransfer({ ...event, parameters: { ...event.parameters, from: '0x' + 'd'.repeat(40) } }, tokenFor)!.transfer;
    expect(recordAddresses(pay).sort()).toEqual(['0x' + 'd'.repeat(40), '0xbb5238708557943af8348edc7ffaaca15c751c53'].sort());
  });
});
