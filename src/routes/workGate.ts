// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The admission every Work route runs before it spends anything (workspace
 * `docs/architecture/plane.md`, Work): `/v1/work/*`, the parser's cloud
 * executor and the listing, and `/v1/jobs/*`, the hirer's side. One
 * implementation, so the order cannot drift between them:
 *
 *  1. the global brake (`WORK_RL`, on the route family's global key);
 *  2. the strict gateway: outside development, `503 strict_gateway_required`
 *     while `AI_GATEWAY_ID` is unset (decision 0021 (f));
 *  3. the body and the route's own check of it, before any model;
 *  4. the per-IP ceiling (`WORK_IP_RL`);
 *  5. the chat's gate: a fast session pinned to the account, then an active
 *     High authority on it, remembered five minutes
 *     (`services/chat/authorityMemo.ts`);
 *  6. the per-account bucket (`WORK_RL`), counted only once the gate passes,
 *     because account addresses are public;
 *  7. the chat's caps, before any model call: the account's
 *     `CHAT_MONTHLY_USD_CAP` (`429 fair_use_cap`) and the plane's
 *     `AI_MONTHLY_BUDGET_USD` (`503 ai_budget_reached`).
 *
 * A request that runs no model (a listing taken down) skips 2 and 7: no
 * budget may keep a worker from withdrawing a listing.
 *
 * Every hosted call a route makes is metered to the account and to
 * `plane:global` through `waitUntil`, with no turn counted (decision 0047 (3),
 * `services/work/meter.ts`).
 */

import type { Context } from 'hono';
import { getAddress, type Address } from 'viem';

import type { Env } from '../env.js';
import { checkOnChainAuthority, type AuthorityCheck } from '../services/authorityCheck.js';
import { TIER } from '../services/ceremony.js';
import { createAuthorityMemo, type AuthorityMemo } from '../services/chat/authorityMemo.js';
import { DurableChatUsageStore, monthOf, monthResetsAt, parseUsdMicro, type ChatUsageStore } from '../services/chatUsageStore.js';
import { createInference, type Inference } from '../services/inference/index.js';
import { envReplayStore, type ReplayStore } from '../services/popReplayStore.js';
import { type PasskeySession } from '../services/sessionAttestation.js';
import { checkSession, isRefusal } from '../services/sessionGate.js';
import type { WorkCall } from '../services/work/fields.js';
import { workUsageDeltas } from '../services/work/meter.js';

export type WorkContext = Context<{ Bindings: Env }>;

export interface WorkRouteDeps {
  /** Max age of a `csa1:` v1 bearer token, as for the chat: one Face ID covers an hour. */
  attestationMaxAgeMs: number;
  now(): number;
  authorityCheck(env: Env, att: PasskeySession): Promise<AuthorityCheck>;
  /** The chat's five-minute memory of a passed check (the Work routes only spend Workers AI). */
  authorityMemo: AuthorityMemo;
  /** The inference seam, or null when Workers AI is not bound. */
  inference(env: Env): Inference | null;
  /** The usage meter, or null when `CHAT_USAGE_DO` is not bound (default: from the env). */
  usageStore?(env: Env): ChatUsageStore | null;
  /** The v2 proof replay cache (default: from the env). */
  replayStore?(env: Env): ReplayStore | null;
}

export function envUsageStore(env: Env): ChatUsageStore | null {
  return env.CHAT_USAGE_DO ? new DurableChatUsageStore(env.CHAT_USAGE_DO) : null;
}

/** One instance per isolate: the three Work routers share its authority memo. */
export const defaultWorkRouteDeps: WorkRouteDeps = {
  attestationMaxAgeMs: 60 * 60 * 1000,
  now: () => Date.now(),
  authorityCheck: (env, att) => checkOnChainAuthority(att, env.BASE_SEPOLIA_RPC_URL),
  authorityMemo: createAuthorityMemo(),
  inference: (env) => createInference(env),
  usageStore: envUsageStore,
};

/** The rate-limit keys of a route family: the global key, and the prefixes of the per-account and per-IP keys. */
export interface GateKeys {
  global: string;
  account: string;
  ip: string;
}

export const WORK_KEYS: GateKeys = { global: 'work:global', account: 'work:', ip: 'work-ip:' };
export const JOBS_KEYS: GateKeys = { global: 'jobs:global', account: 'jobs:', ip: 'jobs-ip:' };
/** Taking a listing down counts on keys of its own: no other Work traffic can use up a withdrawal. */
export const WORK_OFF_KEYS: GateKeys = { global: 'work-off:global', account: 'work-off:', ip: 'work-off-ip:' };

/** How long an isolate trusts its last read of the plane-wide spend, as the chat does. */
export const GLOBAL_SPEND_TTL_MS = 30_000;

export const workLog = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields));

