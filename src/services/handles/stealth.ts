// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The plane's half of ERC-5564 scheme 1 (workspace decision 0086, rule 5): the
 * check a `self` registration passes, with no ephemeral secret and no viewing
 * key. The signer is P = S + h·G, S the meta-address's spending key and h the
 * shared-secret hash; the address an announcement names is the one-time account
 * a factory gives that signer (CREATE2, the signer left-padded to 32 bytes as the
 * salt). cofferdam-sdk's `stealthSignerFromHash` and `oneTimeAccountAddress` are
 * the same functions; the shared fixture's stealth vectors pin both
 * (`test/handlesStealth.test.ts`), so the SDK and the plane never disagree.
 *
 * ASSUMPTION(0086 ruling A): the factory form (recommended), behind the fixture
 * factory until 0083 rule 4's factory exists. Nothing is deployed at the fixture
 * address, so an account under it can never be spent from; the plane reads the
 * factory from `ONE_TIME_FACTORY` and `ONE_TIME_INIT_CODE_HASH`, else the fixture.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { getContractAddress, keccak256, pad, getAddress, type Address, type Hex } from 'viem';

const { Point } = secp256k1;
const N = Point.CURVE().n;

/** A CREATE2 factory: its address and the init code hash every account shares. */
export interface OneTimeFactory {
  address: Address;
  initCodeHash: Hex;
}

/** The placeholder of the SDK's tests and the shared fixture: keccak256 of fixed strings, nothing deployed. */
export const FIXTURE_ONE_TIME_FACTORY: OneTimeFactory = {
  address: getAddress('0x59DAe9808abd873C1c736C063A29e96C53bebb22'),
  initCodeHash: '0x4438b40a986860016c05d8767a4905e4df7ca316e4c3fcaa289dad02dbc99abc',
};

/** The factory the env names, or the fixture's; null when the env names half of one or a malformed one. */
export function oneTimeFactoryOf(env: { ONE_TIME_FACTORY?: string; ONE_TIME_INIT_CODE_HASH?: string }): OneTimeFactory | null {
  const address = env.ONE_TIME_FACTORY?.trim();
  const hash = env.ONE_TIME_INIT_CODE_HASH?.trim();
  if (!address && !hash) return FIXTURE_ONE_TIME_FACTORY;
  if (!address || !hash || !/^0x[0-9a-fA-F]{40}$/.test(address) || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
  return { address: getAddress(address), initCodeHash: hash.toLowerCase() as Hex };
}

function hexBytes(hex: string): Uint8Array {
  const body = hex.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function pointAddress(p: InstanceType<typeof Point>): Address {
  const raw = p.toBytes(false).slice(1);
  return getAddress(`0x${keccak256(raw).slice(-40)}`);
}

/** Whether a 0x hex string is a compressed secp256k1 point on the curve. */
export function isCompressedPoint(hex: string): boolean {
  if (!/^0x0[23][0-9a-fA-F]{64}$/.test(hex)) return false;
  try {
    Point.fromBytes(hexBytes(hex));
    return true;
  } catch {
    return false;
  }
}

/** The two keys of a 66-byte scheme 1 meta-address, or null when either is not a point. */
export function splitMetaAddress(meta: string): { spending: Hex; viewing: Hex } | null {
  if (!/^0x[0-9a-fA-F]{132}$/.test(meta)) return null;
  const spending = `0x${meta.slice(2, 68)}` as Hex;
  const viewing = `0x${meta.slice(68)}` as Hex;
  return isCompressedPoint(spending) && isCompressedPoint(viewing) ? { spending, viewing } : null;
}

/** P = S + h·G, or null when h is 0 or not below the curve order, or S is no point. */
export function stealthSigner(spendingPublicKey: Hex, sharedSecretHash: Hex): Address | null {
  if (!isCompressedPoint(spendingPublicKey) || !/^0x[0-9a-fA-F]{64}$/.test(sharedSecretHash)) return null;
  const h = BigInt(sharedSecretHash);
  if (h === 0n || h >= N) return null;
  const S = Point.fromBytes(hexBytes(spendingPublicKey));
  return pointAddress(S.add(Point.BASE.multiply(h)));
}

/** The one-time account of a stealth signer under a factory. */
export function oneTimeAccount(signer: Address, factory: OneTimeFactory): Address {
  return getContractAddress({ opcode: 'CREATE2', from: factory.address, salt: pad(signer, { size: 32 }), bytecodeHash: factory.initCodeHash });
}

/**
 * Whether `account` is the one-time account of `metaAddress` for h: the
 * `self` route's P = S + h·G check (rule 5). The handle key's signature and
 * whether the meta-address is the identity's are checked by the route.
 */
export function isRegistrationOf(account: Address, metaAddress: string, sharedSecretHash: Hex, factory: OneTimeFactory): boolean {
  const keys = splitMetaAddress(metaAddress);
  if (!keys) return false;
  const signer = stealthSigner(keys.spending, sharedSecretHash);
  return signer !== null && oneTimeAccount(signer, factory).toLowerCase() === account.toLowerCase();
}
