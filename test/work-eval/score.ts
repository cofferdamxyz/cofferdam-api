// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Scoring for the Work extraction evaluation (`test/work.eval.test.ts`):
 * each model's fragments and intents against the synthetic fixtures' gold
 * fields (`test/fixtures/work/`). Pure, so `test/workEval.test.ts` checks it
 * offline on every `yarn test`.
 *
 * Text fields match when their words agree (accents and punctuation aside,
 * at least half the words shared); numbers, dates and the current flag match
 * exactly; lists score items one to one on the same word rule, as precision
 * and recall. A null where the gold has a value is a miss, a value where the
 * gold is null a false positive. Names (employer, school, place) are the
 * block's own placeholders and not a model's output, so they are not scored.
 */

import { fold } from '../../src/services/work/blocks.js';
import type { CvFragment } from '../../src/services/work/cv.js';
import type { ExtractedField, Violation } from '../../src/services/work/fields.js';
import type { IntentFields } from '../../src/services/work/intent.js';

export const SCALAR_FIELDS: Record<string, string[]> = {
  summary: ['title', 'years'],
  experience: ['title', 'rank', 'start', 'end', 'current'],
  education: ['qualification', 'end'],
};

export const LIST_FIELDS: Record<string, string[]> = {
  summary: ['skills'],
  experience: ['skills'],
  skills: ['skills'],
  certificates: ['certificates'],
  languages: ['fluent', 'basic'],
};

const TEXT_FIELDS = new Set(['title', 'qualification', 'task', 'when', 'credential', 'language', 'recurrence']);

export const INTENT_SCORED = ['task', 'when', 'budgetUsd', 'credential', 'language', 'recurrence'] as const;

