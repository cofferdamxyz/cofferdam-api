// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A job read into a work profile's shape: the founder's flow of 2026-10-30.
 *
 * A reasoning model (`work-job-profile`) reads what a hirer wrote, one
 * sentence or a pasted vacancy, into what the job asks for, in English (low
 * effort for a short request, reasoning off for a pasted vacancy):
 * - the occupation, as an English job title;
 * - the skills;
 * - the certificates;
 * - the languages;
 * - the years of experience.
 * Each item comes with the words of the request it was read from.
 *
 * The profile is what the job embeds, in place of the request's own text
 * (`profileText`, the shape a worker's listing embeds):
 * - most of a vacancy (the company, the benefits, how to apply) is noise to a
 *   vector;
 * - the reading translates where the context is, so a Mexican "velador" wanted
 *   for a warehouse at night is a security guard before anything is matched.
 *
 * Fail closed:
 * - an item stays only when its source is whole words of the request; the
 *   years only when their source puts that number before a word for years,
 *   a language only when its source names it, a certificate only when its
 *   source carries its codes ("NR-35", however written, "OSHA 30"). The source check proves the words are there,
 *   not that the model read them right: the hirer confirms the profile on the
 *   card (workspace decision 0073);
 * - an answer out of shape is no profile.
 * The street address never reaches this call: the phone takes it out first
 * (workspace decision 0065).
 */

import type { Inference } from '../inference/index.js';
import { fold } from './blocks.js';
import { failureCode } from './executor.js';
import { estimatedUsage, usageOrEstimate, type WorkCall } from './fields.js';
import { languagesNamed } from './cv.js';
import { languageName, regionName, type StringLocale } from './locale.js';
import { resultObject } from './parse.js';

/**
 * The longest request the reading takes. Of 300 real vacancies (the jobs benchmark's sample of 2026-10-27) the
 * median ran 2,000 characters, one in ten over 5,400, and the longest 22,300.
 */
export const MAX_JOB_TEXT = 24_000;
/** At most this many skills are kept, the required ones first. */
export const MAX_PROFILE_SKILLS = 12;
export const MAX_PROFILE_CERTIFICATES = 5;
export const MAX_PROFILE_LANGUAGES = 4;

/** An item of the profile: its English name and the request's own words it was read from. */
export interface ProfileItem {
  en: string;
  source: string;
}

export interface ProfileSkill extends ProfileItem {
  /** The request requires it; false when it only prefers it. */
  required: boolean;
}

export interface JobProfile {
  /** The occupation, as the English job title an employer would post; null when the request names no work. */
  occupation: ProfileItem | null;
  /** What the worker must be able to do, required ones first. */
  skills: ProfileSkill[];
  /** The licences and certifications the job requires, by their usual name ("NR-35", "CDL Class A"). */
  certificates: ProfileItem[];
  /** The languages the worker must speak, as ISO 639-1 codes. */
  languages: { code: string; source: string }[];
  /** The least years of experience the job asks, when it says. */
  experienceYears: { min: number; source: string } | null;
  scope: 'onsite' | 'remote';
}

/** What the reading dropped, for evaluations and the hirer's card: the field, the model's value and why. */
export interface ProfileDrop {
  field: 'occupation' | 'skills' | 'certificates' | 'languages' | 'experienceYears';
  value: string;
  reason: 'not_in_text' | 'invalid' | 'duplicate' | 'over_cap';
}

const ITEM = {
  type: 'object',
  properties: { en: { type: 'string' }, source: { type: 'string' } },
  required: ['en', 'source'],
  additionalProperties: false,
} as const;

/**
 * The answer's schema, strict. No field is optional or nullable, since a
 * strict schema decodes no `anyOf`: an empty `en` is no occupation, and 0
 * years is none stated.
 */
export const JOB_PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    occupation: ITEM,
    skills: {
      type: 'array',
      items: {
        type: 'object',
        properties: { en: { type: 'string' }, source: { type: 'string' }, required: { type: 'boolean' } },
        required: ['en', 'source', 'required'],
        additionalProperties: false,
      },
    },
    certificates: { type: 'array', items: ITEM },
    languages: {
      type: 'array',
      items: { type: 'object', properties: { code: { type: 'string' }, source: { type: 'string' } }, required: ['code', 'source'], additionalProperties: false },
    },
    experienceYears: {
      type: 'object',
      properties: { min: { type: 'integer' }, source: { type: 'string' } },
      required: ['min', 'source'],
      additionalProperties: false,
    },
    scope: { type: 'string', enum: ['onsite', 'remote'] },
  },
  required: ['occupation', 'skills', 'certificates', 'languages', 'experienceYears', 'scope'],
  additionalProperties: false,
} as const;

