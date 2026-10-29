// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One hirer query, from the sentence to the finalists (S5 to S8; workspace
 * `docs/product/engine.md`, Pipeline, and `docs/product/work-wallet.md`,
 * Matching and award). The sentence is typed text that passed the phone's
 * privacy gate; the phone also sends the coarse region and, when the radius
 * crosses a border, the neighbours it reaches, never a position.
 *
 *  0. Before any hosted call, the sentence runs the block tripwire
 *     (`scanText`, after NFC and a trim, at most `INTENT_MAX_CHARS`), and
 *     the language and the regions are checked: a contact detail the gate
 *     missed stops here when the tripwire recognises it (it is a tripwire,
 *     not a detector, and cannot find a name).
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
 *     Those that pass the floor are the job's needs; a call that answers none
 *     of them stops the plan (fail closed). When a skill passes but no
 *     occupation does, the occupation Clef rated highest is kept at
 *     `NEED_OCCUPATION_FLOOR` or more (decision 0069), and the needed
 *     occupations bring their ISCO-08 unit groups (`isco:7126`): together the
 *     gate's `anyOf`. The kept occupation only widens the gate: its hits rank
 *     as a skill's at the cut, and the mode, the query text and the decision
 *     pass's job read the needs that passed the floor. With no need over the
 *     floor nothing is kept, and the gate stays open (every recalled listing
 *     passes it) for a Curated job.
 *  4. The credential snaps to a `cert:` token without minting, in the job's
 *     region (`licensed electrician` in `us-tx` is the Texas licence), with
 *     the level and modules it names as facet tokens, and the language maps
 *     to its `lang:` code: the gate's `allOf`. The job is
 *     Instant only when every requirement the hirer stated is gated and an
 *     occupation or a skill that passed the floor gates it: a credential
 *     (matched or not: a person confirms a licence, E10), a language the
 *     lexicon cannot name, either one stated but dropped by the validation,
 *     or no need over the floor make it Curated.
 *  5. `recall` over the intent's namespaces, with the decision pass (S8)
 *     when it has the registry's store.
 *
 * Nothing here mints a token, writes an intent record or pings anyone: the
 * confirm card, funding and the waves come around it.
 */

import { clefInput, NEED_FLOOR, NEED_OCCUPATION_FLOOR, needQuestions, readNoul, readRequest, requestQuestions, requestState, type NeedCandidate } from './clef.js';
import { BLOCK_LANGS, scanText, type BlockLang, type BlockRefusal } from './blocks.js';
import { failureCode, type ExecutorOptions } from './executor.js';
import { estimatedUsage, usageOrEstimate, withCalls, type WorkCall } from './fields.js';
import { INTENT_MAX_CHARS, parseIntent, type IntentFields } from './intent.js';
import { REGION, type Scope } from './listings.js';
import { MAX_REGIONS, recall, type RecallDeps, type RecallIntent, type RecallOutcome } from './recall.js';
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
  /**
   * The client's query vector for the sentence (EmbeddingGemma 2 on the
   * phone), already checked against the pinned model. Recall searches with
   * it, and so does the needs step, in place of the parsed task's own, which
   * only the plane could embed; the parsed needs still refine by exact label.
   */
  vector?: number[];
}

export interface HirePlan {
  fields: IntentFields;
  scope: Scope;
  scopeP: number;
  /** The registry tokens Clef said the job needs, with its probability: those over the floor, then an occupation kept below it when only skills passed, marked `kept` (decision 0069). */
  needs: { token: string; label: string; p: number; kept?: true }[];
  certificate: string | null;
  language: string | null;
  intent: RecallIntent;
  /** What the assistant still has to ask for before the confirm card. */
  missing: ('budget' | 'when')[];
}

export type PlanOutcome =
  | { ok: true; plan: HirePlan; calls: WorkCall[] }
  | { ok: false; error: 'refused'; reason: 'harmful' | 'injection'; calls: WorkCall[] }
  | { ok: false; error: 'text_refused'; reason: BlockRefusal; calls: WorkCall[] }
  | { ok: false; error: 'bad_request'; reason: 'lang' | 'regions'; calls: WorkCall[] }
  | { ok: false; error: 'intent_failed' | 'below_minimum' | 'classification_failed' | 'embedding_failed'; calls: WorkCall[] };

type RequestRefusal = Extract<PlanOutcome, { error: 'text_refused' | 'bad_request' }>;

