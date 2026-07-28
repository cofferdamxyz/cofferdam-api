# cofferdam-api

> Public-edge HTTP Worker for the [Cofferdam](https://cofferdam.xyz) wallet stack.
> Hono router on Cloudflare Workers; reads ZKSync Era contracts via viem; binds to
> [`cofferdam-attester`](https://github.com/cofferdamxyz/cofferdam-attester) over
> Workers RPC for signing operations.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

## What it does

`cofferdam-api` is the only public-facing surface in the Cofferdam backend. It:

- Serves the REST API consumed by the Cofferdam wallet (`cofferdam-app`).
- Reads on-chain state from ZKSync Era (Sepolia today, mainnet later) via [viem](https://viem.sh).
- Brokers cross-Worker calls to `cofferdam-attester` (Self.xyz signing) and, in
  later sessions, `cofferdam-prover` (Groth16 prover Container) — both of which
  are private, service-binding-only Workers.

It is **stateless** with respect to identity: no passport bytes, no biometric
material, no private keys ever transit through this Worker. The trust model is
documented in
[cofferdam-sdk/IDENTITY_LAYER_DESIGN.md](https://github.com/cofferdamxyz/cofferdam-sdk/blob/main/IDENTITY_LAYER_DESIGN.md).

### Data boundaries — the plane never touches consumer data

`cofferdam-api` is the **Cofferdam company plane**. Its stateful stores are
**Neon Postgres** (Polis's dedicated SSO/SCIM DB), **Workers KV**, **R2**, and
**ZKSync Era** on-chain. **It has no MongoDB** — MongoDB belongs solely to
consumer apps (e.g. OffshoreSync's MERN stack). Wallet / Safe / treasury
addresses live only here (Neon + on-chain) and are **never returned to a
consumer**: the SDK exposes labels, roles, balances, and a `walletProvisioned`
flag, not addresses. See `ENTERPRISE_MODULE_PLAN.md` §0 + §4.8.

## Routes (current)

| Method | Path                                                  | Description                                                |
|--------|-------------------------------------------------------|------------------------------------------------------------|
| GET    | `/`                                                   | Service info + route inventory                             |
| GET    | `/health`                                             | Liveness probe                                             |
| GET    | `/sepolia/block-height`                               | Current ZKSync Era Sepolia block (live RPC)                |
| GET    | `/sepolia/contracts`                                  | Vendored contract deployments                              |
| POST   | `/v1/attester/test-sign`                              | End-to-end smoke test of the attester binding              |
| POST   | `/v1/session/verify-attestation`                      | Verify a `SignInResponse.attestation` (`csa1:`) token ‡    |
| GET    | `/v1/enterprise/resolve?domain=`                      | Domain → global `companyAnchor` (+ DNS challenge, on-chain status) |
| GET    | `/v1/enterprise/companies/:companyAnchor`                | On-chain registration status for a `companyAnchor`            |
| POST   | `/v1/enterprise/links`                                | Issue / re-grant a `CompanyConsumerLink` †                 |
| GET    | `/v1/enterprise/links?companyAnchor=`                    | List a company's links †                                   |
| GET    | `/v1/enterprise/links/check?companyAnchor=&consumerId=`  | Route-guard check for a consumer †                         |
| POST   | `/v1/enterprise/links/:companyAnchor/:consumerId/revoke` | Revoke a link †                                            |

> † The `links/*` routes require the `LINKS` KV namespace; until it's
> provisioned they return `503 link_store_unprovisioned` (see
> [Provisioning](#provisioning)). `resolve` works with no storage —
> `companyAnchor = keccak256("cofferdam-company-v1" || canonicalDomain)` is a
> pure function of the verified domain (`ENTERPRISE_MODULE_PLAN.md` rev-7.4).
>
> **Security (α):** link issuance/revocation are **not yet authorized** —
> `grantedByMemberRef`/`revokedBy` are trusted from the request body. Gate
> behind an it_admin Polis session / company-Safe signature before staging.

> ‡ `POST /v1/session/verify-attestation` is the relying-party verifier for the
> passkey-signed envelope `@cofferdam/sdk`'s `NativeAccountProvider.signIn()`
> returns as `SignInResponse.attestation`. Body:
> `{ attestation: "csa1:…", expect?: { scope?, appPseudonym?, accountAddress?, chainId? }, maxAgeMs?, checkOnChain? }`.
> It decodes the token, verifies the P-256 / WebAuthn signature over the
> committed sign-in fields, applies the optional `expect` field-pins and
> `maxAgeMs` freshness bound, and — with `checkOnChain: true` — confirms the
> signing public key is an **active authority** on the AA account (ZKSync
> Sepolia only; a not-yet-deployed account returns `authority: 'account_not_deployed'`,
> which is expected before the user's first on-chain op and does not invalidate
> the attestation). The verifier (`services/sessionAttestation.ts`) is a
> Workers-native `viem` + `@noble/curves` re-implementation kept **byte-compatible**
> with the SDK's `ethers` codec — same `csa1:` format and digest preimage.

```bash
# verify a session attestation (signature only):
curl -sX POST http://localhost:8787/v1/session/verify-attestation \
  -H 'content-type: application/json' \
  -d '{"attestation":"csa1:…","expect":{"scope":"offshoresync"}}' | jq '{ok, claims}'
# add "checkOnChain": true to also confirm the passkey is an active on-chain authority.
```

> **Planned — Polis SSO broker (rev-7.5a, `ENTERPRISE_MODULE_PLAN.md` §2.6.1 + §5.4).**
> `cofferdam-api` is the enterprise-SSO broker for the company plane. A future
> `src/routes/sso.ts` adds `GET /v1/enterprise/sso/start|callback` (consume
> self-hosted Ory Polis's OIDC and mint a one-time, signed SSO assertion), `POST
> /v1/enterprise/sso/exchange` (server-to-server redemption — the consumer's SDK
> swaps the opaque one-time code for the verified claims, then does its own
> Mongo create-or-link + JWT), `POST /v1/enterprise/sso/connections` (forward to
> the Polis admin API via `src/services/polis.ts`), and `POST
> /v1/enterprise/scim/webhook` (HMAC-verified directory-sync ingest). Polis runs
> as a separately self-hosted container (Apache-2.0) + Neon/Postgres — **never
> embedded in this Worker**. Secrets (`POLIS_API_KEY`, `POLIS_WEBHOOK_SECRET`,
> `STATE_SIGNING_KEY`, OIDC client creds) via `wrangler secret put`, typed in
> `src/env.ts`.

## Local dev

```bash
yarn install
yarn dev
# Wrangler dev on http://localhost:8787 (auto-bumps if 8787 is taken).

# In a separate terminal, also start cofferdam-attester so the
# ATTESTER service binding resolves locally:
git clone https://github.com/cofferdamxyz/cofferdam-attester.git ../cofferdam-attester
cd ../cofferdam-attester && yarn install && yarn dev
```

Wrangler 4's local registry auto-discovers other `wrangler dev` instances on
the same machine and wires service bindings between them.

### Smoke test

```bash
curl -s http://localhost:8787/sepolia/contracts | jq '.contracts | length'
# expect: 5

curl -sX POST http://localhost:8787/v1/attester/test-sign \
  -H 'content-type: application/json' \
  -d '{"account":"0xfa4D920d5592289A1A0F73CA49D626EF8FE4D695"}' | jq '.onchainValid'
# expect: true  (requires cofferdam-attester running with ATTESTER_PRIVATE_KEY set)

# rev-7.4 company plane — domain → global companyAnchor (no storage needed):
curl -s 'http://localhost:8787/v1/enterprise/resolve?domain=acme.com' | jq '{companyAnchor, registration}'
# expect: deterministic companyAnchor + registration.status "registry_not_deployed"
```

## Deploy

```bash
yarn deploy
# Pushes to the Cloudflare account configured by `wrangler login`.
```

CI will deploy automatically when a tag matching `v*` is pushed, gated by the
`production` environment for manual approval. Set `CLOUDFLARE_API_TOKEN` as a
repo secret with `Workers:Edit` + `Account:Read` scopes.

## Testing

```bash
yarn test        # Vitest, single run
yarn test:watch  # watch mode
```

The session-attestation suite (`test/sessionAttestation.test.ts`) is a
**cross-repo regression guard**: it verifies real `@cofferdam/sdk`-signed
`csa1:` tokens (`test/fixtures/sdk-attestations.json`) against this Worker's
`viem` + `@noble/curves` verifier and the Hono route, for **both** signature
schemes (`p256` and `webauthn`). Because the SDK signs with `ethers` and this
Worker verifies with `viem`/`@noble`, the fixtures pin the two implementations
together — any divergence in the `csa1:` format or digest preimage fails the
suite.

The fixtures are committed (deterministic, no secrets — only public keys +
signatures over public test fields). Regenerate them after any wire-format
change from the **cofferdam-sdk** repo:

```bash
cd ../cofferdam-sdk
yarn build
node packages/core/scripts/gen-attestation-fixtures.mjs
# writes ../cofferdam-api/test/fixtures/sdk-attestations.json directly.
```

## Provisioning

The `/v1/enterprise/resolve` and `/companies/:companyAnchor` routes work with no
extra resources. To light up the `CompanyConsumerLink` grant routes
(`/v1/enterprise/links/*`), provision the `LINKS` KV namespace:

```bash
wrangler kv namespace create LINKS
# Paste the returned id into the commented `kv_namespaces` block in
# wrangler.jsonc and uncomment the LINKS line. env.ts already declares
# `LINKS?: KVNamespace` (optional), so no code change is needed.
```

Until then the link routes return `503 link_store_unprovisioned`. On-chain
registration lookups stay `registry_not_deployed` until
`CofferdamCorporateRegistry` (rev-7.4 redeploy, `ENTERPRISE_MODULE_PLAN.md`
§6.C) is vendored into `src/chain/deployments.ts` + `CORPORATE_REGISTRY_ADDRESS`
in `src/services/company.ts`.

## Repository layout

```
src/
├── index.ts              Hono app entrypoint
├── env.ts                Typed environment bindings
├── chain/
│   ├── client.ts         viem ZKSync Era Sepolia public client
│   └── deployments.ts    Vendored contract addresses
├── routes/
│   ├── health.ts         GET /health
│   ├── sepolia.ts        GET /sepolia/*
│   ├── attester.ts       POST /v1/attester/*
│   ├── session.ts        POST /v1/session/verify-attestation
│   └── enterprise.ts     GET/POST /v1/enterprise/* (rev-7.4 company plane)
└── services/
    ├── attester.ts       Local copy of @cofferdam/attester RPC contract
    │                     (must stay in sync with that repo's src/rpc.ts;
    │                     a future @cofferdam/types package will absorb)
    ├── sessionAttestation.ts  csa1: verifier — byte-compatible (viem + @noble)
    │                     re-impl of @cofferdam/sdk's sessionAttestation.ts
    ├── company.ts        companyAnchor derivation, domain canonicalization,
    │                     DNS challenge, CofferdamCorporateRegistry reads
    └── companyLinks.ts   CompanyConsumerLink types + KV-backed store

test/
├── sessionAttestation.test.ts   Cross-repo verifier suite (Vitest)
└── fixtures/
    └── sdk-attestations.json     Real @cofferdam/sdk-signed csa1: tokens
```

## Sibling repositories

| Repo                                                                       | Role                                          |
|----------------------------------------------------------------------------|-----------------------------------------------|
| [`cofferdam-attester`](https://github.com/cofferdamxyz/cofferdam-attester) | Self.xyz attester signing Worker              |
| [`cofferdam-prover`](https://github.com/cofferdamxyz/cofferdam-prover)     | Self.xyz Groth16 prover Container (WIP)       |
| [`cofferdam-sdk`](https://github.com/cofferdamxyz/cofferdam-sdk)           | Public SDK + identity-layer design doc        |
| [`contracts`](https://github.com/OffshoreSync/contracts)                   | Solidity contracts (Self.xyz integration)     |

## License

[Apache License 2.0](LICENSE). Copyright 2026 Cofferdam Inc.
