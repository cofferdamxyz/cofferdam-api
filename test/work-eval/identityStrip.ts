// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The identity strip of the whole-CV parse (workspace decision 0021, the founder's ruling of 2026-10-30).
 *
 * Before a CV's text leaves the phone for Cofferdam Cloud, the phone removes:
 * - the holder's name and birth date as their passport gives them, when the account is bound to one. A worker whose
 *   account is not bound is never asked to bind it to have a CV read: their name stays in the text, and DeepSeek V4.1
 *   Flash reads it with the rest of the identity;
 * - every email address.
 * Phone numbers stay: their formats differ by country, and neither the embeddings nor Workers AI keep them.
 *
 * Pure and model-free, so the phone runs it on every CV. Written beside the real-resume benchmark that measures it
 * (`RESUME_STRIP`), to be ported to cofferdam-app with its tests (`test/workIdentityStrip.test.ts`).
 */

/** What the app keeps of a bound passport (cofferdam-app `VerifiedIdentity`): the MRZ's names title-cased, the birth date. */
export interface HolderIdentity {
  firstName: string | null;
  lastName: string | null;
  fullName?: string | null;
  /** `YYYY-MM-DD`, as the app writes the MRZ's date. */
  dateOfBirth: string | null;
}

export type StripKind = 'name' | 'birthDate' | 'email';

export interface StripRemoval {
  kind: StripKind;
  /** The text removed, as the CV wrote it: what the worker is shown as staying on the phone. */
  text: string;
  start: number;
  end: number;
  placeholder: string;
}

export interface StripResult {
  /** The text that may leave the phone. */
  text: string;
  /** What was removed, in the order of the text. */
  removed: StripRemoval[];
}

export const NAME_PLACEHOLDER = '[PERSON_1]';
export const BIRTH_DATE_PLACEHOLDER = '[BIRTH_DATE]';
export const emailPlaceholder = (n: number): string => `[EMAIL_${n}]`;

