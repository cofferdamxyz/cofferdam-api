// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The cloud executor's two hosted steps (workspace decisions 0020 and 0021,
 * `docs/product/engine.md`, Parser): Clef reads the de-identified blocks to
 * name the document type (`classifyDocument`, op `work-classify`), and each CV
 * block becomes one `cofferdam.cv.v1` fragment (`extractBlock`, op
 * `work-extract`, then `work-extract-fallback` when the primary fails or
 * answers out of shape). Both take only blocks that passed `checkBlock`; the
 * field machinery and its fail-closed validation are in `fields.ts`.
 *
 * Names are never a model's job: the employer, the school and the place are
 * the block's own placeholders, read without a model (Clairic cut `[ORG_1]`
 * at its bracket and abstained, 2026-10-24).
 */

import { InferenceTimeout, type Inference } from '../inference/index.js';
import {
  CV_BLOCK_KINDS,
  isPlaceholder,
  placeholdersIn,
  type BlockLang,
  type CvBlockKind,
  type DeidentifiedBlock,
  type PlaceholderClass,
} from './blocks.js';
import {
  clefInput,
  clefInputTokens,
  documentQuestions,
  documentState,
  DOCUMENT_TYPE_FLOOR,
  DOCUMENT_TYPE_KEYS,
  readChoice,
  type DocumentType,
} from './clef.js';
import { CV_SCHEMA, languageCode, parseCvDate, type CvClaim, type CvDate, type CvFragment, type CvLanguage } from './cv.js';
import {
  fieldsRequest,
  int,
  list,
  NO_USAGE,
  readFieldsAnswer,
  str,
  usageOf,
  validateValues,
  type ExtractedField,
  type FieldSet,
  type FieldsRead,
  type RawField,
  type ReadFailure,
  type Validated,
  type Violation,
  type WorkCall,
} from './fields.js';

/** One schema per CV kind; an experience or education block is one entry. */
export const BLOCK_SCHEMAS = {
  summary: {
    title: { type: 'text', instructions: 'The occupation or job title the person presents, exactly as written.' },
    years: { type: 'integer', min: 0, max: 60, instructions: 'The years of experience the text states, as a whole number.' },
    skills: { type: 'list', maxItems: 12, instructions: 'Each skill, task or specialty the text names, as a short phrase copied exactly: one item per skill, never a whole sentence.' },
  },
  experience: {
    title: { type: 'text', instructions: 'The job title of this entry, exactly as written, without the employer or the dates.' },
    rank: {
      type: 'integer',
      min: 1,
      max: 10,
      instructions: 'The rank number the title states (chief or first is 1, second is 2, third is 3). Empty when the title states no rank.',
    },
    start: { type: 'date', instructions: 'When the job started, exactly as written, for example "Jun 2019", "03/2018" or "2016".' },
    end: {
      type: 'date',
      instructions: 'When the job ended, exactly as written, or the word that says it continues, for example "Present", "atual" or "actualidad".',
    },
    skills: { type: 'list', maxItems: 12, instructions: 'Each duty, skill or piece of equipment this job names, as a short phrase copied exactly: one item per skill, never a whole sentence.' },
  },
  education: {
    qualification: { type: 'text', instructions: 'The degree, diploma or course, exactly as written.' },
    end: { type: 'date', instructions: 'When it was completed, exactly as written: a year, or a month and year.' },
  },
  skills: {
    skills: { type: 'list', maxItems: 30, instructions: 'Every skill listed, one item per skill, each copied exactly.' },
  },
  certificates: {
    certificates: { type: 'list', maxItems: 20, instructions: 'Every certificate, licence, credential or training course listed, one item each, copied exactly.' },
  },
  languages: {
    fluent: { type: 'list', maxItems: 8, instructions: 'The names of the languages spoken natively or fluently: one language name per item, without its level.' },
    basic: { type: 'list', maxItems: 8, instructions: 'The names of the languages spoken at a basic or intermediate level: one language name per item, without its level.' },
  },
} satisfies Record<CvBlockKind, FieldSet>;

export function isCvKind(kind: string): kind is CvBlockKind {
  return (CV_BLOCK_KINDS as readonly string[]).includes(kind);
}

const KIND_LABEL: Record<CvBlockKind, string> = {
  summary: 'the profile summary',
  experience: 'one experience entry',
  education: 'one education entry',
  skills: 'the skills list',
  certificates: 'the certificates and licences list',
  languages: 'the languages list',
};

export const LANG_LABEL: Record<BlockLang, string> = { en: 'English', pt: 'Brazilian Portuguese', es: 'Mexican Spanish' };

