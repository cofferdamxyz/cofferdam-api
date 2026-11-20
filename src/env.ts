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
import type { PopReplayDO } from './services/popReplayDO.js';
import type { VaultHandoffDO } from './services/vaultHandoffDO.js';

export interface Env {
  // ── vars ────────────────────────────────────────────────────────
  ENVIRONMENT: 'development' | 'staging' | 'production';

  /**
   * Base Sepolia RPC URL — primary chain for all on-chain reads.
   * Defaults to the public Base Sepolia endpoint.
   */
  BASE_SEPOLIA_RPC_URL: string;

  /**
   * Base mainnet (8453) on or off for the plane's reads (workspace decision
   * 0080, milestone M1): on only when exactly `"true"` and `BASE_RPC_URL` is
   * set (`chain/chains.ts`). Off by default and in `wrangler.jsonc`. On, a
   * path still answers `chain_unsupported` on mainnet until its contracts are
   * in `DEPLOYMENTS_BY_CHAIN`, whose mainnet table is empty. The one
   * exception is the 8453 test relay (M2, `services/testRelay.ts`), which
   * signs `handleOps` on mainnet with its own key,
   * `RELAYER_MAINNET_TEST_PRIVATE_KEY`, for the allowlisted test accounts,
   * taking its addresses from `BASE_MAINNET_TEST_DEPLOYMENTS`, and only while
   * `AA_MAINNET_TEST_RELAY` is also `"true"`.
   */
  BASE_MAINNET_ENABLED?: string;

  /**
   * Base mainnet JSON-RPC, read only when `BASE_MAINNET_ENABLED` is `"true"`.
   * In development the Base-mainnet fork (anvil on :8546, chain id 8453); a
   * keyed provider's URL is a secret. No default.
   */
  BASE_RPC_URL?: string;

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
  /**
   * The documents gateway, for the ops that carry a whole document the user
   * opted to send (`DOCUMENT_OPS` in `services/inference`): the same no-log,
   * no-cache settings and no DLP (infra/ai-gateways.json). Unset: those ops
   * take the strict gateway, whose DLP would refuse the document.
   */
  AI_GATEWAY_DOCUMENTS_ID?: string;
  /**
   * `GET /v1/privacy/ai` (secrets): a Cloudflare API token with AI Gateway
   * Read only, and the account id it reads, so the route can show the live
   * gateway settings. Never a var: the account id stays out of wrangler.jsonc.
   */
  AI_GATEWAY_READ_TOKEN?: string;
  AI_GATEWAY_ACCOUNT_ID?: string;
  /** The deployed version (wrangler.jsonc `version_metadata`), shown by `GET /v1/privacy/ai`. */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  /** Model pins by variable; each falls back to the op's default in `services/inference`. */
  CHAT_ROUTER_MODEL?: string;
  CHAT_ACTION_MODEL?: string;
  CHAT_ANSWER_MODEL?: string;
  CHAT_LONG_MODEL?: string;
  /** The Thinking tier's model (decision 0047, amended 2026-10-21); unset, `@cf/deepseek-ai/deepseek-v4.1-flash-1017`. */
  CHAT_REASONING_MODEL?: string;
  /**
   * Clef's reasoning score (0 to 1) at or above which a Thinking turn runs at
   * high effort instead of low. Unset: never, high effort is unmeasured.
   */
  CHAT_THINKING_HIGH_FLOOR?: string;
  /**
   * The router's hiring check (the founder's "layer 0", 2026-10-30): a number
   * in (0, 1] asks Clef whether the message asks for a worker, and at or above
   * it the turn opens the hirer's flow (`post_job`, the app's Find workers).
   * Unset: not asked. 0.5 in `wrangler.jsonc` since 2026-10-31 (workspace
   * decision 0073).
   */
  CHAT_HIRE_FLOOR?: string;
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

