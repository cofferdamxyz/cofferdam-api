// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The curated certificate seed (workspace decision 0018, `docs/product/engine.md`,
 * Token registry): every `cert:` token the registry knows, from
 * `certificates.json`, with what the registry needs beyond a label to read a
 * certificate safely. A certificate is never minted, and a false positive must
 * never award licensed work (E10), so each entry also says:
 *
 *  - its levels, lowest first: a level held serves every level below it (a
 *    master's licence serves a journeyman's job, never the reverse);
 *  - its modules (a module, an endorsement, a specialty), which a holder adds
 *    and which may imply others (EPA 608 Universal implies Types I to III);
 *  - its names: a specific one (BOSIET, NR-35, TSBPE) names the credential on
 *    its own; a shared one (a state, an issuer of many credentials, NCCCO)
 *    names a family, and the string must also hold one of the distinctive
 *    words the seed lists for the credential (electrician, rigger, backflow);
 *  - its excludes: words that make the string another credential (a Texas
 *    industrial electrician licence is not the electrician licence);
 *  - its details: words a worker's claim may carry that change nothing the
 *    plane reads (a welding process, the issuer's name, a course title's
 *    words);
 *  - the phrases a hirer may use for it (`licensed electrician`) and where
 *    they mean it: a state licence in its state, an international credential
 *    in the regions the seed names.
 *
 * Levels and modules are never registry tokens: one credential is one token,
 * so close siblings (OSHA 10 and OSHA 30) no longer split Clef's probability
 * (`docs/product/engine.md`, Clef classification patterns, rule 7). They become
 * facet tokens of a listing's exact list instead: `cert:nccco-rigger/level-2`,
 * `cert:bosiet/ca-ebs`, and `cert:osha-outreach:us/construction/30-hour` for a
 * module at a level, so the exact certificate confirm checks them by set
 * membership. A claim holds its level and every level below it; a requirement
 * names the level and modules it needs, and nothing more.
 *
 * Everything is read off the string by the seed, never by a model: a
 * credential fits a string only when, its level, modules and filler words
 * read off, every word left is the credential's own. A worker's claim may
 * also carry its details, a course's hours (unless the credential's levels
 * are hours, as OSHA's are) and a validity date still ahead; a validity date
 * this month or before says it is not held, and any other date is a word the
 * seed cannot read. A hirer's requirement may carry nothing more, so it never
 * asks for less than it names.
 *
 * The catalogue is built on first use and skips an entry it cannot read
 * (`problems`, which `test/workCertificates.test.ts` holds empty), so a bad
 * seed fails closed for that certificate and never stops the Worker.
 */

import seedJson from './certificates.json';
import { adjudicationQuestions, adjudicationState, clefInput, readChoice } from './clef.js';
import { failureCode } from './executor.js';
import { estimatedUsage, usageOrEstimate, type WorkCall } from './fields.js';
import {
  ADJUDICATION_FLOOR,
  candidatesFor,
  embedTexts,
  labelIdOf,
  labelNorm,
  SLUG_MAX,
  type Candidate,
  type LabelKind,
  type RegistryDeps,
  type RegistryLabel,
  type RegistryToken,
  type SnapInput,
  type SnapOutcome,
  type SnapResult,
  type Tau,
} from './registry.js';

export const CERT_LANGS = ['en', 'pt', 'es'] as const;
export type CertLang = (typeof CERT_LANGS)[number];

/** Between a token and its facet: `cert:nccco-rigger/level-2`. */
export const FACET_SEPARATOR = '/';

/** ISO 3166-1 alpha-2, optionally with a subdivision, as listings write a region (`us-tx`, `br`). */
const REGION = /^[a-z]{2}(-[a-z0-9]{1,3})?$/;
const TOKEN = /^cert:([a-z0-9]+(?:-[a-z0-9]+)*)(?::([a-z]{2}(?:-[a-z0-9]{1,3})?))?$/;
const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface CertificateFacet {
  key: string;
  /** Its English name, for Clef's candidate and the review. */
  en: string;
  /** Normalized phrases (`labelNorm`), longest first. */
  aliases: string[];
  /** Module keys a held module also gives (a module only). */
  implies: string[];
}

export interface CertificateLabel {
  lang: string;
  label: string;
  norm: string;
  /** `norm` without the seed's filler words: what a requirement's exact match compares. */
  bare: string;
  /** `bare` without what a claim may carry (a year, a course's hours, the entry's details): what a claim's exact match compares. */
  claimBare: string;
}

