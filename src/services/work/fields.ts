// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed field extraction on Workers AI, shared by the CV blocks
 * (`executor.ts`) and the hirer's sentence (`intent.ts`); workspace decision
 * 0020 and `docs/product/engine.md`, Clairic.
 *
 * A schema is a set of typed fields with no free text: spans of the input (a
 * title, a skill, how a date is written) and whole numbers. The request
 * follows the pinned model's family: Clairic gets typed `fields` and answers
 * spans with `confidence` and `p_null`; a JSON-mode model gets a JSON schema
 * (Workers AI's own shape for llama, the OpenAI shape for gpt-oss), and its
 * strings are resolved back to the input.
 *
 * Validation fails closed and never repairs. A value that is not a span of
 * the input (ignoring case and runs of whitespace), a date the parser cannot
 * read, a number out of range, or a value holding a placeholder or a refused
 * pattern is dropped and reported as a violation; whatever is kept is the
 * input's own text. A response not in the schema's shape is a failed call.
 */

import type { InferenceOp } from '../inference/index.js';
import { fold, placeholdersIn, scanText } from './blocks.js';
import { parseCvDate } from './cv.js';

export type FieldSpec =
  | { type: 'text'; instructions: string }
  /** A span saying when, read by `parseCvDate`; the end of a job may be the word for "present". */
  | { type: 'date'; instructions: string }
  | { type: 'integer'; instructions: string; min: number; max: number }
  | { type: 'list'; instructions: string; maxItems: number };

export type FieldSet = Record<string, FieldSpec>;

/** Longest span kept; a longer value is dropped. */
export const SPAN_MAX_CHARS = 200;

/** The JSON Schema a JSON-mode model is held to: every field present, nothing else. */
export function jsonSchema(fields: FieldSet): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(fields)) {
    if (f.type === 'integer') properties[name] = { type: ['integer', 'null'], minimum: f.min, maximum: f.max };
    else if (f.type === 'list') properties[name] = { type: 'array', items: { type: 'string' }, maxItems: f.maxItems };
    else properties[name] = { type: ['string', 'null'] };
  }
  return { type: 'object', properties, required: Object.keys(fields), additionalProperties: false };
}

/** Clairic's typed fields: spans for text and dates, numbers with no decimals, lists of spans. */
export function clairicFields(fields: FieldSet): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(fields)) {
    if (f.type === 'integer') out[name] = { type: 'number', decimals: 0, instructions: f.instructions };
    else if (f.type === 'list') out[name] = { type: 'list', items: 'text', instructions: f.instructions };
    else out[name] = { type: 'text', instructions: f.instructions };
  }
  return out;
}

export type ExtractorFamily = 'clairic' | 'json-mode' | 'chat-json';

/** Which request shape a model takes: Clairic's fields, Workers AI JSON mode, or the OpenAI JSON-schema wrapper. */
export function extractorFamily(model: string): ExtractorFamily {
  if (/(^|\/)clairic$/.test(model)) return 'clairic';
  if (/gpt-oss/.test(model)) return 'chat-json';
  return 'json-mode';
}

export interface FieldsPrompt {
  /** The schema's name, for the OpenAI wrapper (`cv_experience`). */
  name: string;
  /** What the model is told, before the field list. */
  system: string;
  /** The user message: a label and the input. */
  user: string;
  /** The input itself, Clairic's `state`; spans are checked against it. */
  state: string;
}

/** The request body on `model`; the input is the only user content, with no id of any kind. */
export function fieldsRequest(model: string, fields: FieldSet, prompt: FieldsPrompt): Record<string, unknown> {
  const family = extractorFamily(model);
  if (family === 'clairic') return { model: model.split('/').pop(), state: prompt.state, fields: clairicFields(fields) };
  const list = Object.entries(fields)
    .map(([name, f]) => `- ${name}: ${f.instructions}`)
    .join('\n');
  const messages = [
    { role: 'system', content: `${prompt.system}\n\nFields:\n${list}` },
    { role: 'user', content: prompt.user },
  ];
  if (family === 'chat-json') {
    return {
      messages,
      response_format: { type: 'json_schema', json_schema: { name: prompt.name, schema: jsonSchema(fields), strict: true } },
      reasoning_effort: 'low',
      max_tokens: 1_500,
    };
  }
  return { messages, response_format: { type: 'json_schema', json_schema: jsonSchema(fields) }, temperature: 0, max_tokens: 800 };
}

