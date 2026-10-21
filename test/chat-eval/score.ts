// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Scoring and reporting for the chat evaluation (decision 0037). Pure: the
 * live harness (`test/chat.eval.test.ts`) collects one `TurnResult` per prompt
 * and these functions turn them into the summary and the Markdown report; the
 * offline test (`test/chatEval.test.ts`) checks them without the network.
 *
 * The prompt file is `test/chat-eval/prompts.json`. Field expectations:
 * a number or string must equal the prefill (strings compared without case or
 * accents); `null` means the field must be absent; an array lists acceptable
 * values, and for `query` a value passes when it contains one of them; a field
 * not named is not scored. `candidates` must all be among the offered choices.
 */

import { CHAT_ACTIONS, decideRoute, ROUTER_THRESHOLDS, type ChatLanguage, type ChatRoute } from '../../src/services/chat/router.js';
import type { RecordedCall } from './restAi.js';

export const ROUTES: ChatRoute[] = ['action', 'answer', 'answer_long', 'refuse', 'clarify'];
export const LANGUAGES: ChatLanguage[] = ['en', 'pt', 'es'];

export type FieldExpectation = number | string | null | (number | string)[];

export interface EvalPrompt {
  id: string;
  language: ChatLanguage;
  history?: { role: 'user' | 'assistant'; text: string }[];
  text: string;
  expect: {
    route: ChatRoute;
    action: string | null;
    fields?: Record<string, FieldExpectation>;
    candidates?: string[];
    /** Regexes (case-insensitive) the reply must not match: wrong claims (decision 0048). */
    avoid?: string[];
    /** Regexes of which at least one must match the reply: the fact it must bring up. */
    mention?: string[];
    notes: string;
  };
}

/** Problems with the prompt file; empty when it is valid. */
export function validatePrompts(prompts: unknown): string[] {
  const errors: string[] = [];
  if (!Array.isArray(prompts)) return ['the prompt file must be an array'];
  const ids = new Set<string>();
  const actionIds = new Set(CHAT_ACTIONS.map((a) => a.id));
  prompts.forEach((raw, i) => {
    const p = raw as Partial<EvalPrompt>;
    const at = `#${i} ${p?.id ?? '(no id)'}`;
    if (typeof p?.id !== 'string' || !p.id) errors.push(`${at}: id missing`);
    else if (ids.has(p.id)) errors.push(`${at}: duplicate id`);
    else ids.add(p.id);
    if (!LANGUAGES.includes(p?.language as ChatLanguage)) errors.push(`${at}: language must be en, pt or es`);
    if (typeof p?.text !== 'string' || !p.text.trim()) errors.push(`${at}: text missing`);
    const e = p?.expect;
    if (!e || typeof e !== 'object') {
      errors.push(`${at}: expect missing`);
      return;
    }
    if (!ROUTES.includes(e.route)) errors.push(`${at}: route ${String(e.route)} unknown`);
    if (e.action !== null && !actionIds.has(e.action as string)) errors.push(`${at}: action ${String(e.action)} is not in CHAT_ACTIONS`);
    if (e.route === 'action' && !e.action) errors.push(`${at}: an action route needs an action`);
    if (e.route !== 'action' && e.action) errors.push(`${at}: only an action route names an action`);
    for (const c of e.candidates ?? []) if (!actionIds.has(c)) errors.push(`${at}: candidate ${c} is not in CHAT_ACTIONS`);
    if (e.fields) {
      const declared = CHAT_ACTIONS.find((a) => a.id === e.action)?.fields ?? {};
      for (const k of Object.keys(e.fields)) if (!(k in declared)) errors.push(`${at}: field ${k} is not declared by ${String(e.action)}`);
    }
    if (typeof e.notes !== 'string') errors.push(`${at}: notes must be a string`);
    for (const key of ['avoid', 'mention'] as const) {
      for (const re of e[key] ?? []) {
        try {
          new RegExp(re, 'i');
        } catch {
          errors.push(`${at}: ${key} pattern ${re} is not a regex`);
        }
      }
    }
    for (const m of p.history ?? []) {
      if ((m?.role !== 'user' && m?.role !== 'assistant') || typeof m?.text !== 'string') errors.push(`${at}: malformed history`);
    }
  });
  return errors;
}

