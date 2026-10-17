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
 * (503 when Base is unreadable). A per-account and a global rate limit sit in
 * front. `ENVIRONMENT=development` tolerates a missing token for `wrangler
 * dev`. The text arrives already gated on the phone; the plane never logs it.
 */

import { Hono } from 'hono';
import { getAddress } from 'viem';

import type { Env } from '../env.js';
import { checkOnChainAuthority, type AuthorityCheck } from '../services/authorityCheck.js';
import { TIER } from '../services/ceremony.js';
import { ChatRequestError, DEFAULT_CHAT_MODELS, parseChatRequest, runChat, type AiRun, type ChatModels } from '../services/chat/run.js';
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
  /** Workers AI for this request (`env.AI`, through `AI_GATEWAY_ID` when set). */
  ai(env: Env): AiRun | null;
}

export const defaultChatRouteDeps: ChatRouteDeps = {
  attestationMaxAgeMs: 60 * 60 * 1000,
  now: () => Date.now(),
  authorityCheck: (env, att) => checkOnChainAuthority(att, env.BASE_SEPOLIA_RPC_URL),
  ai: (env) => {
    if (!env.AI) return null;
    const ai = env.AI;
    const options = env.AI_GATEWAY_ID ? { gateway: { id: env.AI_GATEWAY_ID } } : undefined;
    return (model, input) => ai.run(model as never, input as never, options as never) as Promise<unknown>;
  },
};

/** Model pins from the environment, each falling back to decision 0037's starting model. */
export function chatModels(env: Env): ChatModels {
  return {
    router: env.CHAT_ROUTER_MODEL || DEFAULT_CHAT_MODELS.router,
    action: env.CHAT_ACTION_MODEL || DEFAULT_CHAT_MODELS.action,
    answer: env.CHAT_ANSWER_MODEL || DEFAULT_CHAT_MODELS.answer,
    answerLong: env.CHAT_LONG_MODEL || DEFAULT_CHAT_MODELS.answerLong,
  };
}

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
    const account = getAddress(parsed.account);
    if (await overLimit(c.env.CHAT_RL, `chat:${account.toLowerCase()}`)) {
      return c.json({ ok: false, error: 'rate_limited', message: 'slow down a little; retry shortly' }, 429);
    }

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
      const check = await deps.authorityCheck(c.env, att);
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

    const ai = deps.ai(c.env);
    if (!ai) return c.json({ ok: false, error: 'ai_unprovisioned' }, 503);

    const stream = runChat({
      ai,
      messages: parsed.messages,
      models: chatModels(c.env),
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