export interface CertificateEntry {
  token: string;
  /** The region the credential is valid in (`us-tx`, `br`), from the token; null for an international one. */
  jurisdiction: string | null;
  issuer: string;
  labelEn: string;
  /** Normalized specific names: each names the credential on its own. */
  names: string[];
  /** Normalized shared names: each names a family, so a distinctive word must say which credential. */
  shared: string[];
  /** A worker's labels, the English name first. */
  labels: CertificateLabel[];
  levels: CertificateFacet[];
  modules: CertificateFacet[];
  /** Normalized: any of them makes the string another credential. */
  excludes: string[];
  /** Words a worker's claim may carry that the plane neither reads nor needs. */
  details: ReadonlySet<string>;
  /** Its levels or modules are written in hours (OSHA's 10-Hour and 30-Hour): a claim's hours are never dropped as a course's length. */
  readsHours: boolean;
  /** Where a hirer's phrases mean this credential: its jurisdiction, or the regions the seed names. */
  requirementRegions: string[];
  requirements: CertificateLabel[];
  /** Every word of its labels, names and hirer phrases: a string may use no other. */
  vocabulary: ReadonlySet<string>;
  /**
   * The words the seed lists to tell it apart where only a shared name
   * names it (electrician, rigger, perito): each its own, in no credential
   * sharing a name or a state with it.
   */
  distinctive: ReadonlySet<string>;
}

export interface CertificateCatalogue {
  version: string;
  entries: CertificateEntry[];
  byToken: ReadonlyMap<string, CertificateEntry>;
  /** Region code to its English name. */
  jurisdictions: ReadonlyMap<string, string>;
  fillers: ReadonlySet<string>;
  /** Normalized: any of them says the credential is not held (apprentice, expired, no vigente). */
  notHeld: string[];
  /** What the seed got wrong; an entry with a problem of its own is left out. */
  problems: string[];
}

export interface CertFacets {
  /**
   * The level read; null when the string names none. Of two levels a claim
   * keeps the lower (it never reads higher than it is sure of) and a
   * requirement the higher (it never asks for less than it names).
   */
  level: string | null;
  /** The modules read, as written (implied ones are added only to what a claim holds). */
  modules: string[];
}

export const NO_FACETS: CertFacets = { level: null, modules: [] };

export interface ReadContext {
  /** A hirer's requirement, with the job's region; absent for a worker's claim. */
  requirement?: { region?: string };
  /** When the string is read (ms since the epoch), for a claim's validity date; default now. */
  asOf?: number;
}

// ── Phrases ─────────────────────────────────────────────────────────────────

/** Whether a normalized string holds a normalized phrase as whole words. */
export function hasPhrase(norm: string, phrase: string): boolean {
  return phrase !== '' && ` ${norm} `.includes(` ${phrase} `);
}

function withoutPhrase(norm: string, phrase: string): string {
  return ` ${norm} `.replace(` ${phrase} `, ' ').trim().replace(/ +/g, ' ');
}

const wordsOf = (norm: string) => norm.split(' ').filter(Boolean);

/** Whether a region lies in one of the scopes: the same region, or the country a scope names alone. */
export function inRegion(region: string | undefined, scopes: readonly string[]): boolean {
  if (!region || !REGION.test(region)) return false;
  return scopes.some((s) => s === region || (s.length === 2 && region.slice(0, 2) === s));
}

// ── What a claim may carry ──────────────────────────────────────────────────

/** A validity date in a claim: "exp 2027", "valid until 03/2028", "válido até 2027", "vence 2026", "hasta 2027". */
const VALIDITY = /\b(?:until|thru|through|exp|expires|expiry|expiration|ate|validade|vence|vencimento|hasta|vigencia|caduca)\s+(?:(\d{1,2})\s+)?((?:19|20)\d{2})\b/g;
/** A course's length: "8h", "40hrs", or a number before "horas" or "hours". */
const COURSE_HOURS = /^\d{1,3}(?:h|hs|hr|hrs)$/;
const HOUR_WORDS = new Set(['h', 'hs', 'hr', 'hrs', 'hour', 'hours', 'hora', 'horas']);
/** An alias written in hours ("10-Hour", "30 horas", "10h"): the credential's own hour counts. */
const IN_HOURS = /\b\d{1,3}\s*(?:h|hs|hr|hrs|hour|hours|hora|horas)\b/;

/**
 * Whether a claim's validity date says it is not held. Without a day the
 * plane cannot tell a date this month, or a year without a month this year,
 * from one already past, so both count as past: only a later month, or a
 * later year, is still ahead.
 */
export function expiredClaim(norm: string, asOf: number = Date.now()): boolean {
  const now = new Date(asOf);
  const [year, month] = [now.getUTCFullYear(), now.getUTCMonth() + 1];
  for (const m of norm.matchAll(VALIDITY)) {
    const y = Number(m[2]);
    const mo = m[1] ? Number(m[1]) : null;
    if (mo != null && (mo < 1 || mo > 12)) return true;
    if (y < year || (y === year && (mo == null || mo <= month))) return true;
  }
  return false;
}

function withoutValidity(norm: string): string {
  return norm.replace(VALIDITY, ' ').replace(/ +/g, ' ').trim();
}