function background(c: WorkContext, p: Promise<unknown>): void {
  const settled = p.catch((err) => workLog({ event: 'work_usage_failed', reason: err instanceof Error ? err.message : String(err) }));
  try {
    c.executionCtx.waitUntil(settled);
  } catch {
    // no ExecutionContext (tests): the promise runs on its own
  }
}

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

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

class BadRequest extends Error {}

async function body(c: WorkContext): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new BadRequest('invalid JSON body');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequest('the body must be an object');
  const b = raw as Record<string, unknown>;
  if (typeof b.account !== 'string' || !ADDRESS.test(b.account)) throw new BadRequest('account must be a 0x address');
  return b;
}

/**
 * The route's check of the body: its input, or the refusal to answer with
 * (step 3). Name `T` at the call (`gate.admit<Input>(c, read)`): inferred, it
 * would take in the refusal's response type too.
 */
export type BodyReader<T> = (b: Record<string, unknown>) => T | Response;

export interface Admission<T> {
  account: Address;
  input: T;
}

export interface ModelAdmission<T> extends Admission<T> {
  inference: Inference;
  /** The usage meter, or null when `CHAT_USAGE_DO` is not bound. */
  store: ChatUsageStore | null;
}

export interface WorkGate {
  /** Steps 1 to 7, then Workers AI: everything before a model call. */
  admit<T>(c: WorkContext, read: BodyReader<T>): Promise<ModelAdmission<T> | Response>;
  /** Steps 1 and 3 to 6, for a request that runs no model. */
  admitWithoutModels<T>(c: WorkContext, read: BodyReader<T>): Promise<Admission<T> | Response>;
  /** A request's hosted calls into the meter, through `waitUntil`. */
  meter(c: WorkContext, store: ChatUsageStore | null, account: Address, calls: readonly WorkCall[]): void;
}