/** What the model is told. Its one example is no string of the locale fixture, so the evaluations stay fair. */
export const JOB_PROFILE_SYSTEM = [
  'You read a request for work, one sentence or a pasted vacancy, in any language, and write the job as a profile in English: the shape a worker’s profile has, so the job can be matched with workers. You are told the language the request is written in and, when known, the country of the person hiring; read regional words with the meaning they have there ("pedreiro" in Brazil is a bricklayer).',
  '',
  'Fields:',
  '- occupation: the job title an English-speaking employer would post for this work, specific rather than generic ("primary school teacher", not "teacher"), singular, without rank, employer or place; source: the words of the request it is read from. An empty en and source when the request names no work.',
  '- skills: up to 10 things the worker must be able to do, each as a short English skill a CV would list, at most six words ("repair plumbing systems"); source: the words it is read from; required: false when the request only prefers it. Only what the request asks for: never add a skill it does not state.',
  '- certificates: the licences or certifications the request requires, by their usual name ("NR-35", "CDL Class A"), with their source.',
  '- languages: the languages the worker must speak, as ISO 639-1 codes, with their source; not the language the request is written in, unless it asks for it.',
  '- experienceYears: the least years of experience required, with its source; 0 and an empty source when the request does not say.',
  '- scope: remote when the work can be done from anywhere, else onsite.',
  '',
  'Leave out the company, the pay, the benefits, the schedule and how to apply. Copy every source exactly as the request writes it, in its own language.',
].join('\n');

/** Who wrote the request, and in what: `written in Mexican Spanish by someone hiring in Mexico (mx-nle)`. */
export function postedIn(locale: StringLocale): string {
  const market = locale.market && /^[a-z]{2}-[a-z0-9]{1,3}$/.test(locale.market) ? locale.market : null;
  return market ? `written in ${languageName(locale.lang, market)} by someone hiring in ${regionName(market)}` : `written in ${languageName(locale.lang)}`;
}

/** How much a reasoning model reasons before it answers; `none` turns it off. */
export type ProfileEffort = 'none' | 'low' | 'medium' | 'high';

/**
 * A request up to this long reads at low effort, a longer one with reasoning off (`effortFor`). Measured on DeepSeek
 * V4.1 Flash on 2026-10-30 (`cofferdam-api` `test/work-eval/jobs-profile-*`):
 * - a short request has no context but its title: on the locale fixture's 39 regional titles as vacancy headlines,
 *   low effort placed 30 right and none 25 (28 counting three where it named no occupation and none is expected),
 *   at a median 3.5 s against 1.4 s;
 * - a pasted vacancy is its own context: on 300 real ones (a median 2,000 characters), low matched no better (the
 *   judged first five across markets 0.65 at both) at four times the cost and five times the time.
 */
export const SHORT_REQUEST_CHARS = 500;

/** The effort a request reads at: low for a short one, off for a pasted vacancy. */
export function effortFor(text: string): ProfileEffort {
  return text.length <= SHORT_REQUEST_CHARS ? 'low' : 'none';
}

/**
 * Room for the answer after the reasoning: DeepSeek V4.1 Flash at low effort spent a median 2,400 output tokens on 300
 * real vacancies (one in ten over 3,600, the most 5,600), most of them reasoning, and an answer cut at the cap is out
 * of shape (2026-10-30).
 */
const MAX_OUT: Record<ProfileEffort, number> = { none: 1_500, low: 6_000, medium: 10_000, high: 16_000 };