/**
 * A claim's words without the entry's details and, unless the credential's
 * levels are hours, a course's hours. A year stays: a date the seed does not
 * read as a validity date ahead is a word it cannot read.
 */
function withoutClaimNoise(words: readonly string[], details: ReadonlySet<string>, readsHours: boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (details.has(w)) continue;
    if (!readsHours && COURSE_HOURS.test(w)) continue;
    if (!readsHours && /^\d{1,3}$/.test(w) && HOUR_WORDS.has(words[i + 1] ?? '')) {
      i++;
      continue;
    }
    out.push(w);
  }
  return out;
}

// ── The catalogue ───────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '') ? (v as string[]) : null);
const normalized = (list: string[]) => [...new Set(list.map(labelNorm).filter(Boolean))].sort((a, b) => b.length - a.length);

/** Build the catalogue from the seed's JSON; every problem is named, and an entry with one is left out. */
export function buildCatalogue(seed: unknown): CertificateCatalogue {
  const problems: string[] = [];
  const s = isObject(seed) ? seed : {};
  const version = typeof s.version === 'string' ? s.version : '';
  if (!version) problems.push('the seed has no version');
  const jurisdictions = new Map<string, string>();
  if (isObject(s.jurisdictions)) {
    for (const [code, name] of Object.entries(s.jurisdictions)) {
      if (REGION.test(code) && typeof name === 'string' && name) jurisdictions.set(code, name);
      else problems.push(`jurisdiction ${code} is not a region with a name`);
    }
  }
  /** A list the seed must give whole: a malformed one is a problem, and only its valid strings are kept. */
  const wordList = (v: unknown, where: string): string[] => {
    if (v === undefined) return [];
    if (!strings(v)) problems.push(`${where} is not a list of non-empty strings`);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
  };
  const fillers = new Set(wordList(s.fillers, 'fillers').flatMap((f) => wordsOf(labelNorm(f))));
  const generic = new Set(wordList(s.generic, 'generic').flatMap((f) => wordsOf(labelNorm(f))));
  const notHeld = normalized(wordList(s.notHeld, 'notHeld'));
  if (!notHeld.length) problems.push('the seed has no notHeld words');
  const bareOf = (norm: string) => wordsOf(norm).filter((w) => !fillers.has(w));
  const entries: CertificateEntry[] = [];

  const labelsOf = (v: unknown, where: string, own: string[], details: ReadonlySet<string>, readsHours: boolean): CertificateLabel[] | null => {
    if (v !== undefined && !isObject(v)) {
      problems.push(`${where} is not an object of languages`);
      return null;
    }
    const out: CertificateLabel[] = [];
    for (const [lang, list] of [['en', own] as const, ...Object.entries(v ?? {})]) {
      if (!(CERT_LANGS as readonly string[]).includes(lang)) {
        problems.push(`${where} has an unknown language ${lang}`);
        return null;
      }
      const labels = strings(list);
      if (!labels) {
        problems.push(`${where}.${lang} is not a list of labels`);
        return null;
      }
      for (const label of labels) {
        const norm = labelNorm(label);
        if (out.some((l) => l.lang === lang && l.norm === norm)) continue;
        const bare = bareOf(norm);
        out.push({ lang, label: label.trim(), norm, bare: bare.join(' '), claimBare: withoutClaimNoise(bare, details, readsHours).join(' ') });
      }
    }
    return out;
  };

  const facetsOf = (v: unknown, where: string): CertificateFacet[] | null => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      problems.push(`${where} is not a list`);
      return null;
    }
    const out: CertificateFacet[] = [];
    for (const f of v as unknown[]) {
      const aliases = isObject(f) ? strings(f.aliases) : null;
      const implies = isObject(f) && f.implies !== undefined ? strings(f.implies) : [];
      if (!isObject(f) || typeof f.key !== 'string' || !KEY.test(f.key) || typeof f.en !== 'string' || !f.en || !aliases || !implies) {
        problems.push(`${where} has a facet without a key, an English name and aliases`);
        return null;
      }
      out.push({ key: f.key, en: f.en, aliases: normalized(aliases), implies });
    }
    return out;
  };

  for (const raw of Array.isArray(s.certificates) ? (s.certificates as unknown[]) : []) {
    const e = isObject(raw) ? raw : {};
    const token = typeof e.token === 'string' ? e.token : '';
    const where = token || 'a certificate';
    const shape = TOKEN.exec(token);
    const before = problems.length;
    if (!shape) problems.push(`${where} is not cert:<slug> or cert:<slug>:<region>`);
    else if (shape[1]!.length > SLUG_MAX) problems.push(`${where} has a slug over ${SLUG_MAX} characters`);
    if (entries.some((x) => x.token === token)) problems.push(`${where} is in the seed twice`);
    const jurisdiction = shape?.[2] ?? null;
    if (jurisdiction && !jurisdictions.has(jurisdiction)) problems.push(`${where} has a jurisdiction the seed does not name`);
    const issuer = typeof e.issuer === 'string' ? e.issuer.trim() : '';
    const labelEn = typeof e.en === 'string' ? e.en.trim() : '';
    if (!issuer || !labelEn) problems.push(`${where} needs an issuer and an English name`);
    const names = normalized(wordList(e.names, `${where}.names`));
    const shared = normalized(wordList(e.shared, `${where}.shared`));
    if (!names.length && !shared.length) problems.push(`${where} has no names`);
    const details = new Set(wordList(e.details, `${where}.details`).flatMap((d) => wordsOf(labelNorm(d))));
    for (const d of details) if ([...names, ...shared].some((n) => wordsOf(n).includes(d))) problems.push(`${where} detail "${d}" is one of its names`);
    const levels = facetsOf(e.levels, `${where}.levels`);
    const modules = facetsOf(e.modules, `${where}.modules`);
    const readsHours = [...(levels ?? []), ...(modules ?? [])].some((f) => f.aliases.some((a) => IN_HOURS.test(a)));
    const labels = labelsOf(e.labels, `${where}.labels`, labelEn ? [labelEn] : [], details, readsHours);
    const distinctive = new Set(wordList(e.distinctive, `${where}.distinctive`).flatMap((d) => wordsOf(labelNorm(d))));
    if (shared.length && !distinctive.size) problems.push(`${where} has shared names and no distinctive words`);
    // A malformed exclude list leaves the entry out: without its excludes it would fail open.
    const excludes = normalized(wordList(e.excludes, `${where}.excludes`));
    const req = e.requirements === undefined ? {} : isObject(e.requirements) ? e.requirements : null;
    if (!req) problems.push(`${where}.requirements is not an object`);
    const requirements = labelsOf(req?.labels, `${where}.requirements.labels`, [], new Set(), readsHours);
    const named = req && req.regions !== undefined ? wordList(req.regions, `${where}.requirements.regions`) : null;
    const requirementRegions = named ?? (jurisdiction ? [jurisdiction] : []);
    if (named && !named.every((r) => REGION.test(r))) problems.push(`${where}.requirements.regions holds a region that is not one`);
    if (requirements?.length && !requirementRegions.length) problems.push(`${where} has hirer phrases but no region where they mean it`);

    if (labels && levels && modules) {
      const keys = [...levels, ...modules].map((f) => f.key);
      if (new Set(keys).size !== keys.length) problems.push(`${where} uses a facet key twice`);
      for (const m of modules) for (const k of m.implies) if (!modules.some((x) => x.key === k) || k === m.key) problems.push(`${where} module ${m.key} implies an unknown module ${k}`);
      for (const l of levels) if (l.implies.length) problems.push(`${where} level ${l.key} implies something: only modules do`);
      const aliases = [...levels, ...modules].flatMap((f) => f.aliases);
      for (const l of labels) {
        if (![...names, ...shared].some((n) => hasPhrase(l.norm, n))) problems.push(`${where} label "${l.label}" holds none of its names`);
        for (const a of aliases) if (hasPhrase(l.norm, a)) problems.push(`${where} label "${l.label}" holds its own facet alias "${a}"`);
        for (const x of excludes) if (hasPhrase(l.norm, x)) problems.push(`${where} label "${l.label}" holds its own exclude "${x}"`);
        for (const x of notHeld) if (hasPhrase(l.norm, x)) problems.push(`${where} label "${l.label}" holds "${x}", which says not held`);
        if (!l.claimBare) problems.push(`${where} label "${l.label}" is only filler words`);
      }
      for (const r of requirements ?? []) if (!r.bare) problems.push(`${where} hirer phrase "${r.label}" is only filler words`);
    }
    if (problems.length > before || !shape || !labels || !levels || !modules || !requirements) continue;
    const vocabulary = new Set([...labels, ...requirements, ...[...names, ...shared].map((n) => ({ norm: n }))].flatMap((l) => wordsOf(l.norm)));
    for (const d of distinctive) if (!vocabulary.has(d)) problems.push(`${where} distinctive word "${d}" is in none of its labels`);
    if (problems.length > before) continue;
    entries.push({ token, jurisdiction, issuer, labelEn, names, shared, labels, levels, modules, excludes, details, readsHours, requirementRegions, requirements, vocabulary, distinctive });
  }

  // A distinctive word tells a credential apart only if no credential sharing a name or a state with it uses it, and it is no shared name, generic word or filler.
  const sharedWords = new Set(entries.flatMap((e) => e.shared.flatMap(wordsOf)));
  const state = (e: CertificateEntry) => (e.jurisdiction?.includes('-') ? e.jurisdiction : null);
  const blurred = new Set<string>();
  for (const e of entries) {
    const siblings = entries.filter((f) => f !== e && (f.shared.some((n) => e.shared.includes(n)) || (state(e) != null && state(f) === state(e))));
    for (const d of e.distinctive) {
      const other = siblings.find((f) => f.vocabulary.has(d));
      if (other || sharedWords.has(d) || generic.has(d) || fillers.has(d)) {
        problems.push(`${e.token} distinctive word "${d}" does not tell it apart${other ? ` from ${other.token}` : ''}`);
        blurred.add(e.token);
      }
    }
  }

  // Across entries: one claim label names one credential, and one hirer phrase one per region.
  const claimed = new Map<string, string>();
  for (const e of entries) {
    for (const l of e.labels) {
      for (const form of new Set([l.bare, l.claimBare])) {
        const had = claimed.get(form);
        if (had && had !== e.token) problems.push(`"${l.label}" names both ${had} and ${e.token}`);
        claimed.set(form, e.token);
      }
    }
  }
  for (const [i, a] of entries.entries()) {
    for (const b of entries.slice(i + 1)) {
      const sharedPhrase = a.requirements.filter((r) => b.requirements.some((x) => x.bare === r.bare));
      const overlap = a.requirementRegions.some((r) => inRegion(r, b.requirementRegions) || b.requirementRegions.some((x) => inRegion(x, [r])));
      if (sharedPhrase.length && overlap) problems.push(`the hirer phrase "${sharedPhrase[0]!.label}" means both ${a.token} and ${b.token} in one region`);
    }
  }
  const kept0 = entries.filter((e) => !blurred.has(e.token));
  const catalogue = { version, entries: kept0, byToken: new Map(kept0.map((e) => [e.token, e])), jurisdictions, fillers, notHeld, problems };
  // Every label must fit its own credential as a claim would: a shared name needs a distinctive word beside it.
  const unfit = new Set<string>();
  for (const e of kept0) {
    for (const l of e.labels) {
      if (!accounts(catalogue, e, l.norm)) {
        problems.push(`${e.token} label "${l.label}" holds a shared name and no word that tells it apart`);
        unfit.add(e.token);
      }
    }
  }
  if (!unfit.size) return catalogue;
  const kept = kept0.filter((e) => !unfit.has(e.token));
  return { ...catalogue, entries: kept, byToken: new Map(kept.map((e) => [e.token, e])) };
}

