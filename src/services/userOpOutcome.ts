// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Whether a relayed op itself succeeded, read from the EntryPoint's events.
 *
 * EntryPoint v0.7 reverts `handleOps` only when validation fails (`AAxx`). A
 * revert inside the account's `execute` (a bind the registry refuses, an
 * account already bound, a wrong `custom_data`) is caught: the transaction
 * succeeds, the relayer and the paymaster pay, and the op's failure shows only
 * as `UserOperationEvent.success == false` beside `UserOperationRevertReason`.
 * So a mined receipt is not a done op (workspace decision 0080 (3)). The relay
 * reads these events twice: from an `eth_simulateV1` of `handleOps` before it
 * sends (`execution_reverted`, nothing spent), and from the receipt after
 * (`user_op_reverted`).
 *
 * A revert reason leaves the plane as the error's name only, never its
 * arguments: the registries' errors carry the passport's identifier
 * (`NullifierAlreadyBound(nullifier, account)`, `IdentifierAlreadyBound(identifier,
 * account)`), and the relay's log line names the account (the identity log
 * policy, `identityLog.ts`).
 */

import { decodeAbiParameters, decodeEventLog, getAddress, slice, toFunctionSelector, type Address, type Hex } from 'viem';

import { scrubIdentifiers } from './identityLog.js';

