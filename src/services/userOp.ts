// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * ERC-4337 UserOperation relay — the pure half (`routes/aa.ts` is the HTTP
 * half). The app signs a `PackedUserOperation` with its passkey and POSTs it
 * here; the plane's relayer key submits `EntryPoint.handleOps` and is refunded
 * from the paymaster's deposit. A not-yet-deployed account arrives with
 * `initCode`, so the first sponsored op is the deployment (decision 0012).
 *
 * Policy, before anything is simulated or sent:
 *   - the paymaster named in `paymasterAndData` is ours (we only front gas
 *     the Cofferdam paymaster refunds);
 *   - `initCode`, when present, starts with our factory;
 *   - gas limits and fees stay under caps, so one op cannot drain the deposit.
 * The EntryPoint enforces the rest (signature, nonce, AA14 sender/initCode).
 */

import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';

/** Canonical EntryPoint v0.7 (preinstalled on Base). */
export const ENTRY_POINT_V07: Address = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';

/** Packed operation as the SDK signs it (bigints parsed from decimal strings). */
export interface PackedUserOperationWire {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

export class UserOpRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UserOpRequestError';
  }
}

export interface UserOpPolicy {
  /** `CofferdamPaymaster` — the only paymaster this relayer fronts gas for. */
  paymaster: Address;
  /** `CofferdamAccountFactory4337` — the only factory an `initCode` may name. */
  factory: Address;
  maxVerificationGas: bigint;
  maxCallGas: bigint;
  maxPreVerificationGas: bigint;
  /** Cap on `maxFeePerGas` (wei). */
  maxFeePerGas: bigint;
  /** Cap on the paymaster's prefund for one op (wei): Σ gas limits × maxFeePerGas. */
  maxPrefund: bigint;
}

/** Permissive testnet caps: a deployment op is ~3.5M gas at a few Mwei. */
export const DEFAULT_USER_OP_POLICY: Omit<UserOpPolicy, 'paymaster' | 'factory'> = {
  maxVerificationGas: 5_000_000n,
  maxCallGas: 5_000_000n,
  maxPreVerificationGas: 1_000_000n,
  maxFeePerGas: 10_000_000_000n, // 10 gwei
  maxPrefund: 2_000_000_000_000_000n, // 0.002 ETH
};

const ABI = {
  entryPoint: [
    {
      type: 'function',
      name: 'handleOps',
      stateMutability: 'nonpayable',
      inputs: [
        {
          name: 'ops',
          type: 'tuple[]',
          components: [
            { name: 'sender', type: 'address' },
            { name: 'nonce', type: 'uint256' },
            { name: 'initCode', type: 'bytes' },
            { name: 'callData', type: 'bytes' },
            { name: 'accountGasLimits', type: 'bytes32' },
            { name: 'preVerificationGas', type: 'uint256' },
            { name: 'gasFees', type: 'bytes32' },
            { name: 'paymasterAndData', type: 'bytes' },
            { name: 'signature', type: 'bytes' },
          ],
        },
        { name: 'beneficiary', type: 'address' },
      ],
      outputs: [],
    },
    {
      type: 'error',
      name: 'FailedOp',
      inputs: [
        { name: 'opIndex', type: 'uint256' },
        { name: 'reason', type: 'string' },
      ],
    },
    {
      type: 'error',
      name: 'FailedOpWithRevert',
      inputs: [
        { name: 'opIndex', type: 'uint256' },
        { name: 'reason', type: 'string' },
        { name: 'inner', type: 'bytes' },
      ],
    },
  ],
} as const;

/** `handleOps` + the EntryPoint's failure errors, for simulation and submission. */
export const ENTRY_POINT_ABI = ABI.entryPoint;

function bigintField(v: unknown, name: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^(0x[0-9a-fA-F]+|\d+)$/.test(v)) return BigInt(v);
  throw new UserOpRequestError('bad_user_op', `${name}: expected a non-negative integer (decimal or 0x hex)`);
}

function hexField(v: unknown, name: string, bytes?: number): Hex {
  if (typeof v !== 'string' || !isHex(v, { strict: true })) {
    throw new UserOpRequestError('bad_user_op', `${name}: expected 0x-prefixed hex`);
  }
  if (bytes !== undefined && (v.length - 2) / 2 !== bytes) {
    throw new UserOpRequestError('bad_user_op', `${name}: expected ${bytes} bytes`);
  }
  return v as Hex;
}

function addressField(v: unknown, name: string): Address {
  if (typeof v !== 'string' || !isAddress(v)) {
    throw new UserOpRequestError('bad_user_op', `${name}: expected an address`);
  }
  return getAddress(v);
}

