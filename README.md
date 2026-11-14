# cofferdam-api

The Cofferdam plane: a Cloudflare Worker (Hono, viem) that is the only public backend surface of the Cofferdam stack. It receives Self.xyz's passport proofs and hands the attester-signed bind bundle to the app, relays the app's passkey-signed ERC-4337 operations with paymaster sponsorship, issues ceremony co-signs, verifies `csa1:` session attestations, reads Base, and resolves companies by domain. It holds no passport data and no user keys. Signing keys for binds and ceremonies live in [`cofferdam-attester`](https://github.com/cofferdamxyz/cofferdam-attester), reached only through a service binding.

## Layout

```
src/
  index.ts           Hono app: middleware, sub-routers, BindBundleDO export
  env.ts             typed bindings (keep in sync with wrangler.jsonc)
  routes/            one sub-router per surface (self, aa, ceremony, session, attester,
                     enterprise, activity, sepolia, health)
  services/          the logic behind them: selfBind, bindBundleDO, vaultHandoffDO, userOp, ceremony,
                     sessionAttestation, activity, company, companyLinks, attester (RPC types)
  chain/             viem clients, chains.ts (which chain a request may read: Base Sepolia,
                     Base mainnet behind BASE_MAINNET_ENABLED), Celo reads,
                     deployments.ts (DEPLOYMENTS_BY_CHAIN; mainnet empty)
test/                Vitest suites and fixtures (test/xmtp/ for the operator Workers)
wrangler.jsonc       vars, zone route, service binding, Durable Objects, rate limits
xmtp/                the XMTP operator, three Workers deployed on their own (not the plane):
  backend/           cofferdam-xmtp-backend: the XMTP 8 backend as a Container (Dockerfile,
                     backend.toml), a keep-alive cron, the inbound-TCP ingress slot, fly.toml fallback
  push-relay/        cofferdam-push-relay at push.cofferdam.xyz: seals device tokens, turns the
                     backend's signed webhook into an APNs alert or FCM data push; stores and logs nothing
  cleanup/           cofferdam-xmtp-cleanup: hourly deletion of expired envelopes through Hyperdrive
```

The `xmtp/` Workers share this repository's dependencies and tests but deploy separately (`cd xmtp/<name> && npx wrangler deploy`, from the Mac). The plane never holds a device token, a topic or a message; design in the workspace `docs/architecture/messaging.md` (decisions 0039 to 0042), runbook `docs/runbooks/xmtp-backend.md`.

## Routes

| Method and path | What it does |
|---|---|
| `GET /health` | liveness |
| `GET /v1/locale` | the country Cloudflare saw for the request, for the app's number format (no auth, nothing stored) |
| `GET /sepolia/block-height`, `GET /sepolia/contracts` | Base Sepolia head; the pinned contract addresses |
| `POST /v1/self/verify` | Self's relayer posts the `disclose` proof; pre-flights `NullifierRegistry`, calls the attester's Celo-gated `signBind` or `signRebind`, stores the bundle in the account's `BindBundleDO` (30 min) |
| `GET /v1/self/bind-bundle/:account` | the app picks up its bundle; requires a `csa1:` attestation for the account from a key that is an active High authority on it (checked on Base), outside `development` |
| `POST /v1/aa/user-operation` | relays a passkey-signed op on Base Sepolia (the body's `chainId` 8453 is the Base mainnet test relay, off in `wrangler.jsonc`: allowlisted test accounts, the registry's `check`, the L1 data fee through `preVerificationGas`, its own key): policy (our paymaster, our factory in `initCode`, gas and fee caps), simulation, the execution pre-flight (`eth_simulateV1`, the op's own `UserOperationEvent`), `handleOps` from the relayer key, then the receipt's outcome (`receipt: success | pending | unknown`, or `422 user_op_reverted`); the first op deploys the account |
| `POST /v1/ceremony/first-high` | the co-sign for a first-High enrolment (`enrollFirstHigh`): requires the signing authority's own session token (`Authorization: Bearer csa1:…` or `csa-sess1.…`), gated on the account's chain state, signed by the attester's ceremony key |
| `POST /v1/session/verify-attestation` | verifies a `csa1:` envelope from `@cofferdam/sdk`, optionally against the account's on-chain authority |
| `POST /v1/attester/test-sign` | rail smoke test (served only under `ENVIRONMENT=development`, so `wrangler dev`; 404 on the deployment): synthetic signals with Celo's current roots, signed by the attester, checked against `SelfAttesterRegistry` on Base |
| `GET /v1/activity?address=`, `GET /v1/activity/check` | USDC transfers per chain (the webhook-fed record and 200-block RPC scans on Sepolia, SQD Portal on mainnet) and a cheap "anything new" check |
| `POST /v1/activity/webhooks/cdp` | CDP onchain webhook: verifies `X-Hook0-Signature`, records each MockUSDC transfer in the sender's and recipient's `ActivityDO` |
| `PUT`, `GET`, `HEAD`, `DELETE /v1/vault/:account/objects/:kind/:id`, `POST /v1/vault/:account/list` | the Vault mirror (decision 0081): the account's sealed blobs and one snapshot object (the sealed database with its key's wrap) in R2 under its lower-cased address, gated by a `csa1:` session and an active High authority on Base; `503 vault_unprovisioned` until the `cofferdam-vault` bucket is bound |
| `DELETE /v1/vault/:account` | wipes the account's whole Vault prefix; needs a slow (fresh passkey) session |
| `PUT /v1/vault/:account/handover/:keyHash` | the device-link ceremony's relay (decision 0081, step 5): the old phone puts the two Vault roots sealed to the new phone's handover key, at most 4 KiB with `content-length`, on a slow session; held ten minutes in a `VaultHandoffDO` named by the `keyHash` and the account, one slot per account (`409 handover_exists` on a second put); `503 handover_unprovisioned` until `VAULT_HANDOFF_DO` is bound |
| `GET /v1/vault/:account/handover/:keyHash` | the new phone takes the blob once on its fast session: `404 handover_pending` before the put or for another account, `410 handover_taken` after; `HEAD` answers `405` so it never spends the take |
| `GET /v1/enterprise/resolve?domain=`, `GET /v1/enterprise/companies/:companyAnchor` | domain → `companyAnchor` with the DNS challenge; on-chain registration status |
| `POST /v1/enterprise/links`, `GET /v1/enterprise/links`, `GET /v1/enterprise/links/check`, `POST /v1/enterprise/links/:companyAnchor/:consumerId/revoke` | company ↔ consumer-app link grants; `503 link_store_unprovisioned` until the `LINKS` KV namespace exists |

`GET /` lists the routes. Errors are `{ ok: false, error }` JSON.

## Develop

yarn only; never `npm install`.

```bash
yarn install
yarn dev          # wrangler dev --ip 0.0.0.0 on :8787 (reachable from a phone on the LAN)
yarn test         # Vitest
yarn typecheck    # Worker, then Worker plus tests (tsconfig.test.json)
yarn lint         # typescript-eslint, type-checked
```

For local signing, run `cofferdam-attester` alongside (`yarn wrangler dev --port 8788` there); the local registry wires the `ATTESTER` binding. `.dev.vars` (ignored) holds `RELAYER_PRIVATE_KEY` and `ENVIRONMENT=development`, which lets the bundle pickup run without a `csa1:` token. Self's callback cannot reach a local Worker: bind tests use the deployed API.

## Deploy

From the Mac with the workspace `.envrc` loaded, the attester first when a pin moves: `direnv exec .. yarn deploy`. See `docs/runbooks/cloudflare-deploys.md` in the cofferdam workspace repository.

## Key facts

- Hosts: `https://cofferdam-api.shy-cell-424a.workers.dev` (every route) and the zone route `cofferdam.xyz/v1/*`. The Self endpoint must stay on `cofferdam.xyz`: the host is part of the registry's immutable scope.
- `ENVIRONMENT=staging` on the deployment. Secrets: `RELAYER_PRIVATE_KEY`; optional `ACTIVITY_RPC_URL` (CDP Node URL for the activity scans) and `CDP_WEBHOOK_SECRET` (with the `ACTIVITY_INDEX_FROM_BLOCK` var, turns on the activity store); optional `POLIS_DATABASE_URL` (Neon `polis`) and `ACTIVITY_DATABASE_URL`, unused until provisioned.
- `src/chain/deployments.ts` mirrors `base-contracts/deployments/baseSepolia.json` by hand; the relay policy, the ceremony gate and the Self routes read it. `NullifierRegistry` must equal the attester's `NULLIFIER_REGISTRY_ADDRESS`. Its Base mainnet table is empty (workspace decision 0080), and mainnet reads are off unless `BASE_MAINNET_ENABLED="true"` with `BASE_RPC_URL` (`src/chain/chains.ts`).
- Identity routes (`/v1/self/*`, the relay, `/v1/attester/*`) never log a passport identifier, a proof, evidence, `custom_data` or an op's call data next to the account (`src/services/identityLog.ts`, `test/identityLogs.test.ts`).
- `src/services/sessionAttestation.ts` must stay byte-compatible with the SDK's `sessionAttestation.ts`.
- No `account_id` in `wrangler.jsonc`. Stores: Durable Objects today; Neon Postgres, KV, R2 and D1 as surfaces need them. No MongoDB.

## Documentation

Design documentation lives in the cofferdam workspace repository under `docs/` and will be published at docs.cofferdam.xyz: `docs/architecture/plane.md` (this Worker and the attester), `docs/architecture/identity.md`, `docs/architecture/contracts.md`, `docs/runbooks/cloudflare-deploys.md`, `docs/runbooks/self-verification.md`.

## License

Apache License 2.0. Copyright 2026 Cofferdam Inc. See `LICENSE` and `NOTICE`.
