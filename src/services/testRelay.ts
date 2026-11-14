// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Base mainnet test relay of workspace decision 0080, milestone M2: the
 * pure half (`routes/aa.ts` is the HTTP half). It relays the throwaway test
 * generation's ops on chain 8453 for the founder's real bind and re-bind, and
 * nothing of it serves a real user.
 *
 * Off unless every switch is on (`testRelayConfig`): Base mainnet reads
 * (`BASE_MAINNET_ENABLED` with `BASE_RPC_URL`), `AA_MAINNET_TEST_RELAY="true"`,
 * the test generation's addresses in `BASE_MAINNET_TEST_DEPLOYMENTS` (never the
 * plane's defaults, decision 0080 (2)) and a non-empty allowlist,
 * `AA_MAINNET_TEST_ACCOUNTS`. Its key, `RELAYER_MAINNET_TEST_PRIVATE_KEY`, is
 * checked by the route.
 *
 * The ops are unsponsored: the account prefunds the EntryPoint, which repays
 * the relayer for execution and for `preVerificationGas`. Base's L1 data fee
 * falls on the relayer's transaction, so the op's `preVerificationGas` must
 * cover it (`requiredPreVerificationGas`); the SDK's
 * `preVerificationGas: 'l1-fee'` estimates it, and its default 0 is refused.
 */

import { decodeFunctionData, getAddress, isAddress, keccak256, serializeTransaction, toBytes, type Address, type Hex } from 'viem';

import { mainnetEnabled, type ChainEnv } from '../chain/chains.js';
import { ENTRY_POINT_V07, UserOpRequestError, unpackGasFees, unpackGasLimits, type PackedUserOperationWire } from './userOp.js';

/** The vars the test relay reads (a subset of `Env`). */
export interface TestRelayEnv extends ChainEnv {
  AA_MAINNET_TEST_RELAY?: string;
  AA_MAINNET_TEST_ACCOUNTS?: string;
  BASE_MAINNET_TEST_DEPLOYMENTS?: string;
}

/** The test generation the relay serves, read from the env. */
export interface TestRelayConfig {
  /** The test generation's `CofferdamAccountFactory4337`: the only factory an `initCode` may name. */
  readonly factory: Address;
  /** The test generation's `CofferdamIdentityRegistry`: the only target an op may call. */
  readonly registry: Address;
  /** Lower-cased senders the relay serves. */
  readonly accounts: ReadonlySet<string>;
}

/** `BASE_MAINNET_TEST_DEPLOYMENTS`: the names of `base-contracts/deployments/*.json`, addresses only. */
function testDeployments(raw: string | undefined): { factory: Address; registry: Address } | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const entry = (name: string): Address | null => {
    const v = (parsed as Record<string, unknown> | null)?.[name];
    const address = v && typeof v === 'object' ? (v as { address?: unknown }).address : v;
    return typeof address === 'string' && isAddress(address) ? getAddress(address) : null;
  };
  const factory = entry('CofferdamAccountFactory4337');
  const registry = entry('CofferdamIdentityRegistry');
  return factory && registry ? { factory, registry } : null;
}