/** Parse `{ entryPoint?, userOp }`. Throws `UserOpRequestError('bad_user_op' | 'bad_entry_point')`. */
export function parseUserOperationBody(body: unknown): { entryPoint: Address; userOp: PackedUserOperationWire } {
  if (!body || typeof body !== 'object') throw new UserOpRequestError('bad_user_op', 'body must be a JSON object');
  const b = body as Record<string, unknown>;
  const entryPoint = b.entryPoint === undefined ? ENTRY_POINT_V07 : addressField(b.entryPoint, 'entryPoint');
  if (entryPoint !== ENTRY_POINT_V07) {
    throw new UserOpRequestError('bad_entry_point', `only EntryPoint v0.7 (${ENTRY_POINT_V07}) is relayed`);
  }
  const op = b.userOp;
  if (!op || typeof op !== 'object') throw new UserOpRequestError('bad_user_op', 'userOp must be an object');
  const o = op as Record<string, unknown>;
  return {
    entryPoint,
    userOp: {
      sender: addressField(o.sender, 'sender'),
      nonce: bigintField(o.nonce, 'nonce'),
      initCode: hexField(o.initCode, 'initCode'),
      callData: hexField(o.callData, 'callData'),
      accountGasLimits: hexField(o.accountGasLimits, 'accountGasLimits', 32),
      preVerificationGas: bigintField(o.preVerificationGas, 'preVerificationGas'),
      gasFees: hexField(o.gasFees, 'gasFees', 32),
      paymasterAndData: hexField(o.paymasterAndData, 'paymasterAndData'),
      signature: hexField(o.signature, 'signature'),
    },
  };
}

/** v0.7 packs two uint128 into a bytes32: high half first. */
function unpackPair(packed: Hex): [bigint, bigint] {
  const hex = packed.slice(2);
  return [BigInt('0x' + hex.slice(0, 32)), BigInt('0x' + hex.slice(32, 64))];
}

export function unpackGasLimits(accountGasLimits: Hex): { verificationGasLimit: bigint; callGasLimit: bigint } {
  const [verificationGasLimit, callGasLimit] = unpackPair(accountGasLimits);
  return { verificationGasLimit, callGasLimit };
}

export function unpackGasFees(gasFees: Hex): { maxPriorityFeePerGas: bigint; maxFeePerGas: bigint } {
  const [maxPriorityFeePerGas, maxFeePerGas] = unpackPair(gasFees);
  return { maxPriorityFeePerGas, maxFeePerGas };
}

/** `paymasterAndData` = paymaster (20) ++ verificationGas (16) ++ postOpGas (16) ++ data. */
export function unpackPaymasterAndData(
  paymasterAndData: Hex,
): { paymaster: Address; verificationGasLimit: bigint; postOpGasLimit: bigint } | null {
  const hex = paymasterAndData.slice(2);
  if (hex.length < 104) return null;
  return {
    paymaster: getAddress('0x' + hex.slice(0, 40)),
    verificationGasLimit: BigInt('0x' + hex.slice(40, 72)),
    postOpGasLimit: BigInt('0x' + hex.slice(72, 104)),
  };
}

/** Refuse anything the relayer should not front gas for. Throws `UserOpRequestError`. */
export function checkUserOperationPolicy(op: PackedUserOperationWire, policy: UserOpPolicy): void {
  const pm = unpackPaymasterAndData(op.paymasterAndData);
  if (!pm) throw new UserOpRequestError('paymaster_required', 'the op must be sponsored by the Cofferdam paymaster');
  if (pm.paymaster !== getAddress(policy.paymaster)) {
    throw new UserOpRequestError('paymaster_not_ours', `paymaster ${pm.paymaster} is not the Cofferdam paymaster`);
  }
  if (op.initCode !== '0x') {
    if (op.initCode.length < 42) throw new UserOpRequestError('bad_user_op', 'initCode shorter than a factory address');
    const factory = getAddress(op.initCode.slice(0, 42));
    if (factory !== getAddress(policy.factory)) {
      throw new UserOpRequestError('factory_not_ours', `initCode factory ${factory} is not the Cofferdam factory`);
    }
  }
  const { verificationGasLimit, callGasLimit } = unpackGasLimits(op.accountGasLimits);
  const { maxFeePerGas } = unpackGasFees(op.gasFees);
  if (verificationGasLimit > policy.maxVerificationGas) throw new UserOpRequestError('gas_limit_exceeded', 'verificationGasLimit over cap');
  if (callGasLimit > policy.maxCallGas) throw new UserOpRequestError('gas_limit_exceeded', 'callGasLimit over cap');
  if (op.preVerificationGas > policy.maxPreVerificationGas) throw new UserOpRequestError('gas_limit_exceeded', 'preVerificationGas over cap');
  if (maxFeePerGas > policy.maxFeePerGas) throw new UserOpRequestError('fee_too_high', 'maxFeePerGas over cap');
  const prefund =
    (verificationGasLimit + callGasLimit + op.preVerificationGas + pm.verificationGasLimit + pm.postOpGasLimit) * maxFeePerGas;
  if (prefund > policy.maxPrefund) throw new UserOpRequestError('prefund_too_high', 'the op would prefund more than the per-op cap');
}
