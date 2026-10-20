// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed environment bindings for the Cofferdam API Worker.
 *
 * Mirrors the `vars`, `kv_namespaces`, `r2_buckets`, `d1_databases`,
 * `services`, and `durable_objects.bindings` declared in
 * `wrangler.jsonc`. Keep them in sync — when you uncomment a binding
 * there, add it here too.
 */

import type { AttesterRpc } from './services/attester.js';
import type { ActivityDO } from './services/activityDO.js';
import type { BindBundleDO } from './services/bindBundleDO.js';
import type { ChatUsageDO } from './services/chatUsageDO.js';

export interface Env {
  // ── vars ────────────────────────────────────────────────────────
  ENVIRONMENT: 'development' | 'staging' | 'production';

  /**
   * Base Sepolia RPC URL — primary chain for all on-chain reads.
   * Defaults to the public Base Sepolia endpoint.
   */
  BASE_SEPOLIA_RPC_URL: string;

  /**
   * Celo mainnet JSON-RPC, where Self.xyz anchors its identity registry.
   * Read-only; used to build gate-passing synthetic signals for
   * `/v1/attester/test-sign` and to pre-flight real proofs. Defaults to the
   * public forno endpoint.
   */
  CELO_RPC_URL?: string;

  /**
   * SQD Portal dataset URL for the /v1/activity routes. It overrides the
   * per-chain default only for the chain whose dataset it names
   * (`…/datasets/base-mainnet` → 8453), so a Sepolia value never serves
   * mainnet. Defaults to the free public endpoint (20 req/10s); a Cloud Portal
   * URL for production raises the limit. See workspace decision 0009.
   */
  SQD_PORTAL_URL?: string;

  /**
   * RPC endpoint for the Sepolia activity scans (workspace decision 0032),
   * normally the CDP Node URL. A secret, because the URL carries a client API
   * key. Unset: the scans use `BASE_SEPOLIA_RPC_URL`.
   */
  ACTIVITY_RPC_URL?: string;

  /**
   * Inclusive block span per `eth_getLogs` call in the activity scans. Default
   * 200, the public Base Sepolia node's cap (it refuses 202). Raise it only
   * after testing the provider behind `ACTIVITY_RPC_URL`.
   */
  ACTIVITY_LOG_RANGE?: string;

  /**
   * First block the webhook-fed activity store is complete from: the head
   * block when the CDP subscription was created. Unset, the store is off and
   * `/v1/activity` scans RPC only.
   */
  ACTIVITY_INDEX_FROM_BLOCK?: string;

  /**
   * Secret of the CDP onchain webhook subscription (`metadata.secret`); it keys
   * the `X-Hook0-Signature` HMAC. Set with `wrangler secret put
   * CDP_WEBHOOK_SECRET`. Unset, `POST /v1/activity/webhooks/cdp` answers 503.
   */
  CDP_WEBHOOK_SECRET?: string;

  // ── Inference and chat (workspace decision 0037) ────────────────
  /**
   * Workers AI (wrangler.jsonc `ai`). Only `services/inference` may use it
   * (`test/inference.test.ts`). Unset: `/v1/chat` answers 503.
   */
  AI?: Ai;
  /** Model pins per op class, `model:<op>`; unbound, the variables below and then the defaults. */
  AI_PINS?: KVNamespace;
  /** The strict AI Gateway every inference call goes through; unset: direct to Workers AI. */
  AI_GATEWAY_ID?: string;
  /** Model pins by variable; each falls back to the op's default in `services/inference`. */
  CHAT_ROUTER_MODEL?: string;
  CHAT_ACTION_MODEL?: string;
  CHAT_ANSWER_MODEL?: string;
  CHAT_LONG_MODEL?: string;
  /** The Thinking tier's model (decision 0047); unset, `@cf/zai-org/glm-5.3`. */
  CHAT_REASONING_MODEL?: string;
  /**
   * Clef's reasoning score (0 to 1) at or above which a Thinking turn runs at
   * high effort instead of low. Unset: never, high effort is unmeasured.
   */
  CHAT_THINKING_HIGH_FLOOR?: string;
  /** `off` stops starting the everyday answer alongside the router; anything else keeps it on. */
  CHAT_EARLY_ANSWER?: string;
  /** `POST /v1/chat`: a global brake, and per account after the gate passes. */
  CHAT_RL?: RateLimit;
  /** `POST /v1/chat`: a generous per-IP ceiling before the gate. */
  CHAT_IP_RL?: RateLimit;
  /**
   * Fair-use cap: the most one account's chat may cost in a UTC month, in US
   * dollars (decimals allowed), as the usage meter (`CHAT_USAGE_DO`) estimates
   * it. Unset means no cap; once reached, `POST /v1/chat` answers 429
   * `fair_use_cap`. Plans will set this per account later.
   */
  CHAT_MONTHLY_USD_CAP?: string;
  /**
   * Global brake: the most the plane spends on hosted AI in a UTC month, in
   * US dollars, as estimated by the usage meter's plane-wide row. Every
   * hosted op counts toward it (the chat today, cloud document extraction
   * when it lands); past it, `POST /v1/chat` answers 503 `ai_budget_reached`.
   * Unset means no brake.
   */
  AI_MONTHLY_BUDGET_USD?: string;

