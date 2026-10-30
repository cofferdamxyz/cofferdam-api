// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The identity strip's benchmark (`RESUME_STRIP` in `test/workResume.eval.test.ts`; workspace decision 0021, the
 * founder's ruling of 2026-10-30). The dataset removed every resume's identity, so each one is given a made-up identity
 * (a name, an email, a US phone, and on about 70% a birth date) at the top, the end or in the middle of its text; the
 * strip runs as the phone would, and the counts say what it left and what it took that was not the person's. Pure;
 * tested offline in `test/workIdentityStrip.test.ts`.
 */

import { foldName, NAME_PARTICLES, type HolderIdentity, type StripRemoval } from './identityStrip.js';
import { rng } from './resumeBench.js';

/** Bump when the made-up identities or where they go change, so readings of the old texts are not reused. */
export const STRIP_BENCH_VERSION = 1;

// Given names and surnames of the launch markets, with accents, double surnames, particles, and words a CV also uses
// for work (Cook, Mason, Grant), which a strip must not take from a job title.
const GIVEN = ['James', 'Mary', 'Robert', 'Ashley', 'Michael', 'Linda', 'José', 'María', 'Juan', 'Guadalupe', 'Luis', 'Ana', 'João', 'Antônio', 'Francisca', 'Luiz', 'Márcia', 'Raimundo', 'Jürgen', 'Inês', 'Héctor', 'Verónica', 'Grant', 'Rose'];
const SURNAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'García', 'Hernández', 'López', 'Martínez', 'González', 'Pérez', 'Silva', 'Santos', 'Oliveira', 'Souza', 'Rodrigues', 'Ferreira', 'Gonçalves', 'Müller', 'de la Cruz', 'dos Santos', 'Mason', 'Cook', 'Baker', 'Turner', 'Carpenter', 'Fisher'];
const MONTHS: Record<'en' | 'es' | 'pt', string[]> = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  pt: ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'],
};

export type InjectedKind = 'name' | 'birthDate' | 'email' | 'phone';