/** Step 0: the sentence as every later step reads it, or why no hosted call may see it. */
export function checkHirerRequest(req: HirerRequest): { ok: true; sentence: string } | RequestRefusal {
  const sentence = typeof req.sentence === 'string' ? req.sentence.normalize('NFC').trim() : '';
  if (!sentence) return { ok: false, error: 'text_refused', reason: 'empty', calls: [] };
  if (sentence.length > INTENT_MAX_CHARS) return { ok: false, error: 'text_refused', reason: 'too_long', calls: [] };
  const refused = scanText(sentence);
  if (refused) return { ok: false, error: 'text_refused', reason: refused, calls: [] };
  if (!(BLOCK_LANGS as readonly unknown[]).includes(req.lang)) return { ok: false, error: 'bad_request', reason: 'lang', calls: [] };
  const regions: unknown = req.regions;
  if (!Array.isArray(regions) || !regions.length || regions.length > MAX_REGIONS || regions.some((r) => typeof r !== 'string' || !REGION.test(r))) {
    return { ok: false, error: 'bad_request', reason: 'regions', calls: [] };
  }
  return { ok: true, sentence };
}

/**
 * S5 for one sentence: see the module comment. A store or index failure
 * throws a `WorkCallsError` carrying the calls already made.
 */
export async function planHire(deps: HireDeps, req: HirerRequest): Promise<PlanOutcome> {
  // 0. The tripwire, the language and the regions, before any hosted call.
  const request = checkHirerRequest(req);
  if (!request.ok) return request;
  return withCalls((calls) => planWith(deps, req, request.sentence, calls));
}

