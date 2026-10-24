// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * /v1/jobs — the hirer's side of Cofferdam Work (workspace
 * `docs/product/work-wallet.md`, Matching and award; `docs/product/engine.md`,
 * Pipeline, S5 to S7).
 *
 *   POST /v1/jobs/intent  { account, sentence, lang, regions }
 *        → { ok, plan, finalists: { count, byGateTier: { 1, 2 }, byPersonhood: { 0, 1, 2 } } }
 *
 *   Authorization: DPoP csa1:… + DPoP: <proof>   (a fast or slow session, decision 0055)
 *   (or Authorization: Bearer csa1:…, a v1 token, while CSA1_V1_ACCEPTED allows it)
 *
 * Step 1 of Matching and award: the hirer's sentence becomes the intent the
 * confirm card shows (`services/work/hire.ts`: the safety checks and the scope
 * on Clef first, the parse, the needed tokens, the credential and the
 * language, Instant or Curated, what is still missing), and recall previews
 * how many it would reach. Nothing is funded, stored or pinged: no intent
 * record, no escrow, no wave.
 *
 * The sentence is typed text that passed the phone's privacy gate, at most
 * 1,000 characters; the plane runs the block tripwire on it in the body
 * check, before the gate and any model (`422 text_refused` with the reason,
 * never the text), and never logs it. `lang` is `en`, `pt` or `es`;
 * `regions` are coarse regions (`us-tx`, `br-sp`, `mx`), the hirer's own
 * first and then the neighbours the phone says the radius reaches, at most
 * eight, never a position.
 *
 * The finalists come back as counts only: how many, by gate tier (1 passed
 * the Bloom gate; 2 a vector-strong token miss, Curated only) and by the
 * workers' personhood tier ("pinging 8 workers, 7 verified"). Nothing per
 * finalist reaches the hirer before funding: no listing id, score, token list
 * or card, since any of them would let answers be joined to follow a worker
 * or link their profiles (`finalistCounts`). The hirer's own listings are
 * left out (their pseudonym, under `WORK_PSEUDONYM_KEY`).
 *
 * The gate is the Work gate in full (`routes/workGate.ts`) on its own `jobs:`
 * keys; then the stores (`503 work_db_unprovisioned`,
 * `token_registry_unprovisioned`, `jobs_listings_unprovisioned`). Every model
 * call is metered as on /v1/work, a failed plan's included.
 */

import { Hono } from 'hono';

import type { Env } from '../env.js';
import { WorkCallsError } from '../services/work/fields.js';
import { checkHirerRequest, hirerQuery, MIN_BUDGET_USD, type HireOutcome, type HirePlan, type HirerRequest } from '../services/work/hire.js';
import { pseudonymKey, workPseudonym } from '../services/work/pseudonym.js';
import { parseRemoteCountries, type Finalist } from '../services/work/recall.js';
import { parseTau } from '../services/work/registry.js';
import { allStores, envWorkStores, UNPROVISIONED, type WorkStores } from '../services/work/stores.js';
import { createWorkGate, defaultWorkRouteDeps, JOBS_KEYS, workLog, type WorkRouteDeps } from './workGate.js';

export interface JobsRouteDeps extends WorkRouteDeps {
  /** The Work stores (default: from the env's bindings). */
  stores?(env: Env): WorkStores;
}

/** What the confirm card reads: the intent's fields and tokens, never the query the plane embeds. */
export function planView(plan: HirePlan) {
  return {
    fields: plan.fields,
    scope: plan.scope,
    scopeP: plan.scopeP,
    mode: plan.intent.mode,
    needs: plan.needs,
    certificate: plan.certificate,
    language: plan.language,
    allOf: plan.intent.allOf,
    anyOf: plan.intent.anyOf,
    regions: plan.intent.regions,
    missing: plan.missing,
  };
}

/**
 * What a hirer learns of the finalists before anything is funded: how many,
 * by gate tier and by personhood tier, and nothing per finalist. A card per
 * finalist, even without the listing's id, is a fingerprint (its score for a
 * given sentence, its tier and its tokens are the same in every answer), so
 * answers could be joined to follow a worker across queries and regions, and
 * to tell which of a worker's listings recall kept, so to link their
 * profiles (decision 0060 (5)). Cards wait for the funded Match phase
 * (`docs/product/work-wallet.md`, Coordination). A known residual: in a small
 * cell (the only unbound worker in a region), comparing the counts of
 * queries the hirer chooses can still tell what that worker holds, with
 * nothing to follow them by; small counts are not bucketed yet.
 */