let cached: CertificateCatalogue | null = null;

/** The seed, built on first use. */
export function certificates(): CertificateCatalogue {
  return (cached ??= buildCatalogue(seedJson));
}

// ── Reading a string ────────────────────────────────────────────────────────

/** Whether the string says the credential is not held: an apprentice, an expired, a pending or a lapsed one. */
export function saysNotHeld(catalogue: CertificateCatalogue, norm: string): boolean {
  return catalogue.notHeld.some((p) => hasPhrase(norm, p));
}

/** The string as the facets and words are read from: a claim's validity date ahead is read off first. */
function prepared(norm: string, ctx: ReadContext): string {
  return ctx.requirement ? norm : withoutValidity(norm);
}

/**
 * The level and modules a string names for one credential, read by the
 * seed's aliases, longest first, each consumed as it is read ("CA-EBS" is
 * never also read as "EBS"); `rest` is what is left of the string. Of two
 * levels a claim keeps the lower and a requirement the higher.
 */
export function readFacets(entry: CertificateEntry, norm: string, ctx: ReadContext = {}): { facets: CertFacets; rest: string } {
  const aliases = [
    ...entry.levels.flatMap((f, i) => f.aliases.map((alias) => ({ alias, level: i, key: f.key }))),
    ...entry.modules.flatMap((f) => f.aliases.map((alias) => ({ alias, level: -1, key: f.key }))),
  ].sort((a, b) => b.alias.length - a.alias.length);
  let rest = prepared(norm, ctx);
  const levels = new Set<number>();
  const modules = new Set<string>();
  for (const a of aliases) {
    while (hasPhrase(rest, a.alias)) {
      rest = withoutPhrase(rest, a.alias);
      if (a.level >= 0) levels.add(a.level);
      else modules.add(a.key);
    }
  }
  // A claim never reads higher than it is sure of; a requirement never asks for less than it names.
  const at = levels.size ? (ctx.requirement ? Math.max(...levels) : Math.min(...levels)) : -1;
  return { facets: { level: at >= 0 ? entry.levels[at]!.key : null, modules: [...modules].sort() }, rest };
}

