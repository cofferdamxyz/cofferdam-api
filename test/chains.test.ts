// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The plane's chain switch (workspace decision 0080, milestone M1): Base
 * Sepolia reads as before, Base mainnet only behind `BASE_MAINNET_ENABLED`
 * and `BASE_RPC_URL`, and even then only where its deployments table has the
 * contract a path needs (empty today). The clients are fakes; nothing here
 * reaches a node.
 */

import { encodeAbiParameters, type Address } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { chainContext, chainRpcUrl, mainnetEnabled, type ChainEnv } from '../src/chain/chains.js';
import {
  BASE_MAINNET_DEPLOYMENTS,
  DEPLOYMENTS_BY_CHAIN,
  SEPOLIA_DEPLOYMENTS,
  passkeyModuleFor,
  type ChainDeployments,
} from '../src/chain/deployments.js';
import { CEREMONY_PINS, ceremonyChainId, ceremonyPinsFor } from '../src/routes/ceremony.js';
import { checkOnChainAuthority } from '../src/services/authorityCheck.js';
import { authorityKey } from '../src/services/chat/authorityMemo.js';
import type { PasskeySession } from '../src/services/sessionAttestation.js';

const clients = vi.hoisted(() => ({
  sepolia: { name: 'sepolia', getCode: vi.fn(), readContract: vi.fn() },
  base: { name: 'base', getCode: vi.fn(), readContract: vi.fn() },
  sepoliaUrls: [] as string[],
  baseUrls: [] as string[],
}));

vi.mock('../src/chain/client.js', () => ({
  getBaseSepoliaClient: (url: string) => (clients.sepoliaUrls.push(url), clients.sepolia),
  getBaseClient: (url: string) => (clients.baseUrls.push(url), clients.base),
}));

afterEach(() => {
  vi.resetAllMocks();
  clients.sepoliaUrls.length = 0;
  clients.baseUrls.length = 0;
});

const ON: ChainEnv = { BASE_SEPOLIA_RPC_URL: 'https://sepolia.example', BASE_MAINNET_ENABLED: 'true', BASE_RPC_URL: 'http://127.0.0.1:8546' };
const OFF: ChainEnv = { BASE_SEPOLIA_RPC_URL: 'https://sepolia.example', BASE_RPC_URL: 'http://127.0.0.1:8546' };

const MAINNET_MODULE: Address = '0x1111111111111111111111111111111111111111';
/** A mainnet table as the test generation would give it (never the plane's default). */
const TEST_TABLES = {
  ...DEPLOYMENTS_BY_CHAIN,
  8453: { WebAuthnPasskeyAuthority: { address: MAINNET_MODULE } } satisfies ChainDeployments,
};

const ACCOUNT: Address = '0x80967a159A00dcabe2DeAF86b68249acfc45C265';
const att = (chainId: number): PasskeySession =>
  ({
    accountAddress: ACCOUNT,
    chainId,
    alg: 'webauthn',
    publicKey: { qx: '0x' + '11'.repeat(32), qy: '0x' + '22'.repeat(32) },
  }) as unknown as PasskeySession;

describe('the mainnet switch', () => {
  it('is on only for exactly "true" with a URL', () => {
    expect(mainnetEnabled(ON)).toBe(true);
    expect(mainnetEnabled(OFF)).toBe(false);
    expect(mainnetEnabled({ ...ON, BASE_MAINNET_ENABLED: '1' })).toBe(false);
    expect(mainnetEnabled({ ...ON, BASE_MAINNET_ENABLED: 'TRUE' })).toBe(false);
    expect(mainnetEnabled({ ...ON, BASE_RPC_URL: ' ' })).toBe(false);
    expect(mainnetEnabled({ BASE_MAINNET_ENABLED: 'true' })).toBe(false);
  });

  it('reads Sepolia on its URL (the public node when unset), mainnet only when on, nothing else', () => {
    expect(chainRpcUrl(OFF, 84532)).toBe('https://sepolia.example');
    expect(chainRpcUrl({}, 84532)).toBe('https://sepolia.base.org');
    expect(chainRpcUrl(OFF, 8453)).toBeNull();
    expect(chainRpcUrl(ON, 8453)).toBe('http://127.0.0.1:8546');
    expect(chainRpcUrl(ON, 1)).toBeNull();
    expect(chainContext(ON, 11155111)).toBeNull();
    expect(chainContext(OFF, 8453)).toBeNull();
    expect(chainContext(ON, 8453)?.client).toBe(clients.base);
    expect(chainContext(ON, 84532)?.deployments).toBe(SEPOLIA_DEPLOYMENTS);
  });

  it('keeps the mainnet table empty: no default address on 8453 (decision 0080 (2))', () => {
    expect(BASE_MAINNET_DEPLOYMENTS).toEqual({});
    expect(passkeyModuleFor(BASE_MAINNET_DEPLOYMENTS, 'webauthn')).toBeNull();
    expect(passkeyModuleFor(SEPOLIA_DEPLOYMENTS, 'webauthn')).toBe(SEPOLIA_DEPLOYMENTS.WebAuthnPasskeyAuthority.address);
    expect(passkeyModuleFor(TEST_TABLES[8453], 'p256')).toBeNull();
  });
});