export function finalistCounts(finalists: readonly Finalist[]) {
  const byGateTier = { 1: 0, 2: 0 };
  const byPersonhood = { 0: 0, 1: 0, 2: 0 };
  for (const f of finalists) {
    byGateTier[f.gateTier]++;
    if (f.personhood === 0 || f.personhood === 1 || f.personhood === 2) byPersonhood[f.personhood]++;
  }
  return { count: finalists.length, byGateTier, byPersonhood };
}

/** A store or index failure, as a log reason: the error's name, never a value. */
function failureOf(err: WorkCallsError): string {
  return err.cause instanceof Error ? err.cause.name : 'error';
}

export function createJobsRoutes(deps: JobsRouteDeps = defaultWorkRouteDeps) {
  const routes = new Hono<{ Bindings: Env }>();
  const gate = createWorkGate(deps, JOBS_KEYS);

  routes.post('/intent', async (c) => {
    const admitted = await gate.admit<HirerRequest>(c, (b) => {
      const req = { sentence: b.sentence, lang: b.lang, regions: b.regions } as HirerRequest;
      const checked = checkHirerRequest(req);
      if (checked.ok) return req;
      workLog({ event: 'jobs_intent_refused', error: checked.error, reason: checked.reason });
      return checked.error === 'text_refused'
        ? c.json({ ok: false, error: 'text_refused', reason: checked.reason }, 422)
        : c.json({ ok: false, error: 'bad_request', reason: checked.reason }, 400);
    });
    if (admitted instanceof Response) return admitted;
    const { account, input, inference, store } = admitted;
    const stores = allStores((deps.stores ?? envWorkStores)(c.env));
    if (typeof stores === 'string') return c.json({ ok: false, error: UNPROVISIONED[stores] }, 503);

    const t0 = deps.now();
    const now = () => deps.now();
    const registry = { inference, store: stores.registry, index: stores.tokenIndex, tau: parseTau(c.env.WORK_TAU_AUTO, c.env.WORK_TAU_LOW), now, log: workLog };
    // One account is both sides: its own listings are never its finalists.
    // Without the key no listing can have been published, so none to leave out.
    const key = pseudonymKey(c.env.WORK_PSEUDONYM_KEY);
    const recall = {
      inference,
      index: stores.listingIndex,
      listings: stores.listings,
      remoteCountries: parseRemoteCountries(c.env.WORK_REMOTE_COUNTRIES),
      excludePseudonym: key ? await workPseudonym(key, account) : undefined,
      now,
      log: workLog,
    };
    let outcome: HireOutcome;
    try {
      outcome = await hirerQuery({ registry, recall, now, log: workLog }, input);
    } catch (err) {
      if (!(err instanceof WorkCallsError)) throw err;
      gate.meter(c, store, account, err.calls);
      workLog({ event: 'jobs_intent_failed', reason: failureOf(err), calls: err.calls.length });
      return c.json({ ok: false, error: 'work_store_unavailable' }, 503);
    }
    gate.meter(c, store, account, outcome.calls);
    const ms = deps.now() - t0;
    if (!outcome.ok) {
      workLog({ event: 'jobs_intent_failed', error: outcome.error, calls: outcome.calls.length, ms });
      switch (outcome.error) {
        case 'refused':
          return c.json({ ok: false, error: 'refused', reason: outcome.reason }, 422);
        case 'text_refused':
          return c.json({ ok: false, error: 'text_refused', reason: outcome.reason }, 422);
        case 'bad_request':
          return c.json({ ok: false, error: 'bad_request', reason: outcome.reason }, 400);
        case 'below_minimum':
          return c.json({ ok: false, error: 'below_minimum', minimumUsd: MIN_BUDGET_USD }, 422);
        case 'intent_failed':
        case 'classification_failed':
        case 'embedding_failed':
          return c.json({ ok: false, error: outcome.error }, 502);
      }
    }
    const { plan, recall: found } = outcome;
    if (!found.ok) {
      workLog({ event: 'jobs_intent_failed', error: 'recall_failed', reason: found.error, calls: outcome.calls.length, ms });
      return c.json({ ok: false, error: 'recall_failed', reason: found.error }, 502);
    }
    workLog({
      event: 'jobs_intent',
      scope: plan.scope,
      mode: plan.intent.mode,
      needs: plan.needs.length,
      required: plan.intent.allOf.length,
      missing: plan.missing.length,
      namespaces: found.namespaces.length,
      recalled: found.recalled,
      gated: found.gated,
      finalists: found.finalists.length,
      calls: outcome.calls.length,
      ms,
    });
    return c.json({ ok: true, plan: planView(plan), finalists: finalistCounts(found.finalists) });
  });

  return routes;
}

export const jobsRoutes = createJobsRoutes();
