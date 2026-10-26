// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The US layer (workspace decision 0066): O*NET's job titles become US labels
 * of ESCO's occupation tokens. The bridge is the official ESCO–O*NET crosswalk
 * (version 1, September 2022), which matches O*NET-SOC 2019 occupations to
 * ESCO v1.1.0 ones as exact, close, broad, narrow or exactISCO.
 *
 * Each title is placed on one token, chosen among its O*NET occupation's
 * candidates:
 * - the ESCO occupations of its exact, close and broad matches (broad: the
 *   O*NET occupation is the wider one);
 * - those of its narrow matches, as the broader occupation, since a
 *   specialization snaps to its occupation;
 * - for exactISCO, every ESCO occupation of that ISCO-08 unit group.
 *
 * How the token is chosen. The candidates are ranked by the best cosine
 * between the title and each candidate's English labels:
 * - the best is taken without a model when it reaches `sure` (the registry's
 *   τ_auto) and leads the second by `margin`;
 * - otherwise Clef is asked its choice among the best five, by key, or none,
 *   with the O*NET occupation beside the title. A single candidate goes to
 *   Clef too: the crosswalk often gives a catch-all O*NET occupation ("…, All
 *   Other") one ESCO occupation that most of its titles are not ("Trench
 *   Digger" under tent installer, the 2026-10-25 dry run).
 * - Clef's answer is read in two parts, as calibrated on titles ESCO already
 *   holds (`test/onet.calibrate.test.ts`). Whether the title is one of the
 *   candidates is Clef's probability of none, at most `noneMax`. Which one is
 *   Clef's choice when it reaches `floor`; else the embedding's best, but only
 *   when it is also Clef's most probable candidate (`disagreed` otherwise:
 *   where they part, the embedding's pick is often a word match, "Quality
 *   Checker" on cigar inspector).
 *
 * What is left out:
 * - A title the registry already holds in English stays where it is, so
 *   ESCO's own words keep their tokens; one it holds only in Portuguese or
 *   Spanish is placed on that holder or nowhere (`layerLabelSets`).
 * - A title placed on two tokens is left out of both, since a label of two
 *   occupations cannot decide a snap.
 * - A bare acronym ("CPA", "CMO") is left out, since it names too much
 *   outside O*NET for an exact label.
 *
 * No model writes a code: the codes are the crosswalk's.
 *
 * O*NET 31.0 is under CC BY 4.0. Each label's `source` names its release and
 * code, and the import report says what was changed: each title was placed on
 * an ESCO token.
 */

import type { Inference } from '../inference/index.js';
import { adjudicationQuestions, clefInput, nationalTitleState, readChoice } from './clef.js';
import { parseCsv } from './esco.js';
import type { CodeRelation, NationalCode, NationalLabel } from './national.js';
import { ADJUDICATION_CANDIDATES, DEFAULT_TAU, labelIdOf, type EmbedRole, labelNorm, type Candidate, type RegistryLabel, type RegistryToken } from './registry.js';

export type CrosswalkMatch = 'exactMatch' | 'closeMatch' | 'broadMatch' | 'narrowMatch' | 'exactISCO';

export interface CrosswalkRow {
  onetCode: string;
  onetTitle: string;
  /** An ESCO occupation URI, or for exactISCO an ISCO-08 unit group URI. */
  target: string;
  match: CrosswalkMatch;
}

const RELATION: Record<CrosswalkMatch, CodeRelation> = {
  exactMatch: 'exact',
  closeMatch: 'close',
  broadMatch: 'broad',
  narrowMatch: 'narrow',
  exactISCO: 'isco',
};
/** The stronger relation is kept when a token is a candidate twice. */
const STRENGTH: Record<CodeRelation, number> = { exact: 0, close: 1, broad: 2, narrow: 3, isco: 4 };

export const ONET_SCHEME = 'onet-soc-2019';
export const ONET_CROSSWALK = 'esco-onet-crosswalk-v1';
/** The region of the US layer's labels. */
export const ONET_REGION = 'us';
/** The classification as Clef reads it. */
const ONET_NAME = 'the US O*NET database';
/** How far the best candidate must lead the second, in cosine, to be taken without Clef. */
export const ONET_MARGIN = 0.04;
/** The cosine the best candidate must reach to be taken without Clef: the registry's τ_auto. */
export const ONET_SURE = DEFAULT_TAU.auto;
/**
 * Clef's most probable none for a title placed: above it the title is left
 * out. A wrong label is taken by the exact-label shortcut without a model,
 * while a title left out is snapped as it is today, so the reading is strict:
 * Clef's own choice from `ONET_FLOOR`, else the embedding's best only when it
 * is also Clef's most probable candidate. On 400 titles ESCO already holds
 * (`test/work-eval/onet-clef-2026-10-26.md`): asked with their own
 * occupation's candidates, 47% were placed, 84% of those on the candidate
 * ESCO gives the title and the rest on another candidate of the occupation;
 * asked with another occupation's, 0.8% were placed. Without the agreement
 * check, 0.15 placed 1.8% of those, and a graded sample of what it added put
 * one in eight titles in use and one in four index titles on the wrong
 * occupation, nearly all where Clef and the embedding disagreed (2026-10-26).
 */
export const ONET_NONE_MAX = 0.15;
/** The probability at which Clef's own choice names the token; below it the embedding's best does. */
export const ONET_FLOOR = 0.7;

export class OnetFormatError extends Error {}

// ── The files ───────────────────────────────────────────────────────────────

/** The crosswalk CSV: a block of project metadata, then a header row that starts `O*NET Id`. */
export function readCrosswalk(text: string): CrosswalkRow[] {
  const rows = parseCsv(text);
  const h = rows.findIndex((r) => r[0]?.trim() === 'O*NET Id');
  if (h < 0) throw new OnetFormatError('no header row starting "O*NET Id"');
  const head = rows[h]!.map((c) => c.trim());
  const col = (name: string) => {
    const i = head.indexOf(name);
    if (i < 0) throw new OnetFormatError(`missing ${name}; the header has: ${head.join(', ')}`);
    return i;
  };
  const code = col('O*NET Id');
  const title = col('O*NET Title');
  const uri = col('ESCO or ISCO URI');
  const type = col('Type of Match');
  const out: CrosswalkRow[] = [];
  for (const r of rows.slice(h + 1)) {
    const match = r[type]?.trim() ?? '';
    const onetCode = r[code]?.trim() ?? '';
    const target = r[uri]?.trim() ?? '';
    if (!onetCode || !target || !match) continue;
    if (!(match in RELATION)) throw new OnetFormatError(`unknown match type "${match}" for ${onetCode}`);
    out.push({ onetCode, onetTitle: r[title]?.trim() ?? '', target, match: match as CrosswalkMatch });
  }
  return out;
}

export interface OnetTitle {
  onetCode: string;
  title: string;
  /** O*NET's short form of the title, where it gives one ("BD Executive", "CEO"). */
  short: string | null;
}

/** An O*NET title file, in file order: `job_titles.csv` (Job Title, Short Title) or `sample_of_reported_titles.csv` (Reported Job Title). */
export function readOnetTitles(text: string): OnetTitle[] {
  const rows = parseCsv(text);
  const head = rows[0]?.map((c) => c.trim()) ?? [];
  const code = head.indexOf('O*NET-SOC Code');
  const title = [head.indexOf('Job Title'), head.indexOf('Reported Job Title')].find((i) => i >= 0) ?? -1;
  const short = head.indexOf('Short Title');
  if (code < 0 || title < 0) throw new OnetFormatError(`missing O*NET-SOC Code or a title column; the header has: ${head.join(', ')}`);
  const out: OnetTitle[] = [];
  for (const r of rows.slice(1)) {
    const c = r[code]?.trim();
    const t = r[title]?.trim();
    if (!c || !t) continue;
    out.push({ onetCode: c, title: t, short: (short >= 0 && r[short]?.trim()) || null });
  }
  return out;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const addTo = <K, V>(map: Map<K, Set<V>>, key: K, value: V) => (map.get(key) ?? map.set(key, new Set()).get(key)!).add(value);
/** A title ending in a parenthesis: "CPA (Certified Public Accountant)", "Endoscopy Technician (Endoscopy Tech)". */
const ENDS_IN_PARENTHESIS = /^(.+?)\s*\((.+)\)$/;
/** A form with no lower-case letter is a bare acronym: "CPA", "AP BD+C". */
const isAcronym = (s: string) => !/\p{Ll}/u.test(s);

const words = (s: string) => new Set(labelNorm(s).split(' ').filter(Boolean));

/**
 * The forms of an O*NET title that can become labels.
 * - A title ending in a parenthesis is a long form and a short one, in either
 *   order: the short title says which is which; without one, a part with no
 *   lower-case letter is the abbreviation ("LPC (Licensed Professional
 *   Counselor)"), and of two parts that share a word the longer is the long
 *   form ("Endoscopy Technician (Endoscopy Tech)").
 * - Two parts that are neither are a title and a qualifier ("Singer
 *   (Burning)", a singer of cloth): neither names the occupation alone, so the
 *   title is left out (`qualified`).
 * - The short title is a form of its own.
 * - A parenthesis inside a form is an aside and goes ("Electroencephalogram
 *   (EEG) Technologist").
 * - A bare acronym is returned apart, to be counted, never labelled.
 */
export function titleForms(title: string, short: string | null): { forms: string[]; acronyms: string[]; qualified: boolean } {
  const t = clean(title);
  const s = short ? clean(short) : '';
  const m = ENDS_IN_PARENTHESIS.exec(t);
  let parts: string[];
  if (m) {
    const a = clean(m[1]!);
    const b = clean(m[2]!);
    const sn = s ? labelNorm(s) : '';
    if (sn && sn === labelNorm(a)) parts = [b, s];
    else if (sn && sn === labelNorm(b)) parts = [a, s];
    else if (isAcronym(b) && !isAcronym(a)) parts = [a, ...(s ? [s] : [])];
    else if (isAcronym(a) && !isAcronym(b)) parts = [b, ...(s ? [s] : [])];
    else if ([...words(a)].some((w) => words(b).has(w))) parts = [a.length >= b.length ? a : b, ...(s ? [s] : [])];
    else return { forms: [], acronyms: [], qualified: true };
  } else parts = s ? [t, s] : [t];
  const forms: string[] = [];
  const acronyms: string[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const f = clean(p.replace(/\s*\([^()]*\)/g, '').replace(/[()]/g, ''));
    const norm = labelNorm(f);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    (isAcronym(f) ? acronyms : forms).push(f);
  }
  return { forms, acronyms, qualified: false };
}

// ── Candidates ──────────────────────────────────────────────────────────────

export interface OnetCandidate {
  token: RegistryToken;
  relation: CodeRelation;
}

/** Each O*NET occupation's candidate tokens, from its crosswalk rows: active occupations of the registry only. */
export function onetCandidates(rows: readonly CrosswalkRow[], tokens: readonly RegistryToken[]): Map<string, OnetCandidate[]> {
  const occupations = tokens.filter((t) => t.kind === 'pos' && t.status === 'active');
  const byUri = new Map(occupations.filter((t) => t.escoUri).map((t) => [t.escoUri!, t]));
  const byIsco = new Map<string, RegistryToken[]>();
  for (const t of occupations) {
    if (!t.iscoCode) continue;
    const list = byIsco.get(t.iscoCode) ?? [];
    list.push(t);
    byIsco.set(t.iscoCode, list);
  }
  const out = new Map<string, OnetCandidate[]>();
  for (const r of rows) {
    const list = out.get(r.onetCode) ?? [];
    const relation = RELATION[r.match];
    const add = (t: RegistryToken) => {
      const i = list.findIndex((c) => c.token.token === t.token);
      if (i < 0) list.push({ token: t, relation });
      else if (STRENGTH[relation] < STRENGTH[list[i]!.relation]) list[i] = { token: t, relation };
    };
    if (r.match === 'exactISCO') {
      // A unit group (C2149) or, in four rows of version 1, a minor group (C612): every occupation under it.
      const group = /C?(\d{3,4})\s*$/.exec(r.target)?.[1];
      if (group) for (const [isco, list] of byIsco) if (isco.startsWith(group)) list.forEach(add);
    } else {
      const t = byUri.get(r.target);
      if (t) add(t);
    }
    out.set(r.onetCode, list);
  }
  return out;
}

/**
 * What the plan needs of the registry's labels.
 * - `english`: each occupation's English labels (preferred and alternative),
 *   to rank candidates.
 * - `known`: every English occupation label, of any kind, by norm. The
 *   exact-label shortcut reads an English string's English labels only
 *   (`labelLangs`, since 2026-10-26), so a title held there stays where it
 *   is: `known` on one of its candidates, `elsewhere` on another token.
 * - `foreign`: the Portuguese and Spanish occupation labels, by norm. A
 *   Portuguese or Spanish string reads its own language and English, so an
 *   English label on another token would make that label ambiguous for it: a
 *   title held only there may be placed on its holder ("detective",
 *   "tenor"), never elsewhere.
 */
export function layerLabelSets(tokens: readonly RegistryToken[], labels: readonly RegistryLabel[]) {
  const occupations = new Map(tokens.filter((t) => t.kind === 'pos').map((t) => [t.token, t]));
  const english = new Map<string, string[]>();
  const known = new Map<string, Set<string>>();
  const foreign = new Map<string, Set<string>>();
  for (const t of occupations.values()) english.set(t.token, [t.labelEn]);
  for (const l of labels) {
    if (!occupations.has(l.token)) continue;
    addTo(l.lang === 'en' ? known : foreign, l.labelNorm, l.token);
    if (l.lang !== 'en' || (l.kind !== 'preferred' && l.kind !== 'alternative')) continue;
    const list = english.get(l.token)!;
    if (!list.includes(l.label)) list.push(l.label);
  }
  return { english, known, foreign };
}

// ── The plan ────────────────────────────────────────────────────────────────

export interface OnetPlanInput {
  crosswalk: CrosswalkRow[];
  /** O*NET's job titles and reported titles, in file order. */
  titles: OnetTitle[];
  /** The registry's tokens, as the ESCO import planned them (ESCO URIs and ISCO codes). */
  tokens: RegistryToken[];
  /** `layerLabelSets` of the registry's labels. */
  english: Map<string, string[]>;
  known: Map<string, Set<string>>;
  foreign?: Map<string, Set<string>>;
  /** The O*NET release the titles come from: `31.0`. */
  release: string;
}

export interface OnetAsk {
  title: string;
  onetCode: string;
  /** The O*NET occupation's title, which Clef reads as context. */
  occupation: string;
}

export interface OnetChoice {
  token: string | null;
  p: number | null;
  /** Clef's probability for each shown candidate, by token, and for `none`. */
  probabilities?: Record<string, number>;
  /** The call failed or answered nothing: no choice, and the report says so. */
  failed?: boolean;
}

export interface OnetPlanDeps {
  /**
   * Vectors for texts in their role, in order (called with up to 100 at a
   * time); null for a text the model cannot embed. A title is a query when
   * candidates are ranked for it and a document once it is a label; a
   * candidate's label is a document.
   */
  embed(texts: string[], role: EmbedRole): Promise<(number[] | null)[]>;
  /** Clef, where the cosine is not sure; without it such a title is placed nowhere. */
  choose?(ask: OnetAsk, candidates: Candidate[]): Promise<OnetChoice>;
  margin?: number;
  sure?: number;
  noneMax?: number;
  /** Embedding batches and Clef calls in flight at once. Default 1. */
  parallel?: number;
  progress?(event: string, done: number, total: number): void;
}

export type PlacementMethod =
  | 'single'
  | 'lead'
  | 'clef'
  | 'none'
  | 'clef_failed'
  | 'disagreed'
  | 'known'
  | 'elsewhere'
  | 'ambiguous'
  | 'acronym'
  | 'qualified'
  | 'no_candidate'
  | 'unembedded';

export interface TitlePlacement {
  onetCode: string;
  title: string;
  /** The token the title went to, or would have gone to (ambiguous), or that holds it already (known, elsewhere). */
  token: string | null;
  method: PlacementMethod;
  candidates: number;
  /** The best and second-best cosine among the candidates (no second for a single one). */
  best: number | null;
  second: number | null;
  /** Clef's probability of its choice, and of none, when Clef was asked. */
  p: number | null;
  none: number | null;
}

/** The methods that put a label on a token. */
const PLACED: ReadonlySet<PlacementMethod> = new Set(['single', 'lead', 'clef']);

export interface OnetPlan {
  labels: NationalLabel[];
  /** Each label's vector, by label id: the title's own embedding. */
  vectors: Map<string, number[]>;
  codes: NationalCode[];
  placements: TitlePlacement[];
  counts: Record<PlacementMethod | 'titles' | 'labels' | 'codes', number>;
}

const dot = (a: readonly number[], b: readonly number[]) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};
const unit = (v: readonly number[]) => {
  const n = Math.sqrt(dot(v, v)) || 1;
  return v.map((x) => x / n);
};

async function pool<T>(items: readonly T[], parallel: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, items.length)) }, worker));
}