/** The request body on the pinned model: the OpenAI JSON-schema wrapper with reasoning at `effort` (off unless given) on DeepSeek and gpt-oss, else Workers AI's JSON mode. */
export function jobProfileRequest(model: string, text: string, locale: StringLocale, effort: ProfileEffort = 'none'): Record<string, unknown> {
  const messages = [
    { role: 'system', content: JOB_PROFILE_SYSTEM },
    { role: 'user', content: `A request for work ${postedIn(locale)}:\n\n${text}` },
  ];
  const wrapped = { type: 'json_schema', json_schema: { name: 'job_profile', schema: JOB_PROFILE_SCHEMA, strict: true } };
  if (model.startsWith('@cf/deepseek-ai/')) {
    // Without reasoning the reading is an extraction: temperature 0, as the CV parse asks the same model.
    return { messages, response_format: wrapped, reasoning_effort: effort, max_completion_tokens: MAX_OUT[effort], ...(effort === 'none' ? { temperature: 0 } : {}) };
  }
  if (/gpt-oss/.test(model)) {
    // gpt-oss cannot turn its reasoning off: its least is low, with low's room.
    const least = effort === 'none' ? 'low' : effort;
    return { messages, response_format: wrapped, reasoning_effort: least, max_tokens: MAX_OUT[least] };
  }
  return { messages, response_format: { type: 'json_schema', json_schema: JOB_PROFILE_SCHEMA }, temperature: 0, max_tokens: 1_500 };
}

/**
 * A text as the source check reads it: its words, accents and case folded;
 * markdown, punctuation and dashes are no words, and letters and digits are
 * words of their own, so "NR10", "NR-10" and "NR 10" read alike.
 */
export function words(text: string): string[] {
  return fold(text)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Whether the source is whole words of the request, in order. A source the
 * model shortened with an ellipsis ("instalação … de quadros") counts when each
 * piece is, in that order. At least one word must have `minWord` characters
 * (three, unless a certificate's codes vouch for it), so a fragment ("de",
 * "10") never stands for a requirement. `request` is the request's `words`,
 * joined by single spaces.
 */
export function inRequest(source: string, request: string, minWord = 3): boolean {
  const pieces = source
    .split(/…|\.{3}/)
    .map(words)
    .filter((w) => w.length > 0);
  if (!pieces.some((w) => w.some((x) => x.length >= minWord))) return false;
  const haystack = ` ${request} `;
  let from = 0;
  for (const w of pieces) {
    const at = haystack.indexOf(` ${w.join(' ')} `, from);
    if (at < 0) return false;
    from = at + w.join(' ').length + 1;
  }
  return pieces.length > 0;
}

/**
 * Number words to 20 in the three languages, accents folded, for the years a
 * source may write out ("dois anos"). Spanish "once" (11) is left out, as the
 * English word, and Spanish "dos" (2) counts only in a Spanish request: in
 * Portuguese it is "of the" ("ao longo dos anos").
 */
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
  onze: 11, doze: 12, treze: 13, catorze: 14, quatorze: 14, quinze: 15, dezesseis: 16, dezasseis: 16, dezessete: 17, dezassete: 17, dezoito: 18, dezenove: 19, dezanove: 19, vinte: 20,
  un: 1, uno: 1, una: 1, cuatro: 4, siete: 7, ocho: 8, nueve: 9, diez: 10,
  doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
};

/** A number word, in the request's language where a word is a number in one and not another. */
function numberWord(w: string, lang: string | undefined): number | undefined {
  if (w === 'dos') return lang === 'es' ? 2 : undefined;
  return NUMBER_WORDS[w];
}

/** The words for a year, accents folded: Portuguese and Spanish both fold to `ano`. */
const YEAR_WORDS = new Set(['year', 'years', 'yr', 'yrs', 'ano', 'anos']);

/**
 * Whether a source writes the number of years the model read: the number, in
 * digits or in words, within the three words before a word for years ("2
 * años", "dois anos", "3 a 5 años"). A number alone ("10 am", "2 turnos") or an
 * article ("dos equipamentos", "un puesto") never is.
 */
function writesYears(source: string, min: number, lang?: string): boolean {
  const w = words(source);
  return w.some((x, i) => YEAR_WORDS.has(x) && w.slice(Math.max(0, i - 3), i).some((y) => y === String(min) || numberWord(y, lang) === min));
}

/** A source the model shortened with an ellipsis: its pieces may come from places far apart. */
const ELLIPSIS = /…|\.{3}/;