// ── Reading a response ──────────────────────────────────────────────────────

export interface CallUsage {
  tokensIn: number;
  tokensOut: number;
  /** Workers AI's bill for the call when the model reports it (llama, gpt-oss, bge-m3; not Clairic or Clef). */
  neurons: number | null;
}

export const NO_USAGE: CallUsage = { tokensIn: 0, tokensOut: 0, neurons: null };

const count = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/** The usage a Workers AI result reports, in any of its shapes. */
export function usageOf(result: unknown): CallUsage {
  const r = (result ?? {}) as { usage?: Record<string, unknown>; meta?: Record<string, unknown> };
  const u = r.usage ?? {};
  const neurons = Number(u.neurons ?? r.meta?.neurons);
  return {
    tokensIn: count(u.prompt_tokens ?? u.input_tokens ?? r.meta?.cost_metric_value_1),
    tokensOut: count(u.completion_tokens ?? u.output_tokens),
    neurons: Number.isFinite(neurons) && neurons > 0 ? neurons : null,
  };
}

/** One hosted call, for the meter and the log; never any text. */
export interface WorkCall {
  op: InferenceOp;
  model: string;
  ok: boolean;
  ms: number;
  usage: CallUsage;
}

/** One field as a model answered it, before validation. */
export interface RawField {
  value: unknown;
  confidence?: number;
  pNull?: number;
}

export type ReadFailure = 'no_answers' | 'not_json' | 'not_an_object' | 'unexpected_key' | 'missing_key';

export type FieldsRead = { ok: true; fields: Record<string, RawField> } | { ok: false; reason: ReadFailure };

const unit = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined);

function readClairic(result: unknown, fields: FieldSet): FieldsRead {
  const answers = (result as { answers?: unknown } | null)?.answers;
  if (!answers || typeof answers !== 'object') return { ok: false, reason: 'no_answers' };
  const out: Record<string, RawField> = {};
  for (const name of Object.keys(fields)) {
    const a = (answers as Record<string, unknown>)[name] as Record<string, unknown> | undefined;
    out[name] = a && typeof a === 'object' ? { value: a.value ?? null, confidence: unit(a.confidence), pNull: unit(a.p_null) } : { value: null };
  }
  return { ok: true, fields: out };
}

function jsonObjectOf(result: unknown, family: ExtractorFamily): unknown {
  const r = (result ?? {}) as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
  const candidate = family === 'json-mode' && r.response !== undefined ? r.response : r.choices?.[0]?.message?.content ?? r.response;
  if (typeof candidate !== 'string') return candidate;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function readJson(result: unknown, family: ExtractorFamily, fields: FieldSet): FieldsRead {
  const obj = jsonObjectOf(result, family);
  if (obj === undefined) return { ok: false, reason: 'not_json' };
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'not_an_object' };
  const o = obj as Record<string, unknown>;
  if (Object.keys(o).some((k) => !(k in fields))) return { ok: false, reason: 'unexpected_key' };
  if (Object.keys(fields).some((k) => !(k in o))) return { ok: false, reason: 'missing_key' };
  const out: Record<string, RawField> = {};
  for (const name of Object.keys(fields)) out[name] = { value: o[name] };
  return { ok: true, fields: out };
}

/** The answer's fields in the schema's shape, or why it is not in it. */
export function readFieldsAnswer(model: string, fields: FieldSet, result: unknown): FieldsRead {
  const family = extractorFamily(model);
  return family === 'clairic' ? readClairic(result, fields) : readJson(result, family, fields);
}

// ── Validation ──────────────────────────────────────────────────────────────

export type ViolationReason =
  | 'not_a_span'
  | 'not_a_string'
  | 'not_a_number'
  | 'not_a_list'
  | 'out_of_range'
  | 'bad_date'
  | 'too_long'
  | 'too_many'
  | 'placeholder'
  | 'refused_pattern'
  | 'other_currency';

export interface Violation {
  field: string;
  reason: ViolationReason;
}

/** A field as kept: spans are the input's own text; `confidence` and `pNull` are Clairic's, when it answered. */
export interface ExtractedField {
  value: string | number | string[] | null;
  confidence?: number;
  pNull?: number;
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

const WORD = /[\p{L}\p{N}]/u;

/** The span at `i` neither starts nor ends inside a word ("St" of "Stood" does both). */
function onWordBoundaries(t: string, i: number, length: number): boolean {
  const before = t[i - 1];
  const after = t[i + length];
  return !(before && WORD.test(before) && WORD.test(t[i]!)) && !(after && WORD.test(after) && WORD.test(t[i + length - 1]!));
}

/** Every index where `needle` occurs in `haystack`. */
function* occurrences(haystack: string, needle: string): Generator<number> {
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) yield i;
}

