// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The identity log policy (`src/services/identityLog.ts`, workspace decision
 * 0080): a log line of an identity route never holds a passport identifier, a
 * proof or its public inputs, evidence, `custom_data` / `userContextData`, an
 * op's call data, init code or signature, or a second account bound to the
 * same passport, since every line names the account and Workers Logs keep the
 * IP. This drives `/v1/self/verify` (bind, rebind, attester refusal), the
 * pickup and the relay (pre-flight refusal, mined revert, refused send, failed
 * simulation) with every console method recorded, and fails on a forbidden key
 * at any depth or a forbidden value anywhere in a line.
 */

import { Hono } from 'hono';
import {
  BaseError,
  concat,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  encodePacked,
  keccak256,
  pad,
  parseAbi,
  ripemd160,
  sha256,
  type Address,
  type Hex,
} from 'viem';
import type * as Viem from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/env.js';
import plane from '../src/index.js';
import { createAaRoutes, submitUserOperation } from '../src/routes/aa.js';
import { createSelfRoutes, type BindStatus } from '../src/routes/self.js';
import type { SignBindRequest, SignBindResponse } from '../src/services/attester.js';
import type { BundleStore } from '../src/services/bundleStore.js';
import { IDENTITY_LOG_FORBIDDEN_KEY, identityLogLine } from '../src/services/identityLog.js';
import { DEFAULT_USER_OP_POLICY, ENTRY_POINT_V07 } from '../src/services/userOp.js';
import { ENTRY_POINT_EVENTS_ABI } from '../src/services/userOpOutcome.js';