/** The words a credential must account for: no level, module or filler, and for a claim no year, course hours or detail. */
function remainingWords(catalogue: CertificateCatalogue, entry: CertificateEntry, norm: string, ctx: ReadContext): string[] {
  const words = wordsOf(readFacets(entry, norm, ctx).rest).filter((w) => !catalogue.fillers.has(w));
  return ctx.requirement ? words : withoutClaimNoise(words, entry.details, entry.readsHours);
}

/**
 * Whether a string may be this credential at all, before any model is asked:
 * nothing it holds makes it another credential, and it names the credential
 * or its family. A hirer may leave a state licence's state to the job's
 * region (`licensed electrician` in `us-tx`); a national or international
 * credential is named either way.
 */
export function admits(entry: CertificateEntry, norm: string, ctx: ReadContext = {}): boolean {
  if (entry.excludes.some((x) => hasPhrase(norm, x))) return false;
  if ([...entry.names, ...entry.shared].some((n) => hasPhrase(norm, n))) return true;
  return ctx.requirement != null && entry.jurisdiction?.includes('-') === true && inRegion(ctx.requirement.region, [entry.jurisdiction]);
}

/**
 * Whether the seed can read the whole string as this credential: once its
 * level, modules and filler words are read off (and, for a claim, its year,
 * course hours, details and a validity date ahead), something is left, every
 * word left is the credential's own, and unless a specific name says which
 * credential it is, one of them is distinctive ("Texas license" or "NCCCO
 * certified" names a family, not a credential). A word the seed cannot read
 * ("Class B", "Type I and II") may be a lesser grade or more than the
 * credential, so it never fits.
 */
