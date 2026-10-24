// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A hirer's sentence into the intent's fields (S5; workspace
 * `docs/product/engine.md`, Pipeline, and `docs/product/work-wallet.md`,
 * Matching and award), on op `work-intent` and then the extraction fallback,
 * through the same typed-field machinery as the CV blocks (`fields.ts`):
 * spans of the sentence and a whole-dollar budget, no free text.
 *
 * The sentence has passed the phone's privacy gate; the plane runs the same
 * tripwire as for a block (`scanText`) before any hosted call, and never logs
 * it. The budget follows the chat's amount rule (decision 0046): a bare
 * number is USDC in any language, and an amount in another currency is no
 * budget (`keepsAmount`), so the $50 floor reads a number, never text. The
 * required tokens, the scope and the safety checks are not the extractor's:
 * the registry snaps the spans (S3) and Clef answers the rest.
 */

import { keepsAmount } from '../chat/run.js';
import type { Inference } from '../inference/index.js';
import { scanText, type BlockRefusal } from './blocks.js';
import { languageCode } from './cv.js';
import { failureCode, type ExecutorOptions } from './executor.js';
import {
  fieldsRequest,
  int,
  NO_USAGE,
  readFieldsAnswer,
  str,
  usageOf,
  validateValues,
  type ExtractedField,
  type FieldSet,
  type ReadFailure,
  type Violation,
  type WorkCall,
} from './fields.js';

export const INTENT_FIELDS = {
  task: { type: 'text', instructions: 'The work the person wants done, exactly as written, without the price or the time.' },
  when: { type: 'text', instructions: 'When the work is wanted, exactly as written: a day, a time or a deadline.' },
  budget: {
    type: 'integer',
    min: 1,
    max: 1_000_000,
    instructions: 'What the person will pay, as a whole number, when it is in dollars or written as a bare number. Empty for any other currency, such as reais, pesos or euros.',
  },
  credential: { type: 'text', instructions: 'The licence or certification the worker must hold, exactly as written, for example "licensed electrician".' },
  language: { type: 'text', instructions: 'A language the worker must speak, exactly as written.' },
  recurrence: { type: 'text', instructions: 'How often the job repeats, exactly as written, for example "weekly" or "cada semana".' },
} satisfies FieldSet;

export const INTENT_SYSTEM_PROMPT = [
  'You extract fields from one sentence a person wrote to hire someone for a task. Answer only with JSON that matches the schema.',
  'Copy every string exactly as it appears in the sentence: never translate, correct, summarise or invent.',
  'Use null when the sentence does not state a field.',
].join(' ');

/** The longest sentence the intent parse reads. */
export const INTENT_MAX_CHARS = 1_000;

/** The intent's extracted part, before the registry snap and Clef. */
export interface IntentFields {
  task: string | null;
  when: string | null;
  /** Whole US dollars (USDC); null when the sentence named none or another currency. */
  budgetUsd: number | null;
  credential: string | null;
  language: string | null;
  /** ISO 639-1 of `language`, when the lexicon knows it. */
  languageCode: string | null;
  recurrence: string | null;
}

export function intentRequest(model: string, text: string): Record<string, unknown> {
  return fieldsRequest(model, INTENT_FIELDS, { name: 'intent', system: INTENT_SYSTEM_PROMPT, user: `Request (written by the hirer):\n${text}`, state: text });
}

export interface IntentAttempt {
  call: WorkCall;
  fields: Record<string, ExtractedField> | null;
  violations: Violation[];
  intent: IntentFields | null;
  failure: ReadFailure | 'call_failed' | null;
}

/** The fields as an intent, with the chat's amount rule applied to the budget. */
function toIntent(text: string, fields: Record<string, ExtractedField>, violations: Violation[]): IntentFields {
  let budgetUsd = int(fields.budget);
  if (budgetUsd != null && !keepsAmount(text)) {
    budgetUsd = null;
    fields.budget = { ...fields.budget, value: null };
    violations.push({ field: 'budget', reason: 'other_currency' });
  }
  const language = str(fields.language);
  return {
    task: str(fields.task),
    when: str(fields.when),
    budgetUsd,
    credential: str(fields.credential),
    language,
    languageCode: language ? languageCode(language) : null,
    recurrence: str(fields.recurrence),
  };
}

export async function attemptIntent(inference: Inference, op: 'work-intent' | 'work-extract-fallback', text: string, opts: ExecutorOptions = {}): Promise<IntentAttempt> {
  const now = opts.now ?? Date.now;
  const model = await inference.model(op);
  const t0 = now();
  let result: unknown;
  try {
    result = await inference.run(op, intentRequest(model, text), { signal: opts.signal });
  } catch (err) {
    opts.log?.({ event: 'work_intent_failed', op, model, reason: failureCode(err) });
    return { call: { op, model, ok: false, ms: now() - t0, usage: NO_USAGE }, fields: null, violations: [], intent: null, failure: 'call_failed' };
  }
  const read = readFieldsAnswer(model, INTENT_FIELDS, result);
  const call: WorkCall = { op, model, ok: read.ok, ms: now() - t0, usage: usageOf(result) };
  if (!read.ok) {
    opts.log?.({ event: 'work_intent_failed', op, model, reason: read.reason });
    return { call, fields: null, violations: [], intent: null, failure: read.reason };
  }
  const { fields, violations } = validateValues(text, INTENT_FIELDS, read.fields, now());
  return { call, fields, violations, intent: toIntent(text, fields, violations), failure: null };
}

export type IntentOutcome =
  | { ok: true; intent: IntentFields; fields: Record<string, ExtractedField>; violations: Violation[]; model: string; calls: WorkCall[] }
  | { ok: false; error: 'text_refused'; reason: BlockRefusal | 'too_long' | 'empty'; calls: WorkCall[] }
  | { ok: false; error: 'intent_failed'; calls: WorkCall[] };

/** Parse a hirer's sentence: the tripwire, then the intent op, then the fallback when it fails or answers out of shape. */
export async function parseIntent(inference: Inference, sentence: string, opts: ExecutorOptions = {}): Promise<IntentOutcome> {
  const text = sentence.normalize('NFC').trim();
  if (!text) return { ok: false, error: 'text_refused', reason: 'empty', calls: [] };
  if (text.length > INTENT_MAX_CHARS) return { ok: false, error: 'text_refused', reason: 'too_long', calls: [] };
  const refused = scanText(text);
  if (refused) return { ok: false, error: 'text_refused', reason: refused, calls: [] };
  const calls: WorkCall[] = [];
  for (const op of ['work-intent', 'work-extract-fallback'] as const) {
    const a = await attemptIntent(inference, op, text, opts);
    calls.push(a.call);
    if (a.intent && a.fields) return { ok: true, intent: a.intent, fields: a.fields, violations: a.violations, model: a.call.model, calls };
  }
  return { ok: false, error: 'intent_failed', calls };
}
