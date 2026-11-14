// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/** An op's own outcome from the EntryPoint's events, and its revert reason by name only (decision 0080). */

import { encodeAbiParameters, encodeErrorResult, encodeEventTopics, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { ENTRY_POINT_V07 } from '../src/services/userOp.js';
import { ENTRY_POINT_EVENTS_ABI, opOutcome, revertName } from '../src/services/userOpOutcome.js';

const SENDER: Address = '0x80967a159A00dcabe2DeAF86b68249acfc45C265';
const OTHER: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const HASH = keccak256('0x02');

/** Every registry error the adapter and the registries of PR #21 and Self raise, as their sources declare them. */
const REGISTRY_ERRORS = parseAbi([
  'error IdentifierAlreadyBound(bytes32 identifier, address account)',
  'error AccountAlreadyBound(address account, bytes32 identifier)',
  'error WrongBoundDigest()',
  'error WrongBoundAccount(address expected, address got)',
  'error ExpiryNotProven(uint256 earliest)',
  'error NullifierAlreadyBound(uint256 nullifier, address boundAccount)',
  'error WrongScope(uint256 expected, uint256 got)',
  'error WrongScope(bytes32 expected, bytes32 got)',
]);

const event = (eventName: 'UserOperationEvent' | 'UserOperationRevertReason' | 'PostOpRevertReason', sender: Address, nonce: bigint, extra: { success?: boolean; reason?: Hex } = {}) => ({
  address: ENTRY_POINT_V07,
  topics: encodeEventTopics({
    abi: ENTRY_POINT_EVENTS_ABI,
    eventName,
    args: eventName === 'UserOperationEvent' ? { userOpHash: HASH, sender, paymaster: sender } : { userOpHash: HASH, sender },
  } as never) as Hex[],
  data:
    eventName === 'UserOperationEvent'
      ? encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [nonce, extra.success ?? true, 1n, 1n])
      : encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [nonce, extra.reason ?? '0x']),
});

describe('revertName', () => {
  it('names the registries\' errors and never carries their arguments', () => {
    const identifier = keccak256('0x0bad');
    const data = encodeErrorResult({ abi: REGISTRY_ERRORS, errorName: 'IdentifierAlreadyBound', args: [identifier, SENDER] });
    expect(revertName(data)).toBe('IdentifierAlreadyBound');
    expect(revertName(encodeErrorResult({ abi: REGISTRY_ERRORS, errorName: 'WrongBoundDigest' }))).toBe('WrongBoundDigest');
    expect(revertName(encodeErrorResult({ abi: REGISTRY_ERRORS, errorName: 'NullifierAlreadyBound', args: [123456789n, SENDER] }))).toBe('NullifierAlreadyBound');
    expect(revertName(encodeErrorResult({ abi: REGISTRY_ERRORS, errorName: 'ExpiryNotProven', args: [1n] }))).toBe('ExpiryNotProven');
  });

  it('gives a revert string with its long numbers cut, a panic code, an unknown selector, empty data', () => {
    const msg = encodeErrorResult({ abi: parseAbi(['error Error(string)']), errorName: 'Error', args: [`bound to 0x${'ab'.repeat(32)} as 12345678901234567890`] });
    expect(revertName(msg)).toBe('Error: bound to 0x… as …');
    expect(revertName(encodeErrorResult({ abi: parseAbi(['error Panic(uint256)']), errorName: 'Panic', args: [0x11n] }))).toBe('Panic(0x11)');
    expect(revertName('0xdeadbeef0000')).toBe('0xdeadbeef');
    expect(revertName('0x')).toBe('empty');
    expect(revertName('0x12')).toBe('malformed');
  });
});

describe('opOutcome', () => {
  it('reads the op of this sender and nonce, ignoring every other op and contract', () => {
    const logs = [
      event('UserOperationEvent', OTHER, 26n, { success: false }),
      event('UserOperationEvent', SENDER, 25n, { success: false }),
      { ...event('UserOperationEvent', SENDER, 26n, { success: false }), address: OTHER },
      event('UserOperationEvent', SENDER, 26n),
    ];
    expect(opOutcome(logs, ENTRY_POINT_V07, SENDER, 26n)).toEqual({ status: 'success' });
  });

  it('gives a failed op its reason by name, or postOp\'s', () => {
    const wrong = encodeErrorResult({ abi: REGISTRY_ERRORS, errorName: 'WrongBoundAccount', args: [SENDER, OTHER] });
    expect(
      opOutcome([event('UserOperationRevertReason', SENDER, 26n, { reason: wrong }), event('UserOperationEvent', SENDER, 26n, { success: false })], ENTRY_POINT_V07, SENDER, 26n),
    ).toEqual({ status: 'reverted', reason: 'WrongBoundAccount' });
    expect(
      opOutcome([event('PostOpRevertReason', SENDER, 26n, { reason: '0x' }), event('UserOperationEvent', SENDER, 26n, { success: false })], ENTRY_POINT_V07, SENDER, 26n),
    ).toEqual({ status: 'reverted', reason: 'postOp: empty' });
    expect(opOutcome([event('UserOperationEvent', SENDER, 26n, { success: false })], ENTRY_POINT_V07, SENDER, 26n)).toEqual({ status: 'reverted', reason: 'reverted' });
  });

  it('names a failed op whose gas outran its prefund', () => {
    const tooLow = {
      address: ENTRY_POINT_V07,
      topics: encodeEventTopics({ abi: ENTRY_POINT_EVENTS_ABI, eventName: 'UserOperationPrefundTooLow', args: { userOpHash: HASH, sender: SENDER } }) as Hex[],
      data: encodeAbiParameters([{ type: 'uint256' }], [26n]),
    };
    expect(opOutcome([tooLow, event('UserOperationEvent', SENDER, 26n, { success: false })], ENTRY_POINT_V07, SENDER, 26n)).toEqual({
      status: 'reverted',
      reason: 'prefund_too_low',
    });
  });

  it('is missing when the EntryPoint executed no such op', () => {
    expect(opOutcome([], ENTRY_POINT_V07, SENDER, 26n)).toEqual({ status: 'missing' });
    expect(opOutcome([{ address: ENTRY_POINT_V07, topics: [HASH], data: '0x' }], ENTRY_POINT_V07, SENDER, 26n)).toEqual({ status: 'missing' });
  });
});