// ── One turn ─────────────────────────────────────────────────────────────────

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function fieldMatches(key: string, expected: FieldExpectation, actual: unknown): boolean {
  if (expected === null) return actual === undefined || actual === null;
  if (actual === undefined || actual === null) return false;
  const options = Array.isArray(expected) ? expected : [expected];
  return options.some((o) => {
    if (typeof o === 'number') return Number(actual) === o;
    const a = fold(String(actual)).replace(/^@/, '');
    const b = fold(o);
    return key === 'query' ? a.includes(b) : a === b;
  });
}

const STOPWORDS: Record<ChatLanguage, string[]> = {
  en: ['the', 'you', 'your', 'and', 'to', 'is', 'can', 'it', 'for', 'of', 'with', 'what', 'how', 'this', 'are', 'i', 'my', 'in', 'help'],
  pt: ['você', 'voce', 'não', 'nao', 'para', 'pra', 'com', 'seu', 'sua', 'uma', 'um', 'que', 'é', 'o', 'os', 'as', 'do', 'da', 'no', 'na', 'em', 'posso', 'isso', 'dinheiro', 'pagamento'],
  es: ['tú', 'usted', 'tu', 'tus', 'para', 'con', 'una', 'un', 'que', 'es', 'el', 'los', 'las', 'del', 'en', 'puedo', 'eso', 'dinero', 'pago', 'y', 'hola', 'cómo', 'está'],
};

/** A rough language guess for a reply, by common words; null when too short to tell. */
export function guessLanguage(text: string): ChatLanguage | null {
  const words = text.toLowerCase().match(/[\p{L}]+/gu) ?? [];
  if (words.length < 3) return null;
  const score = (l: ChatLanguage) => words.filter((w) => STOPWORDS[l].includes(w)).length;
  // Portuguese-only and Spanish-only letters break ties between the two.
  const pt = score('pt') + (/[ãõç]|ção|ções/.test(text) ? 3 : 0);
  const es = score('es') + (/ñ|¿|¡|ción\b/.test(text) ? 3 : 0);
  const en = score('en');
  const best = Math.max(en, pt, es);
  if (best === 0) return null;
  return best === en ? 'en' : best === pt ? 'pt' : 'es';
}

