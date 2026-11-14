// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Base mainnet test relay (workspace decision 0080, M2) and the identity
 * registry's `check` pre-flight: the switches, the allowlist, the policy, the
 * L1 data fee through `preVerificationGas`, and the route's lanes. The chain
 * and wallet clients are fakes; nothing reaches a node, and no key is real.
 */

import { Hono } from 'hono';
import {
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  encodePacked,
  keccak256,
  parseAbi,
  parseTransaction,
  toBytes,
  type Address,
  type Hex,
} from 'viem';
import type * as Viem from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { Env } from '../src/env.js';
import { createAaRoutes, relayChainId, submitUserOperation, testLane, type RelayLane } from '../src/routes/aa.js';
import {
  IDENTITY_ACTIONS,
  TEST_RELAY_POLICY,
  calldataGas,
  checkTestRelayPolicy,
  effectiveGasPrice,
  registryCheckCall,
  requiredPreVerificationGas,
  testRelayConfig,
} from '../src/services/testRelay.js';
import { DEFAULT_USER_OP_POLICY, ENTRY_POINT_V07, parseUserOperationBody, type PackedUserOperationWire } from '../src/services/userOp.js';
import { ENTRY_POINT_EVENTS_ABI } from '../src/services/userOpOutcome.js';

const sepolia = vi.hoisted(() => ({ name: 'sepolia' }));
const base = vi.hoisted(() => ({
  readContract: vi.fn(),
  getBlock: vi.fn(),
  simulateContract: vi.fn(),
  simulateBlocks: vi.fn(),
  sendRawTransaction: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
}));
const wallet = vi.hoisted(() => ({ prepareTransactionRequest: vi.fn(), signTransaction: vi.fn() }));
vi.mock('../src/chain/client.js', () => ({ getBaseSepoliaClient: () => sepolia, getBaseClient: () => base }));
vi.mock('viem', async (importOriginal) => ({ ...(await importOriginal<typeof Viem>()), createWalletClient: () => wallet }));

const SENDER: Address = '0x80967a159A00dcabe2DeAF86b68249acfc45C265';
const OTHER: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const FACTORY: Address = '0x1111111111111111111111111111111111111111';
const REGISTRY: Address = '0x2222222222222222222222222222222222222222';
const ADAPTER: Address = '0x3333333333333333333333333333333333333333';
const IDENTIFIER = keccak256('0x0bad1d');
const EVIDENCE = ('0x' + 'c0ffee'.repeat(40)) as Hex;

const ON = {
  BASE_MAINNET_ENABLED: 'true',
  BASE_RPC_URL: 'http://127.0.0.1:8546',
  AA_MAINNET_TEST_RELAY: 'true',
  AA_MAINNET_TEST_ACCOUNTS: ` ${SENDER.toLowerCase()} , not-an-address`,
  BASE_MAINNET_TEST_DEPLOYMENTS: JSON.stringify({ CofferdamAccountFactory4337: { address: FACTORY }, CofferdamIdentityRegistry: REGISTRY }),
  RELAYER_MAINNET_TEST_PRIVATE_KEY: generatePrivateKey(),
};
const CONFIG = testRelayConfig(ON)!;

const pack = (a: bigint, b: bigint): Hex => encodePacked(['uint128', 'uint128'], [a, b]);
const REGISTRY_ABI = parseAbi([
  'function bind(address adapter, bytes evidence)',
  'function relink(address adapter, bytes evidence)',
  'function requestRebind(address adapter, bytes evidence)',
  'function cancelRebind(bytes32 identifier)',
  'function setPaused(bool paused)',
]);
const EXECUTE_ABI = parseAbi(['function execute(address target, uint256 value, bytes data)']);
const execute = (target: Address, data: Hex, value = 0n): Hex => encodeFunctionData({ abi: EXECUTE_ABI, functionName: 'execute', args: [target, value, data] });
const bindCall = (fn: 'bind' | 'relink' | 'requestRebind' = 'bind') =>
  execute(REGISTRY, encodeFunctionData({ abi: REGISTRY_ABI, functionName: fn, args: [ADAPTER, EVIDENCE] }));