  /**
   * Private key for the relayer account on Base Sepolia: submits ERC-4337
   * `handleOps` for the app's sponsored ops (`/v1/aa/user-operation`, refunded
   * by the paymaster).
   * Same account used for the CDP Paymaster on Sepolia.
   * Set via `wrangler secret put RELAYER_PRIVATE_KEY`.
   * Migration path: replace with CDP Server-Side Wallets for production.
   */
  RELAYER_PRIVATE_KEY?: string;

  // ── secrets (set via `wrangler secret put NAME`) ────────────────
  /**
   * Neon Postgres connection string for the `polis` DB (enterprise/company
   * identity). OPTIONAL until provisioned — routes that need it degrade to
   * a 503 `db_unprovisioned`, mirroring the LINKS KV pattern, so the Worker
   * still boots and the on-chain routes are unaffected. Use Neon's pooled
   * HTTP endpoint URL here (the Worker uses `@neondatabase/serverless`).
   *
   * ACTIVITY_DATABASE_URL is retained as an optional future fallback but is
   * NOT required — `/v1/activity` uses the SQD Portal Stream API directly
   * (workspace decision 0009).
   */
  POLIS_DATABASE_URL?: string;
  ACTIVITY_DATABASE_URL?: string;

  // ── KV namespaces (provisioned in later sessions) ───────────────
  // SESSIONS: KVNamespace;
  // PROFILES: KVNamespace;
  /**
   * CompanyConsumerLink grant store for the rev-7.4 company plane
   * (routes/enterprise.ts). OPTIONAL until the KV namespace is provisioned
   * + uncommented in wrangler.jsonc — the link routes return 503
   * `link_store_unprovisioned` while it's absent, so the Worker still boots
   * and the `/resolve` keystone works.
   */
  LINKS?: KVNamespace;
  // ── Durable Objects ─────────────────────────────────────────────
  /**
   * Per-account bind-bundle hand-off (services/bindBundleDO.ts, decision
   * 0010). Strongly consistent, so the app's pickup sees the relayer's write
   * immediately. Declared in wrangler.jsonc `durable_objects`; without it
   * `/v1/self/*` returns 503 `bind_store_unprovisioned`.
   */
  BIND_BUNDLES_DO?: DurableObjectNamespace<BindBundleDO>;

  /**
   * Per-(chain, address) transfer record fed by the CDP webhook
   * (services/activityDO.ts, decision 0032).
   */
  ACTIVITY_DO?: DurableObjectNamespace<ActivityDO>;

  /**
   * The chat's per-account usage meter, one row per month
   * (services/chatUsageDO.ts). Unbound: nothing is metered, no cap applies and
   * `GET /v1/chat/usage` answers 503 `usage_store_unprovisioned`.
   */
  CHAT_USAGE_DO?: DurableObjectNamespace<ChatUsageDO>;

  // ── Rate limits (wrangler.jsonc `ratelimits`; permissive, per-colo) ──
  /** `POST /v1/self/verify`: per account and a global flood brake. */
  SELF_VERIFY_RL?: RateLimit;
  /** `GET /v1/self/bind-bundle/:account`: per account, counted after the gate passes. */
  SELF_PICKUP_RL?: RateLimit;
  /** `GET /v1/self/bind-bundle/:account`: a generous per-IP ceiling before the gate. */
  SELF_PICKUP_IP_RL?: RateLimit;
  /** `POST /v1/aa/user-operation`: a global brake, and per sender once policy and simulation pass (decision 0012). */
  AA_RELAY_RL?: RateLimit;
  /** `POST /v1/aa/user-operation`: a generous per-IP ceiling before policy and simulation. */
  AA_RELAY_IP_RL?: RateLimit;
  /** `/v1/ceremony/*` (decision 0016 co-signs): a global brake, and per account once the gate passes. */
  CEREMONY_RL?: RateLimit;
  /** `/v1/ceremony/*`: a generous per-IP ceiling before the gate. */
  CEREMONY_IP_RL?: RateLimit;

  // ── R2 buckets (provisioned in later sessions) ──────────────────
  // VAULT: R2Bucket;
  // SRS:   R2Bucket;

  // ── D1 databases (provisioned in later sessions) ────────────────
  // DB: D1Database;

  // ── Service bindings ────────────────────────────────────────────
  /**
   * cofferdam-attester service binding (Session 3+). Exposes the
   * `signBind` RPC method via Cloudflare's Workers RPC. Resolves at
   * runtime — at typecheck time we use `Service<AttesterRpc>` so the
   * `env.ATTESTER.signBind(...)` call is fully typed.
   */
  ATTESTER: Service<AttesterRpc>;
  // PROVER: Service<ProverRpc>;  // Sessions 4-5

  // ── Durable Object namespaces (provisioned in later sessions) ───
  // SESSION_DO: DurableObjectNamespace;
}
