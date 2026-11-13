// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The relay's own submission (`submitUserOperation`) against fake chain and wallet clients: a failed
 * simulation or send attempt is logged with the op's bigint nonce and keeps its meaning. Until
 * 2026-10-30 the log line threw on that bigint, so every failed attempt answered `relay_failed` "Do not
 * know how to serialize a BigInt", hiding the node's own error and skipping the retry.
 */

import {
  BaseError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodePacked,
  keccak256,
  type Address,
  type Hex,
} from 'viem';
import type * as Viem from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { Env } from '../src/env.js';
import { UserOpSubmitError, submitUserOperation } from '../src/routes/aa.js';
import { ENTRY_POINT_ABI, ENTRY_POINT_V07, parseUserOperationBody } from '../src/services/userOp.js';
import { ENTRY_POINT_EVENTS_ABI } from '../src/services/userOpOutcome.js';

const chain = vi.hoisted(() => ({
  simulateContract: vi.fn(),
  simulateBlocks: vi.fn(),
  sendRawTransaction: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
}));
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

const OP_HASH = keccak256('0x01');
/** The EntryPoint's `UserOperationEvent` for an op of `sender` and `nonce`. */
const opEvent = (success: boolean, sender: Address = SENDER, nonce = 26n) => ({
  address: ENTRY_POINT_V07,
  topics: encodeEventTopics({ abi: ENTRY_POINT_EVENTS_ABI, eventName: 'UserOperationEvent', args: { userOpHash: OP_HASH, sender, paymaster: SENDER } }),
  data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [nonce, success, 1n, 1n]),
});
/** Its `UserOperationRevertReason`, carrying `reason`. */
const revertEvent = (reason: Hex) => ({
  address: ENTRY_POINT_V07,
  topics: encodeEventTopics({ abi: ENTRY_POINT_EVENTS_ABI, eventName: 'UserOperationRevertReason', args: { userOpHash: OP_HASH, sender: SENDER } }),
  data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [26n, reason]),
});
/** The decision 0080 registry's refusal, which carries the passport's identifier. */
const IDENTIFIER = keccak256('0x0bad1d');
const identifierBound = encodeErrorResult({
  abi: [{ type: 'error', name: 'IdentifierAlreadyBound', inputs: [{ type: 'bytes32' }, { type: 'address' }] }],
  errorName: 'IdentifierAlreadyBound',
  args: [IDENTIFIER, SENDER],
});
const simulated = (logs: unknown[], status: 'success' | 'failure' = 'success', error?: Error) => [
  { calls: [{ status, logs, data: '0x', gasUsed: 1n, ...(error ? { error } : {}) }] },
];

let warn: MockInstance<typeof console.warn>;
const logged = () => warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  chain.simulateContract.mockResolvedValue({
    request: { abi: ENTRY_POINT_ABI, functionName: 'handleOps', args: [[op], SENDER], address: ENTRY_POINT_V07 },
  });
  chain.simulateBlocks.mockResolvedValue(simulated([opEvent(true)]));
  chain.waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [opEvent(true)] });
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
    await expect(submitUserOperation(env, op)).resolves.toEqual({ txHash: keccak256(RAW), receipt: 'success' });
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

describe('submitUserOperation: the execution pre-flight and the op\'s own outcome (decision 0080)', () => {
  it('refuses an op whose own call reverts, by the error name only, with nothing admitted or sent', async () => {
    chain.simulateBlocks.mockResolvedValue(simulated([revertEvent(identifierBound), opEvent(false)]));
    const admit = vi.fn(async () => {});
    const failure = submitUserOperation(env, op, admit);
    await expect(failure).rejects.toMatchObject({ code: 'execution_reverted', message: 'IdentifierAlreadyBound' });
    expect(admit).not.toHaveBeenCalled();
    expect(chain.sendRawTransaction).not.toHaveBeenCalled();
    expect(logged()).toEqual([{ event: 'aa_execution_reverted', sender: SENDER, nonce: '26', reason: 'IdentifierAlreadyBound' }]);
    expect(warn.mock.calls.flat().join('\n')).not.toContain(IDENTIFIER.slice(2));
  });

  it('pre-flights from the relayer through eth_simulateV1 with the handleOps calldata', async () => {
    chain.sendRawTransaction.mockResolvedValue(keccak256(RAW));
    await submitUserOperation(env, op);
    const [{ blocks }] = chain.simulateBlocks.mock.calls[0] as [{ blocks: { calls: { to: Address; data: Hex }[] }[] }];
    expect(blocks[0]!.calls[0]!.to).toBe(ENTRY_POINT_V07);
    expect(blocks[0]!.calls[0]!.data.slice(0, 10)).toBe('0x765e827f'); // handleOps
  });

  it('refuses an op the EntryPoint did not execute, and a handleOps the pre-flight sees revert', async () => {
    chain.simulateBlocks.mockResolvedValue(simulated([opEvent(true, SENDER, 27n)]));
    await expect(submitUserOperation(env, op)).rejects.toMatchObject({ code: 'execution_reverted', message: 'not_executed' });
    chain.simulateBlocks.mockResolvedValue(simulated([], 'failure', new BaseError('execution reverted')));
    await expect(submitUserOperation(env, op)).rejects.toMatchObject({ code: 'simulation_failed' });
    expect(chain.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('fails closed when the node cannot simulate', async () => {
    chain.simulateBlocks.mockRejectedValue(Object.assign(new BaseError('RPC error'), { details: 'the method eth_simulateV1 does not exist/is not available' }));
    await expect(submitUserOperation(env, op)).rejects.toMatchObject({ code: 'preflight_unavailable', message: 'eth_simulateV1 unsupported' });
    expect(chain.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('answers user_op_reverted with the tx hash when the mined op reverted', async () => {
    chain.sendRawTransaction.mockResolvedValue(keccak256(RAW));
    chain.waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [revertEvent(identifierBound), opEvent(false)] });
    const failure = submitUserOperation(env, op);
    await expect(failure).rejects.toMatchObject({ code: 'user_op_reverted', message: 'IdentifierAlreadyBound', txHash: keccak256(RAW) });
    expect(logged()).toEqual([
      { event: 'aa_user_op_reverted', sender: SENDER, nonce: '26', txHash: keccak256(RAW), reason: 'IdentifierAlreadyBound' },
    ]);
  });

  it('answers pending when the receipt does not come in time', async () => {
    chain.sendRawTransaction.mockResolvedValue(keccak256(RAW));
    chain.waitForTransactionReceipt.mockRejectedValue(new BaseError('Timed out while waiting for transaction'));
    await expect(submitUserOperation(env, op, undefined, 10)).resolves.toEqual({ txHash: keccak256(RAW), receipt: 'pending' });
    expect(chain.waitForTransactionReceipt).toHaveBeenCalledWith(expect.objectContaining({ hash: keccak256(RAW), timeout: 10 }));
  });
});