export function accounts(catalogue: CertificateCatalogue, entry: CertificateEntry, norm: string, ctx: ReadContext = {}): boolean {
  const words = remainingWords(catalogue, entry, norm, ctx);
  if (!words.length || !words.every((w) => entry.vocabulary.has(w))) return false;
  return entry.names.some((n) => hasPhrase(norm, n)) || words.some((w) => entry.distinctive.has(w));
}

export interface CertificateMatch {
  entry: CertificateEntry;
  facets: CertFacets;
  /** A worker's label of the seed, or a hirer's phrase in its region. */
  via: 'label' | 'requirement';
}

/**
 * The seed's exact match, without a model: the string is one of a
 * credential's labels once its level, its modules and the filler words
 * ("with", "curso", "card") are read off (and, for a claim, what a claim may
 * carry), or, for a hirer, one of its phrases where the job is. Every
 * credential that matches is returned; the registry takes one only when it
 * is alone.
 */
export function matchCertificate(catalogue: CertificateCatalogue, norm: string, ctx: ReadContext = {}): CertificateMatch[] {
  const out: CertificateMatch[] = [];
  for (const entry of catalogue.entries) {
    if (entry.excludes.some((x) => hasPhrase(norm, x))) continue;
    const { facets } = readFacets(entry, norm, ctx);
    const bare = remainingWords(catalogue, entry, norm, ctx).join(' ');
    if (!bare) continue;
    if (entry.labels.some((l) => (ctx.requirement ? l.bare : l.claimBare) === bare)) out.push({ entry, facets, via: 'label' });
    else if (ctx.requirement && inRegion(ctx.requirement.region, entry.requirementRegions) && entry.requirements.some((l) => l.bare === bare)) {
      out.push({ entry, facets, via: 'requirement' });
    }
  }
  return out;
}

/** A credential as Clef's candidate reads it: its name, issuer, jurisdiction, levels and modules. */
export function describeCertificate(catalogue: CertificateCatalogue, entry: CertificateEntry): string {
  const where = entry.jurisdiction ? (catalogue.jurisdictions.get(entry.jurisdiction) ?? entry.jurisdiction) : null;
  const parts = [`${entry.labelEn}, issued by ${entry.issuer}${where ? `, valid in ${where}` : ''}`];
  if (entry.levels.length) parts.push(`levels ${entry.levels.map((l) => l.en).join(', ')}`);
  if (entry.modules.length) parts.push(`modules ${entry.modules.map((m) => m.en).join(', ')}`);
  return parts.join('; ');
}

// ── Facet tokens ────────────────────────────────────────────────────────────

function implied(entry: CertificateEntry, modules: readonly string[]): string[] {
  const out = new Set<string>();
  const add = (key: string) => {
    if (out.has(key)) return;
    out.add(key);
    for (const k of entry.modules.find((m) => m.key === key)?.implies ?? []) add(k);
  };
  modules.forEach(add);
  return [...out].sort();
}

/**
 * What a worker's certificate puts in the exact token list: the credential,
 * its level and every level below it, each module held (with what it
 * implies), and each module at each of those levels, so a requirement for a
 * module at a level is met only by that module at that level or above.
 */
export function heldTokens(entry: CertificateEntry, facets: CertFacets): string[] {
  const at = facets.level ? entry.levels.findIndex((l) => l.key === facets.level) : -1;
  const levels = entry.levels.slice(0, at + 1).map((l) => l.key);
  const modules = implied(entry, facets.modules.filter((m) => entry.modules.some((x) => x.key === m)));
  const t = (...parts: string[]) => [entry.token, ...parts].join(FACET_SEPARATOR);
  return [entry.token, ...levels.map((l) => t(l)), ...modules.flatMap((m) => [t(m), ...levels.map((l) => t(m, l))])];
}

