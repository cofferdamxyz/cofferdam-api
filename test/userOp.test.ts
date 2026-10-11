// Copyright (c) 2026 Cofferdam Inc
// SPDX-License-Identifier: Apache-2.0

/** The UserOperation relay: parsing, policy and the route against a fake submitter. */

import { describe, expect, it } from 'vitest';
import { encodePacked, type Address, type Hex } from 'viem';

import type { Env } from '../src/env.js';
import { UserOpSubmitError, createAaRoutes } from '../src/routes/aa.js';
import {
  DEFAULT_USER_OP_POLICY,
  ENTRY_POINT_V07,
  checkUserOperationPolicy,
  parseUserOperationBody,
  unpackGasFees,
  unpackGasLimits,
  unpackPaymasterAndData,
} from '../src/services/userOp.js';

const PAYMASTER: Address = '0x5ffb8bA851DCf7A592B85fc2567e72449214204e';
const FACTORY: Address = '0x35CeBf87f5DAE7be7cf755067d30fC65Fa541F3D';
const SENDER: Address = '0x80967a159A00dcabe2DeAF86b68249acfc45C265';
const policy = { ...DEFAULT_USER_OP_POLICY, paymaster: PAYMASTER, factory: FACTORY };

const pack = (a: bigint, b: bigint): Hex => encodePacked(['uint128', 'uint128'], [a, b]);
const pmData = (paymaster: Address = PAYMASTER): Hex =>
  encodePacked(['address', 'uint128', 'uint128'], [paymaster, 1_500_000n, 100_000n]);

function wireOp(overrides: Partial<Record<string, string>> = {}) {
  return {
    sender: SENDER,
    nonce: '0',
    initCode: '0x',
    callData: '0x1234',
    accountGasLimits: pack(1_500_000n, 1_500_000n),
    preVerificationGas: '0',
    gasFees: pack(1_000_000n, 11_000_000n),
    paymasterAndData: pmData(),
    signature: '0x' + 'ab'.repeat(96),
    ...overrides,
  };
}

describe('parseUserOperationBody', () => {
  it('parses decimal and hex bigints and checksums the sender', () => {
    const { entryPoint, userOp } = parseUserOperationBody({ userOp: wireOp({ nonce: '0x1a', preVerificationGas: '42' }) });
    expect(entryPoint).toBe(ENTRY_POINT_V07);
    expect(userOp.nonce).toBe(26n);
    expect(userOp.preVerificationGas).toBe(42n);
    expect(userOp.sender).toBe(SENDER);
  });
  it('rejects another entry point and malformed fields', () => {
    expect(() => parseUserOperationBody({ entryPoint: SENDER, userOp: wireOp() })).toThrow(/EntryPoint v0.7/);
    expect(() => parseUserOperationBody({ userOp: wireOp({ accountGasLimits: '0x00' }) })).toThrow(/32 bytes/);
    expect(() => parseUserOperationBody({ userOp: wireOp({ nonce: '-1' }) })).toThrow(/nonce/);
    expect(() => parseUserOperationBody({ userOp: wireOp({ sender: 'nope' }) })).toThrow(/address/);
  });
});

describe('packing helpers', () => {
  it('unpack the v0.7 bytes32 pairs and paymasterAndData', () => {
    expect(unpackGasLimits(pack(7n, 9n))).toEqual({ verificationGasLimit: 7n, callGasLimit: 9n });
    expect(unpackGasFees(pack(1n, 2n))).toEqual({ maxPriorityFeePerGas: 1n, maxFeePerGas: 2n });
    expect(unpackPaymasterAndData(pmData())).toEqual({ paymaster: PAYMASTER, verificationGasLimit: 1_500_000n, postOpGasLimit: 100_000n });
    expect(unpackPaymasterAndData('0x')).toBeNull();
  });
});

describe('checkUserOperationPolicy', () => {
  const parse = (o: Partial<Record<string, string>>) => parseUserOperationBody({ userOp: wireOp(o) }).userOp;
  it('accepts a sponsored op from our factory', () => {
    expect(() => checkUserOperationPolicy(parse({ initCode: FACTORY + 'ab'.repeat(40) }), policy)).not.toThrow();
  });
  it('refuses an unsponsored op, a foreign paymaster and a foreign factory', () => {
    expect(() => checkUserOperationPolicy(parse({ paymasterAndData: '0x' }), policy)).toThrow(/sponsored/);
    expect(() => checkUserOperationPolicy(parse({ paymasterAndData: pmData(SENDER) }), policy)).toThrow(/not the Cofferdam paymaster/);
    expect(() => checkUserOperationPolicy(parse({ initCode: SENDER + 'ab'.repeat(40) }), policy)).toThrow(/factory/);
  });
  it('caps gas, fees and the prefund', () => {
    expect(() => checkUserOperationPolicy(parse({ accountGasLimits: pack(6_000_000n, 1n) }), policy)).toThrow(/verificationGasLimit/);
    expect(() => checkUserOperationPolicy(parse({ gasFees: pack(1n, 20_000_000_000n) }), policy)).toThrow(/maxFeePerGas/);
    expect(() => checkUserOperationPolicy(parse({ accountGasLimits: pack(4_000_000n, 4_000_000n), gasFees: pack(1n, 10_000_000_000n) }), policy)).toThrow(/prefund/);
  });
});

describe('POST /v1/aa/user-operation', () => {
  const env = (overrides: Partial<Env> = {}) => ({ RELAYER_PRIVATE_KEY: '0x' + '11'.repeat(32), ...overrides }) as unknown as Env;
  const app = (submit: (env: Env, op: unknown) => Promise<Hex>) => {
    const h = new (require('hono').Hono)();
    h.route('/v1/aa', createAaRoutes({ policy, submit: submit as never }));
    return h;
  };
  const post = (h: ReturnType<typeof app>, body: unknown, e = env()) =>
    h.request('/v1/aa/user-operation', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, e);

  it('relays a good op and answers 202 with the tx hash', async () => {
    const seen: unknown[] = [];
    const res = await post(app(async (_e, op) => { seen.push(op); return '0xbeef'; }), { userOp: wireOp() });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, txHash: '0xbeef', entryPoint: ENTRY_POINT_V07 });
    expect((seen[0] as { sender: string }).sender).toBe(SENDER);
  });
  it('maps policy, simulation, relay and configuration failures', async () => {
    const h = app(async () => { throw new UserOpSubmitError('simulation_failed', 'FailedOp: AA14 initCode must return sender'); });
    expect((await post(h, { userOp: wireOp({ paymasterAndData: '0x' }) })).status).toBe(400);
    const sim = await post(h, { userOp: wireOp() });
    expect(sim.status).toBe(400);
    expect(await sim.json()).toMatchObject({ error: 'simulation_failed', message: expect.stringContaining('AA14') });
    const relay = app(async () => { throw new UserOpSubmitError('relay_failed', 'nonce too low'); });
    expect((await post(relay, { userOp: wireOp() })).status).toBe(502);
    expect((await post(h, { userOp: wireOp() }, env({ RELAYER_PRIVATE_KEY: undefined }))).status).toBe(503);
    expect((await post(h, 'not json' as unknown)).status).toBe(400);
  });
});