export function createWorkGate(deps: WorkRouteDeps, keys: GateKeys): WorkGate {
  const usageStore = (env: Env) => (deps.usageStore ?? envUsageStore)(env);

  async function authority(env: Env, att: PasskeySession): Promise<AuthorityCheck> {
    const remembered = await deps.authorityMemo.get(att);
    if (remembered) return remembered;
    const check = await deps.authorityCheck(env, att);
    if (check.status === 'active' && check.tier === TIER.High) await deps.authorityMemo.put(att, check);
    return check;
  }

  let globalSpend: { month: string; microUsd: number; until: number } | null = null;
  async function spentThisMonth(store: ChatUsageStore, month: string, now: number): Promise<number> {
    if (globalSpend && globalSpend.month === month && globalSpend.until > now) return globalSpend.microUsd;
    const row = await store.readGlobal(month);
    globalSpend = { month, microUsd: row?.estimatedMicroUsd ?? 0, until: now + GLOBAL_SPEND_TTL_MS };
    return globalSpend.microUsd;
  }

  /** The session pinned to the account, then an active High on it. Null when the caller may go on. */
  async function gate(c: WorkContext, account: Address): Promise<Response | null> {
    const result = await checkSession(
      {
        env: c.env,
        authorization: c.req.header('authorization'),
        proof: c.req.header('dpop'),
        method: c.req.method,
        url: c.req.url,
      },
      {
        account,
        requiredTier: 'fast',
        v1MaxAgeMs: deps.attestationMaxAgeMs,
        now: deps.now(),
        replay: (deps.replayStore ?? envReplayStore)(c.env),
      },
    );
    if (isRefusal(result)) {
      if (result.body.error === 'attestation_required' && c.env.ENVIRONMENT === 'development') return null;
      return c.json(result.body, result.status);
    }
    const check = await authority(c.env, result.session);
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

  /** The global brake and the account's cap, before any model call. An unreadable meter lets the call through. */
  async function caps(c: WorkContext, store: ChatUsageStore | null, account: Address): Promise<Response | null> {
    const cap = parseUsdMicro(c.env.CHAT_MONTHLY_USD_CAP);
    const budget = parseUsdMicro(c.env.AI_MONTHLY_BUDGET_USD);
    if (!store || (cap == null && budget == null)) return null;
    const now = deps.now();
    const month = monthOf(now);
    const quiet = <T>(p: Promise<T>, fallback: T) =>
      p.catch((err) => {
        workLog({ event: 'work_usage_read_failed', reason: err instanceof Error ? err.message : String(err) });
        return fallback;
      });
    const [spent, used] = await Promise.all([
      budget != null ? quiet(spentThisMonth(store, month, now), 0) : 0,
      cap != null ? quiet(store.read(account, month).then((u) => u?.estimatedMicroUsd ?? 0), 0) : 0,
    ]);
    const resetsAt = monthResetsAt(now);
    const retryAfter = String(Math.max(1, Math.ceil((resetsAt.getTime() - now) / 1000)));
    if (budget != null && spent >= budget) {
      workLog({ event: 'work_budget_reached', month, spent_micro_usd: spent, budget_micro_usd: budget });
      c.header('retry-after', retryAfter);
      return c.json({ ok: false, error: 'ai_budget_reached', resetsAt: resetsAt.toISOString() }, 503);
    }
    if (cap != null && used >= cap) {
      c.header('retry-after', retryAfter);
      return c.json({ ok: false, error: 'fair_use_cap', resetsAt: resetsAt.toISOString() }, 429);
    }
    return null;
  }

  /** Steps 1 to 6; the strict gateway only for a request that runs models. */
  async function steps<T>(c: WorkContext, read: BodyReader<T>, models: boolean): Promise<Admission<T> | Response> {
    if (await overLimit(c.env.WORK_RL, keys.global)) {
      return c.json({ ok: false, error: 'rate_limited', message: 'busy; retry shortly' }, 429);
    }
    if (models && c.env.ENVIRONMENT !== 'development' && !c.env.AI_GATEWAY_ID) {
      return c.json({ ok: false, error: 'strict_gateway_required', message: 'the Work routes run models only behind the strict AI Gateway' }, 503);
    }
    let b: Record<string, unknown>;
    try {
      b = await body(c);
    } catch (err) {
      return c.json({ ok: false, error: 'bad_request', message: err instanceof BadRequest ? err.message : 'invalid body' }, 400);
    }
    const input = read(b);
    if (input instanceof Response) return input;
    const ip = c.req.header('cf-connecting-ip');
    if (ip && (await overLimit(c.env.WORK_IP_RL, `${keys.ip}${ip}`))) {
      return c.json({ ok: false, error: 'rate_limited', message: 'too many requests from this network; retry shortly' }, 429);
    }
    const account = getAddress(b.account as string);
    const refused = await gate(c, account);
    if (refused) return refused;
    if (await overLimit(c.env.WORK_RL, `${keys.account}${account.toLowerCase()}`)) {
      return c.json({ ok: false, error: 'rate_limited', message: 'slow down a little; retry shortly' }, 429);
    }
    return { account, input };
  }

  return {
    async admit(c, read) {
      const admitted = await steps(c, read, true);
      if (admitted instanceof Response) return admitted;
      const store = usageStore(c.env);
      const capped = await caps(c, store, admitted.account);
      if (capped) return capped;
      const inference = deps.inference(c.env);
      if (!inference) return c.json({ ok: false, error: 'ai_unprovisioned' }, 503);
      return { ...admitted, inference, store };
    },

    admitWithoutModels(c, read) {
      return steps(c, read, false);
    },

    meter(c, store, account, calls) {
      if (!store) return;
      const at = deps.now();
      const month = monthOf(at);
      const deltas = workUsageDeltas(calls, at, workLog);
      if (!deltas.length) return;
      background(c, Promise.all(deltas.flatMap((d) => [store.record(account, month, d), store.recordGlobal(month, d)])));
    },
  };
}