/** What a hirer's requirement asks of the exact list: the credential, the level named, each module named, at that level. */
export function requiredTokens(entry: CertificateEntry, facets: CertFacets): string[] {
  const level = facets.level && entry.levels.some((l) => l.key === facets.level) ? facets.level : null;
  const modules = facets.modules.filter((m) => entry.modules.some((x) => x.key === m));
  const t = (...parts: string[]) => [entry.token, ...parts].join(FACET_SEPARATOR);
  return [entry.token, ...(level ? [t(level)] : []), ...modules.flatMap((m) => [t(m), ...(level ? [t(m, level)] : [])])];
}

// ── The import ──────────────────────────────────────────────────────────────

export interface CertificatePlan {
  tokens: RegistryToken[];
  labels: RegistryLabel[];
  counts: { certificates: number; labels: number };
}

/**
 * The seed as registry rows (D1) and label vectors (`token-registry-v1`),
 * for `registrySql` and `vectorLine` (`esco.ts`): each credential a `seed`
 * token, each worker's label one embedded label. A hirer's phrases, the
 * levels, the modules and the rest stay in the seed: the plane reads them
 * from it.
 */
export async function planCertificateImport(catalogue: CertificateCatalogue = certificates()): Promise<CertificatePlan> {
  const tokens: RegistryToken[] = [];
  const labels: RegistryLabel[] = [];
  for (const e of catalogue.entries) {
    tokens.push({ token: e.token, kind: 'cert', source: 'seed', labelEn: e.labelEn, escoUri: null, iscoCode: null, status: 'active', mergedInto: null });
    const first = new Set<string>();
    for (const l of e.labels) {
      const kind: LabelKind = first.has(l.lang) ? 'alternative' : 'preferred';
      first.add(l.lang);
      labels.push({ labelId: await labelIdOf(e.token, l.lang, l.norm), token: e.token, lang: l.lang, label: l.label, labelNorm: l.norm, kind, embedded: true });
    }
  }
  return { tokens, labels, counts: { certificates: tokens.length, labels: labels.length } };
}

// ── The registry's certificate path ────────────────────────────────────────

/** Certificate candidates Clef is shown at most: fewer and more distinct than an occupation's five (rule 7). */
export const CERT_CANDIDATES = 3;

/** What `snap` hands the certificate path: the string, its calls, and how a decision is kept. */
export interface CertificateSnapContext {
  raw: string;
  norm: string;
  calls: WorkCall[];
  tau: Tau;
  now: () => number;
  result: (r: SnapOutcome) => SnapResult;
  record: (r: SnapOutcome, model: string | null) => Promise<SnapResult>;
  observe: (token: string) => Promise<void>;
}

/**
 * A certificate's snap (`snap` calls it for `kind: 'cert'`): never a mint,
 * and every step before a model fails closed.
 *
 *  0. A string that says the credential is not held (an apprentice's, an
 *     expired or a pending one, or a claim whose validity date is past) is
 *     no token, and no model is asked.
 *  1. An exact label of the registry, for a credential that fits the string.
 *  2. The seed's exact match: a label once the level, the modules and the
 *     filler words are read off ("NCCCO Aparejador Nivel II" is `NCCCO
 *     aparejador` at Level II), or a hirer's phrase where the job is
 *     (`licensed electrician` in `us-tx`).
 *  3. The nearest labels, kept only for credentials that fit the string: it
 *     names them (a hirer may leave a state licence's state to the job's
 *     region), nothing in it names another credential, and every word the
 *     seed does not read off is the credential's own, a distinctive one
 *     among them when only a shared name says which (`accounts`). At most
 *     three, and only those in the band; one alone at or above τ_auto is
 *     taken.
 *  4. In the band Clef chooses one of them by key, or none, at its floor,
 *     never lowered for licensed work.
 *
 * The level and modules are always read off the string by the seed, never by
 * a model: a claim keeps the lower of two levels, a requirement the higher. A
 * worker's claim keeps its string as an alias; a hirer's words never do, so a
 * phrase read by the job's region never becomes a worker's label.
 */
