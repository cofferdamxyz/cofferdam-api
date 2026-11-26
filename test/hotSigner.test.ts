// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The plane's hot signers behind their switch (workspace decision 0090,
 * cdp-setup.md E4): which signer a role's env picks, that nothing falls back to
 * a raw key, that a CDP send resends under one idempotency key and never logs
 * CDP's own message, and the relay and the registrar on a CDP account.
 */

import { encodeAbiParameters, encodeEventTopics, encodePacked, keccak256, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, celo } from 'viem/chains';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/env.js';
import { submitUserOperation, sepoliaLane, type RelayLane } from '../src/routes/aa.js';
import { CdpApiError, type CdpClient, type SendTransactionInput } from '../src/services/cdp/client.js';
import type * as CdpClientModule from '../src/services/cdp/client.js';
import { registrarOf, statementSignerOf } from '../src/services/handles/anchor.js';
import { hotSigner, keySpec, sendThroughCdp, signerMissing, signerSpecOf, type SignerSpec } from '../src/services/hotSigner.js';
import { SendRefusedError } from '../src/services/relaySend.js';
import { ENTRY_POINT_V07, parseUserOperationBody } from '../src/services/userOp.js';
import { ENTRY_POINT_EVENTS_ABI } from '../src/services/userOpOutcome.js';

const chain = vi.hoisted(() => ({
  simulateContract: vi.fn(),
  simulateBlocks: vi.fn(),
  sendRawTransaction: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
}));
const cdp = vi.hoisted(() => ({ fake: null as unknown }));
vi.mock('../src/chain/client.js', () => ({ getBaseSepoliaClient: () => chain }));
vi.mock('../src/services/cdp/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof CdpClientModule>()),
  createCdpClient: () => cdp.fake,
}));

const CDP_ACCOUNT = privateKeyToAccount(generatePrivateKey());
const CREDS = { CDP_API_KEY_ID: 'id', CDP_API_KEY_SECRET: 'secret-value-api', CDP_WALLET_SECRET: 'secret-value-wallet' };
const TX_HASH = `0x${'cd'.repeat(32)}` as Hex;
const noSleep = async () => {};

/** A fake CDP client: signs typed data with the account's key, records every send. */
function fakeCdp(answers: Array<Hex | CdpApiError> = [TX_HASH]) {
  const sends: Array<{ address: Address; input: SendTransactionInput }> = [];
  const client: CdpClient = {
    getAccountByName: () => Promise.reject(new Error('unused')),
    signTypedData: (address, typedData) => {
      expect(address).toBe(CDP_ACCOUNT.address);
      return CDP_ACCOUNT.signTypedData(typedData as never);
    },
    sendTransaction: (address, input) => {
      sends.push({ address, input });
      const next = answers[Math.min(sends.length, answers.length) - 1]!;
      return next instanceof CdpApiError ? Promise.reject(next) : Promise.resolve({ transactionHash: next, idempotencyKey: input.idempotencyKey });
    },
  };
  return { client, sends };
}

describe('signerSpecOf: which signer a role uses', () => {
  const key = generatePrivateKey();

  it('defaults to the raw key, and is null without one or with a malformed one', () => {
    expect(signerSpecOf({ RELAYER_PRIVATE_KEY: key }, 'relayer')).toMatchObject({ kind: 'key', address: privateKeyToAccount(key).address });
    expect(signerSpecOf({ RELAYER_SIGNER: ' KEY ', RELAYER_PRIVATE_KEY: key }, 'relayer')?.kind).toBe('key');
    expect(signerSpecOf({}, 'relayer')).toBeNull();
    expect(signerSpecOf({ HANDLE_REGISTRAR_KEY: '0x1234' }, 'registrar')).toBeNull();
  });

  it('under cdp needs the account address and all three CDP secrets, and never falls back to the key', () => {
    const env = { RELAYER_SIGNER: 'cdp', RELAYER_PRIVATE_KEY: key, RELAYER_CDP_ADDRESS: CDP_ACCOUNT.address.toLowerCase(), ...CREDS };
    expect(signerSpecOf(env, 'relayer')).toMatchObject({ kind: 'cdp', address: CDP_ACCOUNT.address });
    expect(signerSpecOf({ ...env, RELAYER_CDP_ADDRESS: undefined }, 'relayer')).toBeNull();
    expect(signerSpecOf({ ...env, RELAYER_CDP_ADDRESS: '0xnot' }, 'relayer')).toBeNull();
    expect(signerSpecOf({ ...env, CDP_WALLET_SECRET: '' }, 'relayer')).toBeNull();
  });

  it('refuses an unknown switch instead of guessing', () => {
    expect(signerSpecOf({ RELAYER_SIGNER: 'cpd', RELAYER_PRIVATE_KEY: key }, 'relayer')).toBeNull();
    expect(signerMissing({ RELAYER_SIGNER: 'cpd' }, 'relayer')).toBe('RELAYER_SIGNER must be "key" or "cdp"');
  });

  it('names what is missing by name, never by value', () => {
    const env = { HANDLE_REGISTRAR_SIGNER: 'cdp', ...CREDS };
    const message = signerMissing(env, 'registrar');
    expect(message).toContain('HANDLE_REGISTRAR_CDP_ADDRESS');
    expect(message).not.toContain('secret-value');
    expect(signerMissing({}, 'registrar')).toBe('HANDLE_REGISTRAR_KEY not set');
  });
});

