// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * /v1/work — the cloud executor of the Cofferdam Work parser (workspace
 * decisions 0020 and 0021, `docs/product/engine.md`, Parser). The phone sends
 * de-identified blocks, one block per extraction, never the header, contact,
 * references or personal blocks, never an image, a PDF or raw OCR text.
 *
 *   POST /v1/work/classify  { account, blocks: [{ kind, lang, text }, …] }  → the document type
 *   POST /v1/work/extract   { account, block: { kind, lang, text } }        → one cofferdam.cv.v1 fragment
 *
 *   Authorization: DPoP csa1:… + DPoP: <proof>   (a fast or slow session, decision 0055)
 *   (or Authorization: Bearer csa1:…, a v1 token, while CSA1_V1_ACCEPTED allows it)
 *
 * Outside development both answer `503 strict_gateway_required` until
 * `AI_GATEWAY_ID` names the strict AI Gateway (no cache, DLP in Block mode, no
 * log), which decision 0021 (f) requires before the cloud executor ships.
 *
 * The gate is the chat's, in the chat's order: a global brake, a per-IP
 * ceiling, a session pinned to the account, an active High authority on the
 * account (remembered five minutes, `services/chat/authorityMemo.ts`), then
 * the per-account bucket. The chat's caps run before any model call: the
 * account's `CHAT_MONTHLY_USD_CAP` and the plane's `AI_MONTHLY_BUDGET_USD`.
 * Every model call is metered to the account and to `plane:global` through
 * `waitUntil`, with no turn counted (decision 0047 (3), `services/work/meter.ts`).
 *
 * The plane re-checks every block (`services/work/blocks.ts`) and answers a
 * refusal with its reason, never the text. Nothing is stored, and nothing
 * ties two blocks of one document together: the account is read for the gate
 * and the meter only and never reaches a model or a log line with a block.
 */

import { Hono, type Context } from 'hono';
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
import { checkBlock, type DeidentifiedBlock } from '../services/work/blocks.js';
import { classifyDocument, extractBlock } from '../services/work/executor.js';
import type { WorkCall } from '../services/work/fields.js';
import { workUsageDeltas } from '../services/work/meter.js';

export interface WorkRouteDeps {
  /** Max age of a `csa1:` v1 bearer token, as for the chat: one Face ID covers an hour. */
  attestationMaxAgeMs: number;
  now(): number;
  authorityCheck(env: Env, att: PasskeySession): Promise<AuthorityCheck>;
  /** The chat's five-minute memory of a passed check (both routes only spend Workers AI). */
  authorityMemo: AuthorityMemo;
  /** The inference seam, or null when Workers AI is not bound. */
  inference(env: Env): Inference | null;
  /** The usage meter, or null when `CHAT_USAGE_DO` is not bound (default: from the env). */
  usageStore?(env: Env): ChatUsageStore | null;
  /** The v2 proof replay cache (default: from the env). */
  replayStore?(env: Env): ReplayStore | null;
}

function envUsageStore(env: Env): ChatUsageStore | null {
  return env.CHAT_USAGE_DO ? new DurableChatUsageStore(env.CHAT_USAGE_DO) : null;
}

export const defaultWorkRouteDeps: WorkRouteDeps = {
  attestationMaxAgeMs: 60 * 60 * 1000,
  now: () => Date.now(),
  authorityCheck: (env, att) => checkOnChainAuthority(att, env.BASE_SEPOLIA_RPC_URL),
  authorityMemo: createAuthorityMemo(),
  inference: (env) => createInference(env),
  usageStore: envUsageStore,
};

const GLOBAL_KEY = 'work:global';

/** Blocks a classification reads at most: the first few are enough to name a document. */
export const CLASSIFY_MAX_BLOCKS = 4;

/** How long an isolate trusts its last read of the plane-wide spend, as the chat does. */
export const GLOBAL_SPEND_TTL_MS = 30_000;

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields));