/** EntryPoint v0.7's per-op outcome events. */
export const ENTRY_POINT_EVENTS_ABI = [
  {
    type: 'event',
    name: 'UserOperationEvent',
    inputs: [
      { name: 'userOpHash', type: 'bytes32', indexed: true },
      { name: 'sender', type: 'address', indexed: true },
      { name: 'paymaster', type: 'address', indexed: true },
      { name: 'nonce', type: 'uint256', indexed: false },
      { name: 'success', type: 'bool', indexed: false },
      { name: 'actualGasCost', type: 'uint256', indexed: false },
      { name: 'actualGasUsed', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'UserOperationRevertReason',
    inputs: [
      { name: 'userOpHash', type: 'bytes32', indexed: true },
      { name: 'sender', type: 'address', indexed: true },
      { name: 'nonce', type: 'uint256', indexed: false },
      { name: 'revertReason', type: 'bytes', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'PostOpRevertReason',
    inputs: [
      { name: 'userOpHash', type: 'bytes32', indexed: true },
      { name: 'sender', type: 'address', indexed: true },
      { name: 'nonce', type: 'uint256', indexed: false },
      { name: 'revertReason', type: 'bytes', indexed: false },
    ],
  },
] as const;

/**
 * Custom errors an op's target can revert with, by signature, so a reason has
 * a name: the decision 0080 identity registry and its ZKPassport adapter
 * (base-contracts PR #21, `CofferdamIdentityRegistry.sol`,
 * `ZKPassportEvidenceAdapter.sol`) and Self's `NullifierRegistry` on Sepolia.
 * Only the selector and the name are used; the arguments are never decoded.
 */
const KNOWN_ERRORS = [
  // CofferdamIdentityRegistry
  'NotOwner()',
  'NotPendingOwner()',
  'ZeroAddress()',
  'ZeroValue()',
  'DelayTooShort(uint256,uint256)',
  'DelayTooLong(uint256,uint256)',
  'Paused()',
  'NotTestAccount(address)',
  'UnknownAction(bytes32)',
  'AdapterNotActive(address)',
  'AdapterAlreadyActive(address)',
  'AdapterNotProposed(address)',
  'AdapterNotReady(uint256)',
  'AdapterProposalExpired(uint256)',
  'WrongIdentifierKind(bytes32,bytes32)',
  'WrongScope(bytes32,bytes32)',
  'ZeroIdentifier()',
  'RetiredIdentifier(bytes32)',
  'AccountAlreadyBound(address,bytes32)',
  'IdentifierAlreadyBound(bytes32,address)',
  'AccountNotBound(address)',
  'IdentifierNotBound(bytes32)',
  'SameIdentifier(bytes32)',
  'SameAccount(address)',
  'NoPendingRebind(bytes32)',
  'RebindNotReady(uint48)',
  'RebindStale(bytes32)',
  'NotBoundAccount(address,address)',
  // ZKPassportEvidenceAdapter
  'NotCanonicalVerifier(address)',
  'ZeroVersion()',
  'EmptyScope()',
  'BadValidity(uint256)',
  'BadIdentifierType(uint8)',
  'BadOprfKeyHash()',
  'BadMinAge(uint8)',
  'MalformedEvidence()',
  'WrongIdentifierType(uint256,uint256)',
  'WrongOprfKey(bytes32,bytes32)',
  'ProofInvalid()',
  'IdentifierMismatch(bytes32,bytes32)',
  'HelperMismatch(address,address)',
  'WrongBoundAccount(address,address)',
  'WrongBoundChain(uint256,uint256)',
  'WrongBoundDigest()',
  'AgeNotProven(uint8)',
  'BadExpiryMargin(uint256)',
  'ExpiryNotProven(uint256)',
  'DisclosureRefused(uint8)',
  'MalformedCommittedInputs()',
  'BindSectionCount(uint256)',
  // NullifierRegistry (Self, Base Sepolia)
  'ZeroScope()',
  'ZeroDestChainId()',
  'WrongAttestationId(uint256,uint256)',
  'WrongScope(uint256,uint256)',
  'UserIdentifierMismatch(address,address)',
  'MalformedUserContext(uint256)',
  'WrongDestChainId(uint256,uint256)',
  'UserIdentifierCommitmentMismatch(uint256,uint256)',
  'AccountAlreadyBound(address,uint256)',
  'NullifierAlreadyBound(uint256,address)',
  'UntrustedAttester()',
  'InvalidProof()',
  'NullifierNotBound(uint256)',
  'NoPendingRebind(uint256)',
] as const;

const ERROR_NAMES: ReadonlyMap<string, string> = new Map(
  KNOWN_ERRORS.map((sig) => [toFunctionSelector(sig), sig.slice(0, sig.indexOf('('))]),
);

const ERROR_STRING = '0x08c379a0';
const PANIC = '0x4e487b71';


/**
 * A revert's name, safe to log beside the account: a known custom error's
 * name, `Error: <message>` (scrubbed) or `Panic(0x..)`, else the bare
 * 4-byte selector, `empty` for no data. Never an argument.
 */
export function revertName(data: Hex | undefined): string {
  if (!data || data === '0x') return 'empty';
  if (data.length < 10) return 'malformed';
  const selector = slice(data, 0, 4).toLowerCase();
  if (selector === ERROR_STRING) {
    try {
      const [message] = decodeAbiParameters([{ type: 'string' }], slice(data, 4));
      return `Error: ${scrubIdentifiers(message, 96)}`;
    } catch {
      return 'Error';
    }
  }
  if (selector === PANIC) {
    try {
      const [code] = decodeAbiParameters([{ type: 'uint256' }], slice(data, 4));
      return `Panic(0x${code.toString(16)})`;
    } catch {
      return 'Panic';
    }
  }
  return ERROR_NAMES.get(selector) ?? selector;
}

/** A log as both viem's receipts and `eth_simulateV1` give it. */
export interface OutcomeLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
}

/** What the EntryPoint says became of one op. */
export type OpOutcome =
  | { status: 'success' }
  | { status: 'reverted'; reason: string }
  /** No `UserOperationEvent` for this sender and nonce: the op was not executed. */
  | { status: 'missing' };

/** The op `(sender, nonce)`'s outcome among an EntryPoint's logs. */
export function opOutcome(logs: readonly OutcomeLog[], entryPoint: Address, sender: Address, nonce: bigint): OpOutcome {
  const ep = getAddress(entryPoint);
  const who = getAddress(sender);
  let success: boolean | null = null;
  let reason: string | null = null;
  for (const log of logs) {
    if (getAddress(log.address) !== ep || log.topics.length === 0) continue;
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: ENTRY_POINT_EVENTS_ABI,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      });
    } catch {
      continue;
    }
    const args = decoded.args as { sender: Address; nonce: bigint };
    if (getAddress(args.sender) !== who || args.nonce !== nonce) continue;
    if (decoded.eventName === 'UserOperationEvent') {
      success = (decoded.args as { success: boolean }).success;
    } else if (reason === null) {
      const name = revertName((decoded.args as { revertReason: Hex }).revertReason);
      reason = decoded.eventName === 'PostOpRevertReason' ? `postOp: ${name}` : name;
    }
  }
  if (success === null) return { status: 'missing' };
  if (success) return { status: 'success' };
  return { status: 'reverted', reason: reason ?? 'reverted' };
}