const JARGON = /\b(crypto|blockchain|web3|wallet|token|on-chain|onchain|gas|stablecoin|seed phrase)\b/i;
const MARKDOWN = /(\*\*|^#{1,6}\s|^\s*[-*]\s|\|.*\|)/m;
// A reply that begs off instead of answering (seen on rotation and pay questions, 2026-10-20).
const DECLINED =
  /\b(I (do not|don't|cannot|can't) (have|provide|give|access)|não (tenho|posso) (acesso|fornecer|dar)|no (tengo|puedo) (acceso|proporcionar|dar))\b/i;

export interface Prices {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

/** Catalogue rates (decision 0037, read 2026-10-16 to 18), by the model's last path segment. */
export const PRICES: Record<string, Prices> = {
  'clef-flash': { input: 0.038, output: 0 },
  'gemma-4-26b-a4b-it': { input: 0.1, output: 0.3 },
  'granite-4.0-h-micro': { input: 0.017, output: 0.112 },
  'glm-4.7-flash': { input: 0.06, output: 0.4 },
  'glm-5.3-flash': { input: 0.15, output: 0.5 },
  'glm-5.3': { input: 1.4, output: 4.4 },
  'deepseek-v4.1-flash-1017': { input: 0.3, output: 1.2 },
  'llama-3.3-70b-instruct-fp8-fast': { input: 0.293, output: 2.253 },
};

export interface CallCost {
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** True when a count was estimated (characters / 4) instead of reported. */
  estimated: boolean;
  usd: number | null;
}

/** One call's cost; Clef's input is always an estimate (characters / 4), its output is free. */
export function callCost(call: RecordedCall, prices: Record<string, Prices> = PRICES): CallCost {
  const short = call.model.split('/').pop() ?? call.model;
  // A call refused before the model ran bills nothing.
  if (call.status === 'network' || (typeof call.status === 'number' && call.status >= 400)) {
    return { model: short, tokensIn: 0, tokensOut: 0, estimated: false, usd: 0 };
  }
  const price = prices[short];
  const clef = short.startsWith('clef');
  const reportedIn = clef ? undefined : call.usage?.prompt_tokens;
  const reportedOut = clef ? 0 : call.usage?.completion_tokens;
  const tokensIn = reportedIn ?? Math.ceil(call.inputChars / 4);
  const tokensOut = reportedOut ?? Math.ceil(call.outputChars / 4);
  const estimated = reportedIn === undefined || reportedOut === undefined;
  const usd = price ? (tokensIn * price.input + tokensOut * price.output) / 1e6 : null;
  return { model: short, tokensIn, tokensOut, estimated, usd };
}

export interface TurnResult {
  id: string;
  language: ChatLanguage;
  expect: EvalPrompt['expect'];
  /** What the turn did. */
  route: ChatRoute | null;
  action: string | null;
  confidence: number | null;
  routerLanguage: ChatLanguage | null;
  candidates: string[];
  /** The prefill of the proposed request for the expected action (action event, or the first choice). */
  fields: Record<string, unknown> | null;
  reply: string;
  error?: string;
  /** Scores. */
  routeOk: boolean;
  actionOk: boolean;
  /** An expected action offered as the first choice of a clarify: the user is one tap away. */
  softOk: boolean;
  fieldScores: Record<string, boolean>;
  candidatesOk: boolean | null;
  routerLanguageOk: boolean;
  replyLanguage: ChatLanguage | null;
  replyLanguageOk: boolean | null;
  jargon: boolean;
  markdown: boolean;
  /** The reply begged off ("I do not have information…") instead of answering. */
  declined: boolean;
  /** The reply matched one of the prompt's `avoid` patterns: a wrong claim. */
  claims: boolean;
  /** The reply matched none of the prompt's `mention` patterns. */
  unmentioned: boolean;
  /** Milliseconds from the turn's `chat_turn` line and the clock around it. */
  ms: { router?: number; first?: number; fields?: number; model?: number; total: number };
  calls: CallCost[];
  costUsd: number | null;
  costEstimated: boolean;
  /** Clef's raw answers, for the threshold sweep. */
  clef?: unknown;
}

export interface TurnObservation {
  events: { type: string; [k: string]: unknown }[];
  log: Record<string, unknown>[];
  calls: RecordedCall[];
  totalMs: number;
  /** The router's model id, to find its call among the recorded ones. */
  routerModel: string;
}

/** Score one turn from what the harness saw. */
export function scoreTurn(prompt: EvalPrompt, obs: TurnObservation): TurnResult {
  const e = prompt.expect;
  const routeEv = obs.events.find((x) => x.type === 'route');
  const actionEv = obs.events.find((x) => x.type === 'action');
  const choicesEv = obs.events.find((x) => x.type === 'choices');
  const errorEv = obs.events.find((x) => x.type === 'error');
  const reply = obs.events.filter((x) => x.type === 'text').map((x) => String(x.delta ?? '')).join('');
  const turnLog = obs.log.find((l) => l.event === 'chat_turn');
  const failures = obs.log.filter((l) => l.event !== 'chat_turn').map((l) => `${String(l.event)}: ${String(l.reason ?? '')}`);

  const route = (routeEv?.route as ChatRoute | undefined) ?? null;
  const request = (actionEv?.request as Record<string, unknown> | undefined) ?? null;
  const requests = (choicesEv?.requests as Record<string, unknown>[] | undefined) ?? [];
  const action = route === 'action' ? ((request?.id as string | undefined) ?? (routeEv?.action as string | null) ?? null) : null;
  const candidates = requests.map((r) => String(r.id));

  // A failed turn, or one the router never decided (the fallback answer), scores no route.
  const failed = Boolean(errorEv) || obs.log.some((l) => l.event === 'chat_router_failed');
  const routeOk = !failed && route === e.route;
  const actionOk = routeOk && (e.action ?? null) === action;
  const softOk = actionOk || (e.route === 'action' && route === 'clarify' && candidates[0] === e.action);

  const proposed = request?.id === e.action ? request : requests[0]?.id === e.action && e.action ? requests[0]! : null;
  const fields = proposed ? Object.fromEntries(Object.entries(proposed).filter(([k]) => k !== 'id')) : null;
  const fieldScores: Record<string, boolean> = {};
  if (proposed && e.fields) for (const [k, v] of Object.entries(e.fields)) fieldScores[k] = fieldMatches(k, v, fields?.[k]);

  const candidatesOk = e.candidates ? route === 'clarify' && e.candidates.every((c) => candidates.includes(c)) : null;

  const routerLanguage = (turnLog?.language as ChatLanguage | undefined) ?? null;
  const answered = route === 'answer' || route === 'answer_long';
  const replyLanguage = answered ? guessLanguage(reply) : null;

  const routerCall = obs.calls.find((c) => c.model === obs.routerModel);
  const calls = obs.calls.map((c) => callCost(c));
  const costUsd = calls.some((c) => c.usd === null) ? null : calls.reduce((n, c) => n + (c.usd ?? 0), 0);

  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  return {
    id: prompt.id,
    language: prompt.language,
    expect: e,
    route,
    action,
    confidence: num(routeEv?.confidence) ?? null,
    routerLanguage,
    candidates,
    fields,
    reply,
    error: errorEv ? String(errorEv.message) + (failures.length ? ` (${failures.join('; ')})` : '') : failures.length ? failures.join('; ') : undefined,
    routeOk,
    actionOk,
    softOk,
    fieldScores,
    candidatesOk,
    routerLanguageOk: routerLanguage === prompt.language,
    replyLanguage,
    replyLanguageOk: answered && replyLanguage ? replyLanguage === prompt.language : null,
    jargon: answered && JARGON.test(reply),
    markdown: answered && MARKDOWN.test(reply),
    declined: answered && DECLINED.test(reply),
    claims: answered && (prompt.expect.avoid ?? []).some((re) => new RegExp(re, 'i').test(reply)),
    unmentioned: answered && (prompt.expect.mention?.length ?? 0) > 0 && !prompt.expect.mention!.some((re) => new RegExp(re, 'i').test(reply)),
    ms: {
      router: num(turnLog?.router),
      first: num(turnLog?.first),
      fields: num(turnLog?.fields),
      model: num(turnLog?.model),
      total: num(turnLog?.ms) ?? obs.totalMs,
    },
    calls,
    costUsd,
    costEstimated: calls.some((c) => c.estimated),
    clef: (routerCall?.result as { answers?: unknown } | undefined)?.answers,
  };
}

// ── Summary ──────────────────────────────────────────────────────────────────

export function percentile(values: number[], p: number): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const i = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[i]!;
}

interface Tally {
  n: number;
  route: number;
  action: number;
  soft: number;
}

function tally(results: TurnResult[]): Tally {
  return {
    n: results.length,
    route: results.filter((r) => r.routeOk).length,
    action: results.filter((r) => r.actionOk).length,
    soft: results.filter((r) => r.softOk).length,
  };
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) m.set(key(it), [...(m.get(key(it)) ?? []), it]);
  return m;
}