function background(c: Context<{ Bindings: Env }>, p: Promise<unknown>): void {
  const settled = p.catch((err) => log({ event: 'work_usage_failed', reason: err instanceof Error ? err.message : String(err) }));
  try {
    c.executionCtx.waitUntil(settled);
  } catch {
    // no ExecutionContext (tests): the promise runs on its own
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

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

class BadRequest extends Error {}

async function body(c: Context<{ Bindings: Env }>): Promise<Record<string, unknown>> {
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

export function createWorkRoutes(deps: WorkRouteDeps = defaultWorkRouteDeps) {
  const routes = new Hono<{ Bindings: Env }>();
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
  async function gate(c: Context<{ Bindings: Env }>, account: Address): Promise<Response | null> {
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
  async function caps(c: Context<{ Bindings: Env }>, store: ChatUsageStore | null, account: Address): Promise<Response | null> {
    const cap = parseUsdMicro(c.env.CHAT_MONTHLY_USD_CAP);
    const budget = parseUsdMicro(c.env.AI_MONTHLY_BUDGET_USD);
    if (!store || (cap == null && budget == null)) return null;
    const now = deps.now();
    const month = monthOf(now);
    const quiet = <T>(p: Promise<T>, fallback: T) =>
      p.catch((err) => {
        log({ event: 'work_usage_read_failed', reason: err instanceof Error ? err.message : String(err) });
        return fallback;
      });
    const [spent, used] = await Promise.all([
      budget != null ? quiet(spentThisMonth(store, month, now), 0) : 0,
      cap != null ? quiet(store.read(account, month).then((u) => u?.estimatedMicroUsd ?? 0), 0) : 0,
    ]);
    const resetsAt = monthResetsAt(now);
    const retryAfter = String(Math.max(1, Math.ceil((resetsAt.getTime() - now) / 1000)));
    if (budget != null && spent >= budget) {
      log({ event: 'work_budget_reached', month, spent_micro_usd: spent, budget_micro_usd: budget });
      c.header('retry-after', retryAfter);
      return c.json({ ok: false, error: 'ai_budget_reached', resetsAt: resetsAt.toISOString() }, 503);
    }
    if (cap != null && used >= cap) {
      c.header('retry-after', retryAfter);
      return c.json({ ok: false, error: 'fair_use_cap', resetsAt: resetsAt.toISOString() }, 429);
    }
    return null;
  }

  /**
   * Everything before a model call, in order: the global brake, the strict
   * gateway, the body and its blocks, the per-IP ceiling, the gate, the
   * per-account bucket and the caps.
   */
  async function admit(
    c: Context<{ Bindings: Env }>,
    readBlocks: (b: Record<string, unknown>) => DeidentifiedBlock[] | Response,
  ): Promise<{ account: Address; blocks: DeidentifiedBlock[]; inference: Inference; store: ChatUsageStore | null } | Response> {
    if (await overLimit(c.env.WORK_RL, GLOBAL_KEY)) {
      return c.json({ ok: false, error: 'rate_limited', message: 'busy; retry shortly' }, 429);
    }
    if (c.env.ENVIRONMENT !== 'development' && !c.env.AI_GATEWAY_ID) {
      return c.json({ ok: false, error: 'strict_gateway_required', message: 'the cloud executor runs only behind the strict AI Gateway' }, 503);
    }
    let b: Record<string, unknown>;
    try {
      b = await body(c);
    } catch (err) {
      return c.json({ ok: false, error: 'bad_request', message: err instanceof BadRequest ? err.message : 'invalid body' }, 400);
    }
    const blocks = readBlocks(b);
    if (blocks instanceof Response) return blocks;
    const ip = c.req.header('cf-connecting-ip');
    if (ip && (await overLimit(c.env.WORK_IP_RL, `work-ip:${ip}`))) {
      return c.json({ ok: false, error: 'rate_limited', message: 'too many requests from this network; retry shortly' }, 429);
    }
    const account = getAddress(b.account as string);
    const refused = await gate(c, account);
    if (refused) return refused;
    if (await overLimit(c.env.WORK_RL, `work:${account.toLowerCase()}`)) {
      return c.json({ ok: false, error: 'rate_limited', message: 'slow down a little; retry shortly' }, 429);
    }
    const store = usageStore(c.env);
    const capped = await caps(c, store, account);
    if (capped) return capped;
    const inference = deps.inference(c.env);
    if (!inference) return c.json({ ok: false, error: 'ai_unprovisioned' }, 503);
    return { account, blocks, inference, store };
  }

  function meter(c: Context<{ Bindings: Env }>, store: ChatUsageStore | null, account: Address, calls: readonly WorkCall[]): void {
    if (!store) return;
    const at = deps.now();
    const month = monthOf(at);
    const deltas = workUsageDeltas(calls, at, log);
    if (!deltas.length) return;
    background(c, Promise.all(deltas.flatMap((d) => [store.record(account, month, d), store.recordGlobal(month, d)])));
  }

  const refusal = (c: Context<{ Bindings: Env }>, reason: string, index?: number) =>
    c.json({ ok: false, error: 'block_refused', reason, ...(index != null ? { index } : {}) }, 422);

  routes.post('/extract', async (c) => {
    const admitted = await admit(c, (b) => {
      const r = checkBlock(b.block);
      if (!r.ok) {
        log({ event: 'work_block_refused', reason: r.reason });
        return refusal(c, r.reason);
      }
      if (r.block.kind === 'body') return c.json({ ok: false, error: 'kind_not_extractable', message: 'no extraction schema takes a body block' }, 422);
      return [r.block];
    });
    if (admitted instanceof Response) return admitted;
    const { account, blocks, inference, store } = admitted;
    const block = blocks[0]!;
    const outcome = await extractBlock(inference, block, { now: () => deps.now(), log });
    meter(c, store, account, outcome.calls);
    for (const call of outcome.calls) {
      log({ event: 'work_extract', kind: block.kind, lang: block.lang, op: call.op, model: call.model, ok: call.ok, ms: call.ms, tokens_in: call.usage.tokensIn, tokens_out: call.usage.tokensOut });
    }
    if (!outcome.ok) return c.json({ ok: false, error: outcome.error }, outcome.error === 'kind_not_extractable' ? 422 : 502);
    const e = outcome.extraction;
    return c.json({
      ok: true,
      schema: e.schema,
      kind: e.kind,
      fragment: e.fragment,
      fields: e.fields,
      violations: e.violations,
      model: e.model,
      executor: 'cloud',
    });
  });

  routes.post('/classify', async (c) => {
    const admitted = await admit(c, (b) => {
      if (!Array.isArray(b.blocks) || b.blocks.length === 0 || b.blocks.length > CLASSIFY_MAX_BLOCKS) {
        return c.json({ ok: false, error: 'bad_request', message: `blocks must hold 1 to ${CLASSIFY_MAX_BLOCKS} blocks` }, 400);
      }
      const blocks: DeidentifiedBlock[] = [];
      for (const [i, raw] of (b.blocks as unknown[]).entries()) {
        const r = checkBlock(raw);
        if (!r.ok) {
          log({ event: 'work_block_refused', reason: r.reason });
          return refusal(c, r.reason, i);
        }
        blocks.push(r.block);
      }
      return blocks;
    });
    if (admitted instanceof Response) return admitted;
    const { account, blocks, inference, store } = admitted;
    const outcome = await classifyDocument(inference, blocks, { now: () => deps.now(), log });
    meter(c, store, account, outcome.calls);
    if (!outcome.ok) return c.json({ ok: false, error: outcome.error }, 502);
    log({ event: 'work_classify', type: outcome.type, confidence: outcome.confidence, blocks: blocks.length, model: outcome.model });
    return c.json({
      ok: true,
      type: outcome.type,
      confidence: outcome.confidence,
      probabilities: outcome.probabilities,
      schema: outcome.schema,
      model: outcome.model,
    });
  });

  return routes;
}

export const workRoutes = createWorkRoutes();
