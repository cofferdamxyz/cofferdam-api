// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The locale arms of the real-vacancy benchmark (`test/workJobs.eval.test.ts`,
 * JOBS_ARMS): production's requests (`market`: a worker's titles and skills
 * snap with their listing's region, `listings.ts` `claimSnapInput`), or the
 * same with that market out of what the registry's model steps say of a
 * string (`language`), as production says it of a string with no market
 * (workspace `docs/product/engine.md`, Token registry, "What the model steps
 * are told"). The switch is the eval's alone: it rewrites the hosted requests
 * on their way out, so the registry, the listing and every other step run as
 * in production. Also here: the key a band request is about, the search term
 * that found an ad as a reference for its title's snap, and the judge that
 * reads the ad where the arms' snaps differ. Pure, and tested offline in
 * `test/workLocaleArms.test.ts`.
 */

import { languageName, regionName, writtenIn } from '../../src/services/work/locale.js';
import type { TokenKind } from '../../src/services/work/registry.js';

export const ARMS = ['market', 'language'] as const;
export type Arm = (typeof ARMS)[number];

/** JOBS_ARMS: `market` (the default, production), `language`, or both, each once, in the order given. */
export function armsOf(spec: string | undefined): Arm[] {
  const arms = (spec ?? 'market')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!arms.length || new Set(arms).size !== arms.length || arms.some((a) => !(ARMS as readonly string[]).includes(a))) {
    throw new Error(`JOBS_ARMS takes ${ARMS.join(' and ')}, each at most once: "${spec ?? ''}"`);
  }
  return arms as Arm[];
}

/**
 * What production writes of a worker's string in each of these markets, and
 * what it writes of the same string with no market (`writtenIn`): "written in
 * Brazilian Portuguese by a worker in Brazil (br-sp)" and "written in
 * Portuguese by a worker or a hirer". A market that is not a region names
 * nothing, so it has no phrase.
 */
export function marketPhrases(locales: Iterable<{ lang: string; region: string }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const { lang, region } of locales) {
    const said = writtenIn({ lang, market: region });
    const unsaid = writtenIn({ lang });
    if (said !== unsaid) out.set(said, unsaid);
  }
  return out;
}

/**
 * The language arm's request: production's, with each market phrase written
 * as without the market wherever the request carries it (Clef's band state,
 * the pivot's message), and nothing else changed.
 */
export function withoutMarket<T>(value: T, phrases: ReadonlyMap<string, string>): T {
  if (typeof value === 'string') {
    let s: string = value;
    for (const [from, to] of phrases) s = s.split(from).join(to);
    return s as T;
  }
  if (Array.isArray(value)) return value.map((v: unknown) => withoutMarket(v, phrases)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutMarket(v, phrases)])) as T;
  return value;
}

/** A band state that names a worker's market (`adjudicationState`, `writtenIn`). */
const MARKET_HEAD = /^An? (?:occupation|skill|certificate or licence) written in [^\n]+? by a worker in /;

/**
 * Whether a request still names a worker's market, in a band state it
 * carries (Clef's `state`, the pivot's message): in the language arm, a leak.
 * Only a band state counts, so a claim or a hirer's sentence that happens to
 * say "by a worker in" is none.
 */
export function namesMarket(request: unknown): boolean {
  if (typeof request === 'string') return MARKET_HEAD.test(request);
  const items: unknown[] = Array.isArray(request) ? request : request && typeof request === 'object' ? Object.values(request) : [];
  return items.some(namesMarket);
}

/**
 * A string as the arms compare it: its kind, its language and the string as
 * the registry stores it (NFC, runs of white space as one). Two spellings of
 * one label ("Soldador", "SOLDADOR") are two strings: whichever an arm snaps
 * first decides the other by its alias, and the arms may not snap them in the
 * same order.
 */
export const stringKey = (kind: string, lang: string, raw: string): string => `${kind}|${lang}|${raw.normalize('NFC').replace(/\s+/g, ' ').trim()}`;