export interface Summary {
  n: number;
  overall: Tally;
  byRoute: Record<string, Tally>;
  byAction: Record<string, Tally>;
  byLanguage: Record<string, Tally>;
  fields: { scored: number; ok: number; byField: Record<string, { scored: number; ok: number }> };
  candidates: { scored: number; ok: number };
  routerLanguage: { ok: number; n: number };
  replyLanguage: { ok: number; n: number };
  jargon: number;
  markdown: number;
  declined: number;
  claims: number;
  unmentioned: number;
  errors: number;
  /** Wrong screen opened, or a screen opened where none was expected: the costly misses. */
  wrongAction: number;
  /** A screen expected but the turn answered or refused. */
  missedAction: number;
  /** A refusal expected but the turn did something else. */
  missedRefusal: number;
  cost: { meanUsd: number | null; p50Usd: number | null; maxUsd: number | null; estimated: boolean; byRoute: Record<string, number | null> };
  latency: Record<'router' | 'first' | 'total', { p50: number | null; p95: number | null }>;
}

export function summarize(results: TurnResult[]): Summary {
  const byRoute: Record<string, Tally> = {};
  for (const [k, v] of groupBy(results, (r) => r.expect.route)) byRoute[k] = tally(v);
  const byAction: Record<string, Tally> = {};
  for (const [k, v] of groupBy(results.filter((r) => r.expect.action), (r) => r.expect.action!)) byAction[k] = tally(v);
  const byLanguage: Record<string, Tally> = {};
  for (const [k, v] of groupBy(results, (r) => r.language)) byLanguage[k] = tally(v);

  const byField: Record<string, { scored: number; ok: number }> = {};
  for (const r of results) {
    for (const [k, ok] of Object.entries(r.fieldScores)) {
      byField[k] ??= { scored: 0, ok: 0 };
      byField[k].scored++;
      if (ok) byField[k].ok++;
    }
  }
  const fieldScored = Object.values(byField).reduce((n, f) => n + f.scored, 0);
  const fieldOk = Object.values(byField).reduce((n, f) => n + f.ok, 0);

  const withCandidates = results.filter((r) => r.candidatesOk !== null);
  const withReplyLang = results.filter((r) => r.replyLanguageOk !== null);
  const costs = results.map((r) => r.costUsd).filter((c): c is number => c !== null);
  const costByRoute: Record<string, number | null> = {};
  for (const [k, v] of groupBy(results, (r) => r.route ?? 'none')) {
    const c = v.map((r) => r.costUsd).filter((x): x is number => x !== null);
    costByRoute[k] = c.length ? c.reduce((a, b) => a + b, 0) / c.length : null;
  }
  const lat = (pick: (r: TurnResult) => number | undefined) => {
    const v = results.map(pick).filter((x): x is number => typeof x === 'number');
    return { p50: percentile(v, 50), p95: percentile(v, 95) };
  };

  return {
    n: results.length,
    overall: tally(results),
    byRoute,
    byAction,
    byLanguage,
    fields: { scored: fieldScored, ok: fieldOk, byField },
    candidates: { scored: withCandidates.length, ok: withCandidates.filter((r) => r.candidatesOk).length },
    routerLanguage: { ok: results.filter((r) => r.routerLanguageOk).length, n: results.length },
    replyLanguage: { ok: withReplyLang.filter((r) => r.replyLanguageOk).length, n: withReplyLang.length },
    jargon: results.filter((r) => r.jargon).length,
    markdown: results.filter((r) => r.markdown).length,
    declined: results.filter((r) => r.declined).length,
    claims: results.filter((r) => r.claims).length,
    unmentioned: results.filter((r) => r.unmentioned).length,
    errors: results.filter((r) => r.error).length,
    wrongAction: results.filter((r) => r.route === 'action' && r.action !== r.expect.action).length,
    missedAction: results.filter((r) => r.expect.route === 'action' && (r.route === 'answer' || r.route === 'answer_long' || r.route === 'refuse')).length,
    missedRefusal: results.filter((r) => r.expect.route === 'refuse' && r.route !== 'refuse').length,
    cost: {
      meanUsd: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
      p50Usd: percentile(costs, 50),
      maxUsd: costs.length ? Math.max(...costs) : null,
      estimated: results.some((r) => r.costEstimated),
      byRoute: costByRoute,
    },
    latency: { router: lat((r) => r.ms.router), first: lat((r) => r.ms.first), total: lat((r) => r.ms.total) },
  };
}

