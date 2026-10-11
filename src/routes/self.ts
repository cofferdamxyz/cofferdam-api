// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * /v1/self routes — the Self.xyz proof endpoint and the bind-bundle pickup.
 *
 *   POST /v1/self/verify
 *     Called by Self's relayer after the enclave finishes a `disclose` proof
 *     for a SelfApp whose `endpoint` is this URL. Body (Self's shape):
 *       { attestationId, proof: {a, b, c}, publicSignals[21], userContextData }
 *     The Worker recovers the target account from `userContextData`, checks
 *     the registry on Base has not already bound the account or nullifier,
 *     asks `cofferdam-attester` to gate the proof on Celo and sign, stores the
 *     resulting bind bundle in KV for the app, and answers in Self's shape:
 *       200 { status: 'success', result: true, … }   → app sees VERIFICATION_COMPLETE success
 *       4xx { status: 'error',   result: false, code, message }
 *
 *   Stores are strongly consistent Durable Objects (one per account, see
 *   services/bundleStore.ts); rate limits are the Workers rate-limiting
 *   binding, keyed per account plus a global brake on /verify (decision 0010).
 *
 *   GET /v1/self/bind-bundle/:account
 *     The app's pickup after VERIFICATION_COMPLETE. Returns the bundle to pass
 *     to `NullifierRegistry.verifyAndBind` (proof already in Solidity order).
 *     Gated by a `csa1:` session attestation for the account
 *     (`Authorization: Bearer csa1:…`); absent attestations are tolerated only
 *     when ENVIRONMENT=development. An account the registry already shows as
 *     bound gets `409 account_already_bound` and its stale bundle is dropped:
 *     the first device run (2026-10-11) showed Self reporting completion
 *     twice and the app re-submitting a bundle whose bind had just landed.
 *
 * The endpoint must be served on the `cofferdam.xyz` host: only the host of
 * `SelfApp.endpoint` enters the immutable `NullifierRegistry.expectedScope`
 * (see wrangler.jsonc `routes`). The path is free.
 *
 * Trust: nothing here is load-bearing. The attester refuses any proof whose
 * Merkle root Self never published, and `verifyAndBind` re-verifies the
 * Groth16 proof, scope, attestation id, user context and one-shot rule on
 * Base. An attacker posting garbage gets an error and nothing is stored; a
 * replay of a genuine callback re-stores the same bundle.
 *
 */

import { Hono } from 'hono';
import { getAddress, isAddress, type Address } from 'viem';
import type { Env } from '../env.js';
import { getBaseSepoliaClient } from '../chain/client.js';
import { SEPOLIA_DEPLOYMENTS } from '../chain/deployments.js';
import type { SignBindRequest, SignBindResponse } from '../services/attester.js';
import { DurableBindStore, type BundleStore } from '../services/bundleStore.js';
import {
  SelfVerifyRequestError,
  buildBindBundle,
  parseSelfVerifyBody,
} from '../services/selfBind.js';
import {
  SessionAttestationError,
  decodeAndVerifySessionAttestation,
} from '../services/sessionAttestation.js';

/** Minimal read surface of `NullifierRegistry` for the pre-flight. */
const NULLIFIER_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'accountToNullifier',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'nullifierToAccount',
    stateMutability: 'view',
    inputs: [{ name: 'nullifier', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
] as const;

export type BindStatus =
  | { kind: 'unbound' }
  | { kind: 'account_already_bound'; nullifier: string }
  | { kind: 'nullifier_already_bound'; boundAccount: Address }
  | { kind: 'unknown'; message: string };

/** Injection seams so the routes unit-test without Base RPC, a clock or Durable Objects. */
export interface SelfRouteDeps {
  bindStatus(env: Env, account: Address, nullifier: bigint): Promise<BindStatus>;
  now(): number;
  /** Max age of the `csa1:` attestation presented on pickup. */
  attestationMaxAgeMs: number;
  /** The bundle store for this request, or null when the deployment lacks one. */
  store(env: Env): BundleStore | null;
}

/** Rate-limit helper: absent binding or a binding error never blocks. */
async function overLimit(rl: RateLimit | undefined, key: string): Promise<boolean> {
  if (!rl) return false;
  try {
    const { success } = await rl.limit({ key });
    return !success;
  } catch {
    return false;
  }
}

/** Legitimate traffic is a couple of posts per bind; anything near this is abuse. */
const VERIFY_GLOBAL_KEY = 'verify:all';

/** Read the registry on Base. Failure is reported, not thrown: the attester and the chain still gate. */
async function readBindStatus(env: Env, account: Address, nullifier: bigint): Promise<BindStatus> {
  try {
    const client = getBaseSepoliaClient(env.BASE_SEPOLIA_RPC_URL);
    const registry = SEPOLIA_DEPLOYMENTS.NullifierRegistry.address;
    const [boundNullifier, boundAccount] = await Promise.all([
      client.readContract({
        address: registry,
        abi: NULLIFIER_REGISTRY_ABI,
        functionName: 'accountToNullifier',
        args: [account],
      }),
      client.readContract({
        address: registry,
        abi: NULLIFIER_REGISTRY_ABI,
        functionName: 'nullifierToAccount',
        args: [nullifier],
      }),
    ]);
    if (boundNullifier !== 0n) {
      return { kind: 'account_already_bound', nullifier: boundNullifier.toString() };
    }
    if (boundAccount !== '0x0000000000000000000000000000000000000000') {
      return { kind: 'nullifier_already_bound', boundAccount: getAddress(boundAccount) };
    }
    return { kind: 'unbound' };
  } catch (err) {
    return { kind: 'unknown', message: err instanceof Error ? err.message : String(err) };
  }
}

export const defaultSelfRouteDeps: SelfRouteDeps = {
  bindStatus: readBindStatus,
  now: () => Date.now(),
  attestationMaxAgeMs: 10 * 60 * 1000,
  store: (env) => (env.BIND_BUNDLES_DO ? new DurableBindStore(env.BIND_BUNDLES_DO) : null),
};

/**
 * Extract the attester's `CODE` from its `CODE: detail` message. Workers RPC
 * re-serialises thrown errors and may prefix the class name
 * (`AttesterError: CELO_ROOT_UNKNOWN: …`), so the first ALL-CAPS token
 * followed by `: ` wins; anything else is an RPC-level failure.
 */
export function attesterErrorCode(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const m = /(?:^|\s)([A-Z][A-Z0-9_]{2,}): /.exec(message);
  return m?.[1] ?? 'attester_rpc_failed';
}

export function createSelfRoutes(deps: SelfRouteDeps = defaultSelfRouteDeps) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.post('/verify', async (c) => {
    const store = deps.store(c.env);
    if (!store) {
      // Refuse before spending an attester signature nobody could pick up.
      return c.json(
        {
          status: 'error',
          result: false,
          code: 'bind_store_unprovisioned',
          message: 'the bind-bundle Durable Object is not bound on this deployment',
        },
        503,
      );
    }

    if (await overLimit(c.env.SELF_VERIFY_RL, VERIFY_GLOBAL_KEY)) {
      return c.json(
        { status: 'error', result: false, code: 'rate_limited', message: 'too many proofs right now; retry shortly' },
        429,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ status: 'error', result: false, code: 'invalid_json', message: 'body is not JSON' }, 400);
    }

    let req;
    try {
      req = parseSelfVerifyBody(body);
    } catch (err) {
      if (err instanceof SelfVerifyRequestError) {
        return c.json({ status: 'error', result: false, code: err.code, message: err.message }, 400);
      }
      throw err;
    }

    if (await overLimit(c.env.SELF_VERIFY_RL, `verify:${req.account.toLowerCase()}`)) {
      return c.json(
        { status: 'error', result: false, code: 'rate_limited', message: `too many proofs for ${req.account}; retry shortly` },
        429,
      );
    }

    // Pre-flight on Base: a bound account or nullifier can never bind again,
    // so do not ask the attester to sign something the chain will revert.
    const status = await deps.bindStatus(c.env, req.account, BigInt(req.nullifier));
    if (status.kind === 'account_already_bound') {
      return c.json(
        {
          status: 'error',
          result: false,
          code: 'account_already_bound',
          message: `account ${req.account} is already bound to a nullifier`,
        },
        409,
      );
    }
    if (status.kind === 'nullifier_already_bound') {
      // The multi-device reconciliation signal: this passport already has an
      // account. Surfaced distinctly so the app can offer recovery instead of
      // a dead-end error.
      return c.json(
        {
          status: 'error',
          result: false,
          code: 'nullifier_already_bound',
          boundAccount: status.boundAccount,
          message: 'this passport is already bound to another account',
        },
        409,
      );
    }

    const signReq: SignBindRequest = {
      registry: SEPOLIA_DEPLOYMENTS.NullifierRegistry.address,
      account: req.account,
      pubSignals: req.publicSignals,
      userContextData: req.userContextData,
    };
    let signed: SignBindResponse;
    try {
      signed = await c.env.ATTESTER.signBind(signReq);
    } catch (err) {
      const code = attesterErrorCode(err);
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        JSON.stringify({
          kind: 'self.verify.rejected',
          account: req.account,
          nullifier: req.nullifier,
          code,
          message,
        }),
      );
      const retryable = code === 'CELO_RPC_UNAVAILABLE' || code === 'attester_rpc_failed';
      const operator = /_VAR$|^BAD_ATTESTER_KEY$|^BAD_CELO/.test(code);
      return c.json(
        { status: 'error', result: false, code, message, retryable },
        retryable ? 503 : operator ? 500 : 400,
      );
    }

    const bundle = buildBindBundle(req, signed, deps.now());
    await store.put(bundle);

    console.log(
      JSON.stringify({
        kind: 'self.verify',
        account: bundle.account,
        nullifier: bundle.nullifier,
        merkleRoot: signed.celo.merkleRoot,
        proofDate: signed.celo.proofDate,
        preflight: status.kind,
        expiresAt: bundle.expiresAt,
      }),
    );

    return c.json({
      status: 'success',
      result: true,
      account: bundle.account,
      nullifier: bundle.nullifier,
      expiresAt: bundle.expiresAt,
      celo: signed.celo,
    });
  });

  routes.get('/bind-bundle/:account', async (c) => {
    const store = deps.store(c.env);
    if (!store) {
      return c.json({ ok: false, error: 'bind_store_unprovisioned' }, 503);
    }

    const raw = c.req.param('account');
    if (!isAddress(raw)) {
      return c.json({ ok: false, error: 'bad_account', hint: 'expected 0x-prefixed address' }, 400);
    }
    const account = getAddress(raw);

    if (await overLimit(c.env.SELF_PICKUP_RL, `pickup:${account.toLowerCase()}`)) {
      return c.json({ ok: false, error: 'rate_limited', retryAfterSeconds: 10 }, 429);
    }

    // Pickup gate: prove you hold a passkey on this account (csa1 session
    // attestation pinned to the address). Development tolerates its absence
    // so the smoke flow works before the app wires sign-in into this call.
    const auth = c.req.header('authorization');
    const token = auth?.replace(/^Bearer\s+/i, '').trim();
    if (token) {
      try {
        decodeAndVerifySessionAttestation(token, {
          expect: { accountAddress: account },
          maxAgeMs: deps.attestationMaxAgeMs,
          now: deps.now(),
        });
      } catch (err) {
        if (err instanceof SessionAttestationError) {
          return c.json({ ok: false, error: 'attestation_rejected', message: err.message }, 401);
        }
        throw err;
      }
    } else if (c.env.ENVIRONMENT !== 'development') {
      return c.json(
        { ok: false, error: 'attestation_required', hint: 'Authorization: Bearer csa1:…' },
        401,
      );
    }

    const bundle = await store.get(account);
    if (!bundle) {
      return c.json({ ok: false, error: 'bind_bundle_not_found', account }, 404);
    }

    // One-shot on-chain: once bound, the bundle can only produce a revert.
    const status = await deps.bindStatus(c.env, account, BigInt(bundle.nullifier));
    if (status.kind === 'account_already_bound') {
      await store.delete(account);
      return c.json(
        { ok: false, error: 'account_already_bound', account, nullifier: status.nullifier },
        409,
      );
    }
    return c.json({ ok: true, bundle });
  });

  return routes;
}

export const selfRoutes = createSelfRoutes();
