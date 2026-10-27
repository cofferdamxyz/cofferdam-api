// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Scoring for the whole-CV parse evaluation (`test/workParse.eval.test.ts`):
 * a `ParsedCv` against the known truth of a synthetic CV
 * (`test/fixtures/work/parse/cvs.json`). Pure, so `test/workParse.test.ts`
 * checks it offline on every `yarn test`.
 *
 * Fields are scored one by one: text by the block evaluation's word rule
 * (`textMatch`, accents and punctuation aside), the email ignoring case, the
 * phone by its digits, the location also when one holds the other's words,
 * dates, numbers and the current flag exactly. A null where the truth has a
 * value is a miss, a value where the truth is null a miss too. Each truth
 * job and qualification is paired with a prediction of the same title
 * (qualification), exact before close, else of the same employer
 * (institution); a prediction
 * left unpaired is spurious. A run that failed has no parse and scores zero
 * (the caller gives it no score, not `scoreParse(null)`). Skills, certificates and languages (by ISO code) are lists,
 * scored as precision and recall; a paired certificate also scores its
 * expiry, and a paired language its level.
 */

import type { ParsedCv } from '../../src/services/work/parse.js';
import { listMatch, normText, textMatch } from './score.js';

export interface ParseTruth {
  identity: { name: string | null; email: string | null; phone: string | null; location: string | null };
  headline: { title: string | null; years: number | null };
  experience: { title: string; employer: string | null; start: string | null; end: string | null; current: boolean }[];
  education: { qualification: string | null; institution: string | null; end: string | null }[];
  skills: string[];
  certificates: { name: string; expires: string | null }[];
  languages: { code: string; level: 'fluent' | 'basic' }[];
}

export interface FieldScore {
  /** `identity.name`, `experience.0.employer`, … */
  path: string;
  gold: unknown;
  pred: unknown;
  correct: boolean;
}

export interface ListScoreP {
  list: 'skills' | 'certificates' | 'languages';
  tp: number;
  predCount: number;
  goldCount: number;
}

export interface ParseScore {
  fields: FieldScore[];
  lists: ListScoreP[];
  /** Predicted jobs and qualifications no truth entry paired with. */
  spurious: { experience: number; education: number };
  /** Correct fields and paired list items over everything scored, spurious entries and unmatched predictions included. */
  accuracy: number;
}

const digits = (s: string) => s.replace(/\D+/g, '');

function textEq(pred: string | null, gold: string | null): boolean {
  if (pred == null || gold == null) return pred == null && gold == null;
  return textMatch(pred, gold);
}

function locationEq(pred: string | null, gold: string | null): boolean {
  if (pred == null || gold == null) return pred == null && gold == null;
  const p = normText(pred);
  const g = normText(gold);
  return textMatch(pred, gold) || p.includes(g) || g.includes(p);
}

function exact(pred: unknown, gold: unknown): boolean {
  return (pred ?? null) === (gold ?? null);
}

/**
 * Pair truth entries with predictions in passes: every truth entry first
 * takes an unused prediction the first rule accepts (the same title, word for
 * word), and only the ones left over try the next rule (a title sharing half
 * its words, then the same employer). So two jobs at one employer, listed in
 * the other order, still pair by title, and "Supervisora de Seguridad" does
 * not take "Inspectora de Seguridad"'s place.
 */
function pair<G, P>(gold: G[], pred: P[], rules: ((g: G, p: P) => boolean)[]): { pairs: (P | null)[]; unused: number } {
  const used = new Set<number>();
  const pairs: (P | null)[] = gold.map(() => null);
  for (const same of rules) {
    gold.forEach((g, gi) => {
      if (pairs[gi] != null) return;
      const i = pred.findIndex((p, j) => !used.has(j) && same(g, p));
      if (i < 0) return;
      used.add(i);
      pairs[gi] = pred[i]!;
    });
  }
  return { pairs, unused: pred.length - used.size };
}

