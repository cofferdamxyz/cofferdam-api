// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The whole-CV parse under evaluation (workspace `docs/product/engine.md`,
 * "Whole-document parse (under evaluation)"): one hosted call reads a CV,
 * as a page image or as the phone's OCR text, into the identity and the
 * `claimed` section of a `cofferdam.cv.v1`, and the plane keeps nothing.
 *
 * NOT ROUTED. Decision 0021 forbids any image or raw OCR text reaching a
 * hosted model; this module exists so `test/workParse.eval.test.ts` can
 * measure the alternative the founder asked for on 2026-10-27, on synthetic
 * CVs only. A route (`POST /v1/work/parse`) waits on the decision 0021
 * amendment.
 *
 * The request follows the model's family: Workers AI's own JSON mode for
 * llama, the OpenAI JSON-schema wrapper with thinking off for the rest. An
 * image goes as an OpenAI content part with a data URI. The reader fails
 * closed on shape and drops, never repairs, a value it cannot read (a date
 * `parseCvDate` refuses, a level outside the two, a number out of range).
 */

import { thinkingOff } from '../chat/run.js';
import { dedupeClaims, languageCode, parseCvDate, type CvClaim, type CvClaimed, type CvDate, type CvLanguage } from './cv.js';

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
  languages: { type: 'array', maxItems: 10, items: obj({ name: str, level: { type: 'string', enum: ['fluent', 'basic'] } }) },
});

export const PARSE_SYSTEM = [
  'You read one CV (résumé) and fill the JSON fields from it. The CV may be in Portuguese, Spanish or English; keep every value in the words and language the CV uses, never translate.',
  'The CV may have columns or a sidebar: read each column as its own text, and never attach a line from one column to an entry in another.',
  'Fields:',
  '- name: the person the CV is about, as written. email, phone: as written. location: where the person lives (city, region), as written.',
  '- headline_title: the occupation the CV gives the person at the top or in its summary. years_experience: the total years of experience the CV states, else null.',
  '- experience: one item per job, most recent first. title: the job title only, without the employer, the place or the dates; employer: the company; location: where, if the entry says; start and end: as the CV writes them (a year, or a month and year); end is null and current is true when the job continues ("atual", "actualidad", "present"); skills: tools or skills the entry itself names.',
  '- education: one item per qualification: the qualification, the institution (its name only, without its city, state or program), and the year it ended.',
  '- skills: the skills the CV lists outside its jobs, one per item, without bullets.',
  '- certificates: one item per certificate or licence, name as written without its validity, and expires as written (a date), else null.',
  '- languages: one item per language, its name without the level, and level fluent for native, fluent or advanced, basic for basic or intermediate.',
  'Use null or an empty list for anything the CV does not state. Never invent a value.',
].join('\n');

/**
 * Workers AI's own JSON mode for llama; every other candidate takes the
 * OpenAI JSON-schema wrapper and a thinking switch. This differs from
 * `extractorFamily` in `fields.ts`, which knows only the block path's three
 * models; the benchmark says whether the guess holds for the vision models.
 */
const isLlama = (model: string) => model.startsWith('@cf/meta/');

/** The request body for `model`. The CV is the only user content, with no id of any kind. */
export function parseRequest(model: string, input: ParseInput): Record<string, unknown> {
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
    return { messages, response_format: { type: 'json_schema', json_schema: PARSE_JSON_SCHEMA }, temperature: 0, max_tokens: 2_500 };
  }
  return {
    messages,
    response_format: { type: 'json_schema', json_schema: { name: 'cofferdam_cv_parse', schema: PARSE_JSON_SCHEMA, strict: true } },
    temperature: 0,
    max_tokens: 2_500,
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
    if (e.level !== 'fluent' && e.level !== 'basic') {
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