/** The test relay's configuration, or null while any switch is off or any address is missing. */
export function testRelayConfig(env: TestRelayEnv): TestRelayConfig | null {
  if (!mainnetEnabled(env) || env.AA_MAINNET_TEST_RELAY !== 'true') return null;
  const deployments = testDeployments(env.BASE_MAINNET_TEST_DEPLOYMENTS);
  if (!deployments) return null;
  const accounts = new Set(
    (env.AA_MAINNET_TEST_ACCOUNTS ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter((a) => isAddress(a))
      .map((a) => a.toLowerCase()),
  );
  if (accounts.size === 0) return null;
  return { ...deployments, accounts };
}

/**
 * Caps for one bind or re-bind (a bind measured 1,166,315 gas on the
 * Base-mainnet fork, 2026-11-09). The account pays; the caps bound what one op
 * can take from it and what the relayer fronts before the EntryPoint repays it.
 */
export const TEST_RELAY_POLICY = {
  maxVerificationGas: 3_000_000n,
  maxCallGas: 1_500_000n,
  /** Gas units; a bind's L1 fee at Base's low L2 prices needs millions. */
  maxPreVerificationGas: 60_000_000n,
  /** Cap on `maxFeePerGas` (wei): 1 gwei, a hundred times Base's usual base fee. */
  maxFeePerGas: 1_000_000_000n,
  /** Cap on the account's prefund for one op (wei): Σ gas limits × `maxFeePerGas`. */
  maxPrefund: 2_000_000_000_000_000n, // 0.002 ETH
} as const;

/** The registry calls the relay carries for the test generation. */
const REGISTRY_ABI = [
  { type: 'function', name: 'bind', stateMutability: 'nonpayable', inputs: [{ name: 'adapter', type: 'address' }, { name: 'evidence', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'relink', stateMutability: 'nonpayable', inputs: [{ name: 'adapter', type: 'address' }, { name: 'evidence', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'requestRebind', stateMutability: 'nonpayable', inputs: [{ name: 'adapter', type: 'address' }, { name: 'evidence', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'cancelRebind', stateMutability: 'nonpayable', inputs: [{ name: 'identifier', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'finalizeRebind', stateMutability: 'nonpayable', inputs: [{ name: 'identifier', type: 'bytes32' }], outputs: [] },
] as const;

const ACCOUNT_EXECUTE_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

/** `CofferdamIdentityRegistry.check(action, account, adapter, evidence)`, the pre-flight view. */
export const IDENTITY_REGISTRY_CHECK_ABI = [
  {
    type: 'function',
    name: 'check',
    stateMutability: 'view',
    inputs: [
      { name: 'action', type: 'bytes32' },
      { name: 'account', type: 'address' },
      { name: 'adapter', type: 'address' },
      { name: 'evidence', type: 'bytes' },
    ],
    outputs: [
      { name: 'identifier', type: 'bytes32' },
      { name: 'counterpart', type: 'address' },
    ],
  },
] as const;

/** The registry's action tags (`CofferdamIdentityRegistry.BIND`, `REBIND`, `RELINK`). */
export const IDENTITY_ACTIONS = {
  bind: keccak256(toBytes('cofferdam-identity-bind-v1')),
  requestRebind: keccak256(toBytes('cofferdam-identity-rebind-v1')),
  relink: keccak256(toBytes('cofferdam-identity-relink-v1')),
} as const;

/** What an op's `callData` asks of the account: nothing (a deployment), or one call. */
type DecodedCall =
  | { kind: 'none' }
  | { kind: 'execute'; target: Address; value: bigint; data: Hex }
  | { kind: 'other' };

function decodeAccountCall(callData: Hex): DecodedCall {
  if (callData === '0x') return { kind: 'none' };
  try {
    const { args } = decodeFunctionData({ abi: ACCOUNT_EXECUTE_ABI, data: callData });
    return { kind: 'execute', target: getAddress(args[0]), value: args[1], data: args[2] };
  } catch {
    return { kind: 'other' };
  }
}

/** A registry call whose evidence `check` can pre-flight: its action tag, the adapter and the evidence. */
export interface RegistryCheckCall {
  readonly action: Hex;
  readonly adapter: Address;
  readonly evidence: Hex;
}

/**
 * The `check` pre-flight an op's call to `registry` needs, or null: `bind`,
 * `relink` and `requestRebind` take evidence `check` runs; every other call,
 * and any call elsewhere, has none.
 */
export function registryCheckCall(callData: Hex, registry: Address): RegistryCheckCall | null {
  const call = decodeAccountCall(callData);
  if (call.kind !== 'execute' || call.target !== getAddress(registry)) return null;
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: REGISTRY_ABI, data: call.data });
  } catch {
    return null;
  }
  if (decoded.functionName !== 'bind' && decoded.functionName !== 'relink' && decoded.functionName !== 'requestRebind') return null;
  const [adapter, evidence] = decoded.args as readonly [Address, Hex];
  return { action: IDENTITY_ACTIONS[decoded.functionName], adapter: getAddress(adapter), evidence };
}

/**
 * The test relay's policy, before anything is simulated. Throws
 * `UserOpRequestError`: `not_test_account` (the route answers 403), then
 * `paymaster_not_allowed`, `factory_not_ours`, `call_not_allowed`,
 * `gas_limit_exceeded`, `fee_too_high`, `prefund_too_high`.
 */
export function checkTestRelayPolicy(op: PackedUserOperationWire, config: TestRelayConfig): void {
  if (!config.accounts.has(op.sender.toLowerCase())) {
    throw new UserOpRequestError('not_test_account', 'the Base mainnet test relay serves allowlisted test accounts only');
  }
  if (op.paymasterAndData !== '0x') {
    throw new UserOpRequestError('paymaster_not_allowed', 'the test relay takes unsponsored ops only: paymasterAndData must be empty');
  }
  if (op.initCode !== '0x') {
    if (op.initCode.length < 42) throw new UserOpRequestError('bad_user_op', 'initCode shorter than a factory address');
    if (getAddress(op.initCode.slice(0, 42)) !== config.factory) {
      throw new UserOpRequestError('factory_not_ours', 'initCode does not name the test generation factory');
    }
  }
  const call = decodeAccountCall(op.callData);
  const allowed =
    (call.kind === 'none' && op.initCode !== '0x') ||
    (call.kind === 'execute' && call.target === config.registry && call.value === 0n && callsRegistry(call.data));
  if (!allowed) {
    throw new UserOpRequestError(
      'call_not_allowed',
      'the test relay carries a deployment or one call to the test registry (bind, relink, requestRebind, cancelRebind, finalizeRebind) with no value',
    );
  }
  const { verificationGasLimit, callGasLimit } = unpackGasLimits(op.accountGasLimits);
  const { maxFeePerGas } = unpackGasFees(op.gasFees);
  const p = TEST_RELAY_POLICY;
  if (verificationGasLimit > p.maxVerificationGas) throw new UserOpRequestError('gas_limit_exceeded', 'verificationGasLimit over cap');
  if (callGasLimit > p.maxCallGas) throw new UserOpRequestError('gas_limit_exceeded', 'callGasLimit over cap');
  if (op.preVerificationGas > p.maxPreVerificationGas) throw new UserOpRequestError('gas_limit_exceeded', 'preVerificationGas over cap');
  if (maxFeePerGas > p.maxFeePerGas) throw new UserOpRequestError('fee_too_high', 'maxFeePerGas over cap');
  const prefund = (verificationGasLimit + callGasLimit + op.preVerificationGas) * maxFeePerGas;
  if (prefund > p.maxPrefund) throw new UserOpRequestError('prefund_too_high', 'the op would prefund more than the per-op cap');
}

function callsRegistry(data: Hex): boolean {
  try {
    decodeFunctionData({ abi: REGISTRY_ABI, data });
    return true;
  } catch {
    return false;
  }
}

/** OP Stack's GasPriceOracle predeploy: `getL1Fee` of an unsigned transaction, the fee Base charges its sender. */
export const GAS_PRICE_ORACLE: Address = '0x420000000000000000000000000000000000000F';
export const GAS_PRICE_ORACLE_ABI = [
  {
    type: 'function',
    name: 'getL1Fee',
    stateMutability: 'view',
    inputs: [{ name: '_data', type: 'bytes' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/**
 * The unsigned `handleOps` transaction `getL1Fee` prices: EIP-1559 on Base
 * mainnet to the EntryPoint at the op's own fees, as the relayer signs it. The
 * nonce and the gas limit are stand-ins; they move the size by a byte or two.
 */
export function unsignedHandleOpsTx(data: Hex, op: PackedUserOperationWire): Hex {
  const { maxFeePerGas, maxPriorityFeePerGas } = unpackGasFees(op.gasFees);
  return serializeTransaction({
    type: 'eip1559',
    chainId: 8453,
    nonce: 0,
    to: ENTRY_POINT_V07,
    data,
    gas: 5_000_000n,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
}

/**
 * Margin on the L1 fee: the L1 base fee may move between the check and the
 * block. The SDK's `preVerificationGas: 'l1-fee'` estimates at 137.5% of the
 * same `getL1Fee` (branch `zkp-sdk`), so its ops clear this check with 10% to
 * spare.
 */
const L1_FEE_MARGIN_PERCENT = 125n;

/** The transaction's intrinsic gas, which no op accounts for (the SDK adds the same). */
const INTRINSIC_GAS = 21_000n;

/** Calldata gas (EIP-2028): 4 per zero byte, 16 per other byte. */
export function calldataGas(data: Hex): bigint {
  let gas = 0n;
  for (let i = 2; i < data.length; i += 2) gas += data.slice(i, i + 2) === '00' ? 4n : 16n;
  return gas;
}

/** The price the EntryPoint charges the op at: `min(maxFeePerGas, maxPriorityFeePerGas + basefee)`. */
export function effectiveGasPrice(op: PackedUserOperationWire, baseFee: bigint): bigint {
  const { maxFeePerGas, maxPriorityFeePerGas } = unpackGasFees(op.gasFees);
  const tip = maxPriorityFeePerGas + baseFee;
  return tip < maxFeePerGas ? tip : maxFeePerGas;
}

/**
 * The least `preVerificationGas` that repays the relayer what no op accounts
 * for: the L1 data fee with its margin, at the op's own price, plus the
 * transaction's calldata gas and its intrinsic 21,000, the SDK's own sum. The
 * EntryPoint's few thousand gas of loop outside any op stay the relayer's.
 * Null when the op's price is zero (nothing would repay the relayer).
 */
export function requiredPreVerificationGas(l1FeeWei: bigint, price: bigint, handleOpsData: Hex): bigint | null {
  if (price <= 0n) return null;
  const l1 = (l1FeeWei * L1_FEE_MARGIN_PERCENT + 99n) / 100n;
  return (l1 + price - 1n) / price + calldataGas(handleOpsData) + INTRINSIC_GAS;
}
