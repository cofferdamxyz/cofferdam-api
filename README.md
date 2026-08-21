# cofferdam-api

> Public-edge HTTP Worker for the [Cofferdam](https://cofferdam.xyz) wallet stack.
> Hono router on Cloudflare Workers; reads Base contracts via viem; binds to
> [`cofferdam-attester`](https://github.com/cofferdamxyz/cofferdam-attester) over
> Workers RPC for signing operations.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

## What it does

`cofferdam-api` is the only public-facing surface in the Cofferdam backend. It:

- Serves the REST API consumed by the Cofferdam wallet (`cofferdam-app`).
- Reads on-chain state from Base (Sepolia today, mainnet later) via [viem](https://viem.sh).
- Brokers cross-Worker calls to `cofferdam-attester` (Self.xyz signing) and, in
  later sessions, `cofferdam-prover` (Groth16 prover Container) — both of which
  are private, service-binding-only Workers.

It is **stateless** with respect to identity: no passport bytes, no biometric
material, no private keys ever transit through this Worker. The trust model is
documented in
[cofferdam-sdk/IDENTITY_LAYER_DESIGN.md](https://github.com/cofferdamxyz/cofferdam-sdk/blob/main/IDENTITY_LAYER_DESIGN.md).

## Architecture

### Chain layer — Base Sepolia

All on-chain reads target **Base Sepolia** (chain ID `84532`) via a single
viem public client (`src/chain/client.ts`). The client uses the stock
`baseSepolia` chain definition from `viem/chains` — no L2-specific decorators
or custom transport. The RPC URL is configured via the `BASE_SEPOLIA_RPC_URL`
environment variable (defaults to `https://sepolia.base.org`, the public
Base Sepolia endpoint).

Contract addresses are vendored from
[`base-contracts/deployments/baseSepolia.json`](https://github.com/cofferdamxyz/base-contracts/blob/main/deployments/baseSepolia.json)
into `src/chain/deployments.ts`. The canonical contracts include:

- **ERC-4337 EntryPoint** (`0x0000000071727De22E5E9d8BAf0edAc6f37da032`) — the
  v0.7 EntryPoint preinstalled on Base.
- **CofferdamAccountFactory4337** — create2 factory for per-user smart accounts.
- **CofferdamPaymaster** — open paymaster sponsoring gasless account ops.
- **WebAuthnPasskeyAuthority** / **PasskeyAuthority** — high-tier passkey
  authority modules (WebAuthn assertion vs raw P-256 `r||s`).
- **SessionKeyAuthorityLowUntrusted** / **SessionKeyAuthorityLowManaged** —
  low-tier session-key authority modules.
- **SelfAttesterRegistry** — allow-list of trusted Self.xyz TEE attester
  ECDSA addresses.
- **NullifierRegistry** — one-shot Self.xyz nullifier-to-account binding,
  locked to the immutable scope `cofferdam-bind-v1` (must match `SelfApp.scope`
  in `cofferdam-app`). Also pins `selfDestChainId` to Self's declared
  `SelfApp.chainID` (`42220`), not Base's.
- **Verifier_vc_and_disclose** — the real snarkJS Groth16 verifier for Self's
  `vc_and_disclose` circuit, vendored from Self and deployed on Base Sepolia.
  (The earlier `MockGroth16Verifier` deploy is superseded.)
- **MockUSDC** — test USDC token.
- **EscrowFactory** / **CofferdamSpotEscrow** — paid maritime contract surface.

The `PASSKEY_AUTHORITY_MODULE_BY_SCHEME` map resolves a session attestation's
signature scheme (`webauthn` or `p256`) to the correct on-chain authority
module address, used by the `checkOnChain` verification path.

### Service bindings

The Worker binds to `cofferdam-attester` via a Cloudflare service binding
(`ATTESTER`). This is a private, same-account RPC channel — no public ingress.
The attester Worker holds the Self.xyz attester ECDSA signing key and exposes
a `signBind` RPC method. Local dev requires both Workers running under
`wrangler dev`; Wrangler 4's local registry auto-discovers and wires the
binding.

### Data sources

| Store | Purpose | Status |
|-------|---------|--------|
| **Base Sepolia RPC** | Block height, contract reads, on-chain authority verification | ✅ Live |
| **SQD Portal Stream API** | ERC-20 Transfer history for `/v1/activity` | ✅ Live (archival for Sepolia, real-time for mainnet) |
| **Base Sepolia RPC (eth_getLogs)** | Recent transaction fallback for activity (Sepolia only) | ✅ Live |
| **Workers KV (`LINKS`)** | CompanyConsumerLink grants | 🟡 Declared, not yet provisioned |
| **Neon Postgres (`POLIS_DATABASE_URL`)** | Enterprise SSO/SCIM identity | 🟡 Declared, not yet provisioned |
| **R2 (`VAULT`, `SRS`)** | Encrypted blobs, SRS | 🟡 Declared, not yet provisioned |
| **D1 (`DB`)** | Non-sensitive metadata + audit logs | 🟡 Declared, not yet provisioned |

### Activity service — dual data source

`/v1/activity` uses a dual-source strategy (`src/services/activity.ts`):

- **Base Sepolia (84532):** Direct RPC `eth_getLogs` with 2000-block pagination
  (15 chunks × 2000 = 30K blocks ≈ 24h lookback). SQD Portal's base-sepolia
  dataset is archival-only and lags ~10 days, so RPC is the only way to get
  recent testnet transactions.
- **Base Mainnet (8453):** SQD Portal Stream API (real-time, 7-day lookback).
  Portal's base-mainnet dataset has `real_time=true`.

USDC addresses are chain-specific: MockUSDC on Sepolia, native USDC on mainnet.

### Relayer — EIP-7702 sponsored transactions

`POST /v1/relayer/setup-investments` submits a type-4 EIP-7702 transaction on
behalf of a user's new EOA, atomically delegating to EIP7702Proxy and calling
`setImplementation` to initialize a CoinbaseSmartWallet with the Cofferdam
passkey as owner. The client signs everything off-chain (delegation
authorization + setImplementation EIP712 hash); the relayer constructs and
submits the type-4 tx, paying gas from its own account. The user's EOA needs
zero ETH.

The relayer key is configured via `wrangler secret put RELAYER_PRIVATE_KEY`.
Migration path: replace with CDP Server-Side Wallets for production.

### Data boundaries — the plane never touches consumer data

`cofferdam-api` is the **Cofferdam company plane**. Its stateful stores are
**Neon Postgres** (Polis's dedicated SSO/SCIM DB), **Workers KV**, **R2**, and
**Base** on-chain. **It has no MongoDB** — MongoDB belongs solely to
consumer apps (e.g. OffshoreSync's MERN stack). Wallet / Safe / treasury
addresses live only here (Neon + on-chain) and are **never returned to a
consumer**: the SDK exposes labels, roles, balances, and a `walletProvisioned`
flag, not addresses. See `ENTERPRISE_MODULE_PLAN.md` §0 + §4.8.

## Routes (current)

| Method | Path                                                  | Description                                                |
|--------|-------------------------------------------------------|------------------------------------------------------------|
| GET    | `/`                                                   | Service info + route inventory                             |
| GET    | `/health`                                             | Liveness probe                                             |
| GET    | `/sepolia/block-height`                               | Current Base Sepolia block (live RPC)                      |
| GET    | `/sepolia/contracts`                                  | Vendored contract deployments (Base Sepolia)               |
| GET    | `/v1/activity?address=&limit=&chainId=&fromBlock=&toBlock=` | ERC-20 Transfer history (SQD Portal + RPC fallback)   |
| GET    | `/v1/activity/check?address=&sinceBlock=&chainId=`    | Lightweight reconciliation check (has new transactions?)  |
| POST   | `/v1/attester/test-sign`                              | End-to-end smoke test of the attester binding              |
| POST   | `/v1/session/verify-attestation`                      | Verify a `SignInResponse.attestation` (`csa1:`) token ‡    |
| GET    | `/v1/enterprise/resolve?domain=`                      | Domain → global `companyAnchor` (+ DNS challenge, on-chain status) |
| GET    | `/v1/enterprise/companies/:companyAnchor`                | On-chain registration status for a `companyAnchor`            |
| POST   | `/v1/enterprise/links`                                | Issue / re-grant a `CompanyConsumerLink` †                 |
| GET    | `/v1/enterprise/links?companyAnchor=`                    | List a company's links †                                   |
| GET    | `/v1/enterprise/links/check?companyAnchor=&consumerId=`  | Route-guard check for a consumer †                         |
| POST   | `/v1/enterprise/links/:companyAnchor/:consumerId/revoke` | Revoke a link †                                            |
| POST   | `/v1/relayer/setup-investments`                       | EIP-7702 sponsored tx: delegate EOA → CoinbaseSmartWallet  |

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
> signing public key is an **active authority** on the AA account (Base
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
# expect: 13

curl -s http://localhost:8787/sepolia/block-height | jq '{chainId, blockNumber}'
# expect: {"chainId":84532,"blockNumber":"..."}

curl -sX POST http://localhost:8787/v1/attester/test-sign \
  -H 'content-type: application/json' \
  -d '{"account":"0xfa4D920d5592289A1A0F73CA49D626EF8FE4D695"}' | jq '.onchainValid'
# expect: true  (requires cofferdam-attester running with ATTESTER_PRIVATE_KEY set)

# rev-7.4 company plane — domain → global companyAnchor (no storage needed):
curl -s 'http://localhost:8787/v1/enterprise/resolve?domain=acme.com' | jq '{companyAnchor, registration}'
# expect: deterministic companyAnchor + registration.status "registry_not_deployed"

# activity — recent USDC transfers for an address:
curl -s 'http://localhost:8787/v1/activity?address=0xfa4D920d5592289A1A0F73CA49D626EF8FE4D695&limit=5' | jq '{chainId, transactions: .transactions | length}'
# expect: {"chainId":84532,"transactions":N}
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
├── index.ts              Hono app entrypoint + route composition
├── env.ts                Typed environment bindings (vars, secrets, KV, services)
├── chain/
│   ├── client.ts         viem Base Sepolia public client (getBaseSepoliaClient)
│   └── deployments.ts    Vendored contract addresses from base-contracts/deployments/baseSepolia.json
│                         + PASSKEY_AUTHORITY_MODULE_BY_SCHEME map
├── routes/
│   ├── health.ts         GET /health
│   ├── sepolia.ts        GET /sepolia/block-height, /sepolia/contracts
│   ├── activity.ts       GET /v1/activity, /v1/activity/check
│   ├── attester.ts       POST /v1/attester/test-sign
│   ├── session.ts        POST /v1/session/verify-attestation
│   ├── enterprise.ts     GET/POST /v1/enterprise/* (rev-7.4 company plane)
│   └── relayer.ts        POST /v1/relayer/setup-investments (EIP-7702)
└── services/
    ├── attester.ts       Local copy of @cofferdam/attester RPC contract
    │                     (must stay in sync with that repo's src/rpc.ts;
    │                     a future @cofferdam/types package will absorb)
    ├── sessionAttestation.ts  csa1: verifier — byte-compatible (viem + @noble)
    │                     re-impl of @cofferdam/sdk's sessionAttestation.ts
    ├── activity.ts       Dual-source ERC-20 Transfer fetcher
    │                     (SQD Portal Stream API + RPC eth_getLogs fallback)
    ├── company.ts        companyAnchor derivation, domain canonicalization,
    │                     DNS challenge, CofferdamCorporateRegistry reads
    └── companyLinks.ts   CompanyConsumerLink types + KV-backed store

test/
├── sessionAttestation.test.ts   Cross-repo verifier suite (Vitest)
└── fixtures/
    └── sdk-attestations.json     Real @cofferdam/sdk-signed csa1: tokens
```

## Environment variables

| Variable | Type | Description |
|----------|------|-------------|
| `ENVIRONMENT` | var | `development` \| `staging` \| `production` |
| `BASE_SEPOLIA_RPC_URL` | var | Base Sepolia RPC endpoint (default: `https://sepolia.base.org`) |
| `SQD_PORTAL_URL` | var (optional) | SQD Portal Stream API base URL (default: `https://portal.sqd.dev/datasets/base-sepolia`) |
| `RELAYER_PRIVATE_KEY` | secret (optional) | EIP-7702 relayer signing key for `setup-investments` |
| `POLIS_DATABASE_URL` | secret (optional) | Neon Postgres connection string for enterprise SSO |
| `ATTESTER` | service binding | `cofferdam-attester` Worker (Self.xyz signing) |

KV, R2, and D1 bindings are declared in `wrangler.jsonc` but commented out
until provisioned. See [Provisioning](#provisioning) for instructions.

## Sibling repositories

| Repo                                                                       | Role                                          |
|----------------------------------------------------------------------------|-----------------------------------------------|
| [`cofferdam-attester`](https://github.com/cofferdamxyz/cofferdam-attester) | Self.xyz attester signing Worker              |
| [`cofferdam-prover`](https://github.com/cofferdamxyz/cofferdam-prover)     | Self.xyz Groth16 prover Container (WIP)       |
| [`cofferdam-sdk`](https://github.com/cofferdamxyz/cofferdam-sdk)           | Public SDK + identity-layer design doc        |
| [`base-contracts`](https://github.com/cofferdamxyz/base-contracts)         | Solidity contracts (Self.xyz + AA + escrow)   |

## License

[Apache License 2.0](LICENSE). Copyright 2026 Cofferdam Inc.