function op(overrides: Partial<Record<string, string>> = {}): PackedUserOperationWire {
  return parseUserOperationBody({
    userOp: {
      sender: SENDER,
      nonce: '3',
      initCode: '0x',
      callData: bindCall(),
      accountGasLimits: pack(1_000_000n, 1_400_000n),
      preVerificationGas: '20000000',
      gasFees: pack(5_000_000n, 20_000_000n), // tip 0.005 gwei, max 0.02 gwei
      paymasterAndData: '0x',
      signature: '0x' + 'ab'.repeat(96),
      ...overrides,
    },
  }).userOp;
}

describe('the switches', () => {
  it('is on only with every switch, the two addresses and a non-empty allowlist', () => {
    expect(CONFIG).toEqual({ factory: FACTORY, registry: REGISTRY, accounts: new Set([SENDER.toLowerCase()]) });
    expect(testRelayConfig({ ...ON, AA_MAINNET_TEST_RELAY: '1' })).toBeNull();
    expect(testRelayConfig({ ...ON, BASE_MAINNET_ENABLED: 'false' })).toBeNull();
    expect(testRelayConfig({ ...ON, BASE_RPC_URL: '' })).toBeNull();
    expect(testRelayConfig({ ...ON, AA_MAINNET_TEST_ACCOUNTS: 'nobody' })).toBeNull();
    expect(testRelayConfig({ ...ON, BASE_MAINNET_TEST_DEPLOYMENTS: '{"CofferdamIdentityRegistry":"0x22"}' })).toBeNull();
    expect(testRelayConfig({ ...ON, BASE_MAINNET_TEST_DEPLOYMENTS: 'not json' })).toBeNull();
  });

  it('needs its own key for a lane', () => {
    expect(testLane({ ...ON } as unknown as Env, CONFIG)).toMatchObject({ chainId: 8453, rpcUrl: 'http://127.0.0.1:8546', identityRegistry: REGISTRY, opPaysL1: true });
    expect(testLane({ ...ON, RELAYER_MAINNET_TEST_PRIVATE_KEY: undefined } as unknown as Env, CONFIG)).toBeNull();
    expect(testLane({ ...ON, RELAYER_PRIVATE_KEY: generatePrivateKey(), RELAYER_MAINNET_TEST_PRIVATE_KEY: undefined } as unknown as Env, CONFIG)).toBeNull();
  });

  it('reads the body chain, Base Sepolia when it names none', () => {
    expect(relayChainId({})).toBe(84532);
    expect(relayChainId({ chainId: 8453 })).toBe(8453);
    expect(relayChainId({ chainId: '8453' })).toBe(8453);
    expect(relayChainId({ chainId: 0 })).toBeNull();
  });
});

