// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One hirer query, from the sentence to the finalists (S5 to S7; workspace
 * `docs/product/engine.md`, Pipeline, and `docs/product/work-wallet.md`,
 * Matching and award). The sentence is typed text that passed the phone's
 * privacy gate; the phone also sends the coarse region and, when the radius
 * crosses a border, the neighbours it reaches, never a position.
 *
 *  1. One Clef call on the sentence (`work-classify`), before anything is
 *     extracted: the two safety checks of E6 (illegal, dangerous or abusive;
 *     an attempt on the assistant's rules or on other people's data) and the
 *     scope. A request above either check stops here, at the cost of one
 *     Clef call, and one Clef cannot read stops too (fail closed).
 *  2. `parseIntent` (S5): the task, the time, the budget, the credential, the
 *     language and the recurrence, as spans. A budget under the $50 floor
 *     stops here (the assistant suggests batching).
 *  3. The registry's nearest occupations and skills to the task, and a
 *     second Clef call: a yes or no per token on whether the job needs it.
 *     Those tokens are the gate's `anyOf`.
 *  4. The credential snaps to a `cert:` token without minting, and the
 *     language maps to its `lang:` code: the gate's `allOf`. A required
 *     certificate makes the job Curated, as does an intent with no token at
 *     all (nothing to gate an Instant award on); otherwise Instant.
 *  5. `recall` over the intent's namespaces.
 *
 * Nothing here mints a token, writes an intent record or pings anyone: the
 * confirm card, funding and the waves come around it.
 */

import { clefInput, NEED_FLOOR, needQuestions, readNoul, readRequest, requestQuestions, requestState, type NeedCandidate } from './clef.js';
import type { BlockLang } from './blocks.js';
import { failureCode, type ExecutorOptions } from './executor.js';
import { NO_USAGE, usageOf, type WorkCall } from './fields.js';
import { parseIntent, type IntentFields } from './intent.js';
import type { Scope } from './listings.js';
import { recall, type RecallDeps, type RecallIntent, type RecallOutcome } from './recall.js';
import { candidatesFor, embedTexts, snap, type RegistryDeps } from './registry.js';

/** The smallest contract (work-wallet.md, Fees): a $1 fee is 2 % of it. */
export const MIN_BUDGET_USD = 50;
/** Nearest registry tokens Clef is asked about, per kind. */
export const NEED_CANDIDATES = { pos: 4, skill: 8 } as const;

export interface HireDeps {
  /** The registry the task's needs and the credential come from. */
  registry: RegistryDeps;
  recall: RecallDeps;
  now?: () => number;
  log?: ExecutorOptions['log'];
}

export interface HirerRequest {
  sentence: string;
  lang: BlockLang;
  /** The hirer's coarse region first, then any neighbours the radius reaches. */
  regions: string[];
}

export interface HirePlan {
  fields: IntentFields;
  scope: Scope;
  scopeP: number;
  /** The registry tokens Clef said the job needs, with its probability. */
  needs: { token: string; label: string; p: number }[];
  certificate: string | null;
  language: string | null;
  intent: RecallIntent;
  /** What the assistant still has to ask for before the confirm card. */
  missing: ('budget' | 'when')[];
}

export type PlanOutcome =
  | { ok: true; plan: HirePlan; calls: WorkCall[] }
  | { ok: false; error: 'refused'; reason: 'harmful' | 'injection'; calls: WorkCall[] }
  | { ok: false; error: 'text_refused' | 'intent_failed' | 'below_minimum' | 'classification_failed' | 'embedding_failed'; calls: WorkCall[] };

