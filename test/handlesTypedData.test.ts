// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The plane's EIP-712 types, its P = S + h·G check and the identity map's
 * keys, against the shared fixture `handleAnchorTypes.json` (cofferdam-sdk's,
 * copied unchanged; base-contracts reads the same file): every signed vector
 * recovers to its signer, and the registrar's signatures the plane makes are
 * the fixture's byte for byte (RFC 6979), so the plane, the SDK and the anchor
 * agree on every type and domain (workspace decision 0086, rules 3 to 5).
 */

import { getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { mapKeysOf } from '../src/services/handles/mapKey.js';
import { FIXTURE_ONE_TIME_FACTORY, isRegistrationOf, oneTimeAccount, oneTimeFactoryOf, splitMetaAddress, stealthSigner } from '../src/services/handles/stealth.js';
import { ANCHOR_TYPES, anchorSigner, REGISTRY_TYPES, registrySigner, signAnchor, type AnchorPrimaryType, type RegistryPrimaryType } from '../src/services/handles/typedData.js';
import fixture from './fixtures/handles/handleAnchorTypes.json';

const CHAIN = fixture.chainId;
const ANCHOR = getAddress(fixture.eip712.anchor.domain.verifyingContract);

/** A fixture message with its uint fields as bigints, as viem takes them. */
function messageOf(primaryType: string, message: Record<string, unknown>): Record<string, unknown> {
  const fields = (ANCHOR_TYPES as Record<string, readonly { name: string; type: string }[]>)[primaryType] ??
    (REGISTRY_TYPES as Record<string, readonly { name: string; type: string }[]>)[primaryType]!;
  return Object.fromEntries(fields.map((f) => [f.name, f.type.startsWith('uint') ? BigInt(message[f.name] as number | string) : message[f.name]]));
}

describe('the EIP-712 types match the shared fixture', () => {
  it('has the fixture type strings, field for field', () => {
    for (const [domain, table] of [
      ['anchor', ANCHOR_TYPES],
      ['registry', REGISTRY_TYPES],
    ] as const) {
      const types = fixture.eip712[domain].types as Record<string, { typeString: string; fields: { name: string; type: string }[] }>;
      for (const [name, def] of Object.entries(types)) {
        expect((table as Record<string, unknown>)[name], `${domain}.${name}`).toEqual(def.fields);
        const typeString = `${name}(${def.fields.map((f) => `${f.type} ${f.name}`).join(',')})`;
        expect(typeString).toBe(def.typeString);
      }
    }
  });

  it('recovers every signed vector to its signer', async () => {
    expect(fixture.signed.length).toBe(23);
    for (const s of fixture.signed) {
      const message = messageOf(s.primaryType, s.message as Record<string, unknown>);
      const got =
        s.domain === 'anchor'
          ? await anchorSigner(CHAIN, ANCHOR, s.primaryType as AnchorPrimaryType, message, s.signature as Hex)
          : await registrySigner(CHAIN, s.primaryType as RegistryPrimaryType, message, s.signature as Hex);
      expect(got, s.primaryType).toBe(getAddress(s.signerAddress));
    }
  });

  it("signs the registrar's types exactly as the fixture does", async () => {
    const registrar = privateKeyToAccount(fixture.keys.registrar.privateKey as Hex);
    expect(registrar.address).toBe(getAddress(fixture.keys.registrar.address));
    const theirs = fixture.signed.filter((s) => s.signer === 'registrar');
    expect(theirs.map((s) => s.primaryType).sort()).toEqual(['Hold', 'RegistrarAdvance', 'RegistrarCancel', 'RegistrarClaim', 'RegistrarSetMetaAddress', 'RegistrarTransferOwner', 'RegistrarUnfreeze', 'RenewHold', 'Veto']);
    for (const s of theirs) {
      const sig = await signAnchor(registrar, CHAIN, ANCHOR, s.primaryType as AnchorPrimaryType, messageOf(s.primaryType, s.message as Record<string, unknown>));
      expect(sig, s.primaryType).toBe(s.signature);
    }
  });

  it('refuses a vector under another chain, contract or type', async () => {
    const s = fixture.signed.find((x) => x.primaryType === 'OwnerClaim')!;
    const message = messageOf(s.primaryType, s.message as Record<string, unknown>);
    expect(await anchorSigner(8453, ANCHOR, 'OwnerClaim', message, s.signature as Hex)).not.toBe(getAddress(s.signerAddress));
    expect(await anchorSigner(CHAIN, getAddress('0x' + '11'.repeat(20)), 'OwnerClaim', message, s.signature as Hex)).not.toBe(getAddress(s.signerAddress));
    expect(await anchorSigner(CHAIN, ANCHOR, 'OwnerClaim', message, '0x1234')).toBeNull();
  });
});

describe('P = S + h·G and the one-time account', () => {
  it("gives the fixture's signer and account for every vector", () => {
    const keys = splitMetaAddress(fixture.stealth.metaAddress)!;
    expect(FIXTURE_ONE_TIME_FACTORY).toEqual({ address: getAddress(fixture.stealth.factory.address), initCodeHash: fixture.stealth.factory.initCodeHash });
    for (const v of fixture.stealth.vectors) {
      const signer = stealthSigner(keys.spending, v.sharedSecretHash as Hex);
      expect(signer).toBe(getAddress(v.signer));
      expect(oneTimeAccount(signer!, FIXTURE_ONE_TIME_FACTORY)).toBe(getAddress(v.account));
      expect(isRegistrationOf(v.account as Address, fixture.stealth.metaAddress, v.sharedSecretHash as Hex, FIXTURE_ONE_TIME_FACTORY)).toBe(true);
    }
  });

  it('refuses another meta-address, h = 0, h at the curve order and a malformed meta-address', () => {
    const v = fixture.stealth.vectors[0]!;
    expect(isRegistrationOf(v.account as Address, fixture.epochs[1]!.metaAddress, v.sharedSecretHash as Hex, FIXTURE_ONE_TIME_FACTORY)).toBe(false);
    const keys = splitMetaAddress(fixture.stealth.metaAddress)!;
    expect(stealthSigner(keys.spending, ('0x' + '00'.repeat(32)) as Hex)).toBeNull();
    expect(stealthSigner(keys.spending, '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')).toBeNull();
    expect(splitMetaAddress('0x04' + '11'.repeat(65))).toBeNull();
    expect(splitMetaAddress(fixture.stealth.metaAddress.slice(0, 100))).toBeNull();
  });

  it('reads the factory from the env, or the fixture when both are unset, and refuses half of one', () => {
    expect(oneTimeFactoryOf({})).toEqual(FIXTURE_ONE_TIME_FACTORY);
    expect(oneTimeFactoryOf({ ONE_TIME_FACTORY: '0x' + '22'.repeat(20) })).toBeNull();
    expect(oneTimeFactoryOf({ ONE_TIME_FACTORY: '0x' + '22'.repeat(20), ONE_TIME_INIT_CODE_HASH: '0x' + '33'.repeat(32) })?.address).toBe(getAddress('0x' + '22'.repeat(20)));
  });
});

describe('the identity map keys', () => {
  const SECRET = 'ab'.repeat(32);

  it('tags deterministically by domain, case-insensitively, and seals and opens', async () => {
    const k = (await mapKeysOf(SECRET))!;
    const a = await k.tag('account', '0xABcd' + '00'.repeat(18));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await k.tag('account', '0xabcd' + '00'.repeat(18))).toBe(a);
    expect(await k.tag('install', '0xabcd' + '00'.repeat(18))).not.toBe(a);
    expect(await (await mapKeysOf('cd'.repeat(32)))!.tag('account', '0xabcd' + '00'.repeat(18))).not.toBe(a);
    const plain = crypto.getRandomValues(new Uint8Array(132));
    const sealed = await k.seal(plain);
    expect(sealed.length).toBe(12 + 132 + 16);
    expect(await k.open(sealed)).toEqual(plain);
    sealed[20]! ^= 1;
    await expect(k.open(sealed)).rejects.toThrow();
  });

  it('is null without a 32-byte hex secret', async () => {
    expect(await mapKeysOf(undefined)).toBeNull();
    expect(await mapKeysOf('ab'.repeat(31))).toBeNull();
    expect(await mapKeysOf('zz'.repeat(32))).toBeNull();
  });
});