const chain = vi.hoisted(() => ({
  simulateContract: vi.fn(),
  simulateBlocks: vi.fn(),
  sendRawTransaction: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
}));
const wallet = vi.hoisted(() => ({ prepareTransactionRequest: vi.fn(), signTransaction: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('../src/chain/client.js', () => ({ getBaseSepoliaClient: () => chain, getBaseClient: () => chain }));
vi.mock('viem', async (importOriginal) => ({ ...(await importOriginal<typeof Viem>()), createWalletClient: () => wallet }));

const ACCOUNT: Address = '0xfa4D920d5592289A1A0F73CA49D626EF8FE4D695';
/** The account a rebind moves the passport from: never logged beside `ACCOUNT`. */
const PREVIOUS: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
/** Distinctive values, so a leak is found wherever it lands in a line. */
const NULLIFIER = '918273645091827364509182736450918273645';
const PROOF = ['5551234567890123456789', '5552234567890123456789', '5553234567890123456789'];
const IDENTIFIER = keccak256('0x0bad1d');
const EVIDENCE = ('0x' + 'c0ffee'.repeat(48)) as Hex;
const SIGNATURE = ('0x' + 'ab'.repeat(96)) as Hex;
const CTX = concat([encodePacked(['uint256'], [42220n]), pad(ACCOUNT, { size: 32 })]);

/** Every recorded line, from every console method. */
let lines: string[] = [];
beforeEach(() => {
  lines = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.message} ${a.stack ?? ''}` : JSON.stringify(a))).join(' '));
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function forbiddenKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(IDENTITY_LOG_FORBIDDEN_KEY.test(k) ? [`${path}.${k}`] : []),
      ...forbiddenKeys(v, `${path}.${k}`),
    ]);
  }
  return [];
}

/** The policy, checked on every line recorded so far. */
function expectPolicyKept(extraValues: string[] = []): void {
  const values = [NULLIFIER, ...PROOF, IDENTIFIER.slice(2), EVIDENCE.slice(2, 40), SIGNATURE.slice(2, 40), CTX.slice(2), PREVIOUS.slice(2), ...extraValues];
  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const v of values) expect(lower, `a log line carries ${v}: ${line}`).not.toContain(v.toLowerCase());
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      /* a plain line is checked by value only */
    }
    expect(forbiddenKeys(parsed), `a log line holds a forbidden key: ${line}`).toEqual([]);
  }
}

describe('identityLogLine', () => {
  it('drops a forbidden key at any depth and writes bigints as strings', () => {
    const line = identityLogLine({
      kind: 'x',
      account: ACCOUNT,
      nonce: 26n,
      nullifier: NULLIFIER,
      nested: { customData: '0x01', userContextData: CTX, ok: 1, list: [{ proof: PROOF, keep: true }] },
      previousAccount: PREVIOUS,
      proofDate: '2026-10-10',
    });
    expect(JSON.parse(line)).toEqual({
      kind: 'x',
      account: ACCOUNT,
      nonce: '26',
      nested: { ok: 1, list: [{ keep: true }] },
      proofDate: '2026-10-10',
    });
  });
});

describe('/v1/self/* logs (Self, Base Sepolia until the cut-over)', () => {
  function relayerBody(): Record<string, unknown> {
    const signals = new Array<string>(21).fill('0');
    signals[7] = NULLIFIER;
    signals[8] = '1';
    signals[9] = '1028250853844545477525675497463046671568825934242895532070630707193360198082';
    signals[20] = BigInt(ripemd160(sha256(CTX))).toString();
    return {
      attestationId: 1,
      proof: { a: [PROOF[0], PROOF[1]], b: [[PROOF[2], PROOF[0]], [PROOF[1], PROOF[2]]], c: [PROOF[0], PROOF[1]] },
      publicSignals: signals,
      userContextData: CTX.slice(2),
    };
  }
  const signed = (req: SignBindRequest): SignBindResponse => ({
    attesterAddress: '0x2dFDdE621680A270cC01E8D9D729f25a46Bdae59',
    messageHash: `0x${'ab'.repeat(32)}`,
    signature: `0x${'cd'.repeat(65)}`,
    chainId: '84532',
    registry: req.registry,
    account: req.account,
    userContextData: req.userContextData,
    gate: 'celo',
    celo: { chainId: '42220', registry: '0x37F5CB8cB1f6B00aa768D8aA99F1A9289802A968', merkleRoot: req.pubSignals[9]!, proofDate: '2026-10-10' },
  });
  const store = (): BundleStore => {
    const data = new Map<string, unknown>();
    return {
      put: async (b) => void data.set(b.account.toLowerCase(), JSON.parse(JSON.stringify(b))),
      get: async (a) => (data.get(a.toLowerCase()) as never) ?? null,
      delete: async (a) => void data.delete(a.toLowerCase()),
    };
  };
  const harness = (bindStatus: BindStatus, sign: (req: SignBindRequest) => Promise<SignBindResponse>) => {
    const env = {
      ENVIRONMENT: 'development',
      BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
      ATTESTER: { signBind: sign, signRebind: async (req: SignBindRequest & { epoch: string }) => ({ ...(await sign(req)), epoch: req.epoch }) },
    } as unknown as Env;
    const app = new Hono<{ Bindings: Env }>();
    const s = store();
    app.route(
      '/v1/self',
      createSelfRoutes({
        bindStatus: async () => bindStatus,
        rebindEpoch: async () => 1n,
        now: () => 1_760_000_000_000,
        attestationMaxAgeMs: 600_000,
        store: () => s,
        authorityCheck: async () => ({ status: 'active', authorityId: 0, module: ACCOUNT, tier: 3 }),
        replayStore: () => null,
      }),
    );
    const post = () =>
      app.request('/v1/self/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(relayerBody()) }, env);
    const pickup = () => app.request(`/v1/self/bind-bundle/${ACCOUNT}`, {}, env);
    return { post, pickup };
  };

  it('a bind logs the account, never the nullifier, the proof or the user context', async () => {
    const h = harness({ kind: 'unbound' }, async (req) => signed(req));
    expect((await h.post()).status).toBe(200);
    expect((await h.pickup()).status).toBe(200);
    expect(lines.length).toBeGreaterThan(0);
    expectPolicyKept();
    // What the line keeps: the account, the bundle and the Celo receipt's date.
    expect(lines.map((l) => (l.startsWith('{') ? (JSON.parse(l) as Record<string, unknown>) : null)).find((l) => l?.kind === 'self.verify')).toMatchObject({
      account: ACCOUNT,
      bundle: 'bind',
      proofDate: '2026-10-10',
    });
  });

  it('a rebind never logs the account the passport moves from', async () => {
    const h = harness({ kind: 'nullifier_already_bound', boundAccount: PREVIOUS }, async (req) => signed(req));
    expect((await h.post()).status).toBe(200);
    expect(lines.length).toBeGreaterThan(0);
    expectPolicyKept();
  });

  it("an attester refusal logs its code and its message with the nullifier and the account cut", async () => {
    const h = harness({ kind: 'unbound' }, async () => {
      throw new Error(`CELO_ROOT_UNKNOWN: nullifier ${NULLIFIER} for ${ACCOUNT}`);
    });
    expect((await h.post()).status).toBe(400);
    expect(lines.length).toBeGreaterThan(0);
    expectPolicyKept();
    expect(lines.join('\n')).toContain('"detail":"CELO_ROOT_UNKNOWN: nullifier … for 0x…"');
  });
});

describe('/v1/aa/user-operation logs (a bind is an op of the account itself)', () => {
  const REGISTRY: Address = '0x1111111111111111111111111111111111111111';
  const callData = encodeFunctionData({
    abi: parseAbi(['function execute(address target, uint256 value, bytes data)']),
    functionName: 'execute',
    args: [REGISTRY, 0n, encodeFunctionData({ abi: parseAbi(['function bind(address adapter, bytes evidence)']), functionName: 'bind', args: [REGISTRY, EVIDENCE] })],
  });
  const pack = (a: bigint, b: bigint): Hex => encodePacked(['uint128', 'uint128'], [a, b]);
  const PAYMASTER: Address = '0x2222222222222222222222222222222222222222';
  const wireOp = {
    sender: ACCOUNT,
    nonce: '26',
    initCode: '0x',
    callData,
    accountGasLimits: pack(1_500_000n, 1_500_000n),
    preVerificationGas: '0',
    gasFees: pack(1_000_000n, 1_000_000n),
    paymasterAndData: encodePacked(['address', 'uint128', 'uint128'], [PAYMASTER, 1_500_000n, 100_000n]),
    signature: SIGNATURE,
  };
  const env = { RELAYER_PRIVATE_KEY: generatePrivateKey(), BASE_SEPOLIA_RPC_URL: 'http://127.0.0.1:9' } as unknown as Env;
  const app = () => {
    const h = new Hono<{ Bindings: Env }>();
    h.route('/v1/aa', createAaRoutes({ policy: { ...DEFAULT_USER_OP_POLICY, paymaster: PAYMASTER, factory: REGISTRY }, submit: submitUserOperation }));
    return h;
  };
  const post = () =>
    app().request(
      '/v1/aa/user-operation',
      { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' }, body: JSON.stringify({ userOp: wireOp }) },
      env,
    );

  const HASH = keccak256('0x03');
  const refusal = encodeErrorResult({
    abi: parseAbi(['error IdentifierAlreadyBound(bytes32 identifier, address account)']),
    errorName: 'IdentifierAlreadyBound',
    args: [IDENTIFIER, PREVIOUS],
  });
  const logs = (success: boolean) => [
    {
      address: ENTRY_POINT_V07,
      topics: encodeEventTopics({ abi: ENTRY_POINT_EVENTS_ABI, eventName: 'UserOperationRevertReason', args: { userOpHash: HASH, sender: ACCOUNT } }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes' }], [26n, refusal]),
    },
    {
      address: ENTRY_POINT_V07,
      topics: encodeEventTopics({ abi: ENTRY_POINT_EVENTS_ABI, eventName: 'UserOperationEvent', args: { userOpHash: HASH, sender: ACCOUNT, paymaster: PAYMASTER } }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [26n, success, 1n, 1n]),
    },
  ];

  beforeEach(() => {
    chain.simulateContract.mockImplementation(async ({ abi, functionName, args }: { abi: unknown; functionName: string; args: unknown }) => ({
      request: { abi, functionName, args, address: ENTRY_POINT_V07 },
    }));
    chain.simulateBlocks.mockResolvedValue([{ calls: [{ status: 'success', logs: logs(true), data: '0x', gasUsed: 1n }] }]);
    chain.waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: logs(true) });
    wallet.prepareTransactionRequest.mockResolvedValue({});
    wallet.signTransaction.mockResolvedValue('0x02f86d0101');
  });

  it('a bind the registry refuses in the pre-flight logs the error name only', async () => {
    chain.simulateBlocks.mockResolvedValue([{ calls: [{ status: 'success', logs: logs(false), data: '0x', gasUsed: 1n }] }]);
    const res = await post();
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'execution_reverted', message: 'IdentifierAlreadyBound' });
    expect(lines.length).toBeGreaterThan(0);
    expectPolicyKept();
  });

  it('a mined bind that reverted logs the error name only', async () => {
    chain.sendRawTransaction.mockResolvedValue(keccak256('0x02f86d0101'));
    chain.waitForTransactionReceipt.mockResolvedValue({ status: 'success', logs: logs(false) });
    const res = await post();
    expect(res.status).toBe(422);
    expectPolicyKept();
  });

  it('a refused send, a failed simulation and an unavailable pre-flight log no part of the op', async () => {
    chain.sendRawTransaction.mockRejectedValue(Object.assign(new Error('HTTP request failed.'), { details: 'insufficient funds for gas * price + value' }));
    expect((await post()).status).toBe(502);
    chain.simulateContract.mockRejectedValue(new BaseError('execution reverted'));
    expect((await post()).status).toBe(400);
    chain.simulateContract.mockReset();
    chain.simulateContract.mockImplementation(async ({ abi, functionName, args }: { abi: unknown; functionName: string; args: unknown }) => ({
      request: { abi, functionName, args, address: ENTRY_POINT_V07 },
    }));
    chain.simulateBlocks.mockRejectedValue(new BaseError('the method eth_simulateV1 does not exist'));
    expect((await post()).status).toBe(503);
    expect(lines.length).toBeGreaterThan(2);
    expectPolicyKept([callData.slice(10, 80)]);
  });
});

describe("the plane's unhandled-error log on an identity route", () => {
  it('logs the error by name and cut message, never the request or the nullifier', async () => {
    const signals = new Array<string>(21).fill('0');
    signals[7] = NULLIFIER;
    signals[8] = '1';
    signals[9] = '1028250853844545477525675497463046671568825934242895532070630707193360198082';
    signals[20] = BigInt(ripemd160(sha256(CTX))).toString();
    const body = {
      attestationId: 1,
      proof: { a: [PROOF[0], PROOF[1]], b: [[PROOF[2], PROOF[0]], [PROOF[1], PROOF[2]]], c: [PROOF[0], PROOF[1]] },
      publicSignals: signals,
      userContextData: CTX.slice(2),
    };
    const env = {
      ENVIRONMENT: 'development',
      BASE_SEPOLIA_RPC_URL: 'http://127.0.0.1:9',
      ATTESTER: {
        signBind: async (req: SignBindRequest) => ({
          attesterAddress: '0x2dFDdE621680A270cC01E8D9D729f25a46Bdae59',
          messageHash: `0x${'ab'.repeat(32)}`,
          signature: `0x${'cd'.repeat(65)}`,
          chainId: '84532',
          registry: req.registry,
          account: req.account,
          userContextData: req.userContextData,
          gate: 'celo',
          celo: { chainId: '42220', registry: '0x37F5CB8cB1f6B00aa768D8aA99F1A9289802A968', merkleRoot: '1', proofDate: '2026-10-10' },
        }),
      },
      // The bundle store fails with the nullifier in its message: an unhandled error.
      BIND_BUNDLES_DO: {
        getByName: () => ({
          put: async () => {
            throw new Error(`put refused for nullifier ${NULLIFIER} and ${CTX}`);
          },
        }),
      },
    } as unknown as Env;
    const res = await plane.request(
      '/v1/self/verify',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      env,
    );
    expect(res.status).toBe(500);
    expectPolicyKept();
    const unhandled = lines.find((l) => l.includes('"unhandled"'));
    expect(unhandled && JSON.parse(unhandled)).toEqual({
      event: 'unhandled',
      route: '/v1/self/verify',
      name: 'Error',
      message: 'put refused for nullifier … and 0x…',
    });
  });
});
