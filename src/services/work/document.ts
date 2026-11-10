// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Vault document reading on Cofferdam Cloud (workspace decision 0081,
 * item 3; runbook `docs/runbooks/vault-build.md`, step 3): one hosted call
 * reads a document's text into the generic document schema, and the plane
 * keeps nothing of the request or the answer.
 *
 * `POST /v1/work/document` (`routes/work.ts`) serves it on the document's
 * text only (the PDF's text layer, else the phone's text recognition), after
 * the phone's identity strip, the same as the CV's (decision 0021, ruled
 * 2026-10-28 and 2026-10-30). `parseDocument` is the route's call, on
 * `work-document` (DeepSeek V4.1 Flash) through the documents AI Gateway,
 * which cannot store and has no DLP: the strict gateway's DLP would refuse a
 * certificate's or a licence's own number. It hands its calls to the meter
 * and logs reason codes, never text.
 *
 * The schema and the system prompt are the phone's, byte for byte: Cofferdam
 * Local holds LiteRT-LM to the same schema (`schemaRegex`), and both sides pin
 * their SHA-256 (`test/workDocumentRoute.test.ts`, the app's `reading.test.ts`).
 * The schema never asks the holder's name: `holder_present` is a flag. The
 * plane fails closed on shape (exactly the schema's keys, each of its type,
 * `document_type` in the enum) and never rewrites a value; the phone's reader
 * (`readDocumentAnswer`) parses the dates, bounds the numbers and records
 * what it drops.
 *
 * The document type is the reading's `document_type`, never Clef's
 * `/v1/work/classify`, whose block check refuses an id number.
 */

import { thinkingOff } from '../chat/run.js';
import { InferenceTimeout, OPS, type Inference } from '../inference/index.js';
import { failureCode } from './executor.js';
import { estimatedUsage, usageOrEstimate, type WorkCall } from './fields.js';
import { MAX_PARSE_TEXT, resultObject } from './parse.js';

/** The answer's schema id on the wire. */
export const DOCUMENT_SCHEMA = 'cofferdam.document.v1';

/** The JSON Schema the model is held to, identical on the phone (pinned by hash). `document_type` follows Clef's `DOCUMENT_TYPES` order. */
export const DOCUMENT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    document_type: { type: 'string', enum: ['cv', 'certificate', 'licence', 'passport', 'other'] },
    title: { type: ['string', 'null'] },
    issuer: { type: ['string', 'null'] },
    hours: { type: ['integer', 'null'] },
    completed_on: { type: ['string', 'null'] },
    valid_until: { type: ['string', 'null'] },
    document_number: { type: ['string', 'null'] },
    standard: { type: ['string', 'null'] },
    holder_present: { type: 'boolean' },
  },
  required: ['document_type', 'title', 'issuer', 'hours', 'completed_on', 'valid_until', 'document_number', 'standard', 'holder_present'],
  additionalProperties: false,
} as const;

/** The system prompt, identical on the phone (pinned by hash). The user message is the text with no prefix. */
export const DOCUMENT_SYSTEM =
  "This is the text of a document. Fill the JSON fields from what it says. Dates as YYYY-MM-DD. Set holder_present to true if a person's name is printed, but never copy the name or any personal document number into any field; only the document's own number goes in document_number. Write null for a field the text does not give.";

/** The answer's cap: nine short fields. */
export const DOCUMENT_MAX_TOKENS = 512;

export type DocumentType = (typeof DOCUMENT_JSON_SCHEMA.properties.document_type.enum)[number];

/** The model's answer, checked against the schema and nothing more. */
export interface DocumentReading {
  document_type: DocumentType;
  title: string | null;
  issuer: string | null;
  hours: number | null;
  completed_on: string | null;
  valid_until: string | null;
  document_number: string | null;
  standard: string | null;
  holder_present: boolean;
}