/** The codes of a certificate's English name: each word that holds a digit or is in capitals ("NR-35", "OSHA 30", "CDL Class A"). */
function codesOf(en: string): string[] {
  return en
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => /\d/.test(w) || (w === w.toUpperCase() && /\p{Lu}/u.test(w)))
    .flatMap((w) => words(w));
}

/**
 * Whether a certificate's codes are in its source: every code of its English
 * name must be a word of the source, so "OSHA 30" is never read from
 * "seguridad industrial", and "CDL Class B" never from "Class A CDL".
 */
function carriesCodes(en: string, source: string): boolean {
  const src = new Set(words(source));
  return codesOf(en).every((c) => src.has(c));
}

/** An English name as the profile keeps it: one line, two to 80 characters, at most ten words, a letter in it. */
function englishName(v: unknown, lower: boolean): string | null {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > 80 || s.split(' ').length > 10 || !/\p{L}/u.test(s)) return null;
  return lower ? s.toLowerCase() : s;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Read the model's answer against the request; null when the answer is out of
 * shape (a field missing or of another type, or a scope other than the two).
 * An item stays only when its source is whole words of the request, the years
 * only when their source writes that number, a language only when its source
 * names it, and a certificate only when its source carries its codes.
 */
export function readJobProfile(result: unknown, text: string, lang?: string): { profile: JobProfile; dropped: ProfileDrop[] } | null {
  const obj = resultObject(result);
  if (!obj || !Array.isArray(obj.skills) || !Array.isArray(obj.certificates) || !Array.isArray(obj.languages)) return null;
  if (!isObject(obj.occupation) || !isObject(obj.experienceYears) || (obj.scope !== 'onsite' && obj.scope !== 'remote')) return null;
  const answered = { skills: obj.skills as unknown[], certificates: obj.certificates as unknown[], languages: obj.languages as unknown[] };
  const folded = words(text).join(' ');
  const dropped: ProfileDrop[] = [];
  /** An item read and checked: its name valid and its source in the request; null (and the drop recorded) otherwise. */
  const item = (field: ProfileDrop['field'], raw: unknown, lower: boolean): ProfileItem | null => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const en = englishName(r.en, lower);
    if (!en) {
      if (str(r.en).trim()) dropped.push({ field, value: str(r.en).slice(0, 80), reason: 'invalid' });
      return null;
    }
    // A certificate's code of letters and digits ("NR-35", "6G") stands on its own: the codes then vouch for the source,
    // not its length. A number alone ("Level 2" from "2") never does.
    const codes = codesOf(en);
    const vouched = field === 'certificates' && codes.some((c) => /\d/.test(c)) && codes.some((c) => /\p{L}/u.test(c)) && carriesCodes(en, str(r.source));
    if (!inRequest(str(r.source), folded, vouched ? 1 : 3)) {
      dropped.push({ field, value: en, reason: 'not_in_text' });
      return null;
    }
    return { en, source: str(r.source).trim() };
  };

  const occupation = item('occupation', obj.occupation, true);

  const skills: ProfileSkill[] = [];
  const seen = new Set<string>();
  const read = answered.skills.map((raw) => ({ raw, required: (raw as Record<string, unknown> | null)?.required !== false }));
  // The required ones first, so the cap never keeps a preferred skill over a required one.
  for (const { raw, required } of [...read.filter((x) => x.required), ...read.filter((x) => !x.required)]) {
    const it = item('skills', raw, true);
    if (!it) continue;
    if (seen.has(it.en)) {
      dropped.push({ field: 'skills', value: it.en, reason: 'duplicate' });
      continue;
    }
    seen.add(it.en);
    if (skills.length >= MAX_PROFILE_SKILLS) {
      dropped.push({ field: 'skills', value: it.en, reason: 'over_cap' });
      continue;
    }
    skills.push({ ...it, required });
  }

  const certificates: ProfileItem[] = [];
  for (const raw of answered.certificates) {
    const it = item('certificates', raw, false);
    if (!it) continue;
    // Codes read across an ellipsis may come from two places: a certificate's source is read whole.
    if (ELLIPSIS.test(it.source) || !carriesCodes(it.en, it.source)) dropped.push({ field: 'certificates', value: it.en, reason: 'not_in_text' });
    else if (certificates.some((c) => c.en.toLowerCase() === it.en.toLowerCase())) dropped.push({ field: 'certificates', value: it.en, reason: 'duplicate' });
    else if (certificates.length >= MAX_PROFILE_CERTIFICATES) dropped.push({ field: 'certificates', value: it.en, reason: 'over_cap' });
    else certificates.push(it);
  }

  const languages: JobProfile['languages'] = [];
  for (const raw of answered.languages) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const code = str(r.code).trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(code)) {
      dropped.push({ field: 'languages', value: code.slice(0, 20), reason: 'invalid' });
      continue;
    }
    if (!inRequest(str(r.source), folded) || !languagesNamed(str(r.source)).has(code)) dropped.push({ field: 'languages', value: code, reason: 'not_in_text' });
    else if (languages.some((l) => l.code === code)) dropped.push({ field: 'languages', value: code, reason: 'duplicate' });
    else if (languages.length >= MAX_PROFILE_LANGUAGES) dropped.push({ field: 'languages', value: code, reason: 'over_cap' });
    else languages.push({ code, source: str(r.source).trim() });
  }

  let experienceYears: JobProfile['experienceYears'] = null;
  const ey = obj.experienceYears;
  const min = Number(ey.min);
  if (Number.isInteger(min) && min > 0) {
    if (min > 50) dropped.push({ field: 'experienceYears', value: String(min), reason: 'invalid' });
    else if (ELLIPSIS.test(str(ey.source)) || !inRequest(str(ey.source), folded) || !writesYears(str(ey.source), min, lang)) dropped.push({ field: 'experienceYears', value: String(min), reason: 'not_in_text' });
    else experienceYears = { min, source: str(ey.source).trim() };
  }

  return { profile: { occupation, skills, certificates, languages, experienceYears, scope: obj.scope as JobProfile['scope'] }, dropped };
}