export async function snapCertificate(deps: RegistryDeps, input: SnapInput, ctx: CertificateSnapContext): Promise<SnapResult> {
  const { raw, norm, calls, tau, now } = ctx;
  const catalogue = deps.certificates ?? certificates();
  const asOf = now();
  const read: ReadContext = input.mint === false ? { requirement: { region: input.region }, asOf } : { asOf };
  const claim = !read.requirement;
  const none = { token: null, labelEn: null, specialization: false, score: null, probability: null, candidates: [] as Candidate[] };
  const facetsOf = (entry: CertificateEntry, facets: CertFacets) => ({ facets, tokens: claim ? heldTokens(entry, facets) : requiredTokens(entry, facets) });
  /** The string may be this credential: it names it, nothing excludes it, and the seed reads every word of it. */
  const fits = (entry: CertificateEntry) => admits(entry, norm, read) && accounts(catalogue, entry, norm, read);

  // 0. Not held.
  if (saysNotHeld(catalogue, norm) || (claim && expiredClaim(norm, asOf))) return ctx.record({ decision: 'unmatched', ...none }, null);

  // 1. An exact label of one credential that fits.
  const labelled = (await deps.store.tokensByLabel(norm, 'cert')).flatMap((t) => {
    const entry = catalogue.byToken.get(t.token);
    return entry && fits(entry) ? [{ t, entry }] : [];
  });
  if (labelled.length === 1) {
    const { t, entry } = labelled[0]!;
    return ctx.result({ decision: 'label', token: t.token, labelEn: t.labelEn, specialization: false, score: 1, probability: null, candidates: [], ...facetsOf(entry, readFacets(entry, norm, read).facets) });
  }

  // 2. The seed's exact match, and a hirer's phrase where the job is.
  const matched = matchCertificate(catalogue, norm, read).filter((m) => m.via === 'requirement' || admits(m.entry, norm, read));
  if (matched.length === 1) {
    const { entry, facets } = matched[0]!;
    const live = (await deps.store.tokens([entry.token])).get(entry.token);
    if (live?.token === entry.token) {
      if (claim) await ctx.observe(entry.token);
      return ctx.result({ decision: 'label', token: entry.token, labelEn: live.labelEn, specialization: false, score: 1, probability: null, candidates: [], ...facetsOf(entry, facets) });
    }
  }

  // 3. The nearest labels, for credentials that fit.
  const embedding = await embedTexts(deps.inference, [raw], { now, log: deps.log });
  calls.push(embedding.call);
  if (!embedding.ok) return ctx.result({ decision: 'unmatched', ...none });
  const near = (await candidatesFor(deps, 'cert', embedding.vectors[0]!))
    .flatMap((c) => {
      const entry = catalogue.byToken.get(c.token);
      return entry && fits(entry) ? [{ ...c, detail: describeCertificate(catalogue, entry) }] : [];
    })
    .slice(0, CERT_CANDIDATES);
  const candidates = near.filter((c) => c.score >= tau.low);
  const [top, second] = candidates;
  if (!top) return ctx.record({ decision: 'unmatched', ...none, score: near[0]?.score ?? null, candidates: near }, null);
  if (top.score >= tau.auto && !(second && second.score >= tau.auto)) {
    const entry = catalogue.byToken.get(top.token)!;
    if (claim) await ctx.observe(top.token);
    return ctx.record(
      { decision: 'auto', token: top.token, labelEn: top.labelEn, specialization: false, score: top.score, probability: null, candidates, ...facetsOf(entry, readFacets(entry, norm, read).facets) },
      embedding.call.model,
    );
  }

  // 4. Clef in the band.
  const model = await deps.inference.model('work-adjudicate');
  const request = clefInput(model, adjudicationState('cert', raw, input.lang), adjudicationQuestions('cert', candidates));
  const t0 = now();
  let answer: unknown;
  try {
    answer = await deps.inference.run('work-adjudicate', request);
  } catch (err) {
    calls.push({ op: 'work-adjudicate', model, ok: false, ms: now() - t0, usage: estimatedUsage(request) });
    deps.log?.({ event: 'work_adjudicate_failed', model, reason: failureCode(err) });
    return ctx.record({ decision: 'unmatched', ...none, score: top.score, candidates }, model);
  }
  const keys = [...candidates.map((_, i) => `c${i}`), 'none'];
  const pick = readChoice(answer, 'match', keys, ADJUDICATION_FLOOR);
  const answered = pick.p > 0 || Object.keys(pick.probabilities).length > 0;
  calls.push({ op: 'work-adjudicate', model, ok: answered, ms: now() - t0, usage: { ...usageOrEstimate(answer, request), neurons: null } });
  if (!answered) deps.log?.({ event: 'work_adjudicate_failed', model, reason: 'no_answer' });
  if (!pick.choice || pick.choice === 'none') {
    return ctx.record({ decision: 'unmatched', ...none, score: top.score, probability: answered && pick.choice !== 'none' ? pick.p : null, candidates }, model);
  }
  const chosen = candidates[Number(pick.choice.slice(1))]!;
  const entry = catalogue.byToken.get(chosen.token)!;
  const { facets } = readFacets(entry, norm, read);
  if (claim) await ctx.observe(chosen.token);
  return ctx.record({ decision: 'chosen', token: chosen.token, labelEn: chosen.labelEn, specialization: false, score: top.score, probability: pick.p, candidates, ...facetsOf(entry, facets) }, model);
}