const DOCUMENT_KEYS: readonly string[] = DOCUMENT_JSON_SCHEMA.required;
const DOCUMENT_TYPES: ReadonlySet<string> = new Set(DOCUMENT_JSON_SCHEMA.properties.document_type.enum);

// ── The request ─────────────────────────────────────────────────────────────

/** The keys a document request may carry. Any other, a page image above all, is refused. */
const DOCUMENT_BODY_KEYS: ReadonlySet<string> = new Set(['account', 'text']);

export type DocumentBodyRead =
  | { ok: true; text: string }
  | { ok: false; status: 400; error: 'bad_request'; message: string }
  | { ok: false; status: 413; error: 'text_too_long'; max: number };

/**
 * The route's check of a document request, beside the account the Work gate
 * reads: the document's text and nothing else, at most `MAX_PARSE_TEXT`
 * characters (the CV's limit). A refusal never echoes the body. The text is
 * not trimmed or rewritten: the model reads what the phone sent.
 */
export function readDocumentBody(b: Record<string, unknown>): DocumentBodyRead {
  if (Object.keys(b).some((k) => !DOCUMENT_BODY_KEYS.has(k))) {
    return { ok: false, status: 400, error: 'bad_request', message: "the body takes the account and the document's text only" };
  }
  if (typeof b.text !== 'string' || !b.text.trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: "text must be the document's text" };
  }
  if (b.text.length > MAX_PARSE_TEXT) return { ok: false, status: 413, error: 'text_too_long', max: MAX_PARSE_TEXT };
  return { ok: true, text: b.text };
}

/** Workers AI's own JSON mode for llama; every other model takes the OpenAI JSON-schema wrapper and thinking off (`parseRequest`'s switch). */
const isLlama = (model: string) => model.startsWith('@cf/meta/');

/** The request body for `model`: the system prompt, then the document's text as the only user content, with no prefix and no id of any kind. */
export function documentRequest(model: string, text: string): Record<string, unknown> {
  const messages = [
    { role: 'system', content: DOCUMENT_SYSTEM },
    { role: 'user', content: text },
  ];
  if (isLlama(model)) {
    return { messages, response_format: { type: 'json_schema', json_schema: DOCUMENT_JSON_SCHEMA }, temperature: 0, max_tokens: DOCUMENT_MAX_TOKENS };
  }
  return {
    messages,
    response_format: { type: 'json_schema', json_schema: { name: 'cofferdam_document', schema: DOCUMENT_JSON_SCHEMA, strict: true } },
    temperature: 0,
    max_tokens: DOCUMENT_MAX_TOKENS,
    ...thinkingOff(model),
  };
}

// ── Reading the answer ──────────────────────────────────────────────────────

export class DocumentShapeError extends Error {
  constructor(readonly reason: string) {
    super(`document answer out of shape: ${reason}`);
    this.name = 'DocumentShapeError';
  }
}

const isStringOrNull = (v: unknown) => v === null || typeof v === 'string';

/**
 * The model's answer as a `DocumentReading`, in the schema's key order.
 * Throws `DocumentShapeError` (its reason a key name, never a value) unless
 * the answer is an object with exactly the schema's keys, each of its type,
 * and `document_type` in the enum. Values are passed on as the model wrote
 * them: the phone's reader parses and bounds them.
 */
export function readDocument(result: unknown): DocumentReading {
  const o = resultObject(result);
  if (!o) throw new DocumentShapeError('no JSON object');
  if (Object.keys(o).length !== DOCUMENT_KEYS.length || DOCUMENT_KEYS.some((k) => !Object.hasOwn(o, k))) throw new DocumentShapeError('keys');
  if (typeof o.document_type !== 'string' || !DOCUMENT_TYPES.has(o.document_type)) throw new DocumentShapeError('document_type');
  for (const k of ['title', 'issuer', 'completed_on', 'valid_until', 'document_number', 'standard'] as const) {
    if (!isStringOrNull(o[k])) throw new DocumentShapeError(k);
  }
  if (o.hours !== null && !Number.isInteger(o.hours)) throw new DocumentShapeError('hours');
  if (typeof o.holder_present !== 'boolean') throw new DocumentShapeError('holder_present');
  return {
    document_type: o.document_type as DocumentType,
    title: o.title as string | null,
    issuer: o.issuer as string | null,
    hours: o.hours as number | null,
    completed_on: o.completed_on as string | null,
    valid_until: o.valid_until as string | null,
    document_number: o.document_number as string | null,
    standard: o.standard as string | null,
    holder_present: o.holder_present,
  };
}