  // ── Cofferdam Work (workspace docs/product/engine.md) ───────────
  /**
   * Model pins for the Work op classes in `services/inference` when `AI_PINS`
   * has none; unset, the seam's defaults: `clef-flash` for the document type,
   * `llama-3.3-70b-instruct-fp8-fast` in JSON mode for a block's fields
   * (decision 0020), `gpt-oss-120b` when that fails. A Clairic pin
   * (`@cf/cloudflare/clairic`) switches the extraction request to its typed
   * fields.
   */
  WORK_CLASSIFY_MODEL?: string;
  WORK_EXTRACT_MODEL?: string;
  WORK_EXTRACT_FALLBACK_MODEL?: string;
  /** The hirer's sentence into the intent's fields (S5); unset, llama-3.3-70b in JSON mode. */
  WORK_INTENT_MODEL?: string;
  /** A hirer's request into a job profile in the work profile's shape (`services/work/jobProfile.ts`); unset, DeepSeek V4.1 Flash, low reasoning for a short request and none for a vacancy (`effortFor`). */
  WORK_JOB_PROFILE_MODEL?: string;
  /** The whole-CV parse (`POST /v1/work/parse`, `services/work/parse.ts`); unset, DeepSeek V4.1 Flash with thinking off, the founder's pin of 2026-10-28 (workspace decision 0021). */
  WORK_PARSE_MODEL?: string;
  /** A Vault document's reading (`POST /v1/work/document`, `services/work/document.ts`); unset, DeepSeek V4.1 Flash with thinking off, the parse's model (workspace decision 0081, item 3). */
  WORK_DOCUMENT_MODEL?: string;
  /**
   * The token registry's models (decision 0018): embeddings (set to
   * EmbeddingGemma 2's LiteRT-LM file, the v2 generation, which the phone
   * runs, and the seam's default is the same id; changing it is a re-embed
   * migration into indexes of its own, never a quiet swap), Cofferdam Cloud's
   * stand-in for it when a request carries no vector (`WORK_EMBED_CLOUD_MODEL`;
   * unset, Workers AI's EmbeddingGemma 2, the only model the v2 pin takes there,
   * workspace decision 0084), Clef's choice in
   * the τ band (unset, `clef-flash`), and a new token's English pivot (unset,
   * `llama-3.3-70b` in JSON mode).
   */
  WORK_EMBED_MODEL?: string;
  WORK_EMBED_CLOUD_MODEL?: string;
  WORK_ADJUDICATE_MODEL?: string;
  WORK_PIVOT_MODEL?: string;
  WORK_DECIDE_MODEL?: string;
  /**
   * τ for retrieve-then-choose, cosine in (0, 1]: at or above `WORK_TAU_AUTO`
   * the best candidate snaps without a model; down to `WORK_TAU_LOW` Clef
   * adjudicates; below, a mint. Unset or invalid: the pinned `work-embed` model's own
   * (`DEFAULT_TAU_BY_MODEL` in `services/work/registry.ts`: bge-m3 0.95 and 0.6, EmbeddingGemma
   * 0.81 and 0.45, the v2 pin 0.96 and 0.81); one set alone keeps the other's, and a pair out of order falls back to the model's.
   */
  WORK_TAU_AUTO?: string;
  WORK_TAU_LOW?: string;
  /**
   * The English pivot in the registry's band (workspace decision 0018, amendment proposed 2026-10-30): `"1"` asks
   * `work-pivot` for the English name of a worker's Portuguese or Spanish occupation or skill in parallel with the
   * embedding, and shows Clef the token that name names among the band's candidates (`RegistryDeps.pivotBand`).
   * Unset or any other value: off, as before, until the founder rules on it.
   */
  WORK_PIVOT_BAND?: string;
  /**
   * The Work plane's D1 database, `cofferdam-work`: the token registry and
   * the listing records (migrations in `migrations/work/`). Created
   * 2026-10-24 and bound with `remote: true`, so `wrangler dev` uses the live
   * database too.
   */
  WORK_DB?: D1Database;
  /** `token-registry-v2`: one vector per registry label from EmbeddingGemma 2's LiteRT-LM file (768 dimensions, cosine), metadata index on `kind`. */
  TOKEN_REGISTRY?: Vectorize;
  /**
   * `jobs-listings-v2`: one vector per published listing, the phone's
   * EmbeddingGemma 2 (768, cosine), namespaced by coarse region and scope
   * (`us-tx:onsite`, `br:remote`, decision 0019), metadata `{v, region, scope,
   * tier, bloom, model}` only; metadata index on `tier`. Created 2026-10-30,
   * like `token-registry-v2`, in place of v1's bge-m3 pair of 2026-10-24; both
   * bound with `remote: true`, since Vectorize has no local mode.
   */
  JOBS_LISTINGS?: Vectorize;
  /** Countries whose remote namespaces a remote intent queries, comma-separated ISO codes; unset, `us,br,mx`. */
  WORK_REMOTE_COUNTRIES?: string;
  /**
   * The key of the account's Work pseudonym (`services/work/pseudonym.ts`):
   * HMAC-SHA-256 of the account, which the listing records are keyed by, so
   * none names the account. A secret, at least 32 characters (`openssl rand
   * -base64 32`), set with `wrangler secret put WORK_PSEUDONYM_KEY`. Unset or
   * shorter, `/v1/work/listing` answers 503 `pseudonym_key_unprovisioned`.
   * Rotating it changes every pseudonym, and no listing can be re-keyed in
   * place (no record holds its account), so a rotation takes every listing
   * (record and vector) down first and the phones publish again; no tool
   * does that yet. Never swap it quietly.
   */
  WORK_PSEUDONYM_KEY?: string;
  /** `/v1/work/*` and `/v1/jobs/*`: a global brake per route family, and per account after the gate passes. */
  WORK_RL?: RateLimit;
  /** `/v1/work/*` and `/v1/jobs/*`: a generous per-IP ceiling before the gate. */
  WORK_IP_RL?: RateLimit;

