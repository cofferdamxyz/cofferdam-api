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
 *
 * Usage: every finished turn is added to the account's month in the meter
 * (`services/chatUsageStore.ts`, the `CHAT_USAGE_DO` Durable Object) through
 * `waitUntil`, so the stream never waits on it. With `CHAT_MONTHLY_TOKEN_CAP`
 * set, an account past it answers `429 fair_use_cap` before any model call.
 * `GET /v1/chat/usage?account=0x…` answers the current month behind the same
 * gate. `Accept-Language` (pt, es) picks the fixed replies' language when the
 * router is unsure of it.
 */

import { Hono, type Context } from 'hono';
import { getAddress } from 'viem';

import type { Env } from '../env.js';
import { checkOnChainAuthority, type AuthorityCheck } from '../services/authorityCheck.js';
import { TIER } from '../services/ceremony.js';
import { createAuthorityMemo, type AuthorityMemo } from '../services/chat/authorityMemo.js';
import { ChatRequestError, headerLanguage, parseChatRequest, runChat, type ChatInference } from '../services/chat/run.js';
import {
  capTokens,
  DurableChatUsageStore,
  monthOf,
  monthResetsAt,
  parseTokenCap,
  usageDelta,
  type ChatUsageStore,
} from '../services/chatUsageStore.js';
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
  /** The usage meter, or null when `CHAT_USAGE_DO` is not bound (default: from the env). */
  usageStore?(env: Env): ChatUsageStore | null;
}

function envUsageStore(env: Env): ChatUsageStore | null {
  return env.CHAT_USAGE_DO ? new DurableChatUsageStore(env.CHAT_USAGE_DO) : null;
}

export const defaultChatRouteDeps: ChatRouteDeps = {
  attestationMaxAgeMs: 60 * 60 * 1000,
  now: () => Date.now(),
  authorityCheck: (env, att) => checkOnChainAuthority(att, env.BASE_SEPOLIA_RPC_URL),
  authorityMemo: createAuthorityMemo(),
  inference: (env) => createInference(env),
  usageStore: envUsageStore,
};

const GLOBAL_KEY = 'chat:global';

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields));

/** Keep a promise alive past the response; outside a Worker (tests) it simply runs. */
function background(c: Context<{ Bindings: Env }>, p: Promise<unknown>): void {
  const settled = p.catch((err) => log({ event: 'chat_usage_failed', reason: err instanceof Error ? err.message : String(err) }));
  try {
    c.executionCtx.waitUntil(settled);
  } catch {
    // no ExecutionContext: the promise runs on its own
  }
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

  const usageStore = (env: Env) => (deps.usageStore ?? envUsageStore)(env);

  /**
   * The gate both routes share: the token pinned to the account and fresh,
   * then an active High on the account (remembered for five minutes). Answers
   * the refusal, or null when the caller may go on.
   */
  async function gate(c: Context<{ Bindings: Env }>, account: `0x${string}`): Promise<Response | null> {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      if (c.env.ENVIRONMENT === 'development') return null;
      return c.json({ ok: false, error: 'attestation_required', hint: 'Authorization: Bearer csa1:…' }, 401);
    }
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
    return null;
  }

  async function overIpCeiling(c: Context<{ Bindings: Env }>): Promise<boolean> {
    const ip = c.req.header('cf-connecting-ip');
    return Boolean(ip && (await overLimit(c.env.CHAT_IP_RL, `chat-ip:${ip}`)));
  }

  routes.get('/usage', async (c) => {
    const raw = c.req.query('account') ?? '';
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
      return c.json({ ok: false, error: 'bad_request', message: 'account must be a 0x address' }, 400);
    }
    if (await overIpCeiling(c)) {
      return c.json({ ok: false, error: 'rate_limited', message: 'too many requests from this network; retry shortly' }, 429);
    }
    const account = getAddress(raw);
    const refused = await gate(c, account);
    if (refused) return refused;
    // Its own key on the chat bucket, so reading the meter never spends a turn.
    if (await overLimit(c.env.CHAT_RL, `chat-usage:${account.toLowerCase()}`)) {
      return c.json({ ok: false, error: 'rate_limited', message: 'slow down a little; retry shortly' }, 429);
    }
    const store = usageStore(c.env);
    if (!store) return c.json({ ok: false, error: 'usage_store_unprovisioned' }, 503);
    const now = deps.now();
    const month = monthOf(now);
    const usage = await store.read(account, month);
    const cap = parseTokenCap(c.env.CHAT_MONTHLY_TOKEN_CAP);
    return c.json({
      ok: true,
      month,
      turns: usage?.turns ?? 0,
      tokensIn: usage?.tokensIn ?? 0,
      tokensOut: usage?.tokensOut ?? 0,
      estimatedUsd: (usage?.estimatedMicroUsd ?? 0) / 1_000_000,
      cap: cap == null ? null : { tokens: cap, remaining: Math.max(0, cap - capTokens(usage)) },
    });
  });

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
    if (await overIpCeiling(c)) {
      return c.json({ ok: false, error: 'rate_limited', message: 'too many requests from this network; retry shortly' }, 429);
    }
    const account = getAddress(parsed.account);

    const refused = await gate(c, account);
    if (refused) return refused;
    if (await overLimit(c.env.CHAT_RL, `chat:${account.toLowerCase()}`)) {
      return c.json({ ok: false, error: 'rate_limited', message: 'slow down a little; retry shortly' }, 429);
    }

    // The fair-use cap, before any model call. Read only when a cap is set; an
    // unreadable meter lets the turn through rather than lock everyone out.
    const store = usageStore(c.env);
    const cap = parseTokenCap(c.env.CHAT_MONTHLY_TOKEN_CAP);
    if (store && cap != null) {
      const now = deps.now();
      let used = 0;
      try {
        used = capTokens(await store.read(account, monthOf(now)));
      } catch (err) {
        log({ event: 'chat_usage_read_failed', reason: err instanceof Error ? err.message : String(err) });
      }
      if (used >= cap) {
        const resetsAt = monthResetsAt(now);
        c.header('retry-after', String(Math.max(1, Math.ceil((resetsAt.getTime() - now) / 1000))));
        return c.json({ ok: false, error: 'fair_use_cap', resetsAt: resetsAt.toISOString() }, 429);
      }
    }

    const inference = deps.inference(c.env);
    if (!inference) return c.json({ ok: false, error: 'ai_unprovisioned' }, 503);

    const stream = runChat({
      inference,
      messages: parsed.messages,
      early: c.env.CHAT_EARLY_ANSWER !== 'off',
      log,
      fallbackLanguage: headerLanguage(c.req.header('accept-language')),
      onTurn: store
        ? (usage) => {
            const at = deps.now();
            background(c, store.record(account, monthOf(at), usageDelta(usage, at, log)));
          }
        : undefined,
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