export const EXTRACT_SYSTEM_PROMPT = [
  'You extract fields from one block of a CV. Answer only with JSON that matches the schema.',
  'Copy every string exactly as it appears in the block: never translate, correct, summarise or invent.',
  'Use null when the block does not state a field, and [] for an empty list.',
  'Placeholders such as [ORG_1] or [PLACE_1] stand for names that were removed: never put one in a field.',
].join(' ');

/** The request body for one block on `model`. The block's text is the only user content; no id of any kind. */
export function extractionRequest(model: string, kind: CvBlockKind, block: DeidentifiedBlock): Record<string, unknown> {
  return fieldsRequest(model, BLOCK_SCHEMAS[kind], {
    name: `cv_${kind}`,
    system: EXTRACT_SYSTEM_PROMPT,
    user: `Block (${KIND_LABEL[kind]}, in ${LANG_LABEL[block.lang]}):\n${block.text}`,
    state: block.text,
  });
}

export function readExtraction(model: string, kind: CvBlockKind, result: unknown): FieldsRead {
  return readFieldsAnswer(model, BLOCK_SCHEMAS[kind], result);
}

export function validateFields(kind: CvBlockKind, block: DeidentifiedBlock, raw: Record<string, RawField>, now = Date.now()): Validated {
  return validateValues(block.text, BLOCK_SCHEMAS[kind], raw, now);
}

// ── Fragments ───────────────────────────────────────────────────────────────

function firstPlaceholder(text: string, cls: PlaceholderClass): string | null {
  return placeholdersIn(text).find((p) => isPlaceholder(p, [cls])) ?? null;
}

const claims = (f: ExtractedField | undefined): CvClaim[] => list(f).map((raw) => ({ raw }));

/** A date field at the CV's own precision, or the word for "present". */
function dateOf(f: ExtractedField | undefined, now: number): { date: CvDate | null; present: boolean } {
  const span = str(f);
  const parsed = span == null ? null : parseCvDate(span, now);
  if (!parsed) return { date: null, present: false };
  return parsed.present ? { date: null, present: true } : { date: parsed.date, present: false };
}

/**
 * The validated fields as a `cofferdam.cv.v1` fragment. The employer, the
 * school and the place are the block's first `[ORG_n]` and `[PLACE_n]`
 * placeholders; a start written as "present" reads as no start.
 */
export function toFragment(kind: CvBlockKind, block: DeidentifiedBlock, fields: Record<string, ExtractedField>, now = Date.now()): CvFragment {
  switch (kind) {
    case 'summary': {
      const title = str(fields.title);
      return { kind, headline: { title: title ? { raw: title, rank: null } : null, years: int(fields.years) }, skills: claims(fields.skills) };
    }
    case 'experience': {
      const title = str(fields.title);
      const start = dateOf(fields.start, now);
      const end = dateOf(fields.end, now);
      return {
        kind,
        experience: {
          title: title ? { raw: title, rank: int(fields.rank) } : null,
          employer: firstPlaceholder(block.text, 'ORG'),
          location: firstPlaceholder(block.text, 'PLACE'),
          start: start.date,
          end: end.date,
          current: end.present,
          skills: claims(fields.skills),
        },
      };
    }
    case 'education':
      return { kind, education: { qualification: str(fields.qualification), institution: firstPlaceholder(block.text, 'ORG'), end: dateOf(fields.end, now).date } };
    case 'skills':
      return { kind, skills: claims(fields.skills) };
    case 'certificates':
      return { kind, certificates: claims(fields.certificates) };
    case 'languages': {
      const languages: CvLanguage[] = [
        ...list(fields.fluent).map((raw) => ({ raw, code: languageCode(raw), level: 'fluent' as const })),
        ...list(fields.basic).map((raw) => ({ raw, code: languageCode(raw), level: 'basic' as const })),
      ];
      return { kind, languages };
    }
  }
}

// ── The calls ───────────────────────────────────────────────────────────────

export interface BlockExtraction {
  kind: CvBlockKind;
  /** The schema the fragment belongs to. */
  schema: typeof CV_SCHEMA;
  fragment: CvFragment;
  fields: Record<string, ExtractedField>;
  violations: Violation[];
  model: string;
  op: 'work-extract' | 'work-extract-fallback';
}

export type ExtractOutcome =
  | { ok: true; extraction: BlockExtraction; calls: WorkCall[] }
  | { ok: false; error: 'kind_not_extractable' | 'extraction_failed'; calls: WorkCall[] };

export interface ExecutorOptions {
  now?: () => number;
  signal?: AbortSignal;
  /** One JSON line per failed call: op, model and a reason code, never text. */
  log?: (fields: Record<string, unknown>) => void;
}

