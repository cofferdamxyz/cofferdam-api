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
import type { BindBundleDO } from './services/bindBundleDO.js';

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
   * SQD Portal Stream API base URL for the /v1/activity route.
   * Defaults to the free public endpoint (20 req/10s rate limit).
   * Override with a Cloud Portal URL for production (higher rate limits).
   * See workspace decision 0009.
   */
  SQD_PORTAL_URL?: string;

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

  // ── Rate limits (wrangler.jsonc `ratelimits`; permissive, per-colo) ──
  /** `POST /v1/self/verify`: per account and a global flood brake. */
  SELF_VERIFY_RL?: RateLimit;
  /** `GET /v1/self/bind-bundle/:account`: per account. */
  SELF_PICKUP_RL?: RateLimit;
  /** `POST /v1/aa/user-operation`: per sender and a global brake (decision 0012). */
  AA_RELAY_RL?: RateLimit;
  /** Rate limit for `/v1/ceremony/*` (decision 0016 co-signs): per account and global. */
  CEREMONY_RL?: RateLimit;

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