const BAND_HEAD = /^An? (occupation|skill|certificate or licence) written in (.+?) by a (?:worker in .+|worker or a hirer):\n([\s\S]+)$/;
const KIND_OF_NOUN: Readonly<Record<string, TokenKind>> = { occupation: 'pos', skill: 'skill', 'certificate or licence': 'cert' };
const langOfName = (name: string): string => (name.includes('English') ? 'en' : name.includes('Portuguese') ? 'pt' : name.includes('Spanish') ? 'es' : name);

/**
 * The string a registry band request is about (`stringKey`), read from the
 * band state it carries (`adjudicationState`): Clef's `state`, or the pivot's
 * message. Null for any other request.
 */
export function bandKey(request: unknown): string | null {
  if (typeof request === 'string') {
    const m = BAND_HEAD.exec(request);
    return m ? stringKey(KIND_OF_NOUN[m[1]!]!, langOfName(m[2]!), m[3]!) : null;
  }
  const items: unknown[] = Array.isArray(request) ? request : request && typeof request === 'object' ? Object.values(request) : [];
  for (const item of items) {
    const key = bandKey(item);
    if (key) return key;
  }
  return null;
}

// ── The search term that found an ad, as a reference for its title ─────────

export type Relation = 'right' | 'near' | 'industry' | 'far';

/**
 * The ISCO-08 unit groups each JobSpy search term names (the terms of
 * `scripts/work/jobspy-pull.py`'s pull of 2026-10-27): an ad's title that
 * snaps to one of them is the term's occupation. The search returns
 * neighbouring jobs too (a forklift driver for "warehouse associate"), and
 * that noise is the same in every arm, so the measure compares arms, not
 * absolute accuracy.
 */
export const TERM_ISCO: Readonly<Record<string, readonly string[]>> = {
  'registered nurse': ['2221', '3221'],
  enfermeiro: ['2221', '3221'],
  enfermera: ['2221', '3221'],
  'HVAC technician': ['7127'],
  'técnico de refrigeração': ['7127'],
  'técnico en refrigeración': ['7127'],
  'diesel mechanic': ['7231', '7233'],
  mecânico: ['7231', '7233'],
  mecánico: ['7231', '7233'],
  'truck driver': ['8332'],
  motorista: ['8322', '8331', '8332'],
  chofer: ['8322', '8331', '8332'],
  electrician: ['7411', '7412'],
  'offshore electrician': ['7411', '7412'],
  eletricista: ['7411', '7412'],
  electricista: ['7411', '7412'],
  'warehouse associate': ['4321', '9321', '9333'],
  'auxiliar de logística': ['4321', '9321', '9333'],
  'auxiliar de almacén': ['4321', '9321', '9333'],
  accountant: ['2411', '3313', '4311'],
  contador: ['2411', '3313', '4311'],
  welder: ['7212'],
  soldador: ['7212'],
  plumber: ['7126'],
  pipefitter: ['7126'],
  encanador: ['7126'],
  plomero: ['7126'],
  'software developer': ['2512', '2513', '2514', '2519'],
  desenvolvedor: ['2512', '2513', '2514', '2519'],
  desarrollador: ['2512', '2513', '2514', '2519'],
  paralegal: ['3411'],
  'marine engineer': ['2144', '3151'],
  rigger: ['7215'],
  deckhand: ['8350'],
  'crane operator': ['8343'],
  'operador de guindaste': ['8343'],
  'operador de grúa': ['8343'],
  advogado: ['2611'],
  abogado: ['2611'],
};

/**
 * How a title's token stands to the term that found its ad: right in one of
 * the term's unit groups, near in one of their minor groups, of the same
 * industry in one of their sub-major groups, else far. Null without a term
 * the table knows or without an ISCO code (no token, or a pending mint).
 */
export function termRelation(term: string, isco: string | null): Relation | null {
  const groups = TERM_ISCO[term];
  if (!groups || !isco || !/^\d{4}$/.test(isco)) return null;
  if (groups.includes(isco)) return 'right';
  if (groups.some((g) => g.slice(0, 3) === isco.slice(0, 3))) return 'near';
  if (groups.some((g) => g.slice(0, 2) === isco.slice(0, 2))) return 'industry';
  return 'far';
}

