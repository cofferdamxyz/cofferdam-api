// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The whole-CV parse (workspace decision 0021, ruled by the founder on
 * 2026-10-28; `docs/product/engine.md`, Whole-document parse): one hosted
 * call reads a CV into the identity and the `claimed` section of a
 * `cofferdam.cv.v1`, and the plane keeps nothing of the request or the answer.
 *
 * `POST /v1/work/parse` (`routes/work.ts`) serves it on the CV's text only:
 * the PDF's text layer, else the phone's text recognition, after the phone's
 * identity strip (every email and, for an account bound to a passport, the
 * holder's name and birth date become placeholders; the founder's ruling of
 * 2026-10-30). `parseCv` is the route's call, on `work-parse` (DeepSeek V4.1
 * Flash, the founder's pin of 2026-10-28) through the documents AI Gateway,
 * which cannot store; it hands its calls to the meter and logs reason codes,
 * never text. The route never builds the image input, so no page image
 * reaches a hosted model; the image input stays for the benchmarks
 * (`test/workParse.eval.test.ts`, `test/workResume.eval.test.ts`), which
 * compare it with the text.
 *
 * The request follows the model's family: Workers AI's own JSON mode for
 * llama, the OpenAI JSON-schema wrapper with thinking off for the rest. An
 * image goes as an OpenAI content part with a data URI. The reader fails
 * closed on shape and drops, never repairs, a value it cannot read (a date
 * `parseCvDate` refuses, a level outside the three, a number out of range).
 */

import { thinkingOff } from '../chat/run.js';
import { InferenceTimeout, OPS, type Inference } from '../inference/index.js';
import { dedupeClaims, languageCode, parseCvDate, type CvClaim, type CvClaimed, type CvDate, type CvLanguage } from './cv.js';
import { failureCode } from './executor.js';
import { estimatedUsage, usageOrEstimate, type WorkCall } from './fields.js';

export interface ParsePage {
  mime: 'image/png' | 'image/jpeg';
  base64: string;
}

/** Pages a single parse reads; a longer CV is more than a parse can take. */
export const MAX_PAGES = 4;

export type ParseInput =
  /** The CV's pages in order, one image each. */
  | { kind: 'image'; pages: ParsePage[] }
  /** OCR lines in the order the phone read them, pages one after another. */
  | { kind: 'text'; text: string };

/** Who the CV is about. Returned to the phone only; never stored or logged by the plane. */
export interface ParsedIdentity {
  name: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
}

export interface ParsedCertificate extends CvClaim {
  /** `YYYY-MM` or `YYYY`, when the CV gives a validity date. */
  expires: CvDate | null;
}

/**
 * The parse result. Unlike the block path, employer, institution and
 * location are the CV's own words, not placeholders: the whole document
 * went to the model, so there is nothing to re-identify.
 */
export interface ParsedCv {
  identity: ParsedIdentity;
  claimed: Omit<CvClaimed, 'certificates'> & { certificates: ParsedCertificate[] };
  /** Values the reader dropped, by path, for the report. */
  dropped: { path: string; reason: string }[];
}

const str = { type: ['string', 'null'] };
const strList = (maxItems: number) => ({ type: 'array', items: { type: 'string' }, maxItems });
const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** The JSON Schema the model is held to. Dates are written as the CV writes them; the reader parses them. */
export const PARSE_JSON_SCHEMA = obj({
  name: str,
  email: str,
  phone: str,
  location: str,
  headline_title: str,
  years_experience: { type: ['integer', 'null'], minimum: 0, maximum: 60 },
  experience: {
    type: 'array',
    maxItems: 20,
    items: obj({ title: str, employer: str, location: str, start: str, end: str, current: { type: 'boolean' }, skills: strList(15) }),
  },
  education: { type: 'array', maxItems: 10, items: obj({ qualification: str, institution: str, end: str }) },
  skills: strList(40),
  certificates: { type: 'array', maxItems: 30, items: obj({ name: str, expires: str }) },
  languages: { type: 'array', maxItems: 10, items: obj({ name: str, level: { type: 'string', enum: ['fluent', 'intermediate', 'basic'] } }) },
});

