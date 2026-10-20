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
 *   binding (decision 0010): /verify has a global brake and per-account and
 *   per-nullifier keys; the pickup has a per-IP ceiling before its gate and
 *   counts the per-account key only once the gate passes.
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
import { checkOnChainAuthority, type AuthorityCheck } from '../services/authorityCheck.js';
import { TIER } from '../services/ceremony.js';
import {
  SessionAttestationError,
  decodeAndVerifySessionAttestation,
  type SessionAttestation,
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
  {
    type: 'function',
    name: 'rebindCount',
    stateMutability: 'view',
    inputs: [{ name: 'nullifier', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
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
  /** `NullifierRegistry.rebindCount(nullifier)`, the epoch a rebind co-sign is bound to (decision 0022). */
  rebindEpoch(env: Env, nullifier: bigint): Promise<bigint>;
  now(): number;
  /** Max age of the `csa1:` attestation presented on pickup. */
  attestationMaxAgeMs: number;
  /** The bundle store for this request, or null when the deployment lacks one. */
  store(env: Env): BundleStore | null;
  /** Is the token's key an active authority on the account it names? Read on Base. */
  authorityCheck(env: Env, att: SessionAttestation): Promise<AuthorityCheck>;
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

/** `rebindCount(nullifier)` on Base; the registry re-checks it, so a stale read only costs a retry. */
async function readRebindEpoch(env: Env, nullifier: bigint): Promise<bigint> {
  const client = getBaseSepoliaClient(env.BASE_SEPOLIA_RPC_URL);
  return (await client.readContract({
    address: SEPOLIA_DEPLOYMENTS.NullifierRegistry.address,
    abi: NULLIFIER_REGISTRY_ABI,
    functionName: 'rebindCount',
    args: [nullifier],
  })) as bigint;
}

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
  rebindEpoch: readRebindEpoch,
  now: () => Date.now(),
  attestationMaxAgeMs: 10 * 60 * 1000,
  store: (env) => (env.BIND_BUNDLES_DO ? new DurableBindStore(env.BIND_BUNDLES_DO) : null),
  authorityCheck: (env, att) => checkOnChainAuthority(att, env.BASE_SEPOLIA_RPC_URL),
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
    // One passport cannot spray proofs across accounts (decision 0022): the
    // nullifier gets its own brake, with the same ceiling as the account key.
    if (await overLimit(c.env.SELF_VERIFY_RL, `verify:nullifier:${req.nullifier}`)) {
      return c.json(
        { status: 'error', result: false, code: 'rate_limited', message: 'too many proofs for this passport; retry shortly' },
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
    // A passport already bound to another account is the recovery case
    // (decision 0022): the fresh proof names the new account, so the attester
    // co-signs a rebind bound to the registry's current epoch instead of a bind.
    const rebind = status.kind === 'nullifier_already_bound';
    let epoch: bigint | null = null;
    if (rebind) {
      try {
        epoch = await deps.rebindEpoch(c.env, BigInt(req.nullifier));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json(
          { status: 'error', result: false, code: 'registry_unavailable', message, retryable: true },
          503,
        );
      }
    }

    const signReq: SignBindRequest = {
      registry: SEPOLIA_DEPLOYMENTS.NullifierRegistry.address,
      account: req.account,
      pubSignals: req.publicSignals,
      userContextData: req.userContextData,
    };
    let signed: SignBindResponse;
    try {
      signed = rebind
        ? await c.env.ATTESTER.signRebind({ ...signReq, epoch: (epoch as bigint).toString() })
        : await c.env.ATTESTER.signBind(signReq);
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

    const bundle = buildBindBundle(req, signed, deps.now(), rebind ? { epoch: (epoch as bigint).toString() } : undefined);
    await store.put(bundle);

    console.log(
      JSON.stringify({
        kind: 'self.verify',
        bundle: bundle.kind,
        epoch: bundle.epoch,
        previousAccount: status.kind === 'nullifier_already_bound' ? status.boundAccount : undefined,
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
      kind: bundle.kind,
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

    // A generous per-IP ceiling before the gate (carriers put many phones
    // behind one address); the per-account bucket waits until the gate passes.
    const ip = c.req.header('cf-connecting-ip');
    if (ip && (await overLimit(c.env.SELF_PICKUP_IP_RL, `pickup-ip:${ip}`))) {
      return c.json({ ok: false, error: 'rate_limited', retryAfterSeconds: 10 }, 429);
    }

    // Pickup gate: prove you hold a passkey on this account (csa1 session
    // attestation pinned to the address). Development tolerates its absence
    // so the smoke flow works before the app wires sign-in into this call.
    const auth = c.req.header('authorization');
    const token = auth?.replace(/^Bearer\s+/i, '').trim();
    if (token) {
      let att: SessionAttestation;
      try {
        att = decodeAndVerifySessionAttestation(token, {
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
      // The envelope proves that a passkey signed it, not that the passkey is
      // on this account: anyone can mint one for any address. Read the account
      // on Base and require an active High authority before handing out a
      // bundle that links a nullifier to the account.
      const check = await deps.authorityCheck(c.env, att);
      if (check.status === 'check_failed') {
        return c.json({ ok: false, error: 'authority_check_unavailable', message: check.message }, 503);
      }
      if (check.status !== 'active' || check.tier !== TIER.High) {
        const why = check.status === 'active' ? `authority ${check.authorityId} is not High` : check.status;
        return c.json(
          {
            ok: false,
            error: 'attestation_rejected',
            message: `the token's key is not an active High authority on ${account} (${why})`,
          },
          401,
        );
      }
    } else if (c.env.ENVIRONMENT !== 'development') {
      return c.json(
        { ok: false, error: 'attestation_required', hint: 'Authorization: Bearer csa1:…' },
        401,
      );
    }
    // Counted only now: account addresses are public on Base, so a bucket
    // spent before the gate would let anyone lock the owner out of pickup.
    if (await overLimit(c.env.SELF_PICKUP_RL, `pickup:${account.toLowerCase()}`)) {
      return c.json({ ok: false, error: 'rate_limited', retryAfterSeconds: 10 }, 429);
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