/** Accents off and lower case, as the MRZ writes "JOAO" for João (ICAO 9303). */
export function foldName(s: string): string {
  return s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** The MRZ's spelling of the letters ICAO 9303 writes out: Ä as AE, Ö as OE, Ü as UE, ß as SS, Å as AA, Ø as OE, Æ as AE. */
function icaoFold(s: string): string {
  return foldName(
    s
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .replace(/å/g, 'aa')
      .replace(/ø/g, 'oe')
      .replace(/æ/g, 'ae'),
  );
}

/** The joining words of names. A name's own may sit between its parts, but never stand for it. */
export const NAME_PARTICLES: ReadonlySet<string> = new Set(['de', 'da', 'do', 'das', 'dos', 'del', 'la', 'las', 'los', 'le', 'y', 'e', 'van', 'von', 'der', 'den', 'di', 'du']);
const PARTICLES = NAME_PARTICLES;

/** Between two parts of one name: spaces, at most one comma, period or hyphen, and at most one line break. */
const NAME_GAP = /^[ \t]*[,.\-‐–]?[ \t]*(?:\r?\n[ \t]*)?$/;

interface NameParts {
  /** The name's words of two letters or more, particles left out, folded. */
  strong: Set<string>;
  /** Their first letters, for "J. García". */
  initials: Set<string>;
  /** The particles the name itself carries ("de la" in "de la Cruz"). */
  particles: Set<string>;
}

function nameParts(holder: HolderIdentity): NameParts | null {
  const raw = [holder.firstName, holder.lastName].filter((x): x is string => !!x?.trim()).join(' ') || holder.fullName || '';
  const words = raw.split(/[^\p{L}]+/u).map(foldName).filter(Boolean);
  const strong = new Set(words.filter((w) => w.length >= 2 && !PARTICLES.has(w)));
  if (!strong.size) return null;
  return { strong, initials: new Set([...strong].map((w) => w[0]!)), particles: new Set(words.filter((w) => PARTICLES.has(w))) };
}

/**
 * Where the holder's name is written: a run of the name's own words, in any order, case or accents ("José García",
 * "GARCIA, JOSE", "J. García Pérez"), with two of its words, or one beside an initial. A word of the name alone ("Cook"
 * in "Line Cook") is not the name and stays.
 */
function nameSpans(text: string, parts: NameParts): [number, number][] {
  const spans: [number, number][] = [];
  const run: { start: number; end: number; kind: 'strong' | 'initial' | 'particle' }[] = [];
  const close = () => {
    let a = 0;
    let b = run.length;
    while (a < b && run[a]!.kind === 'particle') a++;
    while (b > a && run[b - 1]!.kind === 'particle') b--;
    const words = run.slice(a, b);
    const strong = words.filter((w) => w.kind === 'strong').length;
    const initials = words.filter((w) => w.kind === 'initial').length;
    if (strong >= 2 || (strong >= 1 && initials >= 1)) {
      const last = words[words.length - 1]!;
      spans.push([words[0]!.start, last.kind === 'initial' && text[last.end] === '.' ? last.end + 1 : last.end]);
    }
    run.length = 0;
  };
  for (const m of text.matchAll(/\p{L}+/gu)) {
    const word = m[0];
    const start = m.index;
    const folded = foldName(word);
    const kind =
      parts.strong.has(folded) || parts.strong.has(icaoFold(word))
        ? 'strong'
        : word.length === 1 && word !== word.toLowerCase() && parts.initials.has(folded)
          ? 'initial'
          : parts.particles.has(folded)
            ? 'particle'
            : null;
    if (!kind) {
      close();
      continue;
    }
    const prev = run[run.length - 1];
    if (prev && !NAME_GAP.test(text.slice(prev.end, start))) close();
    run.push({ start, end: start + word.length, kind });
  }
  close();
  return spans;
}

const MONTH_WORDS: [RegExp, number][] = [
  [/^(jan|january|ene|enero|janeiro)$/, 1],
  [/^(feb|february|febrero|fev|fevereiro)$/, 2],
  [/^(mar|march|marzo|marco)$/, 3],
  [/^(apr|april|abr|abril)$/, 4],
  [/^(may|mayo|mai|maio)$/, 5],
  [/^(jun|june|junio|junho)$/, 6],
  [/^(jul|july|julio|julho)$/, 7],
  [/^(aug|august|ago|agosto)$/, 8],
  [/^(sep|sept|september|septiembre|setiembre|set|setembro)$/, 9],
  [/^(oct|october|octubre|out|outubro)$/, 10],
  [/^(nov|november|noviembre|novembro)$/, 11],
  [/^(dec|december|dic|diciembre|dez|dezembro)$/, 12],
];

/** A month's name in English, Spanish or Portuguese, full or short, as its number. */
export function monthOf(word: string): number | null {
  const folded = foldName(word);
  for (const [re, month] of MONTH_WORDS) if (re.test(folded)) return month;
  return null;
}

interface Day {
  y: number;
  m: number;
  d: number;
}

/**
 * The passport's birth date. The app reads the MRZ's two-digit year as 19xx only above 50, so a worker born in 1950 or
 * before would be born in the future: a year after this one is taken a century back.
 */
export function birthDateOf(iso: string | null | undefined, thisYear = new Date().getUTCFullYear()): Day | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso?.trim() ?? '');
  if (!m) return null;
  let y = Number(m[1]);
  const month = Number(m[2]);
  const d = Number(m[3]);
  if (month < 1 || month > 12 || d < 1 || d > 31) return null;
  if (y > thisYear) y -= 100;
  return { y, m: month, d };
}

