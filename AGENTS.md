# AGENTS Instructions

## Scope

Cloudflare Workers API plane for Cofferdam.

## Runtime

- TypeScript, `wrangler`, viem, @noble/curves.
- Do not hardcode `account_id` in `wrangler.jsonc`.

## Key Services

- `src/services/sessionAttestation.ts` verifies `csa1:` passkey-signed envelopes from `@cofferdam/sdk`. Must stay byte-compatible with SDK `sessionAttestation.ts`.
- `src/services/activity.ts` fetches Base Sepolia USDC Transfer events. Pre-production uses viem `getLogs`; production uses SQD Portal Stream API.
- `src/env.ts` declares optional `POLIS_DATABASE_URL` and `ACTIVITY_DATABASE_URL` as future fallbacks.
- `src/routes/enterprise.ts` + `src/services/company.ts` + `src/services/companyLinks.ts` implement the domain-anchored `companyRef` resolver and `CompanyConsumerLink` grants. Link routes return `503 link_store_unprovisioned` until the `LINKS` KV namespace is created.
- The planned Assignment service is generic, account-pseudonym keyed, local-first, and escrow-optional. Port structural behavior from OffshoreSync `WorkAssignment`/`ScheduleOverride`; do not import Mongo IDs or maritime social dispatch into the plane.

## Validation

- `yarn typecheck` must pass.
- Verify on-chain authority config matches SDK encoding before deploying.

## References

- Workspace rules: `AGENTS.md` (workspace root)
- `.devin/rules/cofferdam-infrastructure.md`
- `.devin/rules/cofferdam-identity.md`
- `.devin/rules/cofferdam-sdk.md`
- `.devin/rules/cofferdam-enterprise.md`
- `.devin/rules/cofferdam-messaging.md`