/**
 * The input's own text for a model's string: an exact substring after runs of
 * whitespace collapse, else the same match ignoring case (only where lower
 * casing keeps every offset), in both cases starting and ending on word
 * boundaries. Null when no such span is in the input: Clairic's list answers
 * cut words ("St" of "Stood", "Manuten" of "Manutenção", 2026-10-24).
 */
export function resolveSpan(text: string, value: string): string | null {
  const v = collapse(value);
  if (!v) return null;
  const t = collapse(text);
  for (const i of occurrences(t, v)) if (onWordBoundaries(t, i, v.length)) return t.slice(i, i + v.length);
  const lt = t.toLowerCase();
  const lv = v.toLowerCase();
  if (lt.length !== t.length || lv.length !== v.length) return null;
  for (const i of occurrences(lt, lv)) if (onWordBoundaries(t, i, v.length)) return t.slice(i, i + v.length);
  return null;
}

/** A model string checked against the input: the span, or the reason it was dropped. */
function spanOf(text: string, value: unknown): { span: string } | { reason: ViolationReason } {
  if (typeof value !== 'string') return { reason: 'not_a_string' };
  const span = resolveSpan(text, value);
  if (span == null) return { reason: 'not_a_span' };
  if (span.length > SPAN_MAX_CHARS) return { reason: 'too_long' };
  if (placeholdersIn(span).length > 0) return { reason: 'placeholder' };
  if (scanText(span)) return { reason: 'refused_pattern' };
  return { span };
}

const claimKey = (raw: string) => fold(raw).replace(/\s+/g, ' ').trim();

export interface Validated {
  fields: Record<string, ExtractedField>;
  violations: Violation[];
}

/** Keep what holds, drop and report what does not; never change a value. */
export function validateValues(text: string, schema: FieldSet, raw: Record<string, RawField>, now = Date.now()): Validated {
  const fields: Record<string, ExtractedField> = {};
  const violations: Violation[] = [];
  for (const [name, spec] of Object.entries(schema)) {
    const r = raw[name] ?? { value: null };
    const meta = { ...(r.confidence != null ? { confidence: r.confidence } : {}), ...(r.pNull != null ? { pNull: r.pNull } : {}) };
    const drop = (reason: ViolationReason) => {
      violations.push({ field: name, reason });
      fields[name] = { value: null, ...meta };
    };
    if (r.value == null) {
      fields[name] = { value: spec.type === 'list' ? [] : null, ...meta };
      continue;
    }
    if (spec.type === 'integer') {
      if (typeof r.value !== 'number' || !Number.isFinite(r.value)) drop('not_a_number');
      else if (!Number.isInteger(r.value) || r.value < spec.min || r.value > spec.max) drop('out_of_range');
      else fields[name] = { value: r.value, ...meta };
      continue;
    }
    if (spec.type === 'list') {
      if (!Array.isArray(r.value)) {
        drop('not_a_list');
        continue;
      }
      const kept: string[] = [];
      const seen = new Set<string>();
      for (const item of r.value) {
        const s = spanOf(text, item);
        if ('reason' in s) {
          violations.push({ field: name, reason: s.reason });
          continue;
        }
        const k = claimKey(s.span);
        if (seen.has(k)) continue;
        seen.add(k);
        kept.push(s.span);
      }
      if (kept.length > spec.maxItems) violations.push({ field: name, reason: 'too_many' });
      fields[name] = { value: kept.slice(0, spec.maxItems), ...meta };
      continue;
    }
    const s = spanOf(text, r.value);
    if ('reason' in s) {
      drop(s.reason);
      continue;
    }
    if (spec.type === 'date' && parseCvDate(s.span, now) == null) {
      drop('bad_date');
      continue;
    }
    fields[name] = { value: s.span, ...meta };
  }
  return { fields, violations };
}

export const str = (f: ExtractedField | undefined) => (typeof f?.value === 'string' ? f.value : null);
export const int = (f: ExtractedField | undefined) => (typeof f?.value === 'number' ? f.value : null);
export const list = (f: ExtractedField | undefined) => (Array.isArray(f?.value) ? f.value : []);
