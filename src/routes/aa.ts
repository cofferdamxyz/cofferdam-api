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
 *       202 { ok: true, txHash, entryPoint, receipt: 'success' | 'pending' }
 *     `pending` when the receipt has not come in time: the client still waits
 *     for it and checks the op's own success. A not-yet-deployed account's
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
import { BaseError, ContractFunctionRevertedError, createWalletClient, encodeFunctionData, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

import { getBaseSepoliaClient } from '../chain/client.js';
import { DEFAULT_BASE_SEPOLIA_RPC_URL } from '../chain/chains.js';
import { SEPOLIA_DEPLOYMENTS } from '../chain/deployments.js';
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
import { opOutcome, type OutcomeLog } from '../services/userOpOutcome.js';

export class UserOpSubmitError extends Error {
  constructor(
    readonly code:
      | 'simulation_failed'
      | 'execution_reverted'
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

/** A sent op: its transaction, and whether its receipt showed the op's own success in time. */
export interface RelayOutcome {
  txHash: Hex;
  receipt: 'success' | 'pending';
}

export interface AaRouteDeps {
  policy: UserOpPolicy;
  /**
   * Simulate, pre-flight and submit `handleOps([op], relayer)`; resolves with
   * the tx hash and what the receipt showed. `admit` must be awaited once the
   * simulation and the pre-flight pass and before the send; it throws
   * `rate_limited` to refuse. A reverted op throws `user_op_reverted`.
   */
  submit: (env: Env, op: PackedUserOperationWire, admit: () => Promise<void>) => Promise<RelayOutcome>;
}

/** How long the relay waits for the receipt before answering `pending` (Base mines every 2 s; iOS gives up at 60 s). */
export const RECEIPT_WAIT_MS = 20_000;

const GLOBAL_KEY = 'aa:global';

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

/** A node that cannot run `eth_simulateV1` (method missing or refused as unsupported). */
function simulateUnsupported(err: unknown): boolean {
  const text = err instanceof BaseError ? `${err.shortMessage} ${err.details}` : String(err);
  return /method not found|not supported|unsupported|does not exist|-32601/i.test(text);
}

/**
 * The execution pre-flight: `handleOps([op])` again through `eth_simulateV1`,
 * whose logs carry the op's `UserOperationEvent`. A revert inside the op's own
 * call throws `execution_reverted` with the error's name; a node that cannot
 * simulate throws `preflight_unavailable`. Fails closed: the relay sends
 * nothing it could not pre-flight.
 */
async function preflightExecution(
  client: Pick<ReturnType<typeof getBaseSepoliaClient>, 'simulateBlocks'>,
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
    const reason = revertReason(call.error);
    logRelay('aa_simulation_failed', op, { reason, preflight: true });
    throw new UserOpSubmitError('simulation_failed', reason);
  }
  const outcome = opOutcome((call.logs ?? []) as OutcomeLog[], ENTRY_POINT_V07, op.sender, op.nonce);
  if (outcome.status === 'success') return;
  const reason = outcome.status === 'reverted' ? outcome.reason : 'not_executed';
  logRelay('aa_execution_reverted', op, { reason });
  throw new UserOpSubmitError('execution_reverted', reason);
}

/** Simulate and pre-flight from the relayer, admit, submit (signed once, one retry), then read the op's own outcome. */
export async function submitUserOperation(
  env: Env,
  op: PackedUserOperationWire,
  admit: () => Promise<void> = async () => {},
  receiptWaitMs: number = RECEIPT_WAIT_MS,
): Promise<RelayOutcome> {
  const rpcUrl = env.BASE_SEPOLIA_RPC_URL ?? DEFAULT_BASE_SEPOLIA_RPC_URL;
  const relayer = privateKeyToAccount(env.RELAYER_PRIVATE_KEY as Hex);
  const publicClient = getBaseSepoliaClient(rpcUrl);
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
  await preflightExecution(publicClient, relayer.address, data, op);
  await admit();
  const wallet = createWalletClient({ account: relayer, chain: baseSepolia, transport: http(rpcUrl) });
  let txHash: Hex;
  try {
    txHash = await sendWithRetry({
      sign: async () => {
        const prepared = await wallet.prepareTransactionRequest({ to: request.address, data, chain: baseSepolia });
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
    receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: receiptWaitMs, pollingInterval: 1_000 });
  } catch (err) {
    logRelay('aa_receipt_pending', op, { txHash, reason: revertReason(err) });
    return { txHash, receipt: 'pending' };
  }
  const outcome =
    receipt.status === 'success'
      ? opOutcome(receipt.logs as OutcomeLog[], ENTRY_POINT_V07, op.sender, op.nonce)
      : ({ status: 'reverted', reason: 'handleOps reverted' } as const);
  if (outcome.status === 'success') return { txHash, receipt: 'success' };
  const reason = outcome.status === 'reverted' ? outcome.reason : 'not_executed';
  logRelay('aa_user_op_reverted', op, { txHash, reason });
  throw new UserOpSubmitError('user_op_reverted', reason, txHash);
}

/** The answer's status per submission failure. */
const SUBMIT_STATUS = {
  simulation_failed: 400,
  execution_reverted: 400,
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
    const ip = c.req.header('cf-connecting-ip');
    if (ip && (await overLimit(c.env.AA_RELAY_IP_RL, `aa-ip:${ip}`))) {
      return c.json({ ok: false, error: 'rate_limited', message: 'too many requests from this network; retry shortly' }, 429);
    }
    let parsed;
    try {
      parsed = parseUserOperationBody(body);
      checkUserOperationPolicy(parsed.userOp, deps.policy);
    } catch (err) {
      if (err instanceof UserOpRequestError) return c.json({ ok: false, error: err.code, message: err.message }, 400);
      throw err;
    }
    if (!c.env.RELAYER_PRIVATE_KEY) {
      return c.json({ ok: false, error: 'relayer_not_configured', message: 'RELAYER_PRIVATE_KEY not set' }, 503);
    }
    try {
      // The per-sender bucket is counted only once policy and the handleOps
      // simulation pass (the EntryPoint has checked the passkey signature):
      // sender addresses are public, so an earlier count lets anyone lock the
      // owner out of the relay.
      const sender = parsed.userOp.sender.toLowerCase();
      const admit = async () => {
        if (await overLimit(c.env.AA_RELAY_RL, `aa:${sender}`)) {
          throw new UserOpSubmitError('rate_limited', 'too many ops for this account; retry shortly');
        }
      };
      const { txHash, receipt } = await deps.submit(c.env, parsed.userOp, admit);
      return c.json({ ok: true, txHash, entryPoint: parsed.entryPoint, receipt }, 202);
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
  submit: submitUserOperation,
});
