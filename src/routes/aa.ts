// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * /v1/aa routes — the ERC-4337 UserOperation relay (decision 0012).
 *
 *   POST /v1/aa/user-operation
 *     Body: `{ entryPoint?, userOp }` — a `PackedUserOperation` signed by the
 *     account's passkey (bigints as decimal strings, bytes as hex; see
 *     `@cofferdam/sdk` `serializeUserOperation`). The Worker checks the policy
 *     in `services/userOp.ts` (our paymaster, our factory, gas and fee caps),
 *     simulates `handleOps` from the relayer so a failing op costs nothing,
 *     then runs the execution pre-flight: the same `handleOps` through
 *     `eth_simulateV1`, whose logs say whether the op's own call succeeded
 *     (EntryPoint v0.7 catches a revert inside `account.execute`, so the
 *     first simulation passes a bind the registry will refuse; decision 0080,
 *     `services/userOpOutcome.ts`). It then submits with
 *     `RELAYER_PRIVATE_KEY`, waits up to `RECEIPT_WAIT_MS` for the receipt,
 *     reads the op's `UserOperationEvent`, and answers
 *       202 { ok: true, txHash, entryPoint, receipt: 'success' | 'pending' | 'unknown' }
 *     `pending` when the receipt has not come in time, `unknown` when
 *     `handleOps` itself reverted (the op may have run in an earlier send):
 *     the client still waits for the receipt and checks the op's own success. A not-yet-deployed account's
 *     first op carries `initCode`, so this is also how accounts get deployed:
 *     no app ever holds a funded key.
 *
 *     Errors: 400 bad_user_op | bad_entry_point | paymaster_* | factory_not_ours
 *     | gas_limit_exceeded | fee_too_high | prefund_too_high | simulation_failed
 *     (with the EntryPoint's AAxx reason) | execution_reverted (with the
 *     revert's error name; nothing sent), 422 user_op_reverted (mined, and the
 *     op's call reverted; with `txHash` and the error name), 429 rate_limited,
 *     503 relayer_not_configured | preflight_unavailable (the node cannot run
 *     `eth_simulateV1`), 502 relay_failed.
 *
 *   The op is self-authenticating (the EntryPoint verifies the passkey
 *   signature), so there is no session gate; the paymaster's deposit is what
 *   the policy and the rate limits protect. Limits, in order: a global brake,
 *   a generous per-IP ceiling, then the per-sender bucket, counted only once
 *   policy and the simulation pass, so knowing an address is not enough to
 *   lock its owner out. The relayer
 *   EOA's nonce is read per request (`pending`), which is fine at this volume;
 *   serialise it through a Durable Object before real traffic. The signed
 *   transaction is sent with one retry (`services/relaySend.ts`): the same
 *   bytes again on a transient node error, a fresh nonce on a nonce or fee
 *   clash; every refused attempt and every failed simulation is logged.
 */

import { Hono } from 'hono';
import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
  http,
  type Address,
  type Chain,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';

import { getBaseClient, getBaseSepoliaClient, type ChainClient } from '../chain/client.js';
import { DEFAULT_BASE_SEPOLIA_RPC_URL, chainRpcUrl } from '../chain/chains.js';
import { BASE_MAINNET_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID, SEPOLIA_DEPLOYMENTS } from '../chain/deployments.js';
import type { Env } from '../env.js';
import {
  DEFAULT_USER_OP_POLICY,
  ENTRY_POINT_ABI,
  ENTRY_POINT_V07,
  UserOpRequestError,
  checkUserOperationPolicy,
  parseUserOperationBody,
  type PackedUserOperationWire,
  type UserOpPolicy,
} from '../services/userOp.js';
import { identityLogLine } from '../services/identityLog.js';
import { sendWithRetry } from '../services/relaySend.js';
import {
  GAS_PRICE_ORACLE,
  GAS_PRICE_ORACLE_ABI,
  IDENTITY_REGISTRY_CHECK_ABI,
  checkTestRelayPolicy,
  effectiveGasPrice,
  registryCheckCall,
  requiredPreVerificationGas,
  testRelayConfig,
  unsignedTxSize,
  type TestRelayConfig,
} from '../services/testRelay.js';
import { unpackGasFees } from '../services/userOp.js';
import { opOutcome, revertName, type OutcomeLog } from '../services/userOpOutcome.js';

export class UserOpSubmitError extends Error {
  constructor(
    readonly code:
      | 'simulation_failed'
      | 'execution_reverted'
      | 'identity_check_failed'
      | 'fee_too_low'
      | 'pre_verification_gas_too_low'
      | 'preflight_unavailable'
      | 'relay_failed'
      | 'rate_limited'
      | 'user_op_reverted',
    message: string,
    /** The mined transaction, for `user_op_reverted`. */
    readonly txHash?: Hex,
  ) {
    super(message);
    this.name = 'UserOpSubmitError';
  }
}

/**
 * A sent op: its transaction, and what its receipt showed in time: the op's
 * own success, no receipt yet (`pending`), or a `handleOps` that reverted
 * (`unknown`: the op did not run in this transaction, but a resend after a
 * nonce clash means it may have run in the first one).
 */
export interface RelayOutcome {
  txHash: Hex;
  receipt: 'success' | 'pending' | 'unknown';
}

export interface AaRouteDeps {
  policy: UserOpPolicy;
  /**
   * Simulate, pre-flight and submit `handleOps([op], relayer)`; resolves with
   * the tx hash and what the receipt showed. `admit` must be awaited once the
   * simulation and the pre-flight pass and before the send; it throws
   * `rate_limited` to refuse. A reverted op throws `user_op_reverted`.
   */
  submit: (env: Env, op: PackedUserOperationWire, admit: () => Promise<void>, lane: RelayLane) => Promise<RelayOutcome>;
}

/**
 * Where an op is relayed. Base Sepolia's lane is the relay as it always was;
 * the Base mainnet test lane (decision 0080, M2) adds the registry's `check`
 * pre-flight and makes the op pay the L1 data fee.
 */
export interface RelayLane {
  readonly chainId: typeof BASE_SEPOLIA_CHAIN_ID | typeof BASE_MAINNET_CHAIN_ID;
  readonly rpcUrl: string;
  readonly privateKey: Hex;
  /** The identity registry whose `check` view pre-flights a bind, relink or rebind (none on Sepolia). */
  readonly identityRegistry?: Address;
  /** The op repays the L1 data fee through `preVerificationGas`, and the relayer signs at the op's own price. */
  readonly opPaysL1?: boolean;
}

/** Base Sepolia's lane: `BASE_SEPOLIA_RPC_URL` and `RELAYER_PRIVATE_KEY`, nothing added. */
export function sepoliaLane(env: Env): RelayLane {
  return {
    chainId: BASE_SEPOLIA_CHAIN_ID,
    rpcUrl: env.BASE_SEPOLIA_RPC_URL ?? DEFAULT_BASE_SEPOLIA_RPC_URL,
    privateKey: env.RELAYER_PRIVATE_KEY as Hex,
  };
}

/** The Base mainnet test lane, or null while the key or the mainnet switch is off. */
export function testLane(env: Env, config: TestRelayConfig): RelayLane | null {
  const rpcUrl = chainRpcUrl(env, BASE_MAINNET_CHAIN_ID);
  if (!rpcUrl || !env.RELAYER_MAINNET_TEST_PRIVATE_KEY) return null;
  return {
    chainId: BASE_MAINNET_CHAIN_ID,
    rpcUrl,
    privateKey: env.RELAYER_MAINNET_TEST_PRIVATE_KEY as Hex,
    identityRegistry: config.registry,
    opPaysL1: true,
  };
}

/** How long the relay waits for the receipt before answering `pending` (Base mines every 2 s; iOS gives up at 60 s). */
export const RECEIPT_WAIT_MS = 20_000;

/** The receipt poll's interval: Base's block time, so the wait costs about one node call per block. */
const RECEIPT_POLL_MS = 2_000;

const GLOBAL_KEY = 'aa:global';

/**
 * The chain the body names (`chainId`, Base Sepolia when absent, so every op
 * the SDK sends today keeps its path), or null when it is not a positive
 * safe integer.
 */
export function relayChainId(body: unknown): number | null {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>).chainId : undefined;
  if (raw === undefined) return BASE_SEPOLIA_CHAIN_ID;
  const n = typeof raw === 'string' && /^\d{1,16}$/.test(raw) ? Number(raw) : raw;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function overLimit(rl: RateLimit | undefined, key: string): Promise<boolean> {
  if (!rl) return false;
  try {
    const { success } = await rl.limit({ key });
    return !success;
  } catch {
    return false;
  }
}

/** The EntryPoint's `FailedOp(opIndex, reason)` reason, if the revert decodes. */
function revertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const args = revert.data?.args as readonly unknown[] | undefined;
      const name = revert.data?.errorName ?? revert.reason ?? 'revert';
      return args && args.length >= 2 ? `${name}: ${String(args[1])}` : name;
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * One structured log line per refused relay step. The relay is an identity
 * route (a bind is an op of the account's own), so the line follows the
 * identity log policy (`services/identityLog.ts`): the sender and nonce, a
 * reason by name, never the op's call data, init code or signature. Until
 * 2026-10-30 the bigint nonce made it throw, so every refused send answered
 * `relay_failed` "Do not know how to serialize a BigInt" in place of the
 * node's error, and a failed simulation lost its `simulation_failed`.
 */
function logRelay(event: string, op: PackedUserOperationWire, fields: Record<string, unknown>): void {
  console.warn(identityLogLine({ event, sender: op.sender, nonce: op.nonce, ...fields }));
}

/** A node that cannot run `eth_simulateV1`: JSON-RPC's method-not-found, or the method named as missing. */
function simulateUnsupported(err: unknown): boolean {
  const text = err instanceof BaseError ? `${err.shortMessage} ${err.details}` : String(err);
  return /-32601|method not found|eth_simulateV1[^]*(does not exist|not available|not supported|unsupported)/i.test(text);
}

/** `handleOps`' own revert in the pre-flight, decoded as the simulation decodes it (`FailedOp: AAxx …`). */
function handleOpsRevert(data: Hex | undefined, err: unknown): string {
  if (data && data !== '0x') {
    try {
      const decoded = decodeErrorResult({ abi: ENTRY_POINT_ABI, data });
      const args = decoded.args as readonly unknown[] | undefined;
      return args && args.length >= 2 ? `${decoded.errorName}: ${String(args[1])}` : decoded.errorName;
    } catch {
      // not an EntryPoint error: fall through to the node's message
    }
  }
  return revertReason(err);
}

/**
 * The execution pre-flight: `handleOps([op])` again through `eth_simulateV1`,
 * whose logs carry the op's `UserOperationEvent`. A revert inside the op's own
 * call throws `execution_reverted` with the error's name; a node that cannot
 * simulate throws `preflight_unavailable`. Fails closed: the relay sends
 * nothing it could not pre-flight.
 */
async function preflightExecution(
  client: Pick<ChainClient, 'simulateBlocks'>,
  from: Hex,
  data: Hex,
  op: PackedUserOperationWire,
): Promise<void> {
  let call;
  try {
    const [block] = await client.simulateBlocks({
      blocks: [{ calls: [{ account: from, to: ENTRY_POINT_V07, data }] }],
    });
    call = block?.calls[0];
  } catch (err) {
    const reason = simulateUnsupported(err) ? 'eth_simulateV1 unsupported' : revertReason(err);
    logRelay('aa_preflight_unavailable', op, { reason });
    throw new UserOpSubmitError('preflight_unavailable', reason);
  }
  if (!call) {
    logRelay('aa_preflight_unavailable', op, { reason: 'no call result' });
    throw new UserOpSubmitError('preflight_unavailable', 'no call result');
  }
  if (call.status !== 'success') {
    // `handleOps` itself reverted here although `eth_call` passed: a state
    // change between the two reads. Nothing is sent.
    const reason = handleOpsRevert(call.data, call.error);
    logRelay('aa_simulation_failed', op, { reason, preflight: true });
    throw new UserOpSubmitError('simulation_failed', reason);
  }
  const outcome = opOutcome((call.logs ?? []) as OutcomeLog[], ENTRY_POINT_V07, op.sender, op.nonce);
  if (outcome.status === 'success') return;
  const reason = outcome.status === 'reverted' ? outcome.reason : 'not_executed';
  logRelay('aa_execution_reverted', op, { reason });
  throw new UserOpSubmitError('execution_reverted', reason);
}

/** The revert data of a failed `eth_call`, if the node returned any. */
function revertData(err: unknown): Hex | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError ? revert.raw : undefined;
}

/**
 * The registry's own pre-flight (`CofferdamIdentityRegistry.check`, base-contracts
 * PR #21) for an op that binds, relinks or rebinds: the same checks the call
 * will run, with no simulation of the account. A refusal answers
 * `identity_check_failed` with the error's name; the identifier `check`
 * returns, or carries in its errors, is never read, logged or answered.
 */
async function registryPreflight(client: Pick<ChainClient, 'readContract'>, registry: Address, op: PackedUserOperationWire): Promise<void> {
  const call = registryCheckCall(op.callData, registry);
  if (!call) return;
  try {
    await client.readContract({
      address: registry,
      abi: IDENTITY_REGISTRY_CHECK_ABI,
      functionName: 'check',
      args: [call.action, op.sender, call.adapter, call.evidence],
    });
  } catch (err) {
    const data = revertData(err);
    if (data !== undefined || (err instanceof BaseError && err.walk((e) => e instanceof ContractFunctionRevertedError))) {
      const reason = revertName(data);
      logRelay('aa_identity_check_failed', op, { reason });
      throw new UserOpSubmitError('identity_check_failed', reason);
    }
    const reason = revertReason(err);
    logRelay('aa_preflight_unavailable', op, { reason });
    throw new UserOpSubmitError('preflight_unavailable', reason);
  }
}

/**
 * The mainnet test lane's fee check: the op's price must clear the base fee
 * with a margin (the relayer signs at that price), and its
 * `preVerificationGas` must repay the L1 data fee the relayer's transaction
 * pays (`requiredPreVerificationGas`). The SDK sends 0 today, so until it
 * estimates the value every op meets `pre_verification_gas_too_low`, whose
 * message names the least value.
 */
async function l1FeePreflight(client: Pick<ChainClient, 'getBlock' | 'readContract'>, op: PackedUserOperationWire, data: Hex): Promise<void> {
  let baseFee: bigint;
  let l1Fee: bigint;
  try {
    const [block, fee] = await Promise.all([
      client.getBlock({ blockTag: 'latest' }),
      client.readContract({ address: GAS_PRICE_ORACLE, abi: GAS_PRICE_ORACLE_ABI, functionName: 'getL1FeeUpperBound', args: [unsignedTxSize(data)] }),
    ]);
    baseFee = block.baseFeePerGas ?? 0n;
    l1Fee = fee;
  } catch (err) {
    const reason = revertReason(err);
    logRelay('aa_preflight_unavailable', op, { reason, step: 'l1_fee' });
    throw new UserOpSubmitError('preflight_unavailable', reason);
  }
  const { maxFeePerGas } = unpackGasFees(op.gasFees);
  if (maxFeePerGas * 4n < baseFee * 5n) {
    throw new UserOpSubmitError('fee_too_low', `maxFeePerGas must be at least ${(baseFee * 5n + 3n) / 4n} (the base fee and a quarter)`);
  }
  const required = requiredPreVerificationGas(l1Fee, effectiveGasPrice(op, baseFee), data);
  if (required === null || op.preVerificationGas < required) {
    throw new UserOpSubmitError(
      'pre_verification_gas_too_low',
      required === null ? 'the op pays nothing at this price' : `preVerificationGas must be at least ${required} to repay the L1 data fee`,
    );
  }
}

/**
 * Pre-flight from the relayer, admit, submit (signed once, one retry), then read
 * the op's own outcome. In order: the registry's `check` (a lane with an
 * identity registry), the `handleOps` simulation, the L1 fee (a lane where the
 * op pays it), the execution pre-flight, the per-sender bucket, the send and
 * the receipt.
 */
export async function submitUserOperation(
  env: Env,
  op: PackedUserOperationWire,
  admit: () => Promise<void> = async () => {},
  receiptWaitMs: number = RECEIPT_WAIT_MS,
  lane: RelayLane = sepoliaLane(env),
): Promise<RelayOutcome> {
  const { rpcUrl } = lane;
  const relayer = privateKeyToAccount(lane.privateKey);
  const publicClient: ChainClient =
    lane.chainId === BASE_SEPOLIA_CHAIN_ID ? (getBaseSepoliaClient(rpcUrl) as unknown as ChainClient) : getBaseClient(rpcUrl);
  const chain: Chain = lane.chainId === BASE_SEPOLIA_CHAIN_ID ? baseSepolia : base;
  if (lane.identityRegistry) await registryPreflight(publicClient, lane.identityRegistry, op);
  let request;
  try {
    ({ request } = await publicClient.simulateContract({
      address: ENTRY_POINT_V07,
      abi: ENTRY_POINT_ABI,
      functionName: 'handleOps',
      args: [[op], relayer.address],
      account: relayer,
    }));
  } catch (err) {
    const reason = revertReason(err);
    logRelay('aa_simulation_failed', op, { reason });
    throw new UserOpSubmitError('simulation_failed', reason);
  }
  const data = encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args });
  if (lane.opPaysL1) await l1FeePreflight(publicClient, op, data);
  await preflightExecution(publicClient, relayer.address, data, op);
  await admit();
  const wallet = createWalletClient({ account: relayer, chain, transport: http(rpcUrl) });
  // The mainnet test lane signs at the op's own price, so the EntryPoint's
  // repayment matches what the relayer's transaction pays for L2 gas.
  const fees = lane.opPaysL1 ? unpackGasFees(op.gasFees) : null;
  let txHash: Hex;
  try {
    txHash = await sendWithRetry({
      sign: async () => {
        const prepared = await wallet.prepareTransactionRequest({
          to: request.address,
          data,
          chain,
          ...(fees ? { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas } : {}),
        });
        return wallet.signTransaction(prepared);
      },
      send: (raw) => publicClient.sendRawTransaction({ serializedTransaction: raw }),
      onAttemptError: (attempt, cls, reason) => logRelay('aa_send_refused', op, { attempt, class: cls, reason }),
    });
  } catch (err) {
    throw new UserOpSubmitError('relay_failed', revertReason(err));
  }

  // The op's own outcome. A receipt that does not come in time, or a node
  // error reading it, is `pending`: the transaction is out, and the client
  // reads the receipt itself.
  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: receiptWaitMs, pollingInterval: RECEIPT_POLL_MS });
  } catch (err) {
    logRelay('aa_receipt_pending', op, { txHash, reason: revertReason(err) });
    return { txHash, receipt: 'pending' };
  }
  if (receipt.status !== 'success') {
    // `handleOps` itself reverted: the op did not run in this transaction. A
    // resend after a nonce clash (`relaySend.ts`) may mean it ran in the
    // first, so its fate is not ours to call reverted.
    logRelay('aa_handle_ops_reverted', op, { txHash });
    return { txHash, receipt: 'unknown' };
  }
  const outcome = opOutcome(receipt.logs as OutcomeLog[], ENTRY_POINT_V07, op.sender, op.nonce);
  if (outcome.status === 'success') return { txHash, receipt: 'success' };
  const reason = outcome.status === 'reverted' ? outcome.reason : 'not_executed';
  logRelay('aa_user_op_reverted', op, { txHash, reason });
  throw new UserOpSubmitError('user_op_reverted', reason, txHash);
}