export interface SyntheticPerson {
  /** The passport as the app would keep it: the MRZ's names (capitals without accents) title-cased, the birth date. */
  passport: HolderIdentity;
  /** The name in full, as the person spells it. */
  fullName: string;
  /** The spellings the CV carries: the header's first, then the closing line's when there is one. */
  names: string[];
  email: string;
  phone: string;
  /** The birth date as the CV writes it, or null when the CV gives none. */
  birthDate: string | null;
  birthLabel: string;
  layout: 'top' | 'end' | 'middle';
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The MRZ's spelling of a name, title-cased as the app keeps it (`titleCaseName`). */
function mrzName(s: string): string {
  const ascii = foldName(s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue'));
  return ascii
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** One made-up person, the same for a seed on every run. */
export function syntheticPerson(seed: number): SyntheticPerson {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const given = [...new Set(r() < 0.4 ? [pick(GIVEN), pick(GIVEN)] : [pick(GIVEN)])];
  const surnames = [...new Set(r() < 0.5 ? [pick(SURNAMES), pick(SURNAMES)] : [pick(SURNAMES)])];
  const first = given[0]!;
  const s0 = surnames[0]!;
  const fullName = `${given.join(' ')} ${surnames.join(' ')}`;
  const forms = [
    fullName,
    `${first} ${s0}`,
    given[1] ? `${first} ${given[1].charAt(0)}. ${s0}` : `${first.charAt(0)}. ${surnames.join(' ')}`,
    `${first} ${s0}`.toLocaleUpperCase('es'),
    `${s0}, ${first}`,
  ];
  const header = pick(forms);
  const footer = r() < 0.3 ? `${first} ${s0}` : null;
  const y = 1960 + Math.floor(r() * 45);
  const m = 1 + Math.floor(r() * 12);
  const d = 1 + Math.floor(r() * 28);
  const ascii = (s: string) => foldName(s).replace(/[^a-z]/g, '');
  const lastWord = surnames[surnames.length - 1]!.split(' ').pop()!;
  const local = pick([`${ascii(first)}.${ascii(lastWord)}`, `${ascii(first).charAt(0)}${ascii(lastWord)}`, `${ascii(lastWord)}.${ascii(first)}${10 + Math.floor(r() * 90)}`]);
  const line = pad(Math.floor(r() * 100));
  const shown = r() < 0.7;
  const format = Math.floor(r() * 6);
  const birthDate = !shown
    ? null
    : [`${pad(m)}/${pad(d)}/${y}`, `${pad(d)}/${pad(m)}/${y}`, `${MONTHS.en[m - 1]} ${d}, ${y}`, `${d} de ${MONTHS.es[m - 1]} de ${y}`, `${d} de ${MONTHS.pt[m - 1]} de ${y}`, `${y}-${pad(m)}-${pad(d)}`][format]!;
  const birthLabel = [pick(['Date of birth: ', 'Born ']), pick(['Fecha de nacimiento: ', 'Data de nascimento: ']), 'Date of birth: ', 'Fecha de nacimiento: ', 'Data de nascimento: ', 'Born '][format]!;
  return {
    passport: { firstName: mrzName(given.join(' ')), lastName: mrzName(surnames.join(' ')), fullName: mrzName(fullName), dateOfBirth: `${y}-${pad(m)}-${pad(d)}` },
    fullName,
    names: footer ? [header, footer] : [header],
    email: `${local}@${pick(['example.com', 'example.org', 'example.net'])}`,
    phone: pick([`(312) 555-01${line}`, `312-555-01${line}`, `+1 312 555 01${line}`]),
    birthDate,
    birthLabel,
    layout: pick(['top', 'end', 'middle'] as const),
  };
}

export interface InjectedSpan {
  kind: InjectedKind;
  start: number;
  end: number;
}

export interface Injected {
  text: string;
  spans: InjectedSpan[];
}

/** The resume's text with the person's identity block where their layout puts it, and the name again at the end when they have a closing line. */
export function injectIdentity(text: string, p: SyntheticPerson): Injected {
  const pieces: [string, InjectedKind | null][] = [[p.names[0]!, 'name'], ['\n', null], [p.email, 'email'], [' · ', null], [p.phone, 'phone']];
  if (p.birthDate) pieces.push(['\n', null], [p.birthLabel, null], [p.birthDate, 'birthDate']);
  const body = text.trim();
  const cut = body.indexOf('\n', Math.floor(body.length / 2));
  const [before, after] =
    p.layout === 'top' ? ['', `\n\n${body}`] : p.layout === 'middle' && cut > 0 ? [`${body.slice(0, cut)}\n\n`, `\n\n${body.slice(cut + 1)}`] : [`${body}\n\n`, ''];
  let out = before;
  const spans: InjectedSpan[] = [];
  for (const [s, kind] of pieces) {
    if (kind) spans.push({ kind, start: out.length, end: out.length + s.length });
    out += s;
  }
  out += after;
  if (p.names[1]) {
    out += '\n\n';
    spans.push({ kind: 'name', start: out.length, end: out.length + p.names[1].length });
    out += `${p.names[1]} · Resume`;
  }
  return { text: out, spans };
}

const nameWords = (s: string) =>
  foldName(s)
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 2 && !NAME_PARTICLES.has(w));

export interface StripCounts {
  /** By kind, whether any of the person's strings of that kind is still readable in the text sent. */
  left: Record<InjectedKind, boolean>;
  /** Removals that touch none of the person's strings: what the strip took that was not theirs. */
  extraSpans: number;
  extraChars: number;
}

/** What the strip left of the person and what it took besides. A name counts as left while a word of it (not a particle) is uncovered. */
export function stripCounts(injected: Injected, removed: readonly StripRemoval[], p: SyntheticPerson): StripCounts {
  const own = new Set(nameWords(p.fullName));
  const left: Record<InjectedKind, boolean> = { name: false, birthDate: false, email: false, phone: false };
  for (const s of injected.spans) {
    let uncovered = '';
    let at = s.start;
    for (const r of [...removed].sort((a, b) => a.start - b.start)) {
      if (r.end <= at || r.start >= s.end) continue;
      if (r.start > at) uncovered += `${injected.text.slice(at, r.start)} `;
      at = Math.max(at, r.end);
    }
    if (at < s.end) uncovered += injected.text.slice(at, s.end);
    const readable = s.kind === 'name' ? nameWords(uncovered).some((w) => own.has(w)) : /[\p{L}\d]/u.test(uncovered);
    if (readable) left[s.kind] = true;
  }
  const extra = removed.filter((r) => !injected.spans.some((s) => r.start < s.end && s.start < r.end));
  return { left, extraSpans: extra.length, extraChars: extra.reduce((n, r) => n + r.end - r.start, 0) };
}

/** How a reader's identity name compares with the person's: their own name, a placeholder, none, or another. */
export function nameRead(read: string | null | undefined, p: SyntheticPerson): 'right' | 'placeholder' | 'none' | 'other' {
  if (!read?.trim()) return 'none';
  if (/\[[A-Z_]+\d*\]/.test(read)) return 'placeholder';
  const own = new Set(nameWords(p.fullName));
  const got = nameWords(read);
  return got.length && got.every((w) => own.has(w)) && nameWords(p.names[0]!).every((w) => got.includes(w)) ? 'right' : 'other';
}

/** Whether a phone read is the person's: the same ten digits. */
export function phoneRead(read: string | null | undefined, p: SyntheticPerson): boolean {
  const digits = (s: string) => s.replace(/\D/g, '').slice(-10);
  return !!read && digits(read).length === 10 && digits(read) === digits(p.phone);
}
