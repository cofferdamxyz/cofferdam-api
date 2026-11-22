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

import { BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, encodeFunctionData, http, type Address, type Hex } from 'viem';
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
  /**
   * Whether `account` already had code `seconds` ago (rule 3: a claim never
   * shares the hour of its account's deployment). False when it did not, and
   * when the node cannot say (a pruned state, an error): the caller then waits
   * the whole gap, so a failure only delays a claim.
   */
  deployedBefore(account: Address, seconds: number): Promise<boolean>;
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
 * `HANDLE_STATEMENT_KEY` as an account: the key of the plane's own statements
 * (the same-identity statement, rule 7, and the Verified statement, rule 9),
 * apart from the registrar's (the review of 2026-11-19, M5). Null while unset,
 * malformed, or the registrar key itself.
 */
export function statementSignerOf(env: Env): PrivateKeyAccount | null {
  const raw = env.HANDLE_STATEMENT_KEY?.trim();
  if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
  if (raw.toLowerCase() === env.HANDLE_REGISTRAR_KEY?.trim().toLowerCase()) return null;
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

/**
 * The transaction a registrar call sends: to the anchor, with the call encoded.
 * Built here rather than from `simulateContract`'s `request`, which names the
 * contract as `address` with `abi`, `functionName` and `args`: handed to
 * `prepareTransactionRequest`, that request loses both, and the key signs a
 * contract creation with no code (what the relay sent on 2026-11-22 until this
 * fix, `test/handlesAnchorSend.test.ts`).
 */
export function anchorTransaction(anchor: Address, call: AnchorCall): { to: Address; data: Hex } {
  const data = encodeFunctionData({ abi: HANDLE_ANCHOR_ABI, ...call } as never);
  if (!/^0x[0-9a-f]{8}/i.test(data)) throw new Error('anchor: empty call data');
  return { to: anchor, data };
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
      try {
        await publicClient.simulateContract({ address: anchor, abi: HANDLE_ANCHOR_ABI, account: registrar, ...call } as never);
      } catch (err) {
        throw contractRevert(err) ?? err;
      }
      const tx = anchorTransaction(anchor, call);
      return sendWithRetry({
        sign: async () => wallet.signTransaction(await wallet.prepareTransactionRequest({ ...tx, account: registrar, chain: baseSepolia })),
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
    async deployedBefore(account, seconds) {
      try {
        return await codeBefore(publicClient, account, seconds);
      } catch {
        return false;
      }
    },
  };
}

/** The reads `codeBefore` makes: a block by number or the latest, and an address's code at a block. */
export interface CodeReader {
  getBlock(args: { blockNumber: bigint } | { blockTag: 'latest' }): Promise<{ number: bigint | null; timestamp: bigint }>;
  getCode(args: { address: Address; blockNumber: bigint }): Promise<Hex | undefined>;
}

/** Blocks the block time is measured over. */
const SAMPLE_BLOCKS = 1_000n;

/**
 * Whether `account` had code at a block at least `seconds` older than the head.
 * The block time is measured on the chain (Base's blocks have been 2 s and
 * shorter), the block found is checked to be old enough, and a block that is
 * not answers false, as the caller's safe side.
 */
export async function codeBefore(reader: CodeReader, account: Address, seconds: number): Promise<boolean> {
  if (seconds <= 0) return true;
  const head = await reader.getBlock({ blockTag: 'latest' });
  if (head.number === null || head.number <= SAMPLE_BLOCKS) return false;
  const sample = await reader.getBlock({ blockNumber: head.number - SAMPLE_BLOCKS });
  const span = head.timestamp - sample.timestamp;
  if (span <= 0n) return false;
  // Blocks back for `seconds`, rounded up at the measured rate, plus one.
  const back = (BigInt(seconds) * SAMPLE_BLOCKS + span - 1n) / span + 1n;
  if (back >= head.number) return false;
  const at = await reader.getBlock({ blockNumber: head.number - back });
  if (head.timestamp - at.timestamp < BigInt(seconds)) return false;
  const code = await reader.getCode({ address: account, blockNumber: head.number - back });
  return code !== undefined && code !== '0x';
}