// ── Threshold sweep ──────────────────────────────────────────────────────────

export interface SweepRow {
  action: number;
  candidate: number;
  routeOk: number;
  softOk: number;
  wrongAction: number;
  clarifyForAction: number;
  candidatesOk: number;
  candidatesScored: number;
  n: number;
}

/**
 * Re-decide every recorded Clef answer under other floors, without new calls:
 * the evidence for calibrating 0.55 (action) and 0.15 (candidate).
 */
export function sweepThresholds(
  results: TurnResult[],
  actionFloors = [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7],
  candidateFloors = [0.05, 0.1, 0.15, 0.2, 0.25],
): SweepRow[] {
  const recorded = results.filter((r) => r.clef !== undefined);
  const rows: SweepRow[] = [];
  for (const action of actionFloors) {
    for (const candidate of candidateFloors) {
      const row: SweepRow = { action, candidate, routeOk: 0, softOk: 0, wrongAction: 0, clarifyForAction: 0, candidatesOk: 0, candidatesScored: 0, n: recorded.length };
      for (const r of recorded) {
        // The live floors are typed as constants; the sweep varies them.
        const d = decideRoute(r.clef, { ...ROUTER_THRESHOLDS, action, candidate } as unknown as typeof ROUTER_THRESHOLDS);
        const e = r.expect;
        const ok = d.route === e.route && (e.route !== 'action' || d.action === e.action);
        if (ok) row.routeOk++;
        if (ok || (e.route === 'action' && d.route === 'clarify' && d.candidates[0] === e.action)) row.softOk++;
        if (d.route === 'action' && d.action !== e.action) row.wrongAction++;
        if (e.route === 'action' && d.route === 'clarify') row.clarifyForAction++;
        if (e.candidates) {
          row.candidatesScored++;
          if (d.route === 'clarify' && e.candidates.every((c) => d.candidates.includes(c))) row.candidatesOk++;
        }
      }
      rows.push(row);
    }
  }
  return rows;
}