/**
 * The text a job embeds: its occupation, its skills and its certificates, in
 * English, in the shape a worker's listing embeds (`listingText`), so the
 * two compare like with like. Languages and years are not in it: the gate
 * and the decision read them.
 */
export function profileText(p: Pick<JobProfile, 'occupation' | 'skills' | 'certificates'>): string {
  return [p.occupation ? p.occupation.en : '', p.skills.map((s) => s.en).join('; '), p.certificates.map((c) => c.en).join('; ')].filter(Boolean).join('. ');
}

export type JobReading = { ok: true; profile: JobProfile; dropped: ProfileDrop[]; calls: WorkCall[] } | { ok: false; error: 'profile_failed' | 'text_too_long'; calls: WorkCall[] };

/**
 * One call on `work-job-profile`, at `effortFor` the request's length unless
 * `effort` is given, metered like every Work call: as it answered, or at its
 * estimated input when it threw or reported nothing.
 * The text must already be what may leave the phone (the privacy gate and
 * the plane's tripwire have run).
 */
export async function readJob(
  inference: Inference,
  text: string,
  locale: StringLocale,
  opts: { now?: () => number; log?: (fields: Record<string, unknown>) => void; signal?: AbortSignal; effort?: ProfileEffort } = {},
): Promise<JobReading> {
  if (text.length > MAX_JOB_TEXT) return { ok: false, error: 'text_too_long', calls: [] };
  const now = opts.now ?? Date.now;
  const model = await inference.model('work-job-profile');
  const req = jobProfileRequest(model, text, locale, opts.effort ?? effortFor(text));
  const t0 = now();
  let result: unknown;
  try {
    result = await inference.run('work-job-profile', req, opts.signal ? { signal: opts.signal } : {});
  } catch (err) {
    opts.log?.({ event: 'work_job_profile_failed', model, reason: failureCode(err) });
    return { ok: false, error: 'profile_failed', calls: [{ op: 'work-job-profile', model, ok: false, ms: now() - t0, usage: estimatedUsage(req) }] };
  }
  const read = readJobProfile(result, text, locale.lang);
  const call: WorkCall = { op: 'work-job-profile', model, ok: read !== null, ms: now() - t0, usage: usageOrEstimate(result, req) };
  if (!read) {
    opts.log?.({ event: 'work_job_profile_failed', model, reason: 'out_of_shape' });
    return { ok: false, error: 'profile_failed', calls: [call] };
  }
  return { ok: true, ...read, calls: [call] };
}