/** The answer's status per submission failure. */
const SUBMIT_STATUS = {
  simulation_failed: 400,
  execution_reverted: 400,
  identity_check_failed: 400,
  fee_too_low: 400,
  pre_verification_gas_too_low: 400,
  user_op_reverted: 422,
  rate_limited: 429,
  relay_failed: 502,
  preflight_unavailable: 503,
} as const satisfies Record<UserOpSubmitError['code'], number>;

export function createAaRoutes(deps: AaRouteDeps) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.post('/user-operation', async (c) => {
    if (await overLimit(c.env.AA_RELAY_RL, GLOBAL_KEY)) {
      return c.json({ ok: false, error: 'rate_limited', message: 'the relay is busy; retry shortly' }, 429);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'bad_request', message: 'Invalid JSON body' }, 400);
    }
    // The chain the body names: Base Sepolia when it names none. Base mainnet
    // is the test relay (decision 0080, M2), refused unless every switch is
    // on; any other chain is refused. Both before any other limiter.
    const chainId = relayChainId(body);
    const config = chainId === BASE_MAINNET_CHAIN_ID ? testRelayConfig(c.env) : null;
    if (chainId !== BASE_SEPOLIA_CHAIN_ID && !config) {
      return c.json({ ok: false, error: 'chain_unsupported', message: 'the relay serves Base Sepolia, and Base mainnet only as the switched-on test relay' }, 400);
    }
    const ip = c.req.header('cf-connecting-ip');
    if (ip && (await overLimit(c.env.AA_RELAY_IP_RL, `aa-ip:${ip}`))) {
      return c.json({ ok: false, error: 'rate_limited', message: 'too many requests from this network; retry shortly' }, 429);
    }
    let parsed;
    try {
      parsed = parseUserOperationBody(body);
      if (config) checkTestRelayPolicy(parsed.userOp, config);
      else checkUserOperationPolicy(parsed.userOp, deps.policy);
    } catch (err) {
      if (err instanceof UserOpRequestError) {
        return c.json({ ok: false, error: err.code, message: err.message }, err.code === 'not_test_account' ? 403 : 400);
      }
      throw err;
    }
    let lane: RelayLane;
    if (config) {
      const test = testLane(c.env, config);
      if (!test) {
        return c.json({ ok: false, error: 'relayer_not_configured', message: 'RELAYER_MAINNET_TEST_PRIVATE_KEY not set' }, 503);
      }
      lane = test;
    } else {
      if (!c.env.RELAYER_PRIVATE_KEY) {
        return c.json({ ok: false, error: 'relayer_not_configured', message: 'RELAYER_PRIVATE_KEY not set' }, 503);
      }
      lane = sepoliaLane(c.env);
    }
    try {
      // The per-sender bucket is counted only once policy and the handleOps
      // simulation pass (the EntryPoint has checked the passkey signature):
      // sender addresses are public, so an earlier count lets anyone lock the
      // owner out of the relay.
      const sender = parsed.userOp.sender.toLowerCase();
      const bucket = config ? `aa-test:${sender}` : `aa:${sender}`;
      const admit = async () => {
        if (await overLimit(c.env.AA_RELAY_RL, bucket)) {
          throw new UserOpSubmitError('rate_limited', 'too many ops for this account; retry shortly');
        }
      };
      const { txHash, receipt } = await deps.submit(c.env, parsed.userOp, admit, lane);
      return c.json({ ok: true, txHash, entryPoint: parsed.entryPoint, chainId: lane.chainId, receipt }, 202);
    } catch (err) {
      if (err instanceof UserOpSubmitError) {
        const status = SUBMIT_STATUS[err.code];
        return c.json(
          { ok: false, error: err.code, message: err.message, ...(err.txHash ? { txHash: err.txHash } : {}) },
          status,
        );
      }
      throw err;
    }
  });

  return routes;
}

export const aaRoutes = createAaRoutes({
  policy: {
    ...DEFAULT_USER_OP_POLICY,
    paymaster: SEPOLIA_DEPLOYMENTS.CofferdamPaymaster.address,
    factory: SEPOLIA_DEPLOYMENTS.CofferdamAccountFactory4337.address,
  },
  submit: (env, op, admit, lane) => submitUserOperation(env, op, admit, RECEIPT_WAIT_MS, lane),
});