  /**
   * Private key for the relayer account on Base Sepolia: submits ERC-4337
   * `handleOps` for the app's sponsored ops (`/v1/aa/user-operation`, refunded
   * by the paymaster).
   * Same account used for the CDP Paymaster on Sepolia.
   * Set via `wrangler secret put RELAYER_PRIVATE_KEY`.
   * Migration path: replace with CDP Server-Side Wallets for production.
   */
  RELAYER_PRIVATE_KEY?: string;

  /**
   * The Base mainnet test relay (workspace decision 0080, M2; `services/testRelay.ts`):
   * on only for exactly `"true"`, with `BASE_MAINNET_ENABLED` and `BASE_RPC_URL`,
   * `BASE_MAINNET_TEST_DEPLOYMENTS`, `AA_MAINNET_TEST_ACCOUNTS` and
   * `RELAYER_MAINNET_TEST_PRIVATE_KEY`. `"false"` in `wrangler.jsonc`.
   */
  AA_MAINNET_TEST_RELAY?: string;

  /** Comma-separated test accounts the mainnet test relay serves; no other sender is relayed. */
  AA_MAINNET_TEST_ACCOUNTS?: string;

  /**
   * The throwaway test generation's addresses, JSON in the shape of
   * `base-contracts/deployments/*.json` (`CofferdamAccountFactory4337`,
   * `CofferdamIdentityRegistry`), set on a test deployment only: decision 0080
   * (2) keeps them out of the plane's defaults.
   */
  BASE_MAINNET_TEST_DEPLOYMENTS?: string;

  /**
   * The mainnet test relay's own EOA, a small balance from recorded Cofferdam
   * Inc. money (decision 0080, T4): never `RELAYER_PRIVATE_KEY`, never the
   * CofferdamDev key. Set by the founder via
   * `wrangler secret put RELAYER_MAINNET_TEST_PRIVATE_KEY`; deleted when M2 ends.
   */
  RELAYER_MAINNET_TEST_PRIVATE_KEY?: string;

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

  /**
   * The `csa1:` v2 replay cache, one object per device key (services/popReplayDO.ts,
   * workspace decision 0055). Unbound outside development: every v2 request
   * answers 503 `replay_store_unavailable`, never an unchecked proof.
   */
  POP_REPLAY_DO?: DurableObjectNamespace<PopReplayDO>;