// ── The judge, where the arms' snaps differ ─────────────────────────────────

const KIND_NOUN: Readonly<Record<TokenKind, string>> = { pos: 'occupation', skill: 'skill', cert: 'certificate or licence' };

export interface JudgeCase {
  kind: TokenKind;
  raw: string;
  lang: string;
  /** The coarse region of the ad the string came from (`br-sp`). */
  region: string;
  /** The ad's title, and its own words around the string (empty when the tripwire refuses them), de-identified as the phone would. */
  title: string;
  excerpt: string;
  /** The entries' English names, shown in this order as `e0`, `e1`, … */
  entries: readonly string[];
}

/**
 * The judge's request, for the Thinking model: the string with the ad it came
 * from, and every token either arm reached for it, by English name only, so
 * nothing says which arm chose what. Its question is Clef's: the same thing,
 * or the broader thing it is a specialization of.
 */
export function judgeMessages(c: JudgeCase): { role: 'system' | 'user'; content: string }[] {
  const noun = KIND_NOUN[c.kind];
  return [
    {
      role: 'system',
      content: `You check how a string from a job ad was matched against a registry of ${noun}s. Read the ad to see what the string means there. Answer with one JSON object on a single line, {"match": KEY, "reason": SHORT}, where KEY is one of the entry keys or "none".`,
    },
    {
      role: 'user',
      content: [
        `${/^[aeiou]/.test(noun) ? 'An' : 'A'} ${noun} from a job ad in ${regionName(c.region)}, written in ${languageName(c.lang)}:`,
        c.raw,
        '',
        `The ad's title: ${c.title}`,
        ...(c.excerpt ? ['From the ad:', c.excerpt] : []),
        '',
        'Entries:',
        ...c.entries.map((e, i) => `- e${i}: ${e}`),
        `- none: None of these: a different ${noun}`,
        '',
        `Which entry names the same ${noun} as the string means in this ad, or the broader ${noun} it is a specialization of?`,
      ].join('\n'),
    },
  ];
}

// ── A band call that fails, and why the arms' snaps of a string differ ─────

/** The ops of the band whose failed calls the eval tries again: Clef's choice and the English pivot. */
export const BAND_OPS: ReadonlySet<string> = new Set(['work-adjudicate', 'work-pivot']);

/**
 * A hosted call as production makes it, except that a band call that throws is tried again, twice at most, after 1 s
 * and 2 s, unless its caller cancelled it: transient errors (a timeout, the API's own) strike the arms unevenly, since
 * they run one after the other, and would read as differences the market did not make. A third failure is thrown, so
 * the registry reads it as production would. `onError` hears every failure, `final` on the third.
 */
export async function withBandRetries<T>(
  op: string,
  call: { signal?: AbortSignal } | undefined,
  run: () => Promise<T>,
  onError: (error: string, final: boolean) => void,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (!BAND_OPS.has(op) || call?.signal?.aborted) throw err;
      onError((err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 120), attempt === 3);
      if (attempt === 3) throw err;
      await wait(1_000 * attempt);
    }
  }
}

/** What the cause rule reads of one arm's first snap of a string. */
export interface ArmSnap {
  /** The registry's decision (`auto`, `chosen`, `pivot`, `minted`, `unmatched`) and its token. */
  decision: string;
  token: string | null;
  /** The nearest candidates' tokens, in the order Clef saw them, without the entry of the pivot's name. */
  nearest: readonly string[];
  /** Clef's first answer for the string: the entries it saw, as sent, and what the answer does at the floor; null when Clef was not asked. */
  clef: { entries: string; outcome: string } | null;
  /** The pivot's first answer for the string (its English name, null when it named nothing valid); null when it was not asked. */
  pivot: { english: string | null } | null;
  /** A band call for the string failed all three tries, or Clef answered nothing: no answer, in the registry. */
  failed: boolean;
  /** Another snap of the string ran while this one did (two listings at once), so their band answers cannot be told apart. */
  overlapped: boolean;
}