export function scoreParse(parsed: ParsedCv | null, truth: ParseTruth): ParseScore {
  const fields: FieldScore[] = [];
  const add = (path: string, pred: unknown, gold: unknown, correct: boolean) => fields.push({ path, gold, pred: pred ?? null, correct });
  const c = parsed?.claimed;
  const id = parsed?.identity;

  add('identity.name', id?.name, truth.identity.name, textEq(id?.name ?? null, truth.identity.name));
  add(
    'identity.email',
    id?.email,
    truth.identity.email,
    (id?.email ?? null) == null || truth.identity.email == null
      ? (id?.email ?? null) == null && truth.identity.email == null
      : id!.email!.trim().toLowerCase() === truth.identity.email.toLowerCase(),
  );
  add(
    'identity.phone',
    id?.phone,
    truth.identity.phone,
    (id?.phone ?? null) == null || truth.identity.phone == null
      ? (id?.phone ?? null) == null && truth.identity.phone == null
      : digits(id!.phone!) === digits(truth.identity.phone),
  );
  add('identity.location', id?.location, truth.identity.location, locationEq(id?.location ?? null, truth.identity.location));

  const title = c?.headline.title?.raw ?? null;
  add('headline.title', title, truth.headline.title, textEq(title, truth.headline.title));
  add('headline.years', c?.headline.years, truth.headline.years, exact(c?.headline.years, truth.headline.years));

  const exp = c?.experience ?? [];
  const ep = pair(truth.experience, exp, [
    (g, p) => p.title != null && normText(p.title.raw) === normText(g.title),
    (g, p) => textEq(p.title?.raw ?? null, g.title),
    (g, p) => g.employer != null && textEq(p.employer, g.employer),
  ]);
  truth.experience.forEach((g, i) => {
    const p = ep.pairs[i];
    add(`experience.${i}.title`, p?.title?.raw, g.title, p != null && textEq(p.title?.raw ?? null, g.title));
    add(`experience.${i}.employer`, p?.employer, g.employer, p != null && textEq(p.employer, g.employer));
    add(`experience.${i}.start`, p?.start, g.start, p != null && exact(p.start, g.start));
    add(`experience.${i}.end`, p?.end, g.end, p != null && exact(p.end, g.end));
    add(`experience.${i}.current`, p?.current, g.current, p != null && p.current === g.current);
  });

  const edu = c?.education ?? [];
  const dp = pair(truth.education, edu, [
    (g, p) => g.qualification != null && p.qualification != null && normText(p.qualification) === normText(g.qualification),
    (g, p) => g.qualification != null && textEq(p.qualification, g.qualification),
    (g, p) => g.institution != null && textEq(p.institution, g.institution),
  ]);
  truth.education.forEach((g, i) => {
    const p = dp.pairs[i];
    add(`education.${i}.qualification`, p?.qualification, g.qualification, p != null && textEq(p.qualification, g.qualification));
    add(`education.${i}.institution`, p?.institution, g.institution, p != null && textEq(p.institution, g.institution));
    add(`education.${i}.end`, p?.end, g.end, p != null && exact(p.end, g.end));
  });

  const lists: ListScoreP[] = [];
  lists.push({ list: 'skills', ...listMatch((c?.skills ?? []).map((s) => s.raw), truth.skills) });

  const certs = c?.certificates ?? [];
  lists.push({ list: 'certificates', ...listMatch(certs.map((x) => x.raw), truth.certificates.map((x) => x.name)) });
  const cp = pair(truth.certificates, certs, [(g, p) => textEq(p.raw, g.name)]);
  truth.certificates.forEach((g, i) => {
    const p = cp.pairs[i];
    add(`certificates.${i}.expires`, p?.expires, g.expires, p != null && exact(p.expires, g.expires));
  });

  const langs = c?.languages ?? [];
  const codes = langs.map((l) => l.code ?? `?${l.raw}`);
  const goldCodes = truth.languages.map((l) => l.code);
  const tpLang = goldCodes.filter((g) => codes.includes(g)).length;
  lists.push({ list: 'languages', tp: tpLang, predCount: new Set(codes).size, goldCount: goldCodes.length });
  truth.languages.forEach((g) => {
    const p = langs.find((l) => l.code === g.code);
    add(`languages.${g.code}.level`, p?.level, g.level, p?.level === g.level);
  });

  const spurious = { experience: ep.unused, education: dp.unused };
  const right = fields.filter((f) => f.correct).length + lists.reduce((n, l) => n + l.tp, 0);
  const total =
    fields.length + lists.reduce((n, l) => n + Math.max(l.goldCount, l.predCount), 0) + spurious.experience + spurious.education;
  return { fields, lists, spurious, accuracy: total ? right / total : 1 };
}

/** The section of a field path, for the report's columns. */
export function sectionOf(path: string): string {
  return path.split('.')[0]!;
}

/** Correct over scored fields in one section. */
export function sectionScore(score: ParseScore, section: string): { right: number; total: number } {
  const f = score.fields.filter((x) => sectionOf(x.path) === section);
  return { right: f.filter((x) => x.correct).length, total: f.length };
}