  /**
   * The device-link ceremony's one-shot relay, one object per `keyHash` and account (`<keyHash>:<account>`)
   * (services/vaultHandoffDO.ts, workspace decision 0081, step 5). Unbound:
   * the handover routes answer 503 `handover_unprovisioned`.
   */
  VAULT_HANDOFF_DO?: DurableObjectNamespace<VaultHandoffDO>;

  /**
   * `"false"` refuses `csa1:` v1 bearer tokens on every gated route (workspace
   * decision 0055). Any other value, or unset, accepts them during the move to
   * v2; set it once the app build that sends v2 is out.
   */
  CSA1_V1_ACCEPTED?: string;

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
  /**
   * The Base mainnet test relay's own limit (decision 0080, M2): its global
   * key `aa-test:global` and its per-sender `aa-test:<sender>`, both counted
   * once policy and the pre-flights pass. Unbound, the lane counts on
   * `AA_RELAY_RL`.
   */
  AA_TEST_RELAY_RL?: RateLimit;
  /** `/v1/ceremony/*` (decision 0016 co-signs): a global brake, and per account once the gate passes. */
  CEREMONY_RL?: RateLimit;
  /** `/v1/ceremony/*`: a generous per-IP ceiling before the gate. */
  CEREMONY_IP_RL?: RateLimit;

  /** `/v1/vault/*` (workspace decision 0081): the global brake, `vault:global`, first on every route. */
  VAULT_GLOBAL_RL?: RateLimit;
  /** `/v1/vault/*`: per account (`vault:<account>`), counted only once the session and the on-chain High check pass. */
  VAULT_RL?: RateLimit;
  /** `/v1/vault/*`: a generous per-IP ceiling (`vault-ip:<ip>`) before the gate. */
  VAULT_IP_RL?: RateLimit;

  // ── R2 buckets ──────────────────────────────────────────────────
  /**
   * `cofferdam-vault` (workspace decision 0081): each account's sealed Vault
   * blobs, database snapshot and key wrap under the lower-cased attested
   * account address. Unbound, `/v1/vault/*` answers `503 vault_unprovisioned`.
   */
  VAULT?: R2Bucket;
  // SRS:   R2Bucket;

  // ── D1 databases (provisioned in later sessions) ────────────────
  // DB: D1Database;