export const PARSE_SYSTEM = [
  'You read one CV (résumé) and fill the JSON fields from it. The CV may be in Portuguese, Spanish or English; keep every value in the words and language the CV uses, never translate.',
  'The CV may have columns or a sidebar: read each column as its own text, and never attach a line from one column to an entry in another.',
  'Fields:',
  "- name: the person's own name, as written; null when the CV shows none, since a job title or a heading is not a name. email, phone: as written. location: where the person lives (city, region), as written.",
  '- headline_title: the occupation the CV gives the person at the top or in its summary. years_experience: the total years of experience the CV states, else null.',
  '- experience: one item per job, most recent first. A job is a position held at one employer for a period: its duties, bullets, projects and headings belong to it and are never items of their own, and each job is listed once. title: the job title only, without the employer, the place or the dates; employer: the company; location: where, if the entry says; start and end: as the CV writes them (a year, or a month and year); end is null and current is true when the job continues ("atual", "actualidad", "present"); skills: tools or skills the entry itself names.',
  '- education: one item per qualification: the qualification, the institution (its name only, without its city, state or program), and the year it ended.',
  '- skills: the skills the CV lists outside its jobs, one per item, without bullets.',
  '- certificates: one item per certificate or licence, name as written without its validity, and expires as written (a date), else null.',
  '- languages: only the languages the CV names as ones the person speaks, one item per language: its name without the level, and its level, one of three: fluent for native, fluent or advanced (nativo, fluente, avançado; nativo, fluido, avanzado; a mother tongue), intermediate for intermediate (intermediário; intermedio), basic for basic or beginner (básico, iniciante; básico, principiante); a CEFR level counts A1 and A2 as basic, B1 and B2 as intermediate, C1 and C2 as fluent. The language the CV is written in is not one unless the CV names it.',
  'Use null or an empty list for anything the CV does not state. Never invent a value.',
].join('\n');

/**
 * Workers AI's own JSON mode for llama; every other candidate takes the
 * OpenAI JSON-schema wrapper and a thinking switch. This differs from
 * `extractorFamily` in `fields.ts`, which knows only the block path's three
 * models; the benchmark says whether the guess holds for the vision models.
 */
const isLlama = (model: string) => model.startsWith('@cf/meta/');

/** The answer's cap the benchmarks measured; the route raises it for long CVs (`PARSE_MAX_TOKENS`). */
export const BENCH_MAX_TOKENS = 2_500;

/**
 * The request body for `model`. The CV is the only user content, with no id of any kind. `maxTokens` caps the answer
 * only: an answer that fits under the lower cap is the same under a higher one.
 */
