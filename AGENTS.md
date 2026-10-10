# AGENTS Instructions

## Scope

Cloudflare Workers API plane for Cofferdam.

## Runtime

- TypeScript, `wrangler`, viem, @noble/curves.
- Do not hardcode `account_id` in `wrangler.jsonc`.

## Key Services

- `src/services/sessionAttestation.ts` verifies `csa1:` passkey-signed envelopes from `@cofferdam/sdk`. Must stay byte-compatible with SDK `sessionAttestation.ts`.
- `src/services/activity.ts` fetches USDC Transfer events per chain: Base Sepolia (84532) uses viem `getLogs` (the Portal's Sepolia dataset lags ~10 days); Base mainnet (8453) uses the SQD Portal Stream API (public, unkeyed) and falls back to RPC on 429/529/502/503.
- `src/env.ts` declares optional `POLIS_DATABASE_URL` and `ACTIVITY_DATABASE_URL` as future fallbacks.
- `src/routes/self.ts` + `src/services/selfBind.ts` receive Self.xyz's relayer proof (`POST /v1/self/verify`), pre-flight `NullifierRegistry`, call `ATTESTER.signBind` (Celo-gated), and store the bind bundle in the `BIND_BUNDLES` KV namespace for `GET /v1/self/bind-bundle/:account` (csa1-gated). The endpoint must stay on the `cofferdam.xyz` host (zone route): only the host enters the immutable scope. Returns `503 bind_store_unprovisioned` until the namespace exists.
- `src/routes/enterprise.ts` + `src/services/company.ts` + `src/services/companyLinks.ts` implement the domain-anchored `companyRef` resolver and `CompanyConsumerLink` grants. Link routes return `503 link_store_unprovisioned` until the `LINKS` KV namespace is created.
- The planned Assignment service is generic, account-pseudonym keyed, local-first, and escrow-optional. Port structural behavior from OffshoreSync `WorkAssignment`/`ScheduleOverride`; do not import Mongo IDs or maritime social dispatch into the plane.

## Validation

- `yarn typecheck` must pass.
- Verify on-chain authority config matches SDK encoding before deploying.

## References

- Workspace rules: `../AGENTS.md` (Cofferdam workspace) and the cross-entity index one level above
- `../rules/cofferdam-infrastructure.md`
- `../rules/cofferdam-identity.md`
- `../rules/cofferdam-sdk.md`
- `../rules/cofferdam-enterprise.md`
- `../rules/cofferdam-messaging.md`