const NUMERIC_DATE = /(?<!\d)(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})(?!\d)/g;
const YEAR_FIRST_DATE = /(?<!\d)(\d{4})([./-])(\d{1,2})\2(\d{1,2})(?!\d)/g;
const DAY_MONTH_YEAR = /(?<!\d)(\d{1,2})(?:st|nd|rd|th|º|°)?(?:\s+de\s+|[ \t]*[-./ ][ \t]*)(\p{L}{3,10})\.?(?:\s+de\s+|[ \t]*[-./, ][ \t]*)(\d{4})(?!\d)/giu;
const MONTH_DAY_YEAR = /(?<!\p{L})(\p{L}{3,10})\.?[ \t]+(\d{1,2})(?:st|nd|rd|th)?,?[ \t]+(\d{4})(?!\d)/giu;

/** Every way of writing the date this module reads: 03/14/1985 and 14/03/1985 (both orders), 14.03.85, 1985-03-14, 14 March 1985, 14 de março de 1985, March 14, 1985. */
function birthDateSpans(text: string, dob: Day): [number, number][] {
  const year = (y: number) => y === dob.y || (y < 100 && y === dob.y % 100);
  const spans: [number, number][] = [];
  const add = (m: RegExpMatchArray) => spans.push([m.index!, m.index! + m[0].length]);
  for (const m of text.matchAll(NUMERIC_DATE)) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    if (year(Number(m[4])) && ((a === dob.m && b === dob.d) || (a === dob.d && b === dob.m))) add(m);
  }
  for (const m of text.matchAll(YEAR_FIRST_DATE)) if (Number(m[1]) === dob.y && Number(m[3]) === dob.m && Number(m[4]) === dob.d) add(m);
  for (const m of text.matchAll(DAY_MONTH_YEAR)) if (Number(m[1]) === dob.d && monthOf(m[2]!) === dob.m && Number(m[3]) === dob.y) add(m);
  for (const m of text.matchAll(MONTH_DAY_YEAR)) if (monthOf(m[1]!) === dob.m && Number(m[2]) === dob.d && Number(m[3]) === dob.y) add(m);
  return spans;
}

const EMAIL = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g;

/**
 * Removes every email, and with a bound passport the holder's name and birth date, each replaced by a placeholder the
 * cloud reader sees in its place: `[PERSON_1]`, `[BIRTH_DATE]`, `[EMAIL_1]`, `[EMAIL_2]`, … (one number per address).
 */
export function stripIdentity(text: string, holder: HolderIdentity | null): StripResult {
  const removed: StripRemoval[] = [];
  const free = (a: number, b: number) => !removed.some((r) => a < r.end && r.start < b);
  const emails = new Map<string, string>();
  for (const m of text.matchAll(EMAIL)) {
    const key = m[0].toLowerCase();
    if (!emails.has(key)) emails.set(key, emailPlaceholder(emails.size + 1));
    removed.push({ kind: 'email', text: m[0], start: m.index, end: m.index + m[0].length, placeholder: emails.get(key)! });
  }
  if (holder) {
    // Names and dates are looked for with the emails masked, so "José García jose.garcia@…" ends the name at the email.
    let masked = text;
    for (const r of removed) masked = masked.slice(0, r.start) + '\u0001'.repeat(r.end - r.start) + masked.slice(r.end);
    const dob = birthDateOf(holder.dateOfBirth);
    for (const [a, b] of dob ? birthDateSpans(masked, dob) : []) {
      if (free(a, b)) removed.push({ kind: 'birthDate', text: text.slice(a, b), start: a, end: b, placeholder: BIRTH_DATE_PLACEHOLDER });
    }
    const parts = nameParts(holder);
    for (const [a, b] of parts ? nameSpans(masked, parts) : []) {
      if (free(a, b)) removed.push({ kind: 'name', text: text.slice(a, b), start: a, end: b, placeholder: NAME_PLACEHOLDER });
    }
  }
  removed.sort((x, y) => x.start - y.start);
  let out = '';
  let at = 0;
  for (const r of removed) {
    out += text.slice(at, r.start) + r.placeholder;
    at = r.end;
  }
  return { text: out + text.slice(at), removed };
}
