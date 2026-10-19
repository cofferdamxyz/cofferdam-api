# AGENTS Instructions

## Scope

Cloudflare Workers API plane for Cofferdam.

## Runtime

- TypeScript, `wrangler`, viem, @noble/curves.
- Do not hardcode `account_id` in `wrangler.jsonc`.

## Key Services

- `src/services/sessionAttestation.ts` verifies `csa1:` passkey-signed envelopes from `@cofferdam/sdk`. Must stay byte-compatible with SDK `sessionAttestation.ts`.
- `src/services/activity.ts` fetches USDC Transfer events per chain (workspace decision 0032): Base Sepolia (84532) reads the CDP-webhook-fed `ActivityDO` record (`activityStore.ts`, `activityDO.ts`, `POST /v1/activity/webhooks/cdp`) and scans older blocks with `activityScan.ts` in chunks of `ACTIVITY_LOG_RANGE` (200: the public node refuses 202), where a refused call is an error, never an empty list; Base mainnet (8453) uses the SQD Portal Stream API (public, unkeyed) and falls back to the chunked scan on 429/529/502/503. `ACTIVITY_LIVE=1 yarn vitest run test/activity.live.test.ts` checks the scan against the public Sepolia node.
- `src/env.ts` declares optional `POLIS_DATABASE_URL` and `ACTIVITY_DATABASE_URL` as future fallbacks.
- `src/routes/self.ts` + `src/services/selfBind.ts` receive Self.xyz's relayer proof (`POST /v1/self/verify`), pre-flight `NullifierRegistry`, call `ATTESTER.signBind` (Celo-gated) or, for a passport bound to another account, read `rebindCount` and call `ATTESTER.signRebind` (bundle `kind: 'rebind'`, decision 0022), and store the bundle in the per-account `BindBundleDO` Durable Object (decision 0010) for `GET /v1/self/bind-bundle/:account` (csa1-gated outside development). The endpoint must stay on the `cofferdam.xyz` host (zone route): only the host enters the immutable scope.
- `src/routes/ceremony.ts` + `src/services/ceremony.ts` issue the decision 0016 ceremony co-sign (`POST /v1/ceremony/first-high`): the gate is pure and tested against fakes; chain reads and the `ATTESTER.signCeremony` call are injected.
- `src/routes/aa.ts` + `src/services/userOp.ts` relay the app's signed ERC-4337 ops (`POST /v1/aa/user-operation`): policy (our paymaster, our factory in `initCode`, gas/fee/prefund caps) → `handleOps` simulation from the relayer → submission with `RELAYER_PRIVATE_KEY`. The first op of an account carries `initCode`, so this is also deployment (decision 0012).
- `src/routes/enterprise.ts` + `src/services/company.ts` + `src/services/companyLinks.ts` implement the domain-anchored `companyAnchor` resolver and `CompanyConsumerLink` grants. Link routes return `503 link_store_unprovisioned` until the `LINKS` KV namespace is created.
- `src/services/inference` is the only way to Workers AI (`test/inference.test.ts` fails on `env.AI` anywhere else): op classes with model pins (`AI_PINS` KV, then `CHAT_*_MODEL`, then the default), an `op:` tag per call, timeouts, and the strict gateway with no log when `AI_GATEWAY_ID` is set.
- `src/routes/chat.ts` + `src/services/chat/` run one Cofferdam Cloud chat turn (`POST /v1/chat`, workspace decision 0037): a global brake and `CHAT_IP_RL`, csa1 and an active High gate remembered for five minutes (`authorityMemo.ts`, chat only), the per-account `CHAT_RL` after the gate, a `clef-flash` router (`router.ts`) and the routed models (`run.ts`: the everyday answer starts with the router and is held until it clears the turn; `choices` when unsure), streamed as server-sent events. The text never reaches a log. Each finished turn is metered per account and month in `ChatUsageDO` (`chatUsageStore.ts`, `chatUsageDO.ts`; prices in `MODEL_PRICES` in `services/inference`) through `waitUntil`; `CHAT_MONTHLY_TOKEN_CAP` (unset: no cap) refuses with `429 fair_use_cap` before any model call, and `GET /v1/chat/usage` answers the month behind the same gate.
- `xmtp/` is the XMTP operator (workspace decision 0042), three Workers that deploy on their own and are not the plane: `backend/` (the XMTP 8 backend container, `backend.toml`, ingress slot `INGRESS=off` until the inbound-TCP beta), `push-relay/` (decision 0040: sealed tokens, APNs alert or FCM data, no storage, no `console`, observability off; `test/xmtp/pushRelay.test.ts` enforces it) and `cleanup/` (hourly expired-envelope deletion; its retention vars mirror `backend.toml` `[retention]`, checked by `test/xmtp/config.test.ts`). The backend's database is a direct Postgres 17+ endpoint, never Hyperdrive or a transaction pooler; only `cleanup/` uses Hyperdrive. `XMTP_CLEANUP_PG_URL=postgres://…/xmtp_cleanup_test yarn vitest run test/xmtp` runs the cleanup SQL against a migrated XMTP schema. On a backend version bump re-check `cleanup/src/sql.ts` against its migrations.
- The planned Assignment service is generic, account-pseudonym keyed, local-first, and escrow-optional. Port structural behavior from OffshoreSync `WorkAssignment`/`ScheduleOverride`; do not import Mongo IDs or maritime social dispatch into the plane.

## Validation and deploys

- `yarn test` and `yarn typecheck` must pass.
- Verify on-chain authority config matches SDK encoding before deploying.
- Deploys run only from the Mac with the workspace `.envrc` loaded (`direnv exec .. yarn deploy`), never from a cloud session; when a contract pin moves, deploy the attester first. Runbook: `docs/runbooks/cloudflare-deploys.md` in the workspace. `src/chain/deployments.ts` mirrors `base-contracts/deployments/baseSepolia.json`.
- Design: `docs/architecture/plane.md` in the workspace.

## References

- Workspace rules: `../AGENTS.md` (Cofferdam workspace) and the cross-entity index one level above
- `../rules/cofferdam-infrastructure.md`
- `../rules/cofferdam-identity.md`
- `../rules/cofferdam-sdk.md`
- `../rules/cofferdam-enterprise.md`
- `../rules/cofferdam-messaging.md`
