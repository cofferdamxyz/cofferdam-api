// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * /v1/ceremony routes (decision 0016).
 *
 *   POST /v1/ceremony/first-high → the Cofferdam co-sign for
 *                                  `CofferdamAccount4337.enrollFirstHigh`.
 *     `Authorization: Bearer <token>` is required: the signing authority's
 *     own session, a `csa1:` passkey envelope (Partner) or a `csa-sess1.`
 *     session-signer envelope (Managed), pinned to the account and at most
 *     ten minutes old. The gate then requires that key to be `signerId`.
 *
 *   Limits, in order: the global brake, a generous per-IP ceiling, then the
 *   per-account bucket, counted only once the session verifies and the gate's
 *   chain checks pass, right before the attester signs (`admit`).
 *
 * The gate lives in `services/ceremony.ts`; this file wires it to Base reads
 * and to the attester Worker's `signCeremony`, and maps its errors.
 */

import { Hono } from 'hono';
import { getAddress, type Address, type Hex } from 'viem';

import { getBaseSepoliaClient } from '../chain/client.js';
import { BASE_SEPOLIA_CHAIN_ID, SEPOLIA_DEPLOYMENTS } from '../chain/deployments.js';
import type { Env } from '../env.js';
import {
  AUTHORITY_MODULE_ABI,
  CEREMONY_ACCOUNT_ABI,
  CeremonyRequestError,
  issueFirstHighAttestation,
  parseFirstHighBody,
  type CeremonyDeps,
  type CeremonyHashArgs,
  type FirstHighAttestation,
  type FirstHighCeremonyRequest,
  type FirstHighRequest,
  type SessionEvidence,
} from '../services/ceremony.js';
import { envReplayStore, type ReplayStore } from '../services/popReplayStore.js';
import {
  SESSION_SIGNER_PREFIX,
  SessionAttestationError,
  decodeAndVerifySessionSignerAttestation,
} from '../services/sessionAttestation.js';
import { checkSession, isRefusal, sessionToken } from '../services/sessionGate.js';

export interface CeremonyRouteDeps {
  /**
   * Run the gate and the co-sign. `admit` must be awaited once the gate has
   * passed and before the attester signs; it throws `rate_limited` to refuse.
   */
  issue: (env: Env, req: FirstHighCeremonyRequest, admit: () => Promise<void>) => Promise<FirstHighAttestation>;
  /** Unix milliseconds for the session token's freshness; tests inject one. */
  now?: () => number;
  /** The v2 proof replay cache, or null when `POP_REPLAY_DO` is not bound (default: from the env). */
  replayStore?: (env: Env) => ReplayStore | null;
}

/** A v1 or session-signer token presented on the ceremony route is good for ten minutes. */
export const CEREMONY_SESSION_MAX_AGE_MS = 10 * 60 * 1000;

/** The gate's refusal codes, in the ceremony route's own words. */
const CEREMONY_ERROR: Record<string, string> = {
  attestation_required: 'session_required',
  attestation_rejected: 'session_rejected',
};

const GLOBAL_KEY = 'ceremony:global';

async function overLimit(rl: RateLimit | undefined, key: string): Promise<boolean> {
  if (!rl) return false;
  try {
    const { success } = await rl.limit({ key });
    return !success;
  } catch {
    return false;
  }
}

/** The pinned Sepolia account layer every co-sign is checked against. */
export const CEREMONY_PINS = {
  chainId: BigInt(BASE_SEPOLIA_CHAIN_ID),
  moduleRegistry: SEPOLIA_DEPLOYMENTS.CofferdamModuleRegistry.address,
  ceremonyRegistry: SEPOLIA_DEPLOYMENTS.CofferdamCeremonyAttesterRegistry.address,
  highModule: SEPOLIA_DEPLOYMENTS.WebAuthnPasskeyAuthority.address,
} as const;