export const CAUSES = ['failed', 'overlap', 'registry', 'Clef', 'Clef and pivot', 'pivot'] as const;
export type Cause = (typeof CAUSES)[number];

/** An answer at the floor that sends the string on past Clef: none (a mint, or the refusal of the name's token) or below it (step 3). */
const pastClef = (outcome: string) => outcome === 'none' || outcome === 'neither';

/**
 * Why the market arm's and the language arm's first snaps of a string differ, the first that applies. The causes
 * serve the founder's three answers: under the market for the pivot alone, Clef would answer as in the language arm
 * and the pivot as in the market arm.
 * - `failed`: a band call failed all three tries in either arm, or Clef answered nothing, which says nothing of the market;
 * - `overlap`: two snaps of the string ran at once in an arm, so which answers were its first is unknown;
 * - `registry`: the nearest candidates differ, so a vector one arm's earlier snaps added (a mint's) is behind it;
 * - `Clef`: Clef saw the same entries in both arms and its answer differs at the floor, the state's market the only
 *   difference; the market for the pivot alone would give the language arm's snap;
 * - `Clef and pivot`: the names differ, and either the entries differ only by the token a name named, or Clef's answers
 *   differ and the language arm went on past Clef (its none, or an answer under the floor) with its own name, where the
 *   market's name would have gone instead: the market for the pivot alone would give a snap neither arm made;
 * - `pivot`: Clef saw the same entries and answered alike, or neither arm asked it, the names differ, and an arm's token
 *   came from its name (step 3's token or a mint); the market for the pivot alone would give the market arm's snap;
 * - `registry` for the rest (an alias or a token one arm's earlier snaps made, a token the same name names in one arm only).
 */
export function causeOf(market: ArmSnap, language: ArmSnap): Cause {
  if (market.failed || language.failed) return 'failed';
  if (market.overlapped || language.overlapped) return 'overlap';
  if (market.nearest.join('\n') !== language.nearest.join('\n')) return 'registry';
  const namesDiffer = market.pivot != null && language.pivot != null && market.pivot.english !== language.pivot.english;
  if (market.clef && language.clef) {
    if (market.clef.entries !== language.clef.entries) return namesDiffer ? 'Clef and pivot' : 'registry';
    if (market.clef.outcome !== language.clef.outcome) return namesDiffer && pastClef(language.clef.outcome) ? 'Clef and pivot' : 'Clef';
  } else if (market.clef || language.clef) return 'registry';
  const fromName = (s: ArmSnap) => s.decision === 'pivot' || s.decision === 'minted';
  return namesDiffer && (fromName(market) || fromName(language)) ? 'pivot' : 'registry';
}

/**
 * The two-sided exact sign test on the strings where exactly one arm was right (where the snaps differ, at most one arm
 * reaches the judge's pick): the chance of a split at least this uneven if each arm were as likely to be the right one.
 * It holds for strings that each made their own calls, not for knock-on effects that move together.
 */
export function signTest(x: number, y: number): number {
  const n = x + y;
  if (!n) return 1;
  let logChoose = 0;
  let tail = 0;
  for (let i = 0; i <= Math.min(x, y); i++) {
    tail += Math.exp(logChoose - n * Math.LN2);
    logChoose += Math.log(n - i) - Math.log(i + 1);
  }
  return Math.min(1, 2 * tail);
}

/** The judge's pick from its answer: an entry's index, `none`, or null when the answer names neither. */
export function judgePick(text: string, entries: number): { pick: number | 'none' | null; reason: string } {
  const key = /"match"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null;
  const reason = (/"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ?? '').replace(/\\"/g, '"');
  if (key === 'none') return { pick: 'none', reason };
  const i = key && /^e\d+$/.test(key) ? Number(key.slice(1)) : -1;
  return { pick: i >= 0 && i < entries ? i : null, reason };
}