/** A failed call's reason code: never the error's message, which a provider may build from the input. */
export function failureCode(err: unknown): string {
  if (err instanceof InferenceTimeout) return 'timeout';
  return err instanceof Error ? err.name : 'error';
}

/** One attempt on one op, for `extractBlock` and the evaluation: the call, and the extraction or why there is none. */
export interface BlockAttempt {
  call: WorkCall;
  extraction: BlockExtraction | null;
  failure: ReadFailure | 'call_failed' | null;
}

export async function attemptBlock(
  inference: Inference,
  op: 'work-extract' | 'work-extract-fallback',
  kind: CvBlockKind,
  block: DeidentifiedBlock,
  opts: ExecutorOptions = {},
): Promise<BlockAttempt> {
  const now = opts.now ?? Date.now;
  const model = await inference.model(op);
  const t0 = now();
  let result: unknown;
  try {
    result = await inference.run(op, extractionRequest(model, kind, block), { signal: opts.signal });
  } catch (err) {
    opts.log?.({ event: 'work_extract_failed', op, model, kind, reason: failureCode(err) });
    return { call: { op, model, ok: false, ms: now() - t0, usage: NO_USAGE }, extraction: null, failure: 'call_failed' };
  }
  const read = readExtraction(model, kind, result);
  const call: WorkCall = { op, model, ok: read.ok, ms: now() - t0, usage: usageOf(result) };
  if (!read.ok) {
    opts.log?.({ event: 'work_extract_failed', op, model, kind, reason: read.reason });
    return { call, extraction: null, failure: read.reason };
  }
  const at = now();
  const { fields, violations } = validateFields(kind, block, read.fields, at);
  const fragment = toFragment(kind, block, fields, at);
  return { call, extraction: { kind, schema: CV_SCHEMA, fragment, fields, violations, model, op }, failure: null };
}

/** Extract one block: the primary, then the fallback when the primary throws or answers out of shape. */
export async function extractBlock(inference: Inference, block: DeidentifiedBlock, opts: ExecutorOptions = {}): Promise<ExtractOutcome> {
  const kind = block.kind;
  if (!isCvKind(kind)) return { ok: false, error: 'kind_not_extractable', calls: [] };
  const calls: WorkCall[] = [];
  for (const op of ['work-extract', 'work-extract-fallback'] as const) {
    const attempt = await attemptBlock(inference, op, kind, block, opts);
    calls.push(attempt.call);
    if (attempt.extraction) return { ok: true, extraction: attempt.extraction, calls };
  }
  return { ok: false, error: 'extraction_failed', calls };
}

export type ClassifyOutcome =
  | {
      ok: true;
      /** Null below `DOCUMENT_TYPE_FLOOR`: the phone asks the user. */
      type: DocumentType | null;
      confidence: number;
      probabilities: Partial<Record<DocumentType, number>>;
      /** The extraction schema for the type, or null where the cloud path has none yet. */
      schema: typeof CV_SCHEMA | null;
      model: string;
      calls: WorkCall[];
    }
  | { ok: false; error: 'classification_failed'; calls: WorkCall[] };

/** Name the document type from its de-identified blocks with one Clef call (decision 0021 (d)). */
export async function classifyDocument(inference: Inference, blocks: readonly DeidentifiedBlock[], opts: ExecutorOptions = {}): Promise<ClassifyOutcome> {
  const now = opts.now ?? Date.now;
  const model = await inference.model('work-classify');
  const t0 = now();
  let result: unknown;
  try {
    result = await inference.run('work-classify', clefInput(model, documentState(blocks), documentQuestions()), { signal: opts.signal });
  } catch (err) {
    opts.log?.({ event: 'work_classify_failed', model, reason: failureCode(err) });
    return { ok: false, error: 'classification_failed', calls: [{ op: 'work-classify', model, ok: false, ms: now() - t0, usage: NO_USAGE }] };
  }
  const call: WorkCall = { op: 'work-classify', model, ok: true, ms: now() - t0, usage: { tokensIn: clefInputTokens(result), tokensOut: 0, neurons: null } };
  const reading = readChoice(result, 'document', DOCUMENT_TYPE_KEYS, DOCUMENT_TYPE_FLOOR);
  if (reading.p === 0 && Object.keys(reading.probabilities).length === 0) {
    opts.log?.({ event: 'work_classify_failed', model, reason: 'no_answer' });
    return { ok: false, error: 'classification_failed', calls: [{ ...call, ok: false }] };
  }
  return {
    ok: true,
    type: reading.choice,
    confidence: reading.p,
    probabilities: reading.probabilities,
    schema: reading.choice === 'cv' ? CV_SCHEMA : null,
    model,
    calls: [call],
  };
}