/** Embed every distinct text once in its role, 100 at a time, as unit vectors; a text the model cannot embed has none. */
async function embedAll(deps: OnetPlanDeps, texts: readonly string[], role: EmbedRole): Promise<Map<string, number[]>> {
  const unique = [...new Set(texts)];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += 100) batches.push(unique.slice(i, i + 100));
  const out = new Map<string, number[]>();
  let done = 0;
  await pool(batches, deps.parallel ?? 1, async (batch) => {
    const vectors = await deps.embed(batch, role);
    if (vectors.length !== batch.length) throw new Error(`embed answered ${vectors.length} vectors for ${batch.length} texts`);
    batch.forEach((t, j) => {
      const v = vectors[j];
      if (v) out.set(t, unit(v));
    });
    done += batch.length;
    deps.progress?.(`embedded (${role})`, done, unique.length);
  });
  return out;
}

interface Entry {
  onetCode: string;
  title: string;
  norm: string;
  placement: TitlePlacement;
  /** The candidates ranked by cosine, for a contest. */
  ranked?: { c: OnetCandidate; score: number; matched: string }[];
}

/** Place every O*NET title on one candidate token, or on none; see the module comment. */
export async function planOnetLayer(input: OnetPlanInput, deps: OnetPlanDeps): Promise<OnetPlan> {
  const margin = deps.margin ?? ONET_MARGIN;
  const candidates = onetCandidates(input.crosswalk, input.tokens);
  const occupationTitle = new Map<string, string>();
  for (const r of input.crosswalk) if (!occupationTitle.has(r.onetCode)) occupationTitle.set(r.onetCode, r.onetTitle);

  // Each code's distinct forms, and what can be said of each before any model.
  const entries: Entry[] = [];
  const seen = new Set<string>();
  const placement = (onetCode: string, title: string, method: PlacementMethod, token: string | null = null): TitlePlacement => ({
    onetCode,
    title,
    token,
    method,
    candidates: candidates.get(onetCode)?.length ?? 0,
    best: null,
    second: null,
    p: null,
    none: null,
  });
  for (const t of input.titles) {
    const { forms, acronyms, qualified } = titleForms(t.title, t.short);
    if (qualified) {
      const title = clean(t.title);
      const key = `${t.onetCode}\u0000${labelNorm(title)}`;
      if (!seen.has(key)) entries.push({ onetCode: t.onetCode, title, norm: labelNorm(title), placement: placement(t.onetCode, title, 'qualified') });
      seen.add(key);
    }
    for (const [title, acronym] of [...forms.map((f) => [f, false] as const), ...acronyms.map((a) => [a, true] as const)]) {
      const norm = labelNorm(title);
      const key = `${t.onetCode}\u0000${norm}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cands = candidates.get(t.onetCode) ?? [];
      const holders = input.known.get(norm);
      let p: TitlePlacement;
      if (acronym) p = placement(t.onetCode, title, 'acronym');
      else if (!cands.length) p = placement(t.onetCode, title, 'no_candidate');
      else if (holders) {
        const here = cands.find((c) => holders.has(c.token.token));
        p = placement(t.onetCode, title, here ? 'known' : 'elsewhere', here?.token.token ?? [...holders][0]!);
      } else p = placement(t.onetCode, title, 'none');
      entries.push({ onetCode: t.onetCode, title, norm, placement: p });
    }
  }

  // Vectors: every title that may become a label, and the English labels of its candidates.
  const open = entries.filter((e) => e.placement.method === 'none');
  const ranked = new Set(open.flatMap((e) => candidates.get(e.onetCode)!.map((c) => c.token.token)));
  const titleVectors = await embedAll(deps, open.map((e) => e.title), 'query');
  const labelVectors = await embedAll(deps, [...ranked].flatMap((t) => input.english.get(t) ?? []), 'document');

  // The candidates ranked by cosine: a sure, clear best is taken, anything else goes to Clef.
  const sure = deps.sure ?? ONET_SURE;
  const noneMax = deps.noneMax ?? ONET_NONE_MAX;
  const close: Entry[] = [];
  for (const e of open) {
    const v = titleVectors.get(e.title);
    if (!v) {
      e.placement.method = 'unembedded';
      continue;
    }
    e.ranked = candidates
      .get(e.onetCode)!
      .map((c) => {
        let score = -1;
        let matched = c.token.labelEn;
        for (const l of input.english.get(c.token.token) ?? [c.token.labelEn]) {
          const w = labelVectors.get(l);
          const s = w ? dot(v, w) : -1;
          if (s > score) [score, matched] = [s, l];
        }
        return { c, score, matched };
      })
      .sort((a, b) => b.score - a.score);
    const [first, second] = e.ranked as [(typeof e.ranked)[number], (typeof e.ranked)[number] | undefined];
    e.placement.best = first.score;
    e.placement.second = second?.score ?? null;
    if (first.score >= sure && (!second || first.score - second.score >= margin)) Object.assign(e.placement, { method: second ? 'lead' : 'single', token: first.c.token.token });
    else close.push(e);
  }
  if (deps.choose) {
    const choose = deps.choose.bind(deps);
    let done = 0;
    await pool(close, deps.parallel ?? 1, async (e) => {
      const shown: Candidate[] = e.ranked!.slice(0, ADJUDICATION_CANDIDATES).map((r) => ({
        token: r.c.token.token,
        labelEn: r.c.token.labelEn,
        matched: r.matched,
        matchedLang: 'en',
        score: r.score,
      }));
      const pick = await choose({ title: e.title, onetCode: e.onetCode, occupation: occupationTitle.get(e.onetCode) ?? '' }, shown);
      // Whether: Clef's probability of none (an answer without it fails). Which: Clef's choice at its floor, else the
      // embedding's best when it is also Clef's most probable candidate; when they name different ones, nothing.
      const none = pick.probabilities?.none ?? null;
      const failed = Boolean(pick.failed) || none == null;
      const chosen = pick.token && shown.some((s) => s.token === pick.token) ? pick.token : null;
      const p = (t: string) => pick.probabilities?.[t] ?? 0;
      const likeliest = shown.reduce((a, b) => (p(b.token) > p(a.token) ? b : a)).token;
      let method: PlacementMethod;
      let token: string | null = null;
      if (failed) method = 'clef_failed';
      else if (none > noneMax) method = 'none';
      else if (chosen) [method, token] = ['clef', chosen];
      else if (likeliest === shown[0]!.token) [method, token] = ['clef', likeliest];
      else method = 'disagreed';
      Object.assign(e.placement, { token, p: pick.p, none, method });
      deps.progress?.('chosen', ++done, close.length);
    });
  }

  // A title held only in Portuguese or Spanish goes on its holder or nowhere.
  for (const e of entries) {
    const holders = input.foreign?.get(e.norm);
    if (holders && PLACED.has(e.placement.method) && !holders.has(e.placement.token!)) Object.assign(e.placement, { method: 'elsewhere', token: [...holders][0]! });
  }

  // A title placed on two tokens is left out of both.
  const placedOn = new Map<string, Set<string>>();
  for (const e of entries) if (PLACED.has(e.placement.method)) addTo(placedOn, e.norm, e.placement.token!);
  for (const e of entries) if (PLACED.has(e.placement.method) && placedOn.get(e.norm)!.size > 1) e.placement.method = 'ambiguous';

  // Each label's own vector: its title embedded as a document. A title the model cannot embed so is left out.
  const stored = await embedAll(deps, [...new Set(entries.filter((e) => PLACED.has(e.placement.method)).map((e) => e.title))], 'document');
  for (const e of entries) if (PLACED.has(e.placement.method) && !stored.has(e.title)) e.placement.method = 'unembedded';

  const labels = new Map<string, NationalLabel>();
  const reached = new Map<string, Set<string>>();
  for (const e of entries) {
    const { method, token } = e.placement;
    if (token && (PLACED.has(method) || method === 'known')) addTo(reached, e.onetCode, token);
    if (!token || !PLACED.has(method)) continue;
    const labelId = await labelIdOf(token, 'en', e.norm);
    if (labels.has(labelId)) continue;
    labels.set(labelId, {
      labelId,
      embedded: true,
      token,
      lang: 'en',
      label: e.title,
      labelNorm: e.norm,
      kind: 'alternative',
      source: `onet:${input.release}:${e.onetCode}`,
      region: ONET_REGION,
    });
  }

  // The crosswalk's codes on its tokens; an exactISCO code only on the tokens its titles reached.
  const codes = new Map<string, NationalCode>();
  for (const [onetCode, cands] of candidates) {
    for (const c of cands) {
      if (c.relation === 'isco' && !reached.get(onetCode)?.has(c.token.token)) continue;
      const key = `${c.token.token}\u0000${onetCode}`;
      if (!codes.has(key)) codes.set(key, { token: c.token.token, scheme: ONET_SCHEME, code: onetCode, relation: c.relation, source: ONET_CROSSWALK });
    }
  }

  const placements = entries.map((e) => e.placement);
  const counts: OnetPlan['counts'] = {
    titles: placements.length,
    labels: labels.size,
    codes: codes.size,
    single: 0,
    lead: 0,
    clef: 0,
    none: 0,
    clef_failed: 0,
    disagreed: 0,
    known: 0,
    elsewhere: 0,
    ambiguous: 0,
    acronym: 0,
    qualified: 0,
    no_candidate: 0,
    unembedded: 0,
  };
  for (const p of placements) counts[p.method]++;
  const out = [...labels.values()];
  return { labels: out, vectors: new Map(out.map((l) => [l.labelId, stored.get(l.label)!])), codes: [...codes.values()], placements, counts };
}

/**
 * Clef as the plan's chooser: the band's question over the shown candidates,
 * with the O*NET occupation as context. Its choice counts at `floor`
 * (`ONET_FLOOR`), and every probability it gave comes back, none's included,
 * for the plan's reading. A call that fails or answers nothing chooses nothing
 * and says so.
 */
export function clefChooser(inference: Inference, opts: { floor?: number } = {}): NonNullable<OnetPlanDeps['choose']> {
  const floor = opts.floor ?? ONET_FLOOR;
  return async (ask, shown) => {
    const model = await inference.model('work-adjudicate');
    const request = clefInput(model, nationalTitleState(ask.title, ask.occupation, ONET_NAME), adjudicationQuestions('pos', shown));
    let answer: unknown;
    try {
      answer = await inference.run('work-adjudicate', request);
    } catch {
      return { token: null, p: null, failed: true };
    }
    const keys = [...shown.map((_, i) => `c${i}`), 'none'];
    const pick = readChoice(answer, 'match', keys, floor);
    if (!(pick.p > 0 || Object.keys(pick.probabilities).length > 0)) return { token: null, p: null, failed: true };
    const probabilities: Record<string, number> = {};
    shown.forEach((c, i) => {
      const v = pick.probabilities[`c${i}`];
      if (v != null) probabilities[c.token] = v;
    });
    // The plan reads none's probability first: an answer without it is no answer.
    if (pick.probabilities.none == null) return { token: null, p: null, failed: true };
    probabilities.none = pick.probabilities.none;
    if (!pick.choice || pick.choice === 'none') return { token: null, p: pick.p, probabilities };
    return { token: shown[Number(pick.choice.slice(1))]!.token, p: pick.p, probabilities };
  };
}
