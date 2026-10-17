// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * POST /v1/chat — one Cofferdam Cloud chat turn (workspace decisions 0024 and
 * 0037), streamed back as server-sent events (`services/chat/run.ts`).
 *
 *   Authorization: Bearer csa1:…   (a session attestation for the account)
 *   { "account": "0x…", "messages": [{ "role": "user", "text": "…" }, …] }
 *
 * Workers AI spends money, so the route is gated like the bind-bundle pickup:
 * the attestation must verify, be pinned to the account and be at most an hour
 * old, and its key must be an active High authority on the account on Base
 * (503 when Base is unreadable). A passed check is remembered for five minutes
 * (`services/chat/authorityMemo.ts`), so only the first turn waits on Base.
 *
 * Limits, in order: a global brake, a generous per-IP ceiling (carriers put
 * many phones behind one address), then the per-account bucket, counted only
 * once the token and the on-chain check pass, so knowing someone's address is
 * not enough to use up their turns. `ENVIRONMENT=development` tolerates a
 * missing token for `wrangler dev`. The text arrives already gated on the
 * phone; the plane never logs it.
 */

import { Hono } from 'hono';
import { getAddress } from 'viem';

import type { Env } from '../env.js';
import { checkOnChainAuthority, type AuthorityCheck } from '../services/authorityCheck.js';
import { TIER } from '../services/ceremony.js';
import { createAuthorityMemo, type AuthorityMemo } from '../services/chat/authorityMemo.js';
import { ChatRequestError, parseChatRequest, runChat, type ChatInference } from '../services/chat/run.js';
import { createInference } from '../services/inference/index.js';
import {
  SessionAttestationError,
  decodeAndVerifySessionAttestation,
  type SessionAttestation,
} from '../services/sessionAttestation.js';

export interface ChatRouteDeps {
  /** Max age of the `csa1:` attestation: one Face ID covers an hour of chatting. */
  attestationMaxAgeMs: number;
  now(): number;
  authorityCheck(env: Env, att: SessionAttestation): Promise<AuthorityCheck>;
  /** Remembers a passed check for the chat only. */
  authorityMemo: AuthorityMemo;
  /** The inference seam for this request, or null when Workers AI is not bound. */
  inference(env: Env): ChatInference | null;
}

export const defaultChatRouteDeps: ChatRouteDeps = {
  attestationMaxAgeMs: 60 * 60 * 1000,
  now: () => Date.now(),
  authorityCheck: (env, att) => checkOnChainAuthority(att, env.BASE_SEPOLIA_RPC_URL),
  authorityMemo: createAuthorityMemo(),
  inference: (env) => createInference(env),
};

const GLOBAL_KEY = 'chat:global';

async function overLimit(rl: RateLimit | undefined, key: string): Promise<boolean> {
  if (!rl) return false;
  try {
    const { success } = await rl.limit({ key });
    return !success;
  } catch {
    return false;
  }
}

export function createChatRoutes(deps: ChatRouteDeps = defaultChatRouteDeps) {
  const routes = new Hono<{ Bindings: Env }>();

  /** The on-chain check, remembered for five minutes once it passes. */
  async function authority(env: Env, att: SessionAttestation): Promise<AuthorityCheck> {
    const remembered = await deps.authorityMemo.get(att);
    if (remembered) return remembered;
    const check = await deps.authorityCheck(env, att);
    if (check.status === 'active' && check.tier === TIER.High) await deps.authorityMemo.put(att, check);
    return check;
  }

  routes.post('/', async (c) => {
    if (await overLimit(c.env.CHAT_RL, GLOBAL_KEY)) {
      return c.json({ ok: false, error: 'rate_limited', message: 'the assistant is busy; retry shortly' }, 429);
    }
    let parsed;
    try {
      parsed = parseChatRequest(await c.req.json());
    } catch (err) {
      const message = err instanceof ChatRequestError ? err.message : 'invalid JSON body';
      return c.json({ ok: false, error: 'bad_request', message }, 400);
    }
    const ip = c.req.header('cf-connecting-ip');
    if (ip && (await overLimit(c.env.CHAT_IP_RL, `chat-ip:${ip}`))) {
      return c.json({ ok: false, error: 'rate_limited', message: 'too many requests from this network; retry shortly' }, 429);
    }
    const account = getAddress(parsed.account);

    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '').trim();
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
      // Anyone can mint an envelope for any address; only a High passkey on
      // the account itself may spend Workers AI on its behalf.
      const check = await authority(c.env, att);
      if (check.status === 'check_failed') {
        return c.json({ ok: false, error: 'authority_check_unavailable', message: check.message }, 503);
      }
      if (check.status !== 'active' || check.tier !== TIER.High) {
        const why = check.status === 'active' ? `authority ${check.authorityId} is not High` : check.status;
        return c.json(
          { ok: false, error: 'attestation_rejected', message: `the token's key is not an active High authority on ${account} (${why})` },
          401,
        );
      }
    } else if (c.env.ENVIRONMENT !== 'development') {
      return c.json({ ok: false, error: 'attestation_required', hint: 'Authorization: Bearer csa1:…' }, 401);
    }
    if (await overLimit(c.env.CHAT_RL, `chat:${account.toLowerCase()}`)) {
      return c.json({ ok: false, error: 'rate_limited', message: 'slow down a little; retry shortly' }, 429);
    }

    const inference = deps.inference(c.env);
    if (!inference) return c.json({ ok: false, error: 'ai_unprovisioned' }, 503);

    const stream = runChat({
      inference,
      messages: parsed.messages,
      early: c.env.CHAT_EARLY_ANSWER !== 'off',
      log: (fields) => console.log(JSON.stringify(fields)),
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
    });
  });

  return routes;
}

export const chatRoutes = createChatRoutes();