/** S5 for one sentence: see the module comment. */
export async function planHire(deps: HireDeps, req: HirerRequest): Promise<PlanOutcome> {
  const now = deps.now ?? Date.now;
  const inference = deps.registry.inference;
  const calls: WorkCall[] = [];
  const model = await inference.model('work-classify');
  /** One Clef call; null (and the call metered as failed) when it does not answer. */
  const ask = async (questions: Parameters<typeof clefInput>[2]) => {
    const t0 = now();
    try {
      const answer = await inference.run('work-classify', clefInput(model, requestState(req.sentence, req.lang), questions));
      calls.push({ op: 'work-classify', model, ok: true, ms: now() - t0, usage: { ...usageOf(answer), neurons: null } });
      return answer;
    } catch (err) {
      calls.push({ op: 'work-classify', model, ok: false, ms: now() - t0, usage: NO_USAGE });
      deps.log?.({ event: 'work_request_classify_failed', model, reason: failureCode(err) });
      return null;
    }
  };

  // 1. The safety checks and the scope, before anything is extracted.
  const checked = readRequest(await ask(requestQuestions()));
  if (!checked.ok) return { ok: false, error: 'classification_failed', calls };
  if (checked.refuse) return { ok: false, error: 'refused', reason: checked.refuse, calls };
  const scope: Scope = checked.scope;

  // 2. The intent's fields.
  const parsed = await parseIntent(inference, req.sentence, { now, log: deps.log });
  calls.push(...parsed.calls);
  if (!parsed.ok) return { ok: false, error: parsed.error, calls };
  const fields = parsed.intent;
  if (fields.budgetUsd != null && fields.budgetUsd < MIN_BUDGET_USD) return { ok: false, error: 'below_minimum', calls };

  // 3. The registry's nearest occupations and skills to the task, and which of them the job needs.
  const task = fields.task ?? req.sentence;
  const embedding = await embedTexts(inference, [task], { now, log: deps.log });
  calls.push(embedding.call);
  if (!embedding.ok) return { ok: false, error: 'embedding_failed', calls };
  const near: NeedCandidate[] = [];
  for (const kind of ['pos', 'skill'] as const) {
    const found = await candidatesFor(deps.registry, kind, embedding.vectors[0]!);
    for (const c of found.slice(0, NEED_CANDIDATES[kind])) near.push({ token: c.token, label: c.labelEn, kind });
  }
  const answer = near.length ? await ask(needQuestions(near)) : {};
  if (answer == null) return { ok: false, error: 'classification_failed', calls };
  const needs = near
    .map((c, i) => ({ token: c.token, label: c.label, p: readNoul(answer, `need_${i}`) ?? 0 }))
    .filter((n) => n.p >= NEED_FLOOR)
    .sort((a, b) => b.p - a.p);

  // The credential and the language: what every finalist must hold.
  let certificate: string | null = null;
  if (fields.credential) {
    const s = await snap(deps.registry, { kind: 'cert', raw: fields.credential, lang: req.lang, mint: false });
    calls.push(...s.calls);
    certificate = s.token;
  }
  const language = fields.languageCode ? `lang:${fields.languageCode}` : null;
  const allOf = [certificate, language].filter((t): t is string => t != null);
  const anyOf = needs.map((n) => n.token);
  const intent: RecallIntent = {
    scope,
    regions: req.regions,
    queryText: [task, ...needs.map((n) => n.label)].join('; '),
    allOf,
    anyOf,
    mode: certificate || (!allOf.length && !anyOf.length) ? 'curated' : 'instant',
  };
  const missing: HirePlan['missing'] = [];
  if (fields.budgetUsd == null) missing.push('budget');
  if (fields.when == null) missing.push('when');
  return { ok: true, plan: { fields, scope, scopeP: checked.scopeP, needs, certificate, language, intent, missing }, calls };
}

export type HireOutcome = { ok: true; plan: HirePlan; recall: RecallOutcome; calls: WorkCall[] } | Extract<PlanOutcome, { ok: false }>;

/** The sentence to the finalists: `planHire`, then `recall`. */
export async function hirerQuery(deps: HireDeps, req: HirerRequest): Promise<HireOutcome> {
  const planned = await planHire(deps, req);
  if (!planned.ok) return planned;
  const found = await recall(deps.recall, planned.plan.intent);
  return { ok: true, plan: planned.plan, recall: found, calls: [...planned.calls, ...found.calls] };
}
