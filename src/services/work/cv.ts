// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `cofferdam.cv.v1`, the Cofferdam CV (workspace `docs/product/work-wallet.md`,
 * Listing lifecycle; `docs/product/engine.md`, S2): the one document a worker
 * owns, client-side encrypted in the Vault beside the raw file. The plane
 * never stores it and cannot read it.
 *
 * Here it is the target of the cloud executor: each block the phone sends
 * comes back as a `CvFragment` of the `claimed` section, which the phone
 * merges, re-identifies (placeholders back to names, on the phone only) and
 * shows for review before anything is saved. `assembleCv` is that merge,
 * kept beside the shape so both are tested in one place; the shape moves to
 * `@cofferdam/sdk` when the app's parser consumes it (demand-driven SDK
 * rule). Dates keep the precision the CV wrote: a year, or a year and month.
 */

import { fold } from './blocks.js';

export const CV_SCHEMA = 'cofferdam.cv.v1';

/** `YYYY` or `YYYY-MM`, as precise as the CV was. */
export type CvDate = string;

export interface CvTitle {
  /** As written: `original_raw_title` (decision 0018). */
  raw: string;
  /** The rank the title states, 1 for chief or first; null when it states none (engine.md, Token registry). */
  rank: number | null;
  /** The registry token and its English pivot (`industry_english_title`), once canonicalized (S3). */
  token?: string;
  english?: string;
}

/** A claimed skill or certificate as written, with its registry token once canonicalized. */
export interface CvClaim {
  raw: string;
  token?: string;
}

export interface CvExperience {
  title: CvTitle | null;
  /** A placeholder (`[ORG_1]`), re-identified on the phone only. */
  employer: string | null;
  /** A placeholder (`[PLACE_1]`). */
  location: string | null;
  start: CvDate | null;
  /** Null while `current`, or when the CV gives no end. */
  end: CvDate | null;
  current: boolean;
  skills: CvClaim[];
}

export interface CvEducation {
  qualification: string | null;
  /** A placeholder (`[ORG_1]`). */
  institution: string | null;
  end: CvDate | null;
}

export type CvLanguageLevel = 'fluent' | 'basic';

export interface CvLanguage {
  raw: string;
  /** ISO 639-1, or null when the name is not one the lexicon knows. */
  code: string | null;
  level: CvLanguageLevel;
}

export interface CvHeadline {
  title: CvTitle | null;
  years: number | null;
}

export interface CvClaimed {
  headline: CvHeadline;
  experience: CvExperience[];
  education: CvEducation[];
  skills: CvClaim[];
  certificates: CvClaim[];
  languages: CvLanguage[];
}

/** One settled contract (S10): append-only, written from the plane's attestation, never by a parser. */
export interface CvVerifiedEntry {
  contractRef: string;
  tokens: string[];
  epoch: number;
}

export interface CofferdamCvV1 {
  schema: typeof CV_SCHEMA;
  claimed: CvClaimed;
  verified: CvVerifiedEntry[];
  /** Which executor parsed it and with which models: the app states it (decision 0021). */
  provenance: { executor: 'cloud' | 'local'; models: string[]; parsedAt: string };
}

/** What one block adds to `claimed`. */
export type CvFragment =
  | { kind: 'summary'; headline: CvHeadline; skills: CvClaim[] }
  | { kind: 'experience'; experience: CvExperience }
  | { kind: 'education'; education: CvEducation }
  | { kind: 'skills'; skills: CvClaim[] }
  | { kind: 'certificates'; certificates: CvClaim[] }
  | { kind: 'languages'; languages: CvLanguage[] };

// ── Dates ───────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, janeiro: 1, ene: 1, enero: 1,
  feb: 2, february: 2, fev: 2, fevereiro: 2, febrero: 2,
  mar: 3, march: 3, marco: 3, marzo: 3,
  apr: 4, april: 4, abr: 4, abril: 4,
  may: 5, mai: 5, maio: 5, mayo: 5,
  jun: 6, june: 6, junho: 6, junio: 6,
  jul: 7, july: 7, julho: 7, julio: 7,
  aug: 8, august: 8, ago: 8, agosto: 8,
  sep: 9, sept: 9, september: 9, set: 9, setembro: 9, septiembre: 9, setiembre: 9,
  oct: 10, october: 10, out: 10, outubro: 10, octubre: 10,
  nov: 11, november: 11, novembro: 11, noviembre: 11,
  dec: 12, december: 12, dez: 12, dezembro: 12, dic: 12, diciembre: 12,
};

/** The words a CV writes for a job that continues, accents folded. */
const PRESENT = new Set([
  'present', 'current', 'currently', 'now', 'today', 'to date', 'ongoing',
  'atual', 'atualmente', 'presente', 'hoje', 'ate o momento', 'o momento', 'em curso',
  'actualidad', 'la actualidad', 'actual', 'actualmente', 'a la fecha', 'la fecha', 'hoy', 'en curso',
]);

export type CvDateSpan = { present: true } | { present: false; date: CvDate };

/**
 * Read a date span as a CV writes it ("Jun 2019", "03/2018", "fev/2014",
 * "abril de 2021", "2016", "Present", "a la fecha"). Null for anything else,
 * a full day included: the CV's precision is a year or a month. Years run
 * from 1950 to next year.
 */