  // ── Handles (workspace decision 0086, runbook handles-build.md step 3) ──
  /**
   * `cofferdam-handles-sepolia` (the test registry; a fresh `cofferdam-handles` at the MVP cut): the handle registry, the reserved list, the hold log,
   * the share links and the announcement feed (`migrations/handles/`), apart
   * from `WORK_DB` and from 0083 R10's address map. Unbound, every
   * `/v1/handles`, `/v1/handshake` and `/v1/announcements` route answers
   * `503 handles_db_unprovisioned` and the cron does nothing.
   */
  HANDLES_DB?: D1Database;
  /** The handle routes' per-IP ceiling (`handles-ip:`, `handshake-ip:`, `announce-ip:` keys); no IP is stored. */
  HANDLES_IP_RL?: RateLimit;
  /** The handle routes' global brake (`handles:global`, `handshake:global`, `announce:global`), after the per-IP ceiling. */
  HANDLES_GLOBAL_RL?: RateLimit;
  /** A share link's upload, the one public write: its own per-IP ceiling (`handshake-put-ip:`), far below the reads'. */
  HANDSHAKE_PUT_IP_RL?: RateLimit;
  /** A share link's upload: its own global brake (`handshake-put:global`), so uploads never spend the fetches'. */
  HANDSHAKE_PUT_GLOBAL_RL?: RateLimit;
  /**
   * The quarantine after a release, in whole days, as the anchor this plane
   * relays to enforces it (decision 0086 rule 3; runbook step 2 deploys short
   * delays on Base Sepolia). Unset or not a whole number: 365.
   */
  HANDLES_QUARANTINE_DAYS?: string;
  /**
   * The first Base Sepolia block the announcement feed indexes, decimal. Unset,
   * the indexer is off and the feed stays empty; set it once, to a block before
   * the first Cofferdam announcement (the cursor then lives in `HANDLES_DB`).
   */
  ANNOUNCEMENTS_FROM_BLOCK?: string;
  /**
   * The plane's own announcers, comma-separated addresses, whose announcements
   * the feed keeps without a value check (pay-link and self-derived addresses,
   * decision 0086 rule 5). Unset: none, since none exists yet.
   */
  ANNOUNCEMENTS_PLANE_CALLERS?: string;
  /** A JSON-RPC URL for the feed's reads (a secret when it carries a key); unset, `BASE_SEPOLIA_RPC_URL`. */
  ANNOUNCEMENTS_RPC_URL?: string;
  /**
   * The tokens whose transfer to an announced address in the same transaction
   * makes the feed keep the announcement, comma-separated addresses. Unset:
   * Base Sepolia's MockUSDC and Circle USDC (decision 0086 q18, ruling F).
   */
  ANNOUNCEMENTS_TOKENS?: string;
  /**
   * `CofferdamHandleAnchor` on Base Sepolia (decision 0086 rule 3), once the
   * founder deploys it. Unset, the claim and every route that signs or relays
   * answers `503 anchor_unconfigured`, and the relay sends nothing.
   */
  HANDLE_ANCHOR_ADDRESS?: string;
  /**
   * Secret: the registrar's private key (0x and 64 hex), on the anchor's
   * Safe-owned registrar list; it signs the registrar's typed data and pays the
   * gas of the calls the relay sends (ASSUMPTION(0086 ruling P)). The founder
   * sets it with `wrangler secret put HANDLE_REGISTRAR_KEY`; no session reads it.
   */
  HANDLE_REGISTRAR_KEY?: string;
  /**
   * Secret: the key that signs the plane's own statements, the rename's
   * same-identity statement (0086 rule 7) and the Verified statement (rule 9),
   * 0x and 64 hex, never the registrar key (the review of 2026-11-19, M5: a
   * stolen registrar key must not mint them). Clients check the statements
   * against the address `GET /v1/handles/registrar` names as `statements`. The
   * founder sets it with `wrangler secret put HANDLE_STATEMENT_KEY`; unset, a
   * rename and the Verified route answer `503 statement_key_unprovisioned`.
   */
  HANDLE_STATEMENT_KEY?: string;
  /**
   * Secret: 32 bytes as 64 hex, the key of the identity map's tags and of the
   * watched addresses' seals (`services/handles/mapKey.ts`). Unset, every
   * authenticated handle route answers `503 handles_map_key_unprovisioned`.
   */
  HANDLES_MAP_KEY?: string;
  /**
   * The unbuilt gates this deployment goes without, comma-separated:
   * `device-attestation`, `install-proof`, `locator-pin`
   * (`services/handles/config.ts`). Honoured only under `ENVIRONMENT`
   * `development` or `staging` and only while the handles chain is Base Sepolia.
   */
  HANDLES_SKIP_UNBUILT_GATES?: string;
  /** A claim's relay delay as `min,max` seconds (rule 3: minutes to hours); unset, 600,10800. */
  HANDLES_RELAY_DELAY_S?: string;
  /**
   * Seconds a claim lands at least after its account's deployment (rule 3: never
   * the same hour); unset, 3600. The Sepolia test deployment shortens it so a
   * device test finishes in a session.
   */
  HANDLES_DEPLOY_GAP_S?: string;
  /** A rename's release delay as `min,max` seconds (rule 3: one to seven days); unset, 86400,604800. */
  HANDLES_RELEASE_DELAY_S?: string;
  /**
   * The one-time account factory the `addresses` check computes addresses under
   * (0083 rule 4), with its init code hash. Both unset: the shared fixture's
   * placeholder (ASSUMPTION(0086 ruling A)); one without the other refuses.
   */
  ONE_TIME_FACTORY?: string;
  ONE_TIME_INIT_CODE_HASH?: string;
  /** The authenticated handle routes' per-account bucket (`handles-acct:<account>`), counted after the gate. */
  HANDLES_ACCOUNT_RL?: RateLimit;

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
