// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test money for the app on Base Sepolia, beside the MockUSDC mint the app
 * sends itself (workspace decision 0100, question 7; runbook
 * `pods-pix-ramp.md`, "Minting pBRL for the app").
 *
 *   POST /v1/testnet/brs/mint   { account, amount }   amount in reais, "200" or "250.50"
 *
 * Mints Pods' pBRL, BRS's stand-in on Base Sepolia, to the session's own
 * account through Pods' staging sandbox (`services/podsSandbox.ts`), so the
 * app's Add money works with the revolver on BRS. Never on mainnet and never in
 * production: `ENVIRONMENT=production` answers 404, a session on any chain but
 * Base Sepolia 400, and without `PODS_SANDBOX_API_KEY` (a staging key) the
 * route answers `503 brs_mint_unavailable`.
 *
 * The gate runs in the attachments' order: the global brake
 * (`BRS_MINT_GLOBAL_RL`) and the per-IP ceiling (`BRS_MINT_IP_RL`) before
 * anything else, the body, a fast `csa1:` session pinned to the body's
 * account, an active High on it (remembered five minutes), then
 * `BRS_MINT_RL` per account. The pBRL goes only to that account. The log
 * line carries the outcome and the amount, never the account.
 */

import { Hono, type Context } from 'hono';
import { getAddress, type Address } from 'viem';

import { BASE_SEPOLIA_CHAIN_ID } from '../chain/deployments.js';
import type { Env } from '../env.js';
import { checkOnChainAuthority, type AuthorityCheck } from '../services/authorityCheck.js';
import { TIER } from '../services/ceremony.js';
import { createAuthorityMemo, type AuthorityMemo } from '../services/chat/authorityMemo.js';
import { mintPbrl, parseReaisCents, PBRL_BASE_SEPOLIA, podsSandboxBase, type MintInput, type MintResult } from '../services/podsSandbox.js';
import { envReplayStore, type ReplayStore } from '../services/popReplayStore.js';
import type { PasskeySession } from '../services/sessionAttestation.js';
import { checkSession, isRefusal } from '../services/sessionGate.js';

type TestnetContext = Context<{ Bindings: Env }>;

export interface TestnetRouteDeps {
  attestationMaxAgeMs: number;
  now(): number;
  authorityCheck(env: Env, att: PasskeySession): Promise<AuthorityCheck>;
  authorityMemo: AuthorityMemo;
  mint(input: MintInput): Promise<MintResult>;
  replayStore?(env: Env): ReplayStore | null;
}

export const defaultTestnetRouteDeps: TestnetRouteDeps = {
  attestationMaxAgeMs: 60 * 60 * 1000,
  now: () => Date.now(),
  authorityCheck: (env, att) => checkOnChainAuthority(att, env),
  authorityMemo: createAuthorityMemo(),
  mint: mintPbrl,
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ event: 'brs_mint', ...fields }));

/** A missing binding or a binding error never blocks. */
async function overLimit(rl: RateLimit | undefined, key: string): Promise<boolean> {
  if (!rl) return false;
  try {
    const { success } = await rl.limit({ key });
    return !success;
  } catch {
    return false;
  }
}

export function createTestnetRoutes(deps: TestnetRouteDeps = defaultTestnetRouteDeps) {
  const routes = new Hono<{ Bindings: Env }>();

  async function authority(env: Env, att: PasskeySession): Promise<AuthorityCheck> {
    const remembered = await deps.authorityMemo.get(att);
    if (remembered) return remembered;
    const check = await deps.authorityCheck(env, att);
    if (check.status === 'active' && check.tier === TIER.High) await deps.authorityMemo.put(att, check);
    return check;
  }

  routes.post('/brs/mint', async (c: TestnetContext) => {
    if (c.env.ENVIRONMENT === 'production') return c.json({ ok: false, error: 'not_found' }, 404);
    const apiKey = c.env.PODS_SANDBOX_API_KEY;
    const base = podsSandboxBase(c.env.PODS_API_BASE_URL);
    if (!apiKey || !base) return c.json({ ok: false, error: 'brs_mint_unavailable' }, 503);
    // Before anything that reads the body or the chain: everyone's brake, then a ceiling per IP.
    if (await overLimit(c.env.BRS_MINT_GLOBAL_RL, 'brs-mint:global')) return c.json({ ok: false, error: 'rate_limited', retryAfterSeconds: 10 }, 429);
    const ip = c.req.header('cf-connecting-ip');
    if (ip && (await overLimit(c.env.BRS_MINT_IP_RL, `brs-mint-ip:${ip}`))) {
      return c.json({ ok: false, error: 'rate_limited', retryAfterSeconds: 60 }, 429);
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ ok: false, error: 'bad_request' }, 400);
    }
    if (typeof body !== 'object' || body === null || typeof body.account !== 'string' || !ADDRESS.test(body.account)) {
      return c.json({ ok: false, error: 'bad_request' }, 400);
    }
    const cents = parseReaisCents(body.amount);
    if (cents === null) return c.json({ ok: false, error: 'bad_amount' }, 400);

    const result = await checkSession(
      { env: c.env, authorization: c.req.header('authorization'), proof: c.req.header('dpop'), method: c.req.method, url: c.req.url },
      {
        account: body.account as Address,
        requiredTier: 'fast',
        v1MaxAgeMs: deps.attestationMaxAgeMs,
        now: deps.now(),
        replay: (deps.replayStore ?? envReplayStore)(c.env),
      },
    );
    if (isRefusal(result)) return c.json(result.body, result.status);
    if (result.session.chainId !== BASE_SEPOLIA_CHAIN_ID) return c.json({ ok: false, error: 'chain_unsupported' }, 400);
    const check = await authority(c.env, result.session);
    if (check.status === 'check_failed') return c.json({ ok: false, error: 'authority_check_unavailable' }, 503);
    if (check.status !== 'active' || check.tier !== TIER.High) {
      return c.json({ ok: false, error: 'attestation_rejected', reason: 'authority' }, 401);
    }
    const account = getAddress(result.session.accountAddress);
    if (await overLimit(c.env.BRS_MINT_RL, `brs-mint:${account.toLowerCase()}`)) {
      return c.json({ ok: false, error: 'rate_limited', retryAfterSeconds: 60 }, 429);
    }

    const minted = await deps.mint({ apiKey, base, account, cents });
    log({ ok: minted.ok, cents, minted: minted.mintedCents, error: minted.ok ? undefined : minted.error, code: minted.ok ? undefined : minted.code });
    const answer = {
      token: PBRL_BASE_SEPOLIA,
      decimals: 18,
      requestedCents: cents,
      mintedCents: minted.mintedCents,
      txHashes: minted.txHashes,
    };
    if (minted.ok) return c.json({ ok: true, ...answer });
    const status = minted.error === 'wallet_linked_elsewhere' ? 409 : 502;
    return c.json({ ok: false, error: minted.error, code: minted.code, ...answer }, status);
  });

  return routes;
}

export const testnetRoutes = createTestnetRoutes();