describe('the test relay policy', () => {
  it('passes a bind, a relink, a rebind request and a cancel to the test registry, and a bare deployment', () => {
    for (const fn of ['bind', 'relink', 'requestRebind'] as const) expect(() => checkTestRelayPolicy(op({ callData: bindCall(fn) }), CONFIG)).not.toThrow();
    const cancel = execute(REGISTRY, encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'cancelRebind', args: [IDENTIFIER] }));
    expect(() => checkTestRelayPolicy(op({ callData: cancel }), CONFIG)).not.toThrow();
    expect(() => checkTestRelayPolicy(op({ callData: '0x', initCode: FACTORY + 'abcd' }), CONFIG)).not.toThrow();
  });

  it('refuses a sender off the list first, then a paymaster, another factory, any other call, value, and the caps', () => {
    expect(() => checkTestRelayPolicy(op({ sender: OTHER, paymasterAndData: '0x12' }), CONFIG)).toThrow(expect.objectContaining({ code: 'not_test_account' }));
    expect(() => checkTestRelayPolicy(op({ paymasterAndData: encodePacked(['address', 'uint128', 'uint128'], [OTHER, 1n, 1n]) }), CONFIG)).toThrow(
      expect.objectContaining({ code: 'paymaster_not_allowed' }),
    );
    expect(() => checkTestRelayPolicy(op({ initCode: OTHER + 'abcd' }), CONFIG)).toThrow(expect.objectContaining({ code: 'factory_not_ours' }));
    const refusedCalls: Hex[] = [
      '0x',
      execute(OTHER, encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'bind', args: [ADAPTER, EVIDENCE] })),
      execute(REGISTRY, encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'bind', args: [ADAPTER, EVIDENCE] }), 1n),
      execute(REGISTRY, encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'setPaused', args: [false] })),
      execute(OTHER, '0x'),
      '0xdeadbeef',
    ];
    for (const callData of refusedCalls) expect(() => checkTestRelayPolicy(op({ callData }), CONFIG)).toThrow(expect.objectContaining({ code: 'call_not_allowed' }));
    expect(() => checkTestRelayPolicy(op({ accountGasLimits: pack(1n, 2_000_000n) }), CONFIG)).toThrow(expect.objectContaining({ code: 'gas_limit_exceeded' }));
    expect(() => checkTestRelayPolicy(op({ gasFees: pack(1n, 2_000_000_000n) }), CONFIG)).toThrow(expect.objectContaining({ code: 'fee_too_high' }));
    expect(() => checkTestRelayPolicy(op({ preVerificationGas: '59000000', gasFees: pack(1n, 1_000_000_000n) }), CONFIG)).toThrow(
      expect.objectContaining({ code: 'prefund_too_high' }),
    );
    expect(TEST_RELAY_POLICY.maxCallGas).toBeGreaterThan(1_166_315n);
  });
});

describe("the registry's check pre-flight call", () => {
  it('takes bind, relink and requestRebind with the registry tags, nothing else', () => {
    expect(registryCheckCall(bindCall(), REGISTRY)).toEqual({ action: keccak256(toBytes('cofferdam-identity-bind-v1')), adapter: ADAPTER, evidence: EVIDENCE });
    expect(registryCheckCall(bindCall('relink'), REGISTRY)?.action).toBe(IDENTITY_ACTIONS.relink);
    expect(registryCheckCall(bindCall('requestRebind'), REGISTRY)?.action).toBe(keccak256(toBytes('cofferdam-identity-rebind-v1')));
    expect(registryCheckCall(bindCall(), OTHER)).toBeNull();
    expect(registryCheckCall(execute(REGISTRY, encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'cancelRebind', args: [IDENTIFIER] })), REGISTRY)).toBeNull();
    expect(registryCheckCall('0x', REGISTRY)).toBeNull();
  });
});

describe('the L1 data fee', () => {
  it('charges it at the op price with a quarter margin, plus calldata gas and the intrinsic gas', () => {
    expect(calldataGas('0x00ff00')).toBe(24n);
    expect(effectiveGasPrice(op(), 10_000_000n)).toBe(15_000_000n);
    expect(effectiveGasPrice(op(), 100_000_000n)).toBe(20_000_000n);
    // 0.00006 ETH of L1 fee at 0.015 gwei is 4,000,000 gas; plus 25%, the calldata and the intrinsic 21,000.
    expect(requiredPreVerificationGas(60_000_000_000_000n, 15_000_000n, '0x00ff')).toBe(5_000_000n + 20n + 21_000n);
    expect(requiredPreVerificationGas(1n, 0n, '0x')).toBeNull();
  });
});