describe('sendThroughCdp: one idempotency key, no second transaction', () => {
  const tx = { to: ENTRY_POINT_V07, data: '0x765e827f' as Hex };

  it('resends a timeout and a 503 under the same key, then answers the hash', async () => {
    const { client, sends } = fakeCdp([new CdpApiError(0, 'timeout', undefined, ''), new CdpApiError(503, 'service_unavailable', 'c-1', ''), TX_HASH]);
    await expect(sendThroughCdp(client, CDP_ACCOUNT.address, 'base-sepolia', tx, { sleep: noSleep })).resolves.toBe(TX_HASH);
    expect(sends).toHaveLength(3);
    expect(new Set(sends.map((s) => s.input.idempotencyKey)).size).toBe(1);
    expect(sends[0]!.input).toMatchObject({ network: 'base-sepolia', transaction: { to: tx.to, data: tx.data } });
  });

  it('draws a new key per transaction', async () => {
    const { client, sends } = fakeCdp();
    await sendThroughCdp(client, CDP_ACCOUNT.address, 'base', tx);
    await sendThroughCdp(client, CDP_ACCOUNT.address, 'base', tx);
    expect(sends[0]!.input.idempotencyKey).not.toBe(sends[1]!.input.idempotencyKey);
  });

  it("stops at a policy refusal and reports CDP's type, never its message", async () => {
    const refusal = new CdpApiError(403, 'policy_violation', 'c-2', 'rejected: calldata 0xdeadbeef for 0xabc');
    const { client, sends } = fakeCdp([refusal]);
    const reports: string[] = [];
    const err = await sendThroughCdp(client, CDP_ACCOUNT.address, 'base', tx, { onAttemptError: (_a, _c, m) => reports.push(m) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendRefusedError);
    expect((err as SendRefusedError).rateLimited).toBe(false);
    expect(sends).toHaveLength(1);
    expect(reports).toEqual(['cdp 403 policy_violation (c-2)']);
    expect(JSON.stringify(reports) + (err as Error).message).not.toContain('deadbeef');
  });

  it('says nothing was taken when every attempt was rate-limited', async () => {
    const { client } = fakeCdp([new CdpApiError(429, 'rate_limit_exceeded', undefined, '')]);
    const err = await sendThroughCdp(client, CDP_ACCOUNT.address, 'base', tx, { sleep: noSleep }).catch((e: unknown) => e);
    expect((err as SendRefusedError).rateLimited).toBe(true);
  });

  it('passes the fees it is given and nothing else, so CDP fills the nonce and the gas', async () => {
    const { client, sends } = fakeCdp();
    await sendThroughCdp(client, CDP_ACCOUNT.address, 'base', { ...tx, maxFeePerGas: 7n, maxPriorityFeePerGas: 1n });
    expect(sends[0]!.input.transaction).toEqual({ to: tx.to, data: tx.data, maxFeePerGas: 7n, maxPriorityFeePerGas: 1n });
  });
});

describe('hotSigner', () => {
  const spec: SignerSpec = { kind: 'cdp', address: CDP_ACCOUNT.address, credentials: { apiKeyId: 'id', apiKeySecret: 's', walletSecret: 'w' } };
  const ctx = { chain: baseSepolia, rpcUrl: 'http://127.0.0.1:9', sendRaw: () => Promise.reject(new Error('never sent raw')) };

  it('signs typed data through the CDP account, recovering to it', async () => {
    const { client } = fakeCdp();
    const signer = hotSigner(spec, { ...ctx, cdp: client });
    const typedData = { domain: { name: 'T', chainId: 84532 }, types: { M: [{ name: 'n', type: 'uint256' }] }, primaryType: 'M', message: { n: 1n } } as const;
    const signature = await signer.signTypedData(typedData);
    await expect(recoverTypedDataAddress({ ...typedData, signature })).resolves.toBe(CDP_ACCOUNT.address);
  });

  it('refuses to send on a chain CDP does not serve', async () => {
    const { client, sends } = fakeCdp();
    const signer = hotSigner(spec, { ...ctx, chain: celo, cdp: client });
    await expect(signer.sendTransaction({ to: ENTRY_POINT_V07, data: '0x' })).rejects.toBeInstanceOf(SendRefusedError);
    expect(sends).toHaveLength(0);
  });

  it("keeps the raw key's address for the key kind", () => {
    const key = generatePrivateKey();
    expect(hotSigner(keySpec(key)!, ctx).address).toBe(privateKeyToAccount(key).address);
  });
});

describe('the handle registrar under cdp', () => {
  const env = { HANDLE_REGISTRAR_SIGNER: 'cdp', HANDLE_REGISTRAR_CDP_ADDRESS: CDP_ACCOUNT.address, ...CREDS } as unknown as Env;

  it("names the CDP account as the registrar, and refuses a statement key that is the registrar's own address", () => {
    expect(registrarOf(env)?.address).toBe(CDP_ACCOUNT.address);
    const statementKey = generatePrivateKey();
    expect(statementSignerOf({ ...env, HANDLE_STATEMENT_KEY: statementKey } as Env)?.address).toBe(privateKeyToAccount(statementKey).address);
    const same = { ...env, HANDLE_REGISTRAR_CDP_ADDRESS: privateKeyToAccount(statementKey).address, HANDLE_STATEMENT_KEY: statementKey } as unknown as Env;
    expect(statementSignerOf(same)).toBeNull();
  });
});

describe('the relay on a CDP account', () => {
  const SENDER: Address = '0x80967a159A00dcabe2DeAF86b68249acfc45C265';
  const pack = (a: bigint, b: bigint): Hex => encodePacked(['uint128', 'uint128'], [a, b]);
  const { userOp: op } = parseUserOperationBody({
    userOp: {
      sender: SENDER,
      nonce: '26',
      initCode: '0x',
      callData: '0x1234',
      accountGasLimits: pack(1_500_000n, 1_500_000n),
      preVerificationGas: '0',
      gasFees: pack(1_000_000n, 11_000_000n),
      paymasterAndData: encodePacked(['address', 'uint128', 'uint128'], [SENDER, 1_500_000n, 100_000n]),
      signature: '0x' + 'ab'.repeat(96),
    },
  });
  const env = {
    RELAYER_SIGNER: 'cdp',
    RELAYER_CDP_ADDRESS: CDP_ACCOUNT.address,
    RELAYER_PRIVATE_KEY: generatePrivateKey(),
    BASE_SEPOLIA_RPC_URL: 'http://127.0.0.1:9',
    ...CREDS,
  } as unknown as Env;
  const opEvent = {
    address: ENTRY_POINT_V07,
    topics: encodeEventTopics({ abi: ENTRY_POINT_EVENTS_ABI, eventName: 'UserOperationEvent', args: { userOpHash: keccak256('0x01'), sender: SENDER, paymaster: SENDER } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [26n, true, 1n, 1n]),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    chain.simulateContract.mockResolvedValue({ request: { address: ENTRY_POINT_V07, abi: [{ type: 'function', name: 'handleOps', inputs: [{ type: 'bytes' }, { type: 'address' }], outputs: [], stateMutability: 'nonpayable' }], functionName: 'handleOps', args: ['0x', CDP_ACCOUNT.address] } });
    chain.simulateBlocks.mockResolvedValue([{ calls: [{ status: 'success', logs: [opEvent] }] }]);
    chain.waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [opEvent] });
  });

  it('simulates from the CDP account, sends through CDP once, and never signs or sends raw', async () => {
    const { client, sends } = fakeCdp([new CdpApiError(502, 'bad_gateway', undefined, ''), TX_HASH]);
    cdp.fake = client;
    const lane = sepoliaLane(env) as RelayLane;
    expect(lane.signer.kind).toBe('cdp');
    await expect(submitUserOperation(env, op, async () => {}, 20_000, lane)).resolves.toEqual({ txHash: TX_HASH, receipt: 'success' });
    expect(chain.simulateContract.mock.calls[0]![0]).toMatchObject({ account: CDP_ACCOUNT.address, args: [[op], CDP_ACCOUNT.address] });
    expect(sends).toHaveLength(2);
    expect(sends[0]!.input.idempotencyKey).toBe(sends[1]!.input.idempotencyKey);
    expect(sends[0]!.address).toBe(CDP_ACCOUNT.address);
    expect(chain.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("refuses at the key's hard stop before CDP sees anything, and counts a receipt's gas", async () => {
    const { client, sends } = fakeCdp();
    cdp.fake = client;
    const admitted: boolean[] = [];
    const spent: Array<[string, string]> = [];
    let allow = false;
    const ns = {
      idFromName: (name: string) => name,
      get: () => ({
        admit: () => {
          admitted.push(allow);
          return Promise.resolve({ allowed: allow, calls: 0, gasWei: '0', alert: null });
        },
        spend: (_day: string, t: string, g: string) => {
          spent.push([t, g]);
          return Promise.resolve({ calls: 1, gasWei: g, alert: null });
        },
      }),
    };
    const budgeted = { ...env, KEY_BUDGET_DO: ns } as unknown as Env;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = await submitUserOperation(budgeted, op, async () => {}, 20_000, sepoliaLane(budgeted)).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'budget_exhausted' });
    expect(sends).toHaveLength(0);
    allow = true;
    chain.waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: [opEvent], gasUsed: 100n, effectiveGasPrice: 2n, l1Fee: 5n });
    await submitUserOperation(budgeted, op, async () => {}, 20_000, sepoliaLane(budgeted));
    expect(spent).toEqual([[TX_HASH, '205']]);
    vi.mocked(console.warn).mockRestore();
  });

  it('is not configured under cdp without its secrets, even with a raw key set', () => {
    expect(sepoliaLane({ ...env, CDP_API_KEY_SECRET: undefined } as Env)).toBeNull();
  });
});

