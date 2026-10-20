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
 *     then submits it with `RELAYER_PRIVATE_KEY` and answers
 *       202 { ok: true, txHash, entryPoint }
 *     The client waits for the receipt itself. A not-yet-deployed account's
 *     first op carries `initCode`, so this is also how accounts get deployed:
 *     no app ever holds a funded key.
 *
 *     Errors: 400 bad_user_op | bad_entry_point | paymaster_* | factory_not_ours
 *     | gas_limit_exceeded | fee_too_high | prefund_too_high | simulation_failed
 *     (with the EntryPoint's AAxx reason), 429 rate_limited, 503
 *     relayer_not_configured, 502 relay_failed.
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
import { sendWithRetry } from '../services/relaySend.js';

export class UserOpSubmitError extends Error {
  constructor(
    readonly code: 'simulation_failed' | 'relay_failed' | 'rate_limited',
    message: string,
  ) {
    super(message);
    this.name = 'UserOpSubmitError';
  }
}

export interface AaRouteDeps {
  policy: UserOpPolicy;
  /**
   * Simulate and submit `handleOps([op], relayer)`; resolves with the tx hash.
   * `admit` must be awaited once the simulation passes and before the send;
   * it throws `rate_limited` to refuse.
   */
  submit: (env: Env, op: PackedUserOperationWire, admit: () => Promise<void>) => Promise<Hex>;
}

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

/** One structured log line per refused relay step (no signature, no key). */
function logRelay(event: string, op: PackedUserOperationWire, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ event, sender: op.sender, nonce: op.nonce, ...fields }));
}

/** Simulate from the relayer, admit, then submit with it (signed once, one retry). */
export async function submitUserOperation(
  env: Env,
  op: PackedUserOperationWire,
  admit: () => Promise<void> = async () => {},
): Promise<Hex> {
  const rpcUrl = env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';
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
  await admit();
  const wallet = createWalletClient({ account: relayer, chain: baseSepolia, transport: http(rpcUrl) });
  const data = encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args });
  try {
    return await sendWithRetry({
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
}

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
      const txHash = await deps.submit(c.env, parsed.userOp, admit);
      return c.json({ ok: true, txHash, entryPoint: parsed.entryPoint }, 202);
    } catch (err) {
      if (err instanceof UserOpSubmitError) {
        const status = err.code === 'simulation_failed' ? 400 : err.code === 'rate_limited' ? 429 : 502;
        return c.json({ ok: false, error: err.code, message: err.message }, status);
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