describe('checkOnChainAuthority per chain', () => {
  const active = (module: Address) => {
    const config = encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32)] as never);
    return (args: { functionName: string }) =>
      Promise.resolve(args.functionName === 'authorityCount' ? 1n : [module, 3, true, config]);
  };

  it('answers chain_unsupported on 8453 without a read while mainnet is off, or while its table lacks the module', async () => {
    expect(await checkOnChainAuthority(att(8453), OFF)).toEqual({ status: 'chain_unsupported', chainId: 8453 });
    expect(await checkOnChainAuthority(att(8453), ON)).toEqual({ status: 'chain_unsupported', chainId: 8453 });
    expect(clients.base.getCode).not.toHaveBeenCalled();
    expect(clients.sepolia.getCode).not.toHaveBeenCalled();
  });

  it('reads Sepolia exactly as before, from a string or an env', async () => {
    clients.sepolia.getCode.mockResolvedValue('0x60');
    clients.sepolia.readContract.mockImplementation(active(SEPOLIA_DEPLOYMENTS.WebAuthnPasskeyAuthority.address));
    expect(await checkOnChainAuthority(att(84532), 'https://sepolia.example')).toMatchObject({ status: 'active', authorityId: 0 });
    expect(await checkOnChainAuthority(att(84532), OFF)).toMatchObject({ status: 'active' });
    expect(clients.sepoliaUrls).toEqual(['https://sepolia.example', 'https://sepolia.example']);
  });

  it('never reads mainnet for a Sepolia-only caller (a string), even with mainnet on', async () => {
    expect(await checkOnChainAuthority(att(8453), 'https://sepolia.example', TEST_TABLES)).toEqual({ status: 'chain_unsupported', chainId: 8453 });
    expect(clients.base.getCode).not.toHaveBeenCalled();
  });

  it('reads mainnet through BASE_RPC_URL against the mainnet module once on and deployed', async () => {
    clients.base.getCode.mockResolvedValue('0x60');
    clients.base.readContract.mockImplementation(active(MAINNET_MODULE));
    expect(await checkOnChainAuthority(att(8453), ON, TEST_TABLES)).toMatchObject({ status: 'active', module: MAINNET_MODULE });
    expect(clients.baseUrls).toEqual(['http://127.0.0.1:8546']);
    expect(clients.sepolia.getCode).not.toHaveBeenCalled();

    // The Sepolia module is not a mainnet authority.
    clients.base.readContract.mockImplementation(active(SEPOLIA_DEPLOYMENTS.WebAuthnPasskeyAuthority.address));
    expect(await checkOnChainAuthority(att(8453), ON, TEST_TABLES)).toEqual({ status: 'not_found' });
  });

  it('keeps a pass on one chain from answering for the other in the five-minute memo', () => {
    expect(authorityKey(att(84532))).not.toBe(authorityKey(att(8453)));
  });
});

describe('ceremony pins per chain', () => {
  it('keeps the Sepolia pins and has none on mainnet', () => {
    expect(ceremonyPinsFor(84532, SEPOLIA_DEPLOYMENTS)).toEqual(CEREMONY_PINS);
    expect(ceremonyPinsFor(8453, BASE_MAINNET_DEPLOYMENTS)).toBeNull();
    expect(ceremonyPinsFor(8453, TEST_TABLES[8453])).toBeNull();
    // Even a full mainnet layer gets no co-sign: the one attester binding is Sepolia's (P7).
    expect(ceremonyPinsFor(8453, SEPOLIA_DEPLOYMENTS)).toBeNull();
  });

  it('reads the body\'s chain, Sepolia when it names none', () => {
    expect(ceremonyChainId({})).toBe(84532);
    expect(ceremonyChainId(null)).toBe(84532);
    expect(ceremonyChainId({ chainId: 8453 })).toBe(8453);
    expect(ceremonyChainId({ chainId: '8453' })).toBe(8453);
    expect(ceremonyChainId({ chainId: -1 })).toBeNull();
    expect(ceremonyChainId({ chainId: 'base' })).toBeNull();
  });
});
