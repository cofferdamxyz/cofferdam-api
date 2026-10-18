# cofferdam-api

The Cofferdam plane: a Cloudflare Worker (Hono, viem) that is the only public backend surface of the Cofferdam stack. It receives Self.xyz's passport proofs and hands the attester-signed bind bundle to the app, relays the app's passkey-signed ERC-4337 operations with paymaster sponsorship, issues ceremony co-signs, verifies `csa1:` session attestations, reads Base, and resolves companies by domain. It holds no passport data and no user keys. Signing keys for binds and ceremonies live in [`cofferdam-attester`](https://github.com/cofferdamxyz/cofferdam-attester), reached only through a service binding.

## Layout

```
src/
  index.ts           Hono app: middleware, sub-routers, BindBundleDO export
  env.ts             typed bindings (keep in sync with wrangler.jsonc)
  routes/            one sub-router per surface (self, aa, ceremony, session, attester,
                     enterprise, activity, sepolia, health)
  services/          the logic behind them: selfBind, bindBundleDO, userOp, ceremony,
                     sessionAttestation, activity, company, companyLinks, attester (RPC types)
  chain/             viem client, Celo reads, deployments.ts (SEPOLIA_DEPLOYMENTS)
test/                Vitest suites and fixtures (test/xmtp/ for the operator Workers)
wrangler.jsonc       vars, zone route, service binding, Durable Object, rate limits
xmtp/                the XMTP operator, three Workers deployed on their own (not the plane):
  backend/           cofferdam-xmtp-backend: the XMTP 8 backend as a Container (Dockerfile,
                     backend.toml), a keep-alive cron, the inbound-TCP ingress slot
  push-relay/        cofferdam-push-relay at push.cofferdam.xyz: seals device tokens, turns the
                     backend's signed webhook into an APNs alert or FCM data push; stores and logs nothing
  cleanup/           cofferdam-xmtp-cleanup: hourly deletion of expired envelopes through Hyperdrive
```

The `xmtp/` Workers share this repository's dependencies and tests but deploy separately (`cd xmtp/<name> && npx wrangler deploy`, from the Mac). The plane never holds a device token, a topic or a message; design in the workspace `docs/architecture/messaging.md` (decisions 0039 to 0042), runbook `docs/runbooks/xmtp-backend.md`.

## Routes

| Method and path | What it does |
|---|---|
| `GET /health` | liveness |
| `GET /sepolia/block-height`, `GET /sepolia/contracts` | Base Sepolia head; the pinned contract addresses |
| `POST /v1/self/verify` | Self's relayer posts the `disclose` proof; pre-flights `NullifierRegistry`, calls the attester's Celo-gated `signBind` or `signRebind`, stores the bundle in the account's `BindBundleDO` (30 min) |
| `GET /v1/self/bind-bundle/:account` | the app picks up its bundle; requires a `csa1:` attestation for the account from a key that is an active High authority on it (checked on Base), outside `development` |
| `POST /v1/aa/user-operation` | relays a passkey-signed op: policy (our paymaster, our factory in `initCode`, gas and fee caps), simulation, `handleOps` from the relayer key; the first op deploys the account |
| `POST /v1/ceremony/first-high` | the co-sign for a first-High enrolment (`enrollFirstHigh`): requires the signing authority's own session token (`Authorization: Bearer csa1:…` or `csa-sess1.…`), gated on the account's chain state, signed by the attester's ceremony key |
| `POST /v1/session/verify-attestation` | verifies a `csa1:` envelope from `@cofferdam/sdk`, optionally against the account's on-chain authority |
| `POST /v1/attester/test-sign` | rail smoke test (served only under `ENVIRONMENT=development`, so `wrangler dev`; 404 on the deployment): synthetic signals with Celo's current roots, signed by the attester, checked against `SelfAttesterRegistry` on Base |
| `GET /v1/activity?address=`, `GET /v1/activity/check` | USDC transfers per chain (the webhook-fed record and 200-block RPC scans on Sepolia, SQD Portal on mainnet) and a cheap "anything new" check |
| `POST /v1/activity/webhooks/cdp` | CDP onchain webhook: verifies `X-Hook0-Signature`, records each MockUSDC transfer in the sender's and recipient's `ActivityDO` |
| `GET /v1/enterprise/resolve?domain=`, `GET /v1/enterprise/companies/:companyAnchor` | domain → `companyAnchor` with the DNS challenge; on-chain registration status |
| `POST /v1/enterprise/links`, `GET /v1/enterprise/links`, `GET /v1/enterprise/links/check`, `POST /v1/enterprise/links/:companyAnchor/:consumerId/revoke` | company ↔ consumer-app link grants; `503 link_store_unprovisioned` until the `LINKS` KV namespace exists |

`GET /` lists the routes. Errors are `{ ok: false, error }` JSON.

## Develop

yarn only; never `npm install`.

```bash
yarn install
yarn dev          # wrangler dev --ip 0.0.0.0 on :8787 (reachable from a phone on the LAN)
yarn test         # Vitest
yarn typecheck
```

For local signing, run `cofferdam-attester` alongside (`yarn wrangler dev --port 8788` there); the local registry wires the `ATTESTER` binding. `.dev.vars` (ignored) holds `RELAYER_PRIVATE_KEY` and `ENVIRONMENT=development`, which lets the bundle pickup run without a `csa1:` token. Self's callback cannot reach a local Worker: bind tests use the deployed API.

## Deploy

From the Mac with the workspace `.envrc` loaded, the attester first when a pin moves: `direnv exec .. yarn deploy`. See `docs/runbooks/cloudflare-deploys.md` in the cofferdam workspace repository.

## Key facts

- Hosts: `https://cofferdam-api.shy-cell-424a.workers.dev` (every route) and the zone route `cofferdam.xyz/v1/*`. The Self endpoint must stay on `cofferdam.xyz`: the host is part of the registry's immutable scope.
- `ENVIRONMENT=staging` on the deployment. Secrets: `RELAYER_PRIVATE_KEY`; optional `ACTIVITY_RPC_URL` (CDP Node URL for the activity scans) and `CDP_WEBHOOK_SECRET` (with the `ACTIVITY_INDEX_FROM_BLOCK` var, turns on the activity store); optional `POLIS_DATABASE_URL` (Neon `polis`) and `ACTIVITY_DATABASE_URL`, unused until provisioned.
- `src/chain/deployments.ts` mirrors `base-contracts/deployments/baseSepolia.json` by hand; the relay policy, the ceremony gate and the Self routes read it. `NullifierRegistry` must equal the attester's `NULLIFIER_REGISTRY_ADDRESS`.
- `src/services/sessionAttestation.ts` must stay byte-compatible with the SDK's `sessionAttestation.ts`.
- No `account_id` in `wrangler.jsonc`. Stores: Durable Objects today; Neon Postgres, KV, R2 and D1 as surfaces need them. No MongoDB.

## Documentation

Design documentation lives in the cofferdam workspace repository under `docs/` and will be published at docs.cofferdam.xyz: `docs/architecture/plane.md` (this Worker and the attester), `docs/architecture/identity.md`, `docs/architecture/contracts.md`, `docs/runbooks/cloudflare-deploys.md`, `docs/runbooks/self-verification.md`.

## License

Apache License 2.0. Copyright 2026 Cofferdam Inc. See `LICENSE` and `NOTICE`.