/** Chain-backed deps: every read goes through the public client, the signature through the binding. */
export function baseCeremonyDeps(env: Env): CeremonyDeps {
  const client = getBaseSepoliaClient(env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org');
  return {
    pins: CEREMONY_PINS,
    async readAccount(account: Address, signerId: bigint) {
      const code = await client.getCode({ address: account });
      if (!code || code === '0x') {
        throw new CeremonyRequestError('account_not_deployed', `${account} has no code on Base Sepolia`, 404);
      }
      const read = <T>(functionName: string, args: readonly unknown[] = []) =>
        client.readContract({ address: account, abi: CEREMONY_ACCOUNT_ABI, functionName, args } as never) as Promise<T>;
      const [upgradeLocked, nonce, moduleRegistry, ceremonyRegistry] = await Promise.all([
        read<boolean>('upgradeLocked'),
        read<bigint>('ceremonyNonce'),
        read<Address>('MODULE_REGISTRY'),
        read<Address>('CEREMONY_ATTESTERS'),
      ]);
      const [challenge, authority] = await Promise.all([
        read<Hex>('firstHighChallenge', [nonce]),
        read<readonly [Address, number, boolean, Hex]>('getAuthority', [signerId]),
      ]);
      return {
        upgradeLocked,
        nonce,
        moduleRegistry: getAddress(moduleRegistry),
        ceremonyRegistry: getAddress(ceremonyRegistry),
        challenge,
        signer: { module: getAddress(authority[0]), tier: Number(authority[1]), active: authority[2], config: authority[3] },
      };
    },
    async verifyAssertion(module, account, challenge, config, assertion) {
      try {
        return (await client.readContract({
          address: module,
          abi: AUTHORITY_MODULE_ABI,
          functionName: 'isValidSignature',
          args: [account, challenge, config, assertion],
        })) as boolean;
      } catch {
        return false;
      }
    },
    async onChainCeremonyHash(account, args: CeremonyHashArgs) {
      return (await client.readContract({
        address: account,
        abi: CEREMONY_ACCOUNT_ABI,
        functionName: 'ceremonyHash',
        args: [args.action, args.newKeyHash, args.partnerId, args.nonce, Number(args.notBefore), Number(args.expiry)],
      })) as Hex;
    },
    sign: (req) => env.ATTESTER.signCeremony(req),
  };
}

export function createCeremonyRoutes(deps: CeremonyRouteDeps) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.post('/first-high', async (c) => {
    if (await overLimit(c.env.CEREMONY_RL, GLOBAL_KEY)) {
      return c.json({ error: 'rate_limited', message: 'too many ceremony requests; retry shortly' }, 429);
    }
    let req: FirstHighRequest;
    try {
      req = parseFirstHighBody(await c.req.json().catch(() => null), CEREMONY_PINS.highModule);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: 'bad_request', message }, 400);
    }
    const ip = c.req.header('cf-connecting-ip');
    if (ip && (await overLimit(c.env.CEREMONY_IP_RL, `ceremony-ip:${ip}`))) {
      return c.json({ error: 'rate_limited', message: 'too many requests from this network; retry shortly' }, 429);
    }
    // The signing authority's own session (decision 0016): without it, anyone
    // who can read the chain could farm co-signs for any Partner account. The
    // passkey lane is a slow route (workspace decision 0055): a device-bound
    // slow token with its proof, or a v1 bearer token while those last. The
    // Managed lane's csa-sess1 envelope is unchanged.
    const now = deps.now ? deps.now() : Date.now();
    const authorization = c.req.header('authorization');
    const token = sessionToken(authorization);
    if (!token) {
      return c.json(
        { error: 'session_required', message: 'Authorization: DPoP csa1:… with a DPoP proof (Partner passkey) or Bearer csa-sess1.… (Managed signer)' },
        401,
      );
    }
    let session: SessionEvidence;
    if (token.startsWith(SESSION_SIGNER_PREFIX)) {
      try {
        const { signer } = await decodeAndVerifySessionSignerAttestation(token, {
          expect: { accountAddress: req.account },
          maxAgeMs: CEREMONY_SESSION_MAX_AGE_MS,
          now,
        });
        session = { kind: 'session-signer', signer };
      } catch (err) {
        if (err instanceof SessionAttestationError) {
          return c.json({ error: 'session_rejected', message: err.message }, 401);
        }
        throw err;
      }
    } else {
      const result = await checkSession(
        { env: c.env, authorization, proof: c.req.header('dpop'), method: c.req.method, url: c.req.url },
        {
          account: req.account,
          requiredTier: 'slow',
          v1MaxAgeMs: CEREMONY_SESSION_MAX_AGE_MS,
          now,
          replay: (deps.replayStore ?? envReplayStore)(c.env),
        },
      );
      if (isRefusal(result)) {
        const { ok: _ok, error, ...rest } = result.body;
        return c.json({ error: CEREMONY_ERROR[error] ?? error, ...rest }, result.status);
      }
      session = { kind: 'passkey', publicKey: result.session.publicKey };
    }
    try {
      // The per-account bucket is counted only once the session and the gate
      // pass, right before the attester signs: account addresses are public.
      const admit = async () => {
        if (await overLimit(c.env.CEREMONY_RL, `ceremony:${req.account.toLowerCase()}`)) {
          throw new CeremonyRequestError('rate_limited', 'too many ceremony requests for this account', 429);
        }
      };
      const issued = await deps.issue(c.env, { ...req, session }, admit);
      return c.json({ ok: true, ...issued }, 200);
    } catch (err) {
      if (err instanceof CeremonyRequestError) {
        return c.json({ error: err.code, message: err.message }, err.status as 400 | 403 | 404 | 409 | 422 | 429 | 500);
      }
      const message = err instanceof Error ? err.message : String(err);
      // The attester throws `CODE: detail`; a missing binding or key is a 503.
      const status = /BAD_ATTESTER_KEY|is not a function|undefined/.test(message) ? 503 : 502;
      return c.json({ error: status === 503 ? 'attester_unavailable' : 'attester_rejected', message }, status);
    }
  });

  return routes;
}

export const ceremonyRoutes = createCeremonyRoutes({
  issue: (env, req, admit) => issueFirstHighAttestation(baseCeremonyDeps(env), req, admit),
});