// ── Report ───────────────────────────────────────────────────────────────────

const pct = (ok: number, n: number) => (n ? `${ok}/${n} (${Math.round((100 * ok) / n)}%)` : '–');
const usd = (v: number | null) => (v === null ? '–' : `$${v.toFixed(6)}`);
const msf = (v: number | null | undefined) => (v === null || v === undefined ? '–' : `${Math.round(v)}`);
const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export interface ReportMeta {
  date: string;
  models: Record<string, string>;
  early: boolean;
  /** The tier every prompt ran in (decision 0047); absent in older reports: Ordinary. */
  tier?: 'ordinary' | 'thinking';
  /** The high-effort floor of a Thinking run; null or absent: never high. */
  highFloor?: number | null;
  durationMs: number;
}

/** The console summary: a few lines. */
export function summaryText(s: Summary): string {
  const lines = [
    `chat eval: ${s.n} prompts, route ${pct(s.overall.route, s.n)}, action ${pct(s.overall.action, s.n)}, one tap away ${pct(s.overall.soft, s.n)}`,
    `fields ${pct(s.fields.ok, s.fields.scored)}, candidates ${pct(s.candidates.ok, s.candidates.scored)}, router language ${pct(s.routerLanguage.ok, s.routerLanguage.n)}, reply language ${pct(s.replyLanguage.ok, s.replyLanguage.n)}`,
    `wrong screen opened ${s.wrongAction}, screen missed ${s.missedAction}, refusal missed ${s.missedRefusal}, errors ${s.errors}`,
    `cost per turn mean ${usd(s.cost.meanUsd)}, p50 ${usd(s.cost.p50Usd)}, max ${usd(s.cost.maxUsd)}${s.cost.estimated ? ' (partly estimated)' : ''}`,
    `latency ms p50/p95: router ${msf(s.latency.router.p50)}/${msf(s.latency.router.p95)}, first text ${msf(s.latency.first.p50)}/${msf(s.latency.first.p95)}, total ${msf(s.latency.total.p50)}/${msf(s.latency.total.p95)}`,
  ];
  return lines.join('\n');
}