// ── The route's call ────────────────────────────────────────────────────────

/** Why a reading failed: the call ran out of time, threw, or answered no object of the schema's shape. */
export type DocumentFailure = 'timeout' | 'call_failed' | 'shape';

export type DocumentOutcome =
  | { ok: true; document: DocumentReading; model: string; calls: WorkCall[] }
  | { ok: false; reason: DocumentFailure; model: string; calls: WorkCall[] };

/** A reading answers within this, a retry included, so the phone can wait a fixed time; the gate's checks come before it. */
export const DOCUMENT_BUDGET_MS = 40_000;
/** A retry runs only with this much of the budget left. */
export const DOCUMENT_RETRY_MIN_MS = 10_000;

export interface DocumentOptions {
  now?: () => number;
  signal?: AbortSignal;
  /** One JSON line per failed attempt: op, model, attempt and a reason code, never text. */
  log?: (fields: Record<string, unknown>) => void;
}

/** Whether an answer stopped at its token cap: a retry would stop there too. */
function cutAtCap(result: unknown): boolean {
  const r = (result ?? {}) as { choices?: { finish_reason?: unknown }[] };
  return r.choices?.[0]?.finish_reason === 'length';
}

/**
 * Reads a document's text on `work-document`, in `parseCv`'s shape: one call,
 * and a second only when the first throws (not a timeout) or answers out of
 * shape (not cut at its cap), with enough of `DOCUMENT_BUDGET_MS` left. Every
 * call is returned for the meter, a call that threw at its estimated input. A
 * failure is logged by its code, never by its message, which a provider may
 * build from the input.
 */
export async function parseDocument(inference: Inference, text: string, opts: DocumentOptions = {}): Promise<DocumentOutcome> {
  const now = opts.now ?? Date.now;
  const model = await inference.model('work-document');
  const request = documentRequest(model, text);
  const started = now();
  const calls: WorkCall[] = [];
  let reason: DocumentFailure = 'call_failed';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const left = DOCUMENT_BUDGET_MS - (now() - started);
    if (attempt > 1 && (reason === 'timeout' || left < DOCUMENT_RETRY_MIN_MS)) break;
    const t0 = now();
    let result: unknown;
    try {
      result = await inference.run('work-document', request, { signal: opts.signal, timeoutMs: Math.min(OPS['work-document'].timeoutMs, left) });
    } catch (err) {
      reason = err instanceof InferenceTimeout ? 'timeout' : 'call_failed';
      calls.push({ op: 'work-document', model, ok: false, ms: now() - t0, usage: estimatedUsage(request) });
      opts.log?.({ event: 'work_document_failed', op: 'work-document', model, attempt, reason: failureCode(err) });
      continue;
    }
    const usage = usageOrEstimate(result, request);
    try {
      const document = readDocument(result);
      calls.push({ op: 'work-document', model, ok: true, ms: now() - t0, usage });
      return { ok: true, document, model, calls };
    } catch (err) {
      reason = 'shape';
      calls.push({ op: 'work-document', model, ok: false, ms: now() - t0, usage });
      const cut = cutAtCap(result);
      opts.log?.({ event: 'work_document_failed', op: 'work-document', model, attempt, reason: cut ? 'cut' : err instanceof DocumentShapeError ? 'shape' : failureCode(err) });
      if (cut) break;
    }
  }
  return { ok: false, reason, model, calls };
}
