# REVIEW.md — cofferdam-api (the plane)

Read with `AGENTS.md` and the workspace `docs/architecture/plane.md`. Here failure means **it lets the wrong caller through, leaks, or overspends**.

## What failure looks like

- A gate in the wrong order: the per-account bucket counted before csa1 and the High check pass (account addresses are public), a route that skips the global brake or the per-IP ceiling, a development-only bypass reachable in another `ENVIRONMENT`.
- `src/services/sessionAttestation.ts` no longer byte-compatible with `cofferdam-sdk/packages/core/src/identity/sessionAttestation.ts`.
- The relay (`userOp.ts`, `routes/aa.ts`) accepting an op outside policy: another paymaster or factory, gas, fee or prefund over the caps, submission without simulation.
- A wallet or treasury address, or a nullifier, handed to a consumer app or stored where a consumer surface can read it (wallet isolation, decision 0025).
- Chat text, a prompt or a model answer reaching a log; `env.AI` used outside `src/services/inference`; a hosted AI call that does not record to the meter (`plane:global` included) or runs before the caps are checked.
- A refused or failed upstream call read as an empty result (the activity scan's rule).
- `wrangler.jsonc`: a hardcoded `account_id`, a secret value, a binding or Durable Object migration without its `src/env.ts` type, a migration that renames or deletes a class. Migrations cannot be rolled back: high risk.
- `src/chain/deployments.ts` drifting from `base-contracts/deployments/baseSepolia.json`.
- `facts.generated.ts` edited by hand or out of date with the workspace `skills/`.
- A behaviour change with no test, or a docs claim in the workspace that the change made false.

## Skip

- `facts.generated.ts` contents (check only that it was regenerated), `test/chat-eval/report-*.md`, lockfile churn with no package change.

## How to report

- Every finding names a file and line and quotes the code or text that is wrong. A guess from a name or a path is not a finding.
- Tag each one **Important** (wrong behaviour, a broken rule above, a security or money risk), **Nit** (at most three per review; style alone is never one) or **Pre-existing** (true, but not introduced by this diff; never blamed on it).
- Flag a class of bug once with every instance, not one finding per line. Do not repeat a finding already answered in an earlier round; after the second round read only the new diff.
- Start the summary with the count ("2 Important, 1 Nit, 1 Pre-existing"), and say "Nothing to fix" plainly when that is the result.
- Name the risk tier the diff falls in (workspace `docs/runbooks/code-review.md`).
