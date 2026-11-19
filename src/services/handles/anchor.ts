// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The plane's side of `CofferdamHandleAnchor` (workspace decision 0086, rule 3;
 * base-contracts `contracts/handles/CofferdamHandleAnchor.sol`): reading a
 * record, and sending the calls the registrar relays. The registrar is a hot key
 * on the plane (`HANDLE_REGISTRAR_KEY`, the founder's `wrangler secret put`; no
 * session reads it), on the anchor's Safe-owned registrar list.
 *
 * ASSUMPTION(0086 ruling P): the registrar key also pays the gas of the calls it
 * relays (one secret, one hot key, never the M2 test relayer key and never
 * `RELAYER_PRIVATE_KEY`, whose nonce the AA relay owns). Its signatures are in
 * the calldata anyway, so sending from it reveals nothing more. A separate relay
 * key is a later choice under 0017's key table.
 *
 * Everything here goes through the `AnchorChain` interface, so the routes, the
 * relay and the tests share it; `rpcAnchorChain` is the deployed one.
 */

import { BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

import { chainRpcUrl } from '../../chain/chains.js';
import type { Env } from '../../env.js';
import { sendWithRetry } from '../relaySend.js';
import { HANDLES_CHAIN_ID } from './config.js';

const bytes32 = { type: 'bytes32' } as const;

/** The anchor's ABI, the functions the plane calls. */
export const HANDLE_ANCHOR_ABI = [
  {
    type: 'function',
    name: 'recordOf',
    stateMutability: 'view',
    inputs: [{ name: 'handleId', ...bytes32 }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'owner', type: 'address' },
          { name: 'serial', type: 'uint32' },
          { name: 'nonce', type: 'uint64' },
          { name: 'frozenUntil', type: 'uint48' },
          { name: 'releasedAt', type: 'uint48' },
          { name: 'pendingReadyAt', type: 'uint48' },
          { name: 'pendingKind', type: 'uint8' },
          { name: 'quarantineWaived', type: 'bool' },
          { name: 'pendingNonce', type: 'uint64' },
          { name: 'pendingOwner', type: 'address' },
          { name: 'metaAddress', type: 'bytes' },
          { name: 'pendingMetaAddress', type: 'bytes' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'handleId', ...bytes32 },
      { name: 'handleOwner', type: 'address' },
      { name: 'metaAddress', type: 'bytes' },
      { name: 'deadline', type: 'uint64' },
      { name: 'registrarSig', type: 'bytes' },
      { name: 'ownerSig', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'release',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'handleId', ...bytes32 },
      { name: 'deadline', type: 'uint64' },
      { name: 'ownerSig', type: 'bytes' },
    ],
    outputs: [],
  },
  { type: 'function', name: 'applyChange', stateMutability: 'nonpayable', inputs: [{ name: 'handleId', ...bytes32 }], outputs: [] },
  {
    type: 'function',
    name: 'advance',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'handleId', ...bytes32 },
      { name: 'newOwner', type: 'address' },
      { name: 'newMetaAddress', type: 'bytes' },
      { name: 'deadline', type: 'uint64' },
      { name: 'ownerSig', type: 'bytes' },
      { name: 'newOwnerSig', type: 'bytes' },
      { name: 'registrarSig', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'hold',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'handleId', ...bytes32 },
      { name: 'deadline', type: 'uint64' },
      { name: 'registrarSig', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'renewHold',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'handleId', ...bytes32 },
      { name: 'frozenUntil', type: 'uint64' },
      { name: 'deadline', type: 'uint64' },
      { name: 'registrarSig', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'veto',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'handleId', ...bytes32 },
      { name: 'pendingNonce', type: 'uint256' },
      { name: 'deadline', type: 'uint64' },
      { name: 'registrarSig', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'unfreeze',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'handleId', ...bytes32 },
      { name: 'frozenUntil', type: 'uint64' },
      { name: 'deadline', type: 'uint64' },
      { name: 'ownerSig', type: 'bytes' },
      { name: 'registrarSig', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

/** `ChangeKind` in the contract. */
export const CHANGE_KIND = { None: 0, TransferOwner: 1, SetMetaAddress: 2, Release: 3 } as const;

/** An anchor record, as `recordOf` answers it (times in unix seconds). */
export interface AnchorRecord {
  owner: Address;
  serial: number;
  nonce: bigint;
  frozenUntil: number;
  releasedAt: number;
  pendingReadyAt: number;
  pendingKind: number;
  pendingNonce: bigint;
  pendingOwner: Address;
  metaAddress: Hex;
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/** A call the registrar sends. */
export type AnchorCall =
  | { functionName: 'claim'; args: readonly [Hex, Address, Hex, bigint, Hex, Hex] }
  | { functionName: 'release'; args: readonly [Hex, bigint, Hex] }
  | { functionName: 'applyChange'; args: readonly [Hex] }
  | { functionName: 'advance'; args: readonly [Hex, Address, Hex, bigint, Hex, Hex, Hex] }
  | { functionName: 'hold'; args: readonly [Hex, bigint, Hex] }
  | { functionName: 'renewHold'; args: readonly [Hex, bigint, bigint, Hex] }
  | { functionName: 'veto'; args: readonly [Hex, bigint, bigint, Hex] }
  | { functionName: 'unfreeze'; args: readonly [Hex, bigint, bigint, Hex, Hex] };

export type ReceiptStatus = 'success' | 'reverted' | 'pending';

export interface AnchorChain {
  readonly chainId: number;
  readonly anchor: Address;
  /** The registrar key, which signs and sends. */
  readonly registrar: PrivateKeyAccount;
  record(handleId: Hex): Promise<AnchorRecord>;
  /** Simulate, then sign and send; resolves with the transaction hash. A revert in the simulation throws `AnchorRevert`. */
  send(call: AnchorCall): Promise<Hex>;
  receipt(hash: Hex): Promise<ReceiptStatus>;
  /** The receipt, waited for up to `timeoutMs`; `pending` when it does not come in time. */
  waitReceipt(hash: Hex, timeoutMs: number): Promise<ReceiptStatus>;
}

/** A call the simulation refused: the contract's error name only, never its arguments. */
export class AnchorRevert extends Error {
  constructor(readonly reason: string) {
    super(`anchor reverted: ${reason}`);
    this.name = 'AnchorRevert';
  }
}

/** `HANDLE_REGISTRAR_KEY` as an account, or null while it is unset or malformed. */
export function registrarOf(env: Env): PrivateKeyAccount | null {
  const raw = env.HANDLE_REGISTRAR_KEY?.trim();
  if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
  try {
    return privateKeyToAccount(raw as Hex);
  } catch {
    return null;
  }
}

/**
 * A simulation's contract revert as `AnchorRevert` with the error's name, never
 * its message (which carries the call's arguments); null for anything else (a
 * node or transport error), which the caller rethrows so that a node outage is
 * never taken for the contract's refusal.
 */
export function contractRevert(err: unknown): AnchorRevert | null {
  if (!(err instanceof BaseError)) return null;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return null;
  return new AnchorRevert(reverted.data?.errorName ?? 'reverted');
}

/** The deployed anchor through JSON-RPC (`BASE_SEPOLIA_RPC_URL`), or null while the anchor or the key is missing. */
export function rpcAnchorChain(env: Env, anchor: Address | null): AnchorChain | null {
  const registrar = registrarOf(env);
  const rpcUrl = chainRpcUrl(env, HANDLES_CHAIN_ID);
  if (!anchor || !registrar || !rpcUrl) return null;
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account: registrar, chain: baseSepolia, transport: http(rpcUrl) });
  return {
    chainId: HANDLES_CHAIN_ID,
    anchor,
    registrar,
    async record(handleId) {
      const r = await publicClient.readContract({ address: anchor, abi: HANDLE_ANCHOR_ABI, functionName: 'recordOf', args: [handleId] });
      return {
        owner: r.owner,
        serial: Number(r.serial),
        nonce: r.nonce,
        frozenUntil: Number(r.frozenUntil),
        releasedAt: Number(r.releasedAt),
        pendingReadyAt: Number(r.pendingReadyAt),
        pendingKind: Number(r.pendingKind),
        pendingNonce: r.pendingNonce,
        pendingOwner: r.pendingOwner,
        metaAddress: r.metaAddress,
      };
    },
    async send(call) {
      let request;
      try {
        ({ request } = await publicClient.simulateContract({ address: anchor, abi: HANDLE_ANCHOR_ABI, account: registrar, ...call } as never));
      } catch (err) {
        throw contractRevert(err) ?? err;
      }
      return sendWithRetry({
        sign: async () => wallet.signTransaction(await wallet.prepareTransactionRequest(request as never)),
        send: (raw) => publicClient.sendRawTransaction({ serializedTransaction: raw }),
      });
    },
    async receipt(hash) {
      try {
        const r = await publicClient.getTransactionReceipt({ hash });
        return r.status === 'success' ? 'success' : 'reverted';
      } catch {
        return 'pending';
      }
    },
    async waitReceipt(hash, timeoutMs) {
      try {
        const r = await publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 1_000 });
        return r.status === 'success' ? 'success' : 'reverted';
      } catch {
        return 'pending';
      }
    },
  };
}
