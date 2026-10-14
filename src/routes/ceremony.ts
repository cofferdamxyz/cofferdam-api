// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * /v1/ceremony routes (decision 0016).
 *
 *   POST /v1/ceremony/first-high → the Cofferdam co-sign for
 *                                  `CofferdamAccount4337.enrollFirstHigh`.
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
  type FirstHighRequest,
} from '../services/ceremony.js';

export interface CeremonyRouteDeps {
  issue: (env: Env, req: FirstHighRequest) => Promise<FirstHighAttestation>;
}

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
    if (await overLimit(c.env.CEREMONY_RL, `ceremony:${req.account.toLowerCase()}`)) {
      return c.json({ error: 'rate_limited', message: 'too many ceremony requests for this account' }, 429);
    }
    try {
      const issued = await deps.issue(c.env, req);
      return c.json({ ok: true, ...issued }, 200);
    } catch (err) {
      if (err instanceof CeremonyRequestError) {
        return c.json({ error: err.code, message: err.message }, err.status as 400 | 404 | 409 | 422 | 500);
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
  issue: (env, req) => issueFirstHighAttestation(baseCeremonyDeps(env), req),
});