export function parseRequest(model: string, input: ParseInput, opts: { maxTokens?: number } = {}): Record<string, unknown> {
  const max_tokens = opts.maxTokens ?? BENCH_MAX_TOKENS;
  if (input.kind === 'image' && (input.pages.length < 1 || input.pages.length > MAX_PAGES)) {
    throw new RangeError(`a parse reads 1 to ${MAX_PAGES} pages, not ${input.pages.length}`);
  }
  const user =
    input.kind === 'image'
      ? [
          { type: 'text', text: input.pages.length === 1 ? 'The CV is the attached page image.' : `The CV is the ${input.pages.length} attached page images, in order.` },
          ...input.pages.map((p) => ({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.base64}` } })),
        ]
      : `The CV, as OCR lines:\n\n${input.text}`;
  const messages = [
    { role: 'system', content: PARSE_SYSTEM },
    { role: 'user', content: user },
  ];
  if (isLlama(model)) {
    return { messages, response_format: { type: 'json_schema', json_schema: PARSE_JSON_SCHEMA }, temperature: 0, max_tokens };
  }
  return {
    messages,
    response_format: { type: 'json_schema', json_schema: { name: 'cofferdam_cv_parse', schema: PARSE_JSON_SCHEMA, strict: true } },
    temperature: 0,
    max_tokens,
    ...thinkingOff(model),
  };
}

// ── Reading the answer ──────────────────────────────────────────────────────

/** The JSON object a result carries, in any of Workers AI's shapes, or null. */
export function resultObject(result: unknown): Record<string, unknown> | null {
  const r = (result ?? {}) as { choices?: { message?: { content?: unknown } }[]; response?: unknown };
  let v: unknown = r.choices?.[0]?.message?.content ?? r.response;
  if (typeof v === 'string') {
    const t = v.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try {
      v = JSON.parse(t);
    } catch {
      return null;
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const MAX_TEXT = 300;

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const isObject = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object' && !Array.isArray(v);

/** Years a validity date may run ahead; a licence rarely runs past ten. */
const EXPIRY_YEARS_AHEAD = 15;

/**
 * A certificate's validity date as `YYYY-MM` (or `YYYY`): the CV date forms,
 * plus a full day, which keeps its month, and years up to fifteen ahead. A
 * day written with slashes is read day first (`15/03/2027`, the pt and es
 * order) unless its first number cannot be a month and its second can only
 * be a day (`11/30/2026`, the US order); `03/04/2027` is read as April. Null
 * for anything else.
 */
export function expiryDate(span: string, now = Date.now()): CvDate | null {
  const t = span.trim();
  const maxYear = new Date(now + EXPIRY_YEARS_AHEAD * 365.25 * 86_400_000).getUTCFullYear();
  const ym = (y: number, mo: number) => (y >= 1950 && y <= maxYear && mo >= 1 && mo <= 12 ? `${y}-${String(mo).padStart(2, '0')}` : null);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (iso) return ym(Number(iso[1]), Number(iso[2]));
  const slash = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    return ym(Number(slash[3]), b > 12 && a <= 12 ? a : b);
  }
  // parseCvDate allows one year past the clock it is given, so it gets the ceiling's year minus one.
  const d = parseCvDate(t, Date.UTC(maxYear - 1, 0, 1));
  return d && !d.present ? d.date : null;
}

export class ParseShapeError extends Error {
  constructor(readonly reason: string) {
    super(`parse answer out of shape: ${reason}`);
    this.name = 'ParseShapeError';
  }
}

/**
 * The model's answer as a `ParsedCv`. Throws `ParseShapeError` when the answer
 * is not the schema's object; drops single values it cannot read and records
 * each in `dropped`, and drops a job or qualification that holds nothing.
 */
export function readParse(result: unknown, now = Date.now()): ParsedCv {
  const o = resultObject(result);
  if (!o) throw new ParseShapeError('no JSON object');
  for (const k of ['experience', 'education', 'skills', 'certificates', 'languages']) {
    if (o[k] != null && !Array.isArray(o[k])) throw new ParseShapeError(`${k} is not a list`);
  }
  const dropped: ParsedCv['dropped'] = [];
  /** A value as text, or null; a string too long to be a field is recorded. A literal "null" or "none" is a null, not a drop. */
  const text = (path: string, v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.replace(/\s+/g, ' ').trim();
    if (!t || /^(null|n\/a|none)$/i.test(t)) return null;
    if (t.length > MAX_TEXT) {
      dropped.push({ path, reason: 'length' });
      return null;
    }
    return t;
  };
  const claims = (path: string, v: unknown): CvClaim[] =>
    dedupeClaims(
      arr(v).flatMap((x, i) => {
        const t = text(`${path}.${i}`, x)?.replace(/^[•·\-–*]\s*/, '');
        return t ? [{ raw: t }] : [];
      }),
    );
  const date = (path: string, v: unknown): { date: CvDate | null; present: boolean } => {
    const t = text(path, v);
    if (t == null) return { date: null, present: false };
    const d = parseCvDate(t, now);
    if (!d) {
      dropped.push({ path, reason: 'date' });
      return { date: null, present: false };
    }
    return d.present ? { date: null, present: true } : { date: d.date, present: false };
  };
  const entries = (key: string, v: unknown) =>
    arr(v).flatMap((raw, i) => {
      if (!isObject(raw)) {
        dropped.push({ path: `${key}.${i}`, reason: 'shape' });
        return [];
      }
      return [{ e: raw, i }];
    });

  let years: number | null = null;
  if (o.years_experience != null) {
    const n = Number(o.years_experience);
    if (Number.isInteger(n) && n >= 0 && n <= 60) years = n;
    else dropped.push({ path: 'years_experience', reason: 'range' });
  }
  const headlineTitle = text('headline_title', o.headline_title);

  const experience = entries('experience', o.experience).flatMap(({ e, i }) => {
    const p = `experience.${i}`;
    const start = date(`${p}.start`, e.start);
    const end = date(`${p}.end`, e.end);
    const current = e.current === true || end.present;
    const title = text(`${p}.title`, e.title);
    const employer = text(`${p}.employer`, e.employer);
    if (!title && !employer && !start.date) {
      dropped.push({ path: p, reason: 'empty' });
      return [];
    }
    return [
      {
        title: title ? { raw: title, rank: null } : null,
        employer,
        location: text(`${p}.location`, e.location),
        start: start.date,
        end: current ? null : end.date,
        current,
        skills: claims(`${p}.skills`, e.skills),
      },
    ];
  });

  const education = entries('education', o.education).flatMap(({ e, i }) => {
    const p = `education.${i}`;
    const qualification = text(`${p}.qualification`, e.qualification);
    const institution = text(`${p}.institution`, e.institution);
    if (!qualification && !institution) {
      dropped.push({ path: p, reason: 'empty' });
      return [];
    }
    return [{ qualification, institution, end: date(`${p}.end`, e.end).date }];
  });

  const certificates = dedupeClaims(
    entries('certificates', o.certificates).flatMap(({ e, i }) => {
      const p = `certificates.${i}`;
      const name = text(`${p}.name`, e.name);
      if (!name) return [];
      const t = text(`${p}.expires`, e.expires);
      const expires = t == null ? null : expiryDate(t, now);
      if (t != null && expires == null) dropped.push({ path: `${p}.expires`, reason: 'date' });
      return [{ raw: name, expires }];
    }),
  );

  const languages: CvLanguage[] = entries('languages', o.languages).flatMap(({ e, i }) => {
    const name = text(`languages.${i}.name`, e.name);
    if (!name) return [];
    if (e.level !== 'fluent' && e.level !== 'intermediate' && e.level !== 'basic') {
      dropped.push({ path: `languages.${i}.level`, reason: 'level' });
      return [];
    }
    return [{ raw: name, code: languageCode(name), level: e.level }];
  });

  const skills = claims('skills', o.skills);

  return {
    identity: { name: text('name', o.name), email: text('email', o.email), phone: text('phone', o.phone), location: text('location', o.location) },
    claimed: {
      headline: { title: headlineTitle ? { raw: headlineTitle, rank: null } : null, years },
      experience,
      education,
      skills,
      certificates,
      languages,
    },
    dropped,
  };
}

// ── The route's call ────────────────────────────────────────────────────────

/** The longest CV text the route takes, in characters: about 10,000 tokens, several dense pages. */
export const MAX_PARSE_TEXT = 40_000;

/**
 * The route's answer cap: the schema's lists at their limits (20 jobs of 15 skills, 40 skills, 30 certificates) take
 * about 6,000 tokens, where the benchmarks' 2,500 would cut a long CV's answer and fail it twice. DeepSeek V4.1 Flash
 * wrote 400 to 550 tokens for each synthetic CV.
 */
export const PARSE_MAX_TOKENS = 6_000;

/** The keys a parse request may carry. Any other, a page image above all, is refused. */
const PARSE_BODY_KEYS: ReadonlySet<string> = new Set(['account', 'text']);

export type ParseBodyRead =
  | { ok: true; text: string }
  | { ok: false; status: 400; error: 'bad_request'; message: string }
  | { ok: false; status: 413; error: 'text_too_long'; max: number };

/**
 * The route's check of a parse request, beside the account the Work gate
 * reads: the CV's text and nothing else. A refusal never echoes the body. The
 * text is not trimmed or rewritten: the model reads what the phone sent.
 */
export function readParseBody(b: Record<string, unknown>): ParseBodyRead {
  if (Object.keys(b).some((k) => !PARSE_BODY_KEYS.has(k))) {
    return { ok: false, status: 400, error: 'bad_request', message: "the body takes the account and the CV's text only" };
  }
  if (typeof b.text !== 'string' || !b.text.trim()) {
    return { ok: false, status: 400, error: 'bad_request', message: "text must be the CV's text" };
  }
  if (b.text.length > MAX_PARSE_TEXT) return { ok: false, status: 413, error: 'text_too_long', max: MAX_PARSE_TEXT };
  return { ok: true, text: b.text };
}

/**
 * The placeholders the phone's identity strip writes (`test/work-eval/identityStrip.ts`, its constants;
 * `test/workParseRoute.test.ts` holds the two together until the strip is ported to the app).
 */
const STRIP_PLACEHOLDER = /\[(?:EMAIL_\d+|PERSON_\d+|BIRTH_DATE)\]/;

/** Whether an answer stopped at its token cap: a retry would stop there too. */
function cutAtCap(result: unknown): boolean {
  const r = (result ?? {}) as { choices?: { finish_reason?: unknown }[] };
  return r.choices?.[0]?.finish_reason === 'length';
}

/**
 * The parse with every identity value that holds one of the strip's
 * placeholders dropped and recorded (`placeholder`): DeepSeek copies
 * `[EMAIL_1]` into the email on most stripped CVs (decision 0021, measured
 * 2026-10-30), and the phone fills the email, and a bound account's name,
 * from what its strip removed. The benchmarks read `readParse` without it,
 * so they still count the copies.
 */
export function withoutPlaceholders(parsed: ParsedCv): ParsedCv {
  const identity = { ...parsed.identity };
  const dropped = [...parsed.dropped];
  for (const key of ['name', 'email', 'phone', 'location'] as const) {
    const v = identity[key];
    if (v != null && STRIP_PLACEHOLDER.test(v)) {
      identity[key] = null;
      dropped.push({ path: key, reason: 'placeholder' });
    }
  }
  return { ...parsed, identity, dropped };
}

/** Why a parse failed: the call ran out of time, threw, or answered no object of the schema's shape. */
export type ParseFailure = 'timeout' | 'call_failed' | 'shape';

export type ParseOutcome =
  | { ok: true; parsed: ParsedCv; model: string; calls: WorkCall[] }
  | { ok: false; reason: ParseFailure; model: string; calls: WorkCall[] };

/** A parse answers within this, a retry included, so the phone can wait a fixed time; the gate's checks come before it. */
export const PARSE_BUDGET_MS = 70_000;
/** A retry runs only with this much of the budget left. */
export const PARSE_RETRY_MIN_MS = 15_000;

export interface ParseOptions {
  now?: () => number;
  signal?: AbortSignal;
  /** One JSON line per failed attempt: op, model, attempt and a reason code, never text. */
  log?: (fields: Record<string, unknown>) => void;
}

/**
 * Reads a CV's text on `work-parse`. One call, and a second only when the
 * first throws (not a timeout) or answers out of shape (not cut at its cap),
 * with enough of `PARSE_BUDGET_MS` left: on the real resumes DeepSeek answered
 * about one CV in a hundred with no JSON object and read it at the retry
 * (decision 0021, 2026-10-29 and 2026-10-30). Every call is returned for the
 * meter, a call that threw at its estimated input. A failure is logged by its
 * code, never by its message, which a provider may build from the input.
 */
export async function parseCv(inference: Inference, text: string, opts: ParseOptions = {}): Promise<ParseOutcome> {
  const now = opts.now ?? Date.now;
  const model = await inference.model('work-parse');
  const request = parseRequest(model, { kind: 'text', text }, { maxTokens: PARSE_MAX_TOKENS });
  const started = now();
  const calls: WorkCall[] = [];
  let reason: ParseFailure = 'call_failed';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const left = PARSE_BUDGET_MS - (now() - started);
    if (attempt > 1 && (reason === 'timeout' || left < PARSE_RETRY_MIN_MS)) break;
    const t0 = now();
    let result: unknown;
    try {
      result = await inference.run('work-parse', request, { signal: opts.signal, timeoutMs: Math.min(OPS['work-parse'].timeoutMs, left) });
    } catch (err) {
      reason = err instanceof InferenceTimeout ? 'timeout' : 'call_failed';
      calls.push({ op: 'work-parse', model, ok: false, ms: now() - t0, usage: estimatedUsage(request) });
      opts.log?.({ event: 'work_parse_failed', op: 'work-parse', model, attempt, reason: failureCode(err) });
      continue;
    }
    const usage = usageOrEstimate(result, request);
    try {
      const parsed = readParse(result, now());
      calls.push({ op: 'work-parse', model, ok: true, ms: now() - t0, usage });
      return { ok: true, parsed, model, calls };
    } catch (err) {
      reason = 'shape';
      calls.push({ op: 'work-parse', model, ok: false, ms: now() - t0, usage });
      const cut = cutAtCap(result);
      opts.log?.({ event: 'work_parse_failed', op: 'work-parse', model, attempt, reason: cut ? 'cut' : err instanceof ParseShapeError ? 'shape' : failureCode(err) });
      if (cut) break;
    }
  }
  return { ok: false, reason, model, calls };
}