export function normText(s: string): string {
  return fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function words(s: string): Set<string> {
  return new Set(normText(s).split(' ').filter(Boolean));
}

export function jaccard(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size && !y.size) return 1;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

/** Two texts name the same thing: the same words, or at least half of them shared. */
export function textMatch(pred: string, gold: string): boolean {
  return normText(pred) === normText(gold) || jaccard(pred, gold) >= 0.5;
}

/** Items matched one to one, each gold item to its best unmatched prediction. */
export function listMatch(pred: readonly string[], gold: readonly string[]): { tp: number; predCount: number; goldCount: number } {
  const used = new Set<number>();
  let tp = 0;
  for (const g of gold) {
    let best = -1;
    let bestScore = 0;
    pred.forEach((p, i) => {
      if (used.has(i)) return;
      const s = normText(p) === normText(g) ? 1 : jaccard(p, g);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    });
    if (best >= 0 && bestScore >= 0.5) {
      used.add(best);
      tp++;
    }
  }
  return { tp, predCount: pred.length, goldCount: gold.length };
}

/** The scored fields of a fragment, under the fixtures' gold names. */
export function predictedFields(fragment: CvFragment): Record<string, unknown> {
  const raws = (claims: { raw: string }[]) => claims.map((c) => c.raw);
  switch (fragment.kind) {
    case 'summary':
      return { title: fragment.headline.title?.raw ?? null, years: fragment.headline.years, skills: raws(fragment.skills) };
    case 'experience': {
      const e = fragment.experience;
      return { title: e.title?.raw ?? null, rank: e.title?.rank ?? null, start: e.start, end: e.end, current: e.current, skills: raws(e.skills) };
    }
    case 'education':
      return { qualification: fragment.education.qualification, end: fragment.education.end };
    case 'skills':
      return { skills: raws(fragment.skills) };
    case 'certificates':
      return { certificates: raws(fragment.certificates) };
    case 'languages':
      return {
        fluent: fragment.languages.filter((l) => l.level === 'fluent').map((l) => l.raw),
        basic: fragment.languages.filter((l) => l.level === 'basic').map((l) => l.raw),
      };
  }
}

export interface ScalarScore {
  field: string;
  gold: unknown;
  pred: unknown;
  correct: boolean;
  /** Clairic's chance the input does not determine the field, when it answered one. */
  pNull: number | null;
}

export interface ListScore {
  field: string;
  tp: number;
  predCount: number;
  goldCount: number;
  /** The items, for reading a miss (synthetic text only). */
  pred: string[];
  gold: string[];
}

function scalarCorrect(field: string, pred: unknown, gold: unknown): boolean {
  if (gold == null || pred == null) return gold == null && pred == null;
  if (TEXT_FIELDS.has(field) && typeof pred === 'string' && typeof gold === 'string') return textMatch(pred, gold);
  return pred === gold;
}

/** Score one block's fragment against its gold fields. */
export function scoreBlock(
  kind: string,
  expected: Record<string, unknown>,
  fragment: CvFragment | null,
  fields: Record<string, ExtractedField> | null,
): { scalars: ScalarScore[]; lists: ListScore[] } {
  const pred = fragment ? predictedFields(fragment) : {};
  const scalars = (SCALAR_FIELDS[kind] ?? []).map((field) => {
    const p = pred[field] ?? null;
    const gold = expected[field] ?? null;
    const pNullSource = field === 'current' ? 'end' : field;
    return { field, gold, pred: p, correct: scalarCorrect(field, p, gold), pNull: fields?.[pNullSource]?.pNull ?? null };
  });
  const lists = (LIST_FIELDS[kind] ?? []).map((field) => {
    const p = (pred[field] as string[] | undefined) ?? [];
    const g = (expected[field] as string[] | undefined) ?? [];
    return { field, ...listMatch(p, g), pred: p, gold: g };
  });
  return { scalars, lists };
}

/** Score one intent against its gold fields. */
export function scoreIntent(expected: Record<string, unknown>, intent: IntentFields | null, fields: Record<string, ExtractedField> | null): ScalarScore[] {
  return INTENT_SCORED.map((field) => {
    const p = intent ? (intent[field] ?? null) : null;
    const gold = expected[field] ?? null;
    const source = field === 'budgetUsd' ? 'budget' : field;
    return { field, gold, pred: p, correct: scalarCorrect(field, p, gold), pNull: fields?.[source]?.pNull ?? null };
  });
}

// ── Runs and the summary ─────────────────────────────────────────────────────

export interface Usage {
  tokensIn: number;
  tokensOut: number;
  neurons: number | null;
}

export interface BlockRun {
  model: string;
  id: string;
  cv: string;
  locale: string;
  kind: string;
  ok: boolean;
  failure: string | null;
  ms: number;
  usage: Usage;
  costMicroUsd: number;
  violations: Violation[];
  scalars: ScalarScore[];
  lists: ListScore[];
}

export interface IntentRun {
  model: string;
  id: string;
  locale: string;
  ok: boolean;
  failure: string | null;
  ms: number;
  usage: Usage;
  costMicroUsd: number;
  violations: Violation[];
  scalars: ScalarScore[];
}

export interface ClassifyRun {
  cv: string;
  locale: string;
  type: string | null;
  confidence: number;
  ms: number;
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

export interface Aggregate {
  runs: number;
  answered: number;
  failures: Record<string, number>;
  scalarCorrect: number;
  scalarTotal: number;
  /** Per field: correct of total. */
  byField: Record<string, { correct: number; total: number }>;
  listTp: number;
  listPred: number;
  listGold: number;
  /** Values where the gold is null (a field the input does not give). */
  falsePositives: number;
  /** Nulls where the gold has a value. */
  misses: number;
  /** Mean squared error of p_null against "the gold is null", over the fields that reported it; null when none did. */
  brier: number | null;
  violations: Record<string, number>;
  p50Ms: number;
  p95Ms: number;
  tokensIn: number;
  tokensOut: number;
  neuronsReported: number;
  costMicroUsd: number;
}

export function aggregate(runs: readonly (BlockRun | IntentRun)[]): Aggregate {
  const a: Aggregate = {
    runs: runs.length,
    answered: 0,
    failures: {},
    scalarCorrect: 0,
    scalarTotal: 0,
    byField: {},
    listTp: 0,
    listPred: 0,
    listGold: 0,
    falsePositives: 0,
    misses: 0,
    brier: null,
    violations: {},
    p50Ms: percentile(runs.map((r) => r.ms), 50),
    p95Ms: percentile(runs.map((r) => r.ms), 95),
    tokensIn: 0,
    tokensOut: 0,
    neuronsReported: 0,
    costMicroUsd: 0,
  };
  const brier: number[] = [];
  for (const r of runs) {
    if (r.ok) a.answered++;
    else a.failures[r.failure ?? 'unknown'] = (a.failures[r.failure ?? 'unknown'] ?? 0) + 1;
    a.tokensIn += r.usage.tokensIn;
    a.tokensOut += r.usage.tokensOut;
    if (r.usage.neurons != null) a.neuronsReported++;
    a.costMicroUsd += r.costMicroUsd;
    for (const v of r.violations) a.violations[v.reason] = (a.violations[v.reason] ?? 0) + 1;
    for (const s of r.scalars) {
      a.scalarTotal++;
      const f = (a.byField[s.field] ??= { correct: 0, total: 0 });
      f.total++;
      if (s.correct) {
        a.scalarCorrect++;
        f.correct++;
      }
      if (s.gold == null && s.pred != null) a.falsePositives++;
      if (s.gold != null && s.pred == null) a.misses++;
      if (s.pNull != null) brier.push((s.pNull - (s.gold == null ? 1 : 0)) ** 2);
    }
    for (const l of 'lists' in r ? r.lists : []) {
      a.listTp += l.tp;
      a.listPred += l.predCount;
      a.listGold += l.goldCount;
    }
  }
  a.brier = brier.length ? Math.round(mean(brier) * 1000) / 1000 : null;
  return a;
}

export function listF1(a: Aggregate): { precision: number; recall: number; f1: number } {
  const precision = a.listPred ? a.listTp / a.listPred : 1;
  const recall = a.listGold ? a.listTp / a.listGold : 1;
  return { precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 };
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 1000) / 10}%` : '—');
const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(micro < 10_000 ? 5 : 4)}`;

export interface ReportMeta {
  date: string;
  models: string[];
  classifyModel: string;
  cvs: number;
  blocks: number;
  intents: number;
  durationMs: number;
}

function modelName(id: string): string {
  return id.split('/').pop() ?? id;
}

function summaryRows(models: string[], byModel: Map<string, Aggregate>, cvsPerModel: number): string[] {
  const head = `| | ${models.map(modelName).join(' | ')} |`;
  const sep = `|---|${models.map(() => '---').join('|')}|`;
  const row = (label: string, f: (a: Aggregate) => string) => `| ${label} | ${models.map((m) => f(byModel.get(m)!)).join(' | ')} |`;
  return [
    head,
    sep,
    row('Answered', (a) => `${a.answered} of ${a.runs}`),
    row('Single fields right', (a) => `${pct(a.scalarCorrect, a.scalarTotal)} (${a.scalarCorrect} of ${a.scalarTotal})`),
    row('List items: precision / recall / F1', (a) => {
      const f = listF1(a);
      return `${pct(f.precision, 1)} / ${pct(f.recall, 1)} / ${pct(f.f1, 1)}`;
    }),
    row('Values where the gold is null', (a) => String(a.falsePositives)),
    row('Nulls where the gold has a value', (a) => String(a.misses)),
    row('Dropped by validation', (a) => Object.entries(a.violations).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'),
    row('p_null Brier (lower is better)', (a) => (a.brier == null ? 'not reported' : String(a.brier))),
    row('Latency p50 / p95', (a) => `${(a.p50Ms / 1000).toFixed(1)} s / ${(a.p95Ms / 1000).toFixed(1)} s`),
    row('Tokens in / out per call', (a) => `${Math.round(a.tokensIn / Math.max(1, a.runs))} / ${Math.round(a.tokensOut / Math.max(1, a.runs))}`),
    row('Neurons reported', (a) => `${a.neuronsReported} of ${a.runs} calls`),
    row('Cost per call', (a) => usd(a.costMicroUsd / Math.max(1, a.runs))),
    ...(cvsPerModel ? [row('Cost per CV', (a) => usd(a.costMicroUsd / cvsPerModel))] : []),
  ];
}

function fieldRows(models: string[], byModel: Map<string, Aggregate>): string[] {
  const fields = [...new Set(models.flatMap((m) => Object.keys(byModel.get(m)!.byField)))];
  return [
    `| Field | ${models.map(modelName).join(' | ')} |`,
    `|---|${models.map(() => '---').join('|')}|`,
    ...fields.map((f) => `| ${f} | ${models.map((m) => {
      const v = byModel.get(m)!.byField[f];
      return v ? pct(v.correct, v.total) : '—';
    }).join(' | ')} |`),
  ];
}

function misses(runs: readonly BlockRun[], limit = 40): string[] {
  const out: string[] = [];
  for (const r of runs) {
    for (const s of r.scalars) if (!s.correct) out.push(`- ${modelName(r.model)} ${r.id} ${s.field}: gold ${JSON.stringify(s.gold)}, got ${JSON.stringify(s.pred)}`);
    for (const l of r.lists) if (l.tp < l.goldCount || l.tp < l.predCount) out.push(`- ${modelName(r.model)} ${r.id} ${l.field}: ${l.tp} of ${l.goldCount} gold items; got ${JSON.stringify(l.pred)}`);
    if (!r.ok) out.push(`- ${modelName(r.model)} ${r.id}: failed (${r.failure})`);
  }
  return out.length > limit ? [...out.slice(0, limit), `- … ${out.length - limit} more in the JSON`] : out;
}

export function reportMarkdown(
  meta: ReportMeta,
  blockRuns: readonly BlockRun[],
  intentRuns: readonly IntentRun[],
  classifyRuns: readonly ClassifyRun[],
): string {
  const byModel = new Map(meta.models.map((m) => [m, aggregate(blockRuns.filter((r) => r.model === m))]));
  const intentsByModel = new Map(meta.models.map((m) => [m, aggregate(intentRuns.filter((r) => r.model === m))]));
  const locales = [...new Set(blockRuns.map((r) => r.locale))];
  const localeRows = [
    `| Locale | ${meta.models.map((m) => `${modelName(m)} fields`).join(' | ')} | ${meta.models.map((m) => `${modelName(m)} list F1`).join(' | ')} |`,
    `|---|${meta.models.map(() => '---').join('|')}|${meta.models.map(() => '---').join('|')}|`,
    ...locales.map((loc) => {
      const aggs = meta.models.map((m) => aggregate(blockRuns.filter((r) => r.model === m && r.locale === loc)));
      return `| ${loc} | ${aggs.map((a) => pct(a.scalarCorrect, a.scalarTotal)).join(' | ')} | ${aggs.map((a) => pct(listF1(a).f1, 1)).join(' | ')} |`;
    }),
  ];
  const classified = classifyRuns.filter((r) => r.type === 'cv').length;
  return [
    `# Work extraction evaluation, ${meta.date}`,
    '',
    `Models: ${meta.models.map((m) => `\`${m}\``).join(' and ')}. ${meta.cvs} synthetic CVs as ${meta.blocks} de-identified blocks and ${meta.intents} hirer sentences in en-US, pt-BR and es-MX (\`test/fixtures/work/\`), each sent once to each model through the inference seam over the Workers AI REST API from the Mac, without the fallback, in ${Math.round(meta.durationMs / 1000)} s. No gateway: \`AI_GATEWAY_ID\` is unset, so the strict gateway and its DLP were not measured. Latency is the Mac's round trip.`,
    '',
    '## CV blocks',
    '',
    ...summaryRows(meta.models, byModel, meta.cvs),
    '',
    '### Single fields',
    '',
    ...fieldRows(meta.models, byModel),
    '',
    '### By locale',
    '',
    ...localeRows,
    '',
    '## Hirer sentences (S5)',
    '',
    ...summaryRows(meta.models, intentsByModel, 0),
    '',
    ...fieldRows(meta.models, intentsByModel),
    '',
    `## Document type (\`${modelName(meta.classifyModel)}\`)`,
    '',
    `${classified} of ${classifyRuns.length} CVs classified as a CV from their first two blocks (floor 0.5); confidence ${classifyRuns.map((r) => r.confidence.toFixed(2)).join(', ')}.`,
    '',
    '## Misses',
    '',
    ...misses(blockRuns),
    '',
  ].join('\n');
}