export function parseCvDate(span: string, now = Date.now()): CvDateSpan | null {
  const f = fold(span)
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:]+$/, '');
  if (PRESENT.has(f)) return { present: true };
  const maxYear = new Date(now).getUTCFullYear() + 1;
  const year = (y: string) => {
    const n = Number(y);
    return n >= 1950 && n <= maxYear ? n : null;
  };
  const yearMonth = (y: string, m: number): CvDateSpan | null => {
    const yy = year(y);
    return yy != null && m >= 1 && m <= 12 ? { present: false, date: `${yy}-${String(m).padStart(2, '0')}` } : null;
  };
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})$/.exec(f))) {
    const yy = year(m[1]!);
    return yy == null ? null : { present: false, date: String(yy) };
  }
  if ((m = /^(\d{4})[-/.](\d{1,2})$/.exec(f))) return yearMonth(m[1]!, Number(m[2]));
  if ((m = /^(\d{1,2})[-/.](\d{4})$/.exec(f))) return yearMonth(m[2]!, Number(m[1]));
  if ((m = /^([a-z]+)\.?\s*(?:de |del |\/|-)?\s*(\d{4})$/.exec(f))) {
    const month = MONTHS[m[1]!];
    return month == null ? null : yearMonth(m[2]!, month);
  }
  return null;
}

// ── Languages ───────────────────────────────────────────────────────────────

/** Language names in English, Portuguese and Spanish, accents folded, to ISO 639-1. */
const LANGUAGE_CODES: Record<string, string> = {
  english: 'en', ingles: 'en', inglesa: 'en',
  spanish: 'es', espanhol: 'es', espanol: 'es', castellano: 'es', castelhano: 'es',
  portuguese: 'pt', portugues: 'pt', portuguesa: 'pt',
  french: 'fr', frances: 'fr', francesa: 'fr', francais: 'fr',
  german: 'de', alemao: 'de', aleman: 'de',
  italian: 'it', italiano: 'it',
  chinese: 'zh', mandarin: 'zh', chines: 'zh', chino: 'zh', mandarim: 'zh',
  japanese: 'ja', japones: 'ja',
  korean: 'ko', coreano: 'ko',
  arabic: 'ar', arabe: 'ar',
  russian: 'ru', russo: 'ru', ruso: 'ru',
  hindi: 'hi',
  tagalog: 'tl', filipino: 'tl',
  dutch: 'nl', holandes: 'nl', neerlandes: 'nl',
  vietnamese: 'vi', vietnamita: 'vi',
  'haitian creole': 'ht', 'crioulo haitiano': 'ht', 'criollo haitiano': 'ht',
};

/** The ISO 639-1 code of a language name as written ("Inglés (C2)" → `en`), or null. */
export function languageCode(raw: string): string | null {
  const f = fold(raw)
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return LANGUAGE_CODES[f] ?? LANGUAGE_CODES[f.split(' ')[0] ?? ''] ?? null;
}

// ── Assembly ────────────────────────────────────────────────────────────────

/** The same claim twice, ignoring case and accents. */
const claimKey = (raw: string) => fold(raw).replace(/\s+/g, ' ').trim();

function dedupeClaims(claims: CvClaim[]): CvClaim[] {
  const seen = new Set<string>();
  return claims.filter((c) => {
    const k = claimKey(c.raw);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Current jobs first, then the latest start first; entries without a start keep their order at the end. */
function byRecency(a: CvExperience, b: CvExperience): number {
  if (a.current !== b.current) return a.current ? -1 : 1;
  if (a.start && b.start) return b.start.localeCompare(a.start);
  return a.start ? -1 : b.start ? 1 : 0;
}

/**
 * Merge the fragments of one document into a `cofferdam.cv.v1` (the phone's
 * step before review). The first summary gives the headline; skills from the
 * summary and the skills block merge without repeats; a language claimed at
 * both levels keeps the fluent one.
 */
export function assembleCv(
  fragments: CvFragment[],
  provenance: CofferdamCvV1['provenance'],
): CofferdamCvV1 {
  const claimed: CvClaimed = {
    headline: { title: null, years: null },
    experience: [],
    education: [],
    skills: [],
    certificates: [],
    languages: [],
  };
  let headline = false;
  for (const f of fragments) {
    switch (f.kind) {
      case 'summary':
        if (!headline) {
          claimed.headline = f.headline;
          headline = true;
        }
        claimed.skills.push(...f.skills);
        break;
      case 'experience':
        claimed.experience.push(f.experience);
        break;
      case 'education':
        claimed.education.push(f.education);
        break;
      case 'skills':
        claimed.skills.push(...f.skills);
        break;
      case 'certificates':
        claimed.certificates.push(...f.certificates);
        break;
      case 'languages':
        claimed.languages.push(...f.languages);
        break;
    }
  }
  claimed.experience = claimed.experience
    .map((e, i) => ({ e, i }))
    .sort((a, b) => byRecency(a.e, b.e) || a.i - b.i)
    .map(({ e }) => e);
  claimed.skills = dedupeClaims(claimed.skills);
  claimed.certificates = dedupeClaims(claimed.certificates);
  const languages = new Map<string, CvLanguage>();
  for (const l of claimed.languages) {
    const key = l.code ?? claimKey(l.raw);
    const had = languages.get(key);
    if (!had || (had.level === 'basic' && l.level === 'fluent')) languages.set(key, l);
  }
  claimed.languages = [...languages.values()];
  return { schema: CV_SCHEMA, claimed, verified: [], provenance };
}