export function reportMarkdown(results: TurnResult[], meta: ReportMeta): string {
  const s = summarize(results);
  const out: string[] = [];
  out.push(`# Chat evaluation, ${meta.date}`, '');
  out.push(
    `Decision 0037's evaluation: ${s.n} prompts from \`test/chat-eval/prompts.json\` through the real turn (\`runChat\`, the inference seam, Workers AI over REST). Models: ${Object.entries(meta.models)
      .map(([op, m]) => `${op} \`${m}\``)
      .join(', ')}. Early answer ${meta.early ? 'on' : 'off'}. Tier ${meta.tier ?? 'ordinary'}${meta.tier === 'thinking' ? ` (high effort at or above ${meta.highFloor ?? 'never'})` : ''}. Run time ${Math.round(meta.durationMs / 1000)} s.`,
    '',
  );
  out.push('## Summary', '', '```', summaryText(s), '```', '');
  out.push(
    '"One tap away" counts an expected screen offered as the first choice of a clarify. Costs use the catalogue rates in `score.ts`; Clef input tokens are always estimated (characters / 4), and so are other counts when a model reports no usage. A cancelled early answer is charged its estimated input.',
    '',
  );

  const tallyTable = (title: string, rows: Record<string, Tally>) => {
    out.push(`## ${title}`, '', '| | n | route | action | one tap away |', '|---|---|---|---|---|');
    for (const [k, t] of Object.entries(rows)) out.push(`| ${k} | ${t.n} | ${pct(t.route, t.n)} | ${pct(t.action, t.n)} | ${pct(t.soft, t.n)} |`);
    out.push('');
  };
  tallyTable('By expected route', s.byRoute);
  tallyTable('By expected action', s.byAction);
  tallyTable('By language', s.byLanguage);

  out.push('## Fields', '', '| field | scored | correct |', '|---|---|---|');
  for (const [k, f] of Object.entries(s.fields.byField)) out.push(`| ${k} | ${f.scored} | ${pct(f.ok, f.scored)} |`);
  out.push('');

  out.push('## Language and style', '');
  out.push(`- Router language matches the prompt: ${pct(s.routerLanguage.ok, s.routerLanguage.n)}.`);
  out.push(`- Answer written in the prompt's language (word-list guess): ${pct(s.replyLanguage.ok, s.replyLanguage.n)}.`);
  out.push(`- Answers with banned jargon: ${s.jargon}; with Markdown: ${s.markdown}; that declined to answer: ${s.declined}.`, '');
  out.push(`- Wrong claims (an \`avoid\` pattern matched): ${s.claims}; facts not brought up (no \`mention\` pattern matched): ${s.unmentioned}.`, '');

  out.push('## Cost per turn by route taken', '', '| route | mean |', '|---|---|');
  for (const [k, v] of Object.entries(s.cost.byRoute)) out.push(`| ${k} | ${usd(v)} |`);
  out.push('');

  const sweep = sweepThresholds(results);
  if (sweep.length && sweep[0]!.n) {
    out.push(
      '## Threshold sweep',
      '',
      `Clef's recorded answers re-decided under other floors (no new calls). The live floors are action ${ROUTER_THRESHOLDS.action} and candidate ${ROUTER_THRESHOLDS.candidate}.`,
      '',
      '| action floor | exact | one tap away | wrong screen | clarify instead of action |',
      '|---|---|---|---|---|',
    );
    for (const r of sweep.filter((x) => x.candidate === ROUTER_THRESHOLDS.candidate)) {
      out.push(`| ${r.action} | ${pct(r.routeOk, r.n)} | ${pct(r.softOk, r.n)} | ${r.wrongAction} | ${r.clarifyForAction} |`);
    }
    out.push('', '| candidate floor | clarify candidates right (at action floor ' + ROUTER_THRESHOLDS.action + ') |', '|---|---|');
    for (const r of sweep.filter((x) => x.action === ROUTER_THRESHOLDS.action)) out.push(`| ${r.candidate} | ${pct(r.candidatesOk, r.candidatesScored)} |`);
    out.push('');
  }

  out.push('## Every prompt', '', '| id | lang | expected | got | conf | fields | router ms | first ms | total ms | cost | reply or error |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const expected = r.expect.route === 'action' ? `action ${r.expect.action}` : r.expect.route + (r.expect.candidates ? ` [${r.expect.candidates.join(', ')}]` : '');
    const got = (r.route === 'action' ? `action ${r.action}` : (r.route ?? 'none') + (r.candidates.length ? ` [${r.candidates.join(', ')}]` : '')) + (r.softOk ? '' : ' ✗');
    const fields = Object.entries(r.fieldScores)
      .map(([k, ok]) => `${k}${ok ? '' : `✗(${JSON.stringify(r.fields?.[k] ?? null)})`}`)
      .join(' ');
    const reply = r.error ? `error: ${r.error}` : r.reply.slice(0, 80) + (r.reply.length > 80 ? '…' : '');
    out.push(
      `| ${cell(r.id)} | ${r.language}${r.routerLanguageOk ? '' : `→${r.routerLanguage ?? '?'}`} | ${cell(expected)} | ${cell(got)} | ${r.confidence?.toFixed(2) ?? '–'} | ${cell(fields)} | ${msf(r.ms.router)} | ${msf(r.ms.first)} | ${msf(r.ms.total)} | ${usd(r.costUsd)} | ${cell(reply)} |`,
    );
  }
  out.push('');
  return out.join('\n');
}