async function planWith(deps: HireDeps, req: HirerRequest, sentence: string, calls: WorkCall[]): Promise<PlanOutcome> {
  const now = deps.now ?? Date.now;
  const inference = deps.registry.inference;
  const model = await inference.model('work-classify');
  const state = requestState(sentence, req.lang);
  /** An answer with none of its questions in it: the call counts as failed, and the plan stops. */
  const unanswered = () => {
    const last = calls.at(-1);
    if (last?.op === 'work-classify' && last.ok) last.ok = false;
    deps.log?.({ event: 'work_request_classify_failed', model, reason: 'no_answer' });
  };
  /** One Clef call; null (and the call metered at its estimated input) when it throws. */
  const ask = async (questions: Parameters<typeof clefInput>[2]) => {
    const body = clefInput(model, state, questions);
    const t0 = now();
    try {
      const answer = await inference.run('work-classify', body);
      calls.push({ op: 'work-classify', model, ok: true, ms: now() - t0, usage: { ...usageOrEstimate(answer, body), neurons: null } });
      return answer;
    } catch (err) {
      calls.push({ op: 'work-classify', model, ok: false, ms: now() - t0, usage: estimatedUsage(body) });
      deps.log?.({ event: 'work_request_classify_failed', model, reason: failureCode(err) });
      return null;
    }
  };

  // 1. The safety checks and the scope, before anything is extracted.
  const first = await ask(requestQuestions());
  const checked = readRequest(first);
  if (!checked.ok) {
    if (first != null) unanswered();
    return { ok: false, error: 'classification_failed', calls };
  }
  if (checked.refuse) return { ok: false, error: 'refused', reason: checked.refuse, calls };
  const scope: Scope = checked.scope;

  // 2. The intent's fields.
  const parsed = await parseIntent(inference, sentence, { now, log: deps.log });
  calls.push(...parsed.calls);
  if (!parsed.ok) return parsed.error === 'text_refused' ? { ok: false, error: 'text_refused', reason: parsed.reason, calls } : { ok: false, error: parsed.error, calls };
  const fields = parsed.intent;
  if (fields.budgetUsd != null && fields.budgetUsd < MIN_BUDGET_USD) return { ok: false, error: 'below_minimum', calls };

  // 3. The registry's nearest occupations and skills to the task, and which of them the job needs.
  const task = fields.task ?? sentence;
  let taskVector: number[];
  if (req.vector) taskVector = req.vector;
  else {
    const embedding = await embedTexts(inference, [task], { role: 'query', now, log: deps.log });
    calls.push(embedding.call);
    if (!embedding.ok) return { ok: false, error: 'embedding_failed', calls };
    taskVector = embedding.vectors[0]!;
  }
  const near: NeedCandidate[] = [];
  for (const kind of ['pos', 'skill'] as const) {
    const found = await candidatesFor(deps.registry, kind, taskVector);
    for (const c of found.slice(0, NEED_CANDIDATES[kind])) near.push({ token: c.token, label: c.labelEn, kind });
  }
  const answer = near.length ? await ask(needQuestions(near)) : {};
  if (answer == null) return { ok: false, error: 'classification_failed', calls };
  const read = near.map((c, i) => ({ token: c.token, label: c.label, p: readNoul(answer, `need_${i}`) }));
  if (near.length && read.every((n) => n.p == null)) {
    // No answer is not "needs nothing": the gate is never left open by default.
    unanswered();
    return { ok: false, error: 'classification_failed', calls };
  }
  const rated = read.filter((n): n is { token: string; label: string; p: number } => n.p != null);
  const isOccupation = (n: { token: string }) => n.token.startsWith('pos:');
  const passed = rated.filter((n) => n.p >= NEED_FLOOR).sort((a, b) => b.p - a.p);
  // An occupation is kept (decision 0069): the best Clef rated, when a skill passed the floor and no occupation did. It widens
  // the gate only; with nothing over the floor the gate stays open, as it always was.
  const kept =
    passed.length && !passed.some(isOccupation) ? rated.filter((n) => isOccupation(n) && n.p >= NEED_OCCUPATION_FLOOR).sort((a, b) => b.p - a.p)[0] : undefined;
  const needs: HirePlan['needs'] = kept ? [...passed, { ...kept, kept: true }] : passed;
  // The needed occupations' ISCO-08 unit groups: a listing in the same group passes the gate (decision 0069).
  const occupations = needs.filter(isOccupation).map((n) => n.token);
  const groups = occupations.length
    ? [...(await deps.registry.store.tokens(occupations)).values()].map((t) => t.iscoCode).filter((c): c is string => !!c && /^\d{4}$/.test(c))
    : [];

  // The credential and the language: what every finalist must hold. A licence phrase means the licence of the
  // job's region (the hirer's own, first), and a level or module it names is required too.
  let certificate: string | null = null;
  let certificateTokens: string[] = [];
  if (fields.credential) {
    const s = await snap(deps.registry, { kind: 'cert', raw: fields.credential, lang: req.lang, mint: false, region: req.regions[0] });
    calls.push(...s.calls);
    certificate = s.token;
    certificateTokens = s.tokens;
  }
  const language = fields.languageCode ? `lang:${fields.languageCode}` : null;
  const allOf = [...certificateTokens, ...(language ? [language] : [])];
  const anyOf = [...new Set([...needs.map((n) => n.token), ...groups.map((c) => `isco:${c}`)])];
  // Instant only when every stated requirement is gated and a need over the floor gates it (step 4): a kept occupation
  // never makes a job Instant. A credential or a language the validation dropped (not a span, too long) was still
  // stated: it counts as one the gate cannot hold.
  const dropped = parsed.violations.some((v) => v.field === 'credential' || v.field === 'language');
  const curated = fields.credential != null || (fields.language != null && language == null) || dropped || passed.length === 0;
  const intent: RecallIntent = {
    scope,
    regions: [...new Set(req.regions)],
    queryText: [task, ...passed.map((n) => n.label)].join('; '),
    ...(req.vector ? { vector: req.vector } : {}),
    task,
    needLabels: passed.map((n) => n.label),
    ...(kept ? { keptOccupation: kept.token } : {}),
    allOf,
    anyOf,
    mode: curated ? 'curated' : 'instant',
  };
  const missing: HirePlan['missing'] = [];
  if (fields.budgetUsd == null) missing.push('budget');
  if (fields.when == null) missing.push('when');
  return { ok: true, plan: { fields, scope, scopeP: checked.scopeP, needs, certificate, language, intent, missing }, calls };
}

export type HireOutcome = { ok: true; plan: HirePlan; recall: RecallOutcome; calls: WorkCall[] } | Extract<PlanOutcome, { ok: false }>;

/** The sentence to the finalists: `planHire`, then `recall`; a failure in recall still carries the plan's calls. */
export async function hirerQuery(deps: HireDeps, req: HirerRequest): Promise<HireOutcome> {
  const planned = await planHire(deps, req);
  if (!planned.ok) return planned;
  return withCalls(async (calls) => {
    calls.push(...planned.calls);
    const found = await recall(deps.recall, planned.plan.intent);
    return { ok: true, plan: planned.plan, recall: found, calls: [...calls, ...found.calls] };
  });
}
