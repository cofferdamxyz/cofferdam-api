// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The relay's own submission (`submitUserOperation`) against fake chain and wallet clients: a failed
 * simulation or send attempt is logged with the op's bigint nonce and keeps its meaning. Until
 * 2026-10-30 the log line threw on that bigint, so every failed attempt answered `relay_failed` "Do not
 * know how to serialize a BigInt", hiding the node's own error and skipping the retry.
 */

import { BaseError, encodePacked, keccak256, type Address, type Hex } from 'viem';
import type * as Viem from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { Env } from '../src/env.js';
import { UserOpSubmitError, submitUserOperation } from '../src/routes/aa.js';
import { ENTRY_POINT_ABI, ENTRY_POINT_V07, parseUserOperationBody } from '../src/services/userOp.js';

const chain = vi.hoisted(() => ({ simulateContract: vi.fn(), sendRawTransaction: vi.fn() }));
const wallet = vi.hoisted(() => ({ prepareTransactionRequest: vi.fn(), signTransaction: vi.fn() }));

vi.mock('../src/chain/client.js', () => ({ getBaseSepoliaClient: () => chain }));
vi.mock('viem', async (importOriginal) => ({ ...(await importOriginal<typeof Viem>()), createWalletClient: () => wallet }));

const RAW = '0x02f86d0101' as Hex;
const SENDER: Address = '0x80967a159A00dcabe2DeAF86b68249acfc45C265';
const pack = (a: bigint, b: bigint): Hex => encodePacked(['uint128', 'uint128'], [a, b]);

const { userOp: op } = parseUserOperationBody({
  userOp: {
    sender: SENDER,
    nonce: '26',
    initCode: '0x',
    callData: '0x1234',
    accountGasLimits: pack(1_500_000n, 1_500_000n),
    preVerificationGas: '0',
    gasFees: pack(1_000_000n, 11_000_000n),
    paymasterAndData: encodePacked(['address', 'uint128', 'uint128'], [SENDER, 1_500_000n, 100_000n]),
    signature: '0x' + 'ab'.repeat(96),
  },
});
const env = { RELAYER_PRIVATE_KEY: generatePrivateKey(), BASE_SEPOLIA_RPC_URL: 'http://127.0.0.1:9' } as unknown as Env;
const nodeError = (details: string) => Object.assign(new Error('HTTP request failed.'), { details });

let warn: MockInstance<typeof console.warn>;
const logged = () => warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  chain.simulateContract.mockResolvedValue({
    request: { abi: ENTRY_POINT_ABI, functionName: 'handleOps', args: [[op], SENDER], address: ENTRY_POINT_V07 },
  });
  wallet.prepareTransactionRequest.mockResolvedValue({});
  wallet.signTransaction.mockResolvedValue(RAW);
});

afterEach(() => {
  vi.resetAllMocks();
  warn.mockRestore();
});

describe('submitUserOperation with the op nonce a bigint', () => {
  it('logs a refused send attempt and retries it', async () => {
    chain.sendRawTransaction.mockRejectedValueOnce(nodeError('429 Too Many Requests')).mockResolvedValueOnce(keccak256(RAW));
    await expect(submitUserOperation(env, op)).resolves.toBe(keccak256(RAW));
    expect(chain.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(logged()).toEqual([
      { event: 'aa_send_refused', sender: SENDER, nonce: '26', attempt: 1, class: 'transient', reason: '429 Too Many Requests' },
    ]);
  });

  it("answers relay_failed with the node's own error once the send is refused for good", async () => {
    chain.sendRawTransaction.mockRejectedValue(nodeError('insufficient funds for gas * price + value'));
    const failure = submitUserOperation(env, op);
    await expect(failure).rejects.toBeInstanceOf(UserOpSubmitError);
    await expect(failure).rejects.toMatchObject({ code: 'relay_failed', message: 'insufficient funds for gas * price + value' });
    expect(logged()).toMatchObject([{ event: 'aa_send_refused', nonce: '26', class: 'fatal' }]);
  });

  it('answers simulation_failed for a failed simulation, logged, with nothing admitted or sent', async () => {
    chain.simulateContract.mockRejectedValue(new BaseError('execution reverted'));
    const admit = vi.fn(async () => {});
    const failure = submitUserOperation(env, op, admit);
    await expect(failure).rejects.toBeInstanceOf(UserOpSubmitError);
    await expect(failure).rejects.toMatchObject({ code: 'simulation_failed' });
    expect(admit).not.toHaveBeenCalled();
    expect(chain.sendRawTransaction).not.toHaveBeenCalled();
    expect(logged()).toMatchObject([{ event: 'aa_simulation_failed', sender: SENDER, nonce: '26' }]);
  });
});