describe('submitUserOperation on the mainnet test lane', () => {
  let warn: MockInstance<typeof console.warn>;
  const env = { ...ON } as unknown as Env;
  const lane = testLane(env, CONFIG)!;
  const RAW = '0x02f86d0101' as Hex;
  const opEvent = (success: boolean) => ({
    address: ENTRY_POINT_V07,
    topics: encodeEventTopics({ abi: ENTRY_POINT_EVENTS_ABI, eventName: 'UserOperationEvent', args: { userOpHash: keccak256('0x01'), sender: SENDER, paymaster: '0x0000000000000000000000000000000000000000' } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [3n, success, 1n, 1n]),
  });
  const identifierBound = encodeErrorResult({
    abi: parseAbi(['error IdentifierAlreadyBound(bytes32 identifier, address account)']),
    errorName: 'IdentifierAlreadyBound',
    args: [IDENTIFIER, OTHER],
  });

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    base.readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
      functionName === 'check' ? [IDENTIFIER, '0x0000000000000000000000000000000000000000'] : 30_000_000_000_000n, // L1 fee 0.00003 ETH
    );
    base.getBlock.mockResolvedValue({ baseFeePerGas: 10_000_000n });
    base.simulateContract.mockImplementation(async ({ abi, functionName, args }: { abi: unknown; functionName: string; args: unknown }) => ({
      request: { abi, functionName, args, address: ENTRY_POINT_V07 },
    }));
    base.simulateBlocks.mockResolvedValue([{ calls: [{ status: 'success', logs: [opEvent(true)], data: '0x', gasUsed: 1n }] }]);
    base.sendRawTransaction.mockResolvedValue(keccak256(RAW));
    base.waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [opEvent(true)] });
    wallet.prepareTransactionRequest.mockResolvedValue({});
    wallet.signTransaction.mockResolvedValue(RAW);
  });
  afterEach(() => {
    vi.resetAllMocks();
    warn.mockRestore();
  });

  it("relays a bind through the registry's check, the L1 fee and the pre-flight, signing at the op's price", async () => {
    await expect(submitUserOperation(env, op(), undefined, 10, lane)).resolves.toEqual({ txHash: keccak256(RAW), receipt: 'success' });
    expect(base.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: REGISTRY, functionName: 'check', args: [IDENTITY_ACTIONS.bind, SENDER, ADAPTER, EVIDENCE] }),
    );
    expect(wallet.prepareTransactionRequest).toHaveBeenCalledWith(expect.objectContaining({ maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 5_000_000n }));
    // The L1 fee is priced on the unsigned handleOps transaction at the op's fees.
    const l1Call = base.readContract.mock.calls.map(([a]) => a as { functionName: string; args: [Hex] }).find((a) => a.functionName === 'getL1Fee')!;
    expect(parseTransaction(l1Call.args[0])).toMatchObject({ chainId: 8453, to: ENTRY_POINT_V07.toLowerCase(), maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 5_000_000n });
  });

  it('refuses a bind the registry refuses, by the error name only, before any simulation', async () => {
    base.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'check') throw new ContractFunctionRevertedError({ abi: [], data: identifierBound, functionName: 'check' });
      return 1n;
    });
    const admit = vi.fn(async () => {});
    await expect(submitUserOperation(env, op(), admit, 10, lane)).rejects.toMatchObject({ code: 'identity_check_failed', message: 'IdentifierAlreadyBound' });
    expect(base.simulateContract).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
    const logged = warn.mock.calls.flat().join('\n').toLowerCase();
    expect(logged).toContain('identifieralreadybound');
    expect(logged).not.toContain(IDENTIFIER.slice(2));
    expect(logged).not.toContain(OTHER.slice(2).toLowerCase());
  });

  it('answers preflight_unavailable when the registry cannot be read', async () => {
    base.readContract.mockRejectedValue(new Error('fetch failed'));
    await expect(submitUserOperation(env, op(), undefined, 10, lane)).rejects.toMatchObject({ code: 'preflight_unavailable' });
  });

  it('refuses an op whose preVerificationGas does not repay the L1 fee, naming the least value, and SDK ops at 0', async () => {
    // 0.00003 ETH × 1.25 at 0.015 gwei = 2,500,000 gas, plus calldata and overhead.
    await expect(submitUserOperation(env, op({ preVerificationGas: '2000000' }), undefined, 10, lane)).rejects.toMatchObject({
      code: 'pre_verification_gas_too_low',
      message: expect.stringMatching(/at least \d+/),
    });
    await expect(submitUserOperation(env, op({ preVerificationGas: '0' }), undefined, 10, lane)).rejects.toMatchObject({ code: 'pre_verification_gas_too_low' });
    expect(base.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('refuses a price under the base fee, and takes the SDK-shaped price of 1.2 times it', async () => {
    base.getBlock.mockResolvedValue({ baseFeePerGas: 20_000_001n });
    await expect(submitUserOperation(env, op(), undefined, 10, lane)).rejects.toMatchObject({ code: 'fee_too_low' });
    // The SDK packs eth_gasPrice as both fees: Base mainnet read 6,000,000 against a 5,000,000 base fee (2026-11-13).
    base.getBlock.mockResolvedValue({ baseFeePerGas: 5_000_000n });
    const sdkShaped = op({ gasFees: pack(6_000_000n, 6_000_000n), preVerificationGas: '20000000' });
    await expect(submitUserOperation(env, sdkShaped, undefined, 10, lane)).resolves.toMatchObject({ receipt: 'success' });
    expect(effectiveGasPrice(sdkShaped, 5_000_000n)).toBe(6_000_000n);
  });

  it('skips the check for a call with no evidence (a deployment)', async () => {
    await submitUserOperation(env, op({ callData: '0x', initCode: FACTORY + 'abcd' }), undefined, 10, lane);
    expect(base.readContract).not.toHaveBeenCalledWith(expect.objectContaining({ functionName: 'check' }));
  });
});

describe('POST /v1/aa/user-operation on chain 8453', () => {
  const policy = { ...DEFAULT_USER_OP_POLICY, paymaster: OTHER, factory: OTHER };
  const wire = (o: PackedUserOperationWire) => ({
    ...o,
    nonce: o.nonce.toString(),
    preVerificationGas: o.preVerificationGas.toString(),
  });
  function harness(env: Record<string, unknown>) {
    const keys: string[] = [];
    const lanes: RelayLane[] = [];
    const rl = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }) };
    const h = new Hono<{ Bindings: Env }>();
    h.route(
      '/v1/aa',
      createAaRoutes({
        policy,
        submit: async (_e, _op, admit, lane) => {
          await admit();
          lanes.push(lane);
          return { txHash: '0xbeef', receipt: 'success' };
        },
      }),
    );
    const post = (body: unknown) =>
      h.request(
        '/v1/aa/user-operation',
        { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' }, body: JSON.stringify(body) },
        { AA_RELAY_RL: rl, AA_RELAY_IP_RL: rl, ...env } as unknown as Env,
      );
    return { keys, lanes, post };
  }

  it('refuses 8453 while any switch is off, and any other chain, after the global brake only', async () => {
    for (const env of [{}, { ...ON, AA_MAINNET_TEST_RELAY: 'false' }, { ...ON, BASE_MAINNET_ENABLED: undefined }]) {
      const h = harness(env);
      const res = await h.post({ chainId: 8453, userOp: wire(op()) });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'chain_unsupported' });
      expect(h.keys).toEqual(['aa:global']);
    }
    const other = harness(ON);
    expect((await other.post({ chainId: 1, userOp: wire(op()) })).status).toBe(400);
  });

  it('answers 403 to a sender off the list and 503 without the test key', async () => {
    const h = harness(ON);
    const off = await h.post({ chainId: 8453, userOp: wire(op({ sender: OTHER })) });
    expect(off.status).toBe(403);
    expect(await off.json()).toMatchObject({ error: 'not_test_account' });
    const noKey = harness({ ...ON, RELAYER_MAINNET_TEST_PRIVATE_KEY: undefined, RELAYER_PRIVATE_KEY: generatePrivateKey() });
    const res = await noKey.post({ chainId: 8453, userOp: wire(op()) });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'relayer_not_configured' });
  });

  it('relays an allowlisted op on the test lane with its own bucket', async () => {
    const h = harness(ON);
    const res = await h.post({ chainId: 8453, userOp: wire(op()) });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, chainId: 8453, receipt: 'success' });
    expect(h.lanes[0]).toMatchObject({ chainId: 8453, identityRegistry: REGISTRY, opPaysL1: true });
    expect(h.keys).toEqual(['aa:global', 'aa-ip:203.0.113.7', `aa-test:${SENDER.toLowerCase()}`]);
  });

  it('keeps an op that names no chain on Base Sepolia, under the Sepolia policy, with every switch on', async () => {
    const h = harness({ ...ON, RELAYER_PRIVATE_KEY: generatePrivateKey() });
    const res = await h.post({ userOp: wire(op()) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'paymaster_required' });
  });
});
