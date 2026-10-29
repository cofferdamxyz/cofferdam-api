// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The alignment in this file is ported from LangExtract
// (https://github.com/google/langextract), Copyright 2025 Google LLC,
// licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0), at commit
// 3493510c234c82e217f683071b13562529b2bbdd (2026-10-28):
// `langextract/resolver.py` (`WordAligner.align_extractions` with
// `_find_token_occurrences`, `_select_monotonic_matches`,
// `_tokenize_with_lowercase`, `_normalize_token`, `_best_lcs_spans`,
// `_accept_lcs_match` and `_is_blank`) and the `RegexTokenizer` of
// `langextract/core/tokenizer.py`; it reimplements the matching blocks of
// Python's `difflib.SequenceMatcher`, which the partial match reads.
// Cofferdam Inc. translated it to TypeScript and changed it as "Departures
// from upstream" below lists; the dates and the reading's paths are
// Cofferdam's own.

/**
 * Source grounding for the real-resume benchmark (`test/workResume.eval.test.ts`,
 * workspace decision 0021): every value a reader returns is looked up in the CV's
 * own text, the phone's text recognition or a PDF's text layer, and a value that
 * is not there becomes a question to the worker instead of passing silently, as
 * LangExtract grounds each extraction in its source. Pure: no I/O.
 *
 * A value aligns as LangExtract aligns one extraction, on tokens (a run of
 * letters, a run of digits, or one symbol repeated; white space is no token, so
 * spacing and line breaks never matter) compared in lower case:
 * 1. exact: the value's tokens in order and contiguous, at their first
 *    occurrence (what upstream's order-preserving occurrence DP selects for a
 *    single extraction, its ties going to the earliest-ending chain);
 * 2. lesser (upstream `MATCH_LESSER`): a run of the value's first tokens, where
 *    difflib's matching blocks place it, the span covering that run only;
 * 3. fuzzy (upstream's default LCS algorithm): after a light plural stem (a
 *    final "s" off a token of four characters or more, never "ss"), the
 *    tightest span holding the most of the value's tokens in order, accepted
 *    when it holds at least 0.75 of them, rounded up, at a density of at least
 *    1/3 of the span; when the span with the most fails, one with fewer may pass.
 * Anything else does not align. A lesser match grounds a value on its first
 * tokens alone ("Project Manager" aligns on the "Project" of "Project
 * Coordinator"): upstream counts it as aligned, and so does
 * `ungroundedPaths` by default; `{ acceptMatchLesser: false }`, upstream's own
 * switch, sends such a value to the fuzzy pass instead.
 *
 * Departures from upstream:
 * - One value at a time against the whole text: the extraction delimiters,
 *   chunk offsets and token intervals go, and the occurrence DP is the first
 *   occurrence.
 * - Tokens compare after `fold` (`src/services/work/blocks.ts`, the parse's own:
 *   NFKD, marks off, lower case) where upstream lower-cases only, since text
 *   recognition and PDF text layers decompose or drop accents and write
 *   ligatures; the offsets still point into the text as given.
 * - The tokenizer's classes are those of Python's `regex` module, which upstream
 *   runs, as Unicode properties, and offsets are UTF-16 indices, as
 *   `String.prototype.slice` takes them, where Python counts code points.
 * - An empty text aligns nothing, where upstream raises; a blank value (space,
 *   control and format characters only) aligns nowhere, as upstream skips it.
 * - The fuzzy pass is the LCS algorithm only: the deprecated `legacy` window
 *   ratio is left out, with sentence ranges, token types and visualization.
 */

import { fold } from '../../src/services/work/blocks.js';
import type { CvDate } from '../../src/services/work/cv.js';
import type { Reading } from './resumeBench.js';

// ── Options (upstream's alignment parameters) ───────────────────────────────

/** Upstream `_FUZZY_ALIGNMENT_MIN_THRESHOLD`: the share of a value's tokens a fuzzy span must hold, rounded up. */
export const FUZZY_ALIGNMENT_THRESHOLD = 0.75;
/** Upstream `_FUZZY_ALIGNMENT_MIN_DENSITY`: a fuzzy span's matched tokens over its length. */
export const FUZZY_ALIGNMENT_MIN_DENSITY = 1 / 3;

/** Upstream's alignment parameters; each left out takes upstream's default. */
export interface AlignOptions {
  /** `accept_match_lesser` (true): a partial exact match aligns; when false, the value goes on to the fuzzy pass. */
  acceptMatchLesser?: boolean;
  /** `enable_fuzzy_alignment` (true). */
  enableFuzzyAlignment?: boolean;
  /** `fuzzy_alignment_threshold` (`FUZZY_ALIGNMENT_THRESHOLD`), in [0, 1]. */
  fuzzyAlignmentThreshold?: number;
  /** `fuzzy_alignment_min_density` (`FUZZY_ALIGNMENT_MIN_DENSITY`), in [0, 1]. */
  fuzzyAlignmentMinDensity?: number;
}

/** Where a value aligns: how, and the span's offsets into the text (UTF-16, the end exclusive). */
export interface Alignment {
  status: 'exact' | 'lesser' | 'fuzzy';
  start: number;
  end: number;
}

function settings(options: AlignOptions): Required<AlignOptions> {
  const s: Required<AlignOptions> = {
    acceptMatchLesser: options.acceptMatchLesser ?? true,
    enableFuzzyAlignment: options.enableFuzzyAlignment ?? true,
    fuzzyAlignmentThreshold: options.fuzzyAlignmentThreshold ?? FUZZY_ALIGNMENT_THRESHOLD,
    fuzzyAlignmentMinDensity: options.fuzzyAlignmentMinDensity ?? FUZZY_ALIGNMENT_MIN_DENSITY,
  };
  // Upstream checks the two only when the fuzzy pass is on; NaN fails as it does there.
  if (s.enableFuzzyAlignment) {
    for (const [name, v] of [
      ['fuzzyAlignmentThreshold', s.fuzzyAlignmentThreshold],
      ['fuzzyAlignmentMinDensity', s.fuzzyAlignmentMinDensity],
    ] as const) {
      if (!(v >= 0 && v <= 1)) throw new RangeError(`${name} must be in [0, 1]; got ${v}`);
    }
  }
  return s;
}

// ── Tokens (upstream `RegexTokenizer`) ──────────────────────────────────────

/** A token of a text: its offsets in the text, and its key, the token as compared. */
interface Token {
  start: number;
  end: number;
  key: string;
}

/**
 * Upstream's `[^\W\d_]+|\d+|([^\w\s]|_)\1*`: a run of letters, a run of digits,
 * or one symbol repeated ("--", "!!"), "_" counting as a symbol. Python's
 * `regex` module, which upstream runs, takes `\w` as its `Word` property
 * (Alphabetic, marks, decimal digits, connector punctuation and join
 * controls), `\d` as decimal digits and `\s` as White_Space, so a letter here
 * is any of those but a decimal digit and "_" (the other connector punctuation
 * is listed).
 */
const TOKEN =
  /[\p{Alphabetic}\p{M}\p{Join_Control}‿⁀⁔︳︴﹍-﹏＿]+|\p{Nd}+|([^\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}\p{White_Space}]|_)\1*/gu;

/** Upstream `_tokenize_with_lowercase`, each token keyed by `fold` where upstream lower-cases it. */
function tokenize(text: string): Token[] {
  return Array.from(text.matchAll(TOKEN), (m) => ({ start: m.index, end: m.index + m[0].length, key: fold(m[0]) }));
}

/** A text tokenized once for every value and date looked up in it. */
interface Source {
  tokens: Token[];
  keys: string[];
  /** The keys stemmed for the fuzzy pass, made on first use. */
  stems?: string[];
  /** The dates the text writes, read on first use. */
  dates?: DateMention[];
}

function sourceOf(text: string): Source {
  const tokens = tokenize(text);
  return { tokens, keys: tokens.map((t) => t.key) };
}

/** Upstream `_is_blank`: nothing but space, control and format characters, so nothing to ground. */
const isBlank = (value: string) => /^[\p{White_Space}\p{Cc}\p{Cf}]*$/u.test(value);

/** Upstream `_normalize_token` on a folded key: a final "s" off a key of four characters or more, unless it ends in "ss". */
function stem(key: string): string {
  return [...key].length > 3 && key.endsWith('s') && !key.endsWith('ss') ? key.slice(0, -1) : key;
}

// ── Aligning a value (upstream `WordAligner.align_extractions`) ─────────────

/**
 * Where `value` appears in `text`, as LangExtract aligns one extraction: exact,
 * else lesser, else fuzzy, else null (the module comment says how). Offsets are
 * into `text`.
 */
export function alignValue(value: string, text: string, options: AlignOptions = {}): Alignment | null {
  return align(value, sourceOf(text), settings(options));
}

function align(value: string, source: Source, s: Required<AlignOptions>): Alignment | null {
  if (isBlank(value) || !source.keys.length) return null;
  const keys = tokenize(value).map((t) => t.key);
  if (!keys.length) return null;
  const span = (status: Alignment['status'], first: number, last: number): Alignment => ({
    status,
    start: source.tokens[first]!.start,
    end: source.tokens[last]!.end,
  });

  // The exact pass: upstream's occurrence DP, which keeps a single extraction's first occurrence.
  const at = firstOccurrence(source.keys, keys);
  if (at >= 0) return span('exact', at, at + keys.length - 1);

  // The partial match: difflib's block at the value's first token. It is shorter than the value, since a block as
  // long as the value is an occurrence, which the exact pass took.
  const lesser = matchingBlocks(source.keys, keys).find(([, j]) => j === 0);
  if (lesser && s.acceptMatchLesser) return span('lesser', lesser[0], lesser[0] + lesser[2] - 1);

  // The fuzzy pass (upstream `_lcs_fuzzy_align_extraction`): spans by decreasing match count, since a sparse span
  // with the most matches may fail the density gate while a denser one with fewer still passes the coverage gate.
  if (!s.enableFuzzyAlignment) return null;
  source.stems ??= source.keys.map(stem);
  const stems = keys.map(stem);
  const spans = bestLcsSpans(source.stems, stems);
  for (const k of [...spans.keys()].sort((a, b) => b - a)) {
    const candidate = spans.get(k)!;
    if (acceptLcsMatch(candidate, stems.length, s.fuzzyAlignmentThreshold, s.fuzzyAlignmentMinDensity)) {
      return span('fuzzy', candidate.start, candidate.end);
    }
  }
  return null;
}

/** Upstream `_find_token_occurrences`, its first: the first index where `value` runs in `source`, or -1. */
function firstOccurrence(source: readonly string[], value: readonly string[]): number {
  for (let i = 0; i + value.length <= source.length; i++) {
    if (value.every((t, j) => source[i + j] === t)) return i;
  }
  return -1;
}

/** A block of `a[i, i + size)` equal to `b[j, j + size)`. */
type Block = [i: number, j: number, size: number];

/**
 * The matching blocks of Python's `difflib.SequenceMatcher(None, a, b,
 * autojunk=False)`, without the closing dummy: the longest block (the earliest
 * in `a`, then in `b`), then the same on each side of it, sorted, with adjacent
 * blocks joined. With no junk and autojunk off, difflib's extension of a block
 * over junk and popular elements does nothing, so it is left out.
 */
function matchingBlocks(a: readonly string[], b: readonly string[]): Block[] {
  const inB = new Map<string, number[]>();
  b.forEach((t, j) => {
    const at = inB.get(t);
    if (at) at.push(j);
    else inB.set(t, [j]);
  });
  const found: Block[] = [];
  const queue: [alo: number, ahi: number, blo: number, bhi: number][] = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, size] = longestBlock(a, inB, alo, ahi, blo, bhi);
    if (!size) continue;
    found.push([i, j, size]);
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + size < ahi && j + size < bhi) queue.push([i + size, ahi, j + size, bhi]);
  }
  found.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  const blocks: Block[] = [];
  for (const [i, j, size] of found) {
    const last = blocks.at(-1);
    if (last && last[0] + last[2] === i && last[1] + last[2] === j) last[2] += size;
    else blocks.push([i, j, size]);
  }
  return blocks;
}

/** difflib's `find_longest_match` without junk: the longest block of `a[alo, ahi)` and `b[blo, bhi)`, the earliest in `a`, then in `b`; size 0 for none. */
function longestBlock(a: readonly string[], inB: ReadonlyMap<string, readonly number[]>, alo: number, ahi: number, blo: number, bhi: number): Block {
  let best: Block = [alo, blo, 0];
  // ending.get(j): the size of the block that ends at the previous token of `a` and at b[j].
  let ending = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const next = new Map<number, number>();
    for (const j of inB.get(a[i]!) ?? []) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const size = (ending.get(j - 1) ?? 0) + 1;
      next.set(j, size);
      if (size > best[2]) best = [i - size + 1, j - size + 1, size];
    }
    ending = next;
  }
  return best;
}

/** Upstream `LcsSpan`: `matches` of the value's tokens in order within source tokens `start` to `end`, both included. */
interface LcsSpan {
  matches: number;
  start: number;
  end: number;
}

/**
 * Upstream `_best_lcs_spans`: for each count k of the value's tokens matched in
 * order, the tightest source span holding them, the earliest of equal length.
 * O(n·m²) time and O(m²) memory with rolling rows: row[j][k] is the latest start
 * s such that source[s, i) holds k tokens of value[0, j) as a subsequence, -1
 * for none.
 */
function bestLcsSpans(source: readonly string[], value: readonly string[]): Map<number, LcsSpan> {
  const n = source.length;
  const m = value.length;
  const best = new Map<number, LcsSpan>();
  if (!n || !m) return best;
  const w = m + 1;
  let prev = new Int32Array(w * w).fill(-1);
  let curr = new Int32Array(w * w).fill(-1);
  // At i = 0, zero matches are achievable with s = 0.
  for (let j = 0; j <= m; j++) prev[j * w] = 0;
  for (let i = 1; i <= n; i++) {
    const token = source[i - 1];
    curr[0] = i;
    for (let k = 1; k <= m; k++) curr[k] = -1;
    for (let j = 1; j <= m; j++) {
      curr[j * w] = i;
      const here = token === value[j - 1];
      for (let k = 1; k <= m; k++) {
        let s = Math.max(prev[j * w + k]!, curr[(j - 1) * w + k]!);
        if (here) s = Math.max(s, k === 1 ? i - 1 : prev[(j - 1) * w + k - 1]!);
        curr[j * w + k] = s;
      }
    }
    for (let k = 1; k <= m; k++) {
      const s = curr[m * w + k]!;
      if (s < 0) continue;
      const had = best.get(k);
      const length = i - s;
      const hadLength = had ? had.end - had.start + 1 : Infinity;
      if (!had || length < hadLength || (length === hadLength && s < had.start)) best.set(k, { matches: k, start: s, end: i - 1 });
    }
    [prev, curr] = [curr, prev];
  }
  return best;
}

/** Upstream `_accept_lcs_match`: coverage (matches at least the value's length times `threshold`, rounded up) and density (matches over the span's length). */
function acceptLcsMatch(span: LcsSpan, valueLength: number, threshold: number, minDensity: number): boolean {
  if (span.matches === 0 || valueLength === 0) return false;
  const needed = Math.ceil(valueLength * threshold);
  const length = span.start < 0 ? 0 : span.end - span.start + 1;
  if (length <= 0) return false;
  return span.matches >= needed && span.matches / length >= minDensity;
}

// ── Dates ───────────────────────────────────────────────────────────────────

/** The month words `parseCvDate` reads (`src/services/work/cv.ts`, where they are not exported): English, Portuguese and Spanish, folded. */
const MONTH_WORDS = new Map<string, number>(
  Object.entries({
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
  }),
);

/** What may stand between a month word, after its period, and the year: "Mar-2015", "mar/2015", "Mar, 2015", "março de 2015", "marzo del 2015". */
const MONTH_WORD_SEPARATORS = new Set([',', '-', '/', 'de', 'del']);

const YEAR = /^\d{4}$/;

/** A date a text writes: a year with its month, or a year alone (`month` null). */
interface DateMention {
  year: string;
  month: number | null;
}

/** A month written `MM` ("03", "12"), or `M` ("3") where `single` allows it; else null. */
function monthNumber(key: string | undefined, single: boolean): number | null {
  if (!key || !/^\d{1,2}$/.test(key) || (key.length === 1 && !single)) return null;
  const n = Number(key);
  return n >= 1 && n <= 12 ? n : null;
}

/**
 * The dates a text writes, read left to right so that each number belongs to
 * one date: a month word with its year; `MM/YYYY`, `M/YYYY`, `MM-YYYY`,
 * `MM.YYYY`, `YYYY-MM` and `YYYY/MM`, written without spaces; and any other
 * four-digit number as a year alone.
 */
function datesIn(source: Source): DateMention[] {
  const { tokens, keys } = source;
  /** Token `i` and the next touch: no space between them. */
  const touches = (i: number) => tokens[i + 1]?.start === tokens[i]?.end;
  const out: DateMention[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const named = MONTH_WORDS.get(key);
    if (named != null) {
      let j = i + 1;
      if (keys[j] === '.') j++;
      if (MONTH_WORD_SEPARATORS.has(keys[j] ?? '')) j++;
      if (YEAR.test(keys[j] ?? '')) {
        out.push({ year: keys[j]!, month: named });
        i = j;
      }
      continue;
    }
    if (touches(i) && touches(i + 1)) {
      const sep = keys[i + 1];
      // MM/YYYY, M/YYYY, MM-YYYY, MM.YYYY
      const before = sep === '/' || sep === '-' || sep === '.' ? monthNumber(key, sep === '/') : null;
      if (before != null && YEAR.test(keys[i + 2] ?? '')) {
        out.push({ year: keys[i + 2]!, month: before });
        i += 2;
        continue;
      }
      // YYYY-MM, YYYY/MM
      const after = sep === '-' || sep === '/' ? monthNumber(keys[i + 2], false) : null;
      if (after != null && YEAR.test(key)) {
        out.push({ year: key, month: after });
        i += 2;
        continue;
      }
    }
    if (YEAR.test(key)) out.push({ year: key, month: null });
  }
  return out;
}

/**
 * Whether `text` writes `date` (`YYYY-MM` or `YYYY`, as `parseCvDate` gives it)
 * the way resumes write dates: a month as its English, Portuguese or Spanish
 * name or abbreviation with the year ("March 2015", "Mar. 2015", "Mar-2015",
 * "março de 2015", "fev/2014", "marzo del 2015"), or as `MM/YYYY`, `M/YYYY`,
 * `MM-YYYY`, `MM.YYYY`, `YYYY-MM` or `YYYY/MM` written without spaces; a
 * year-only date as its year written alone. Case and accents do not matter, and
 * the text is read left to right so that each number belongs to one date
 * ("03/2015-06/2017" writes March 2015 and June 2017, never "2015-06").
 *
 * Two choices. A month date whose year alone appears is not in the text: the
 * reader may have invented the month. A year-only date whose year appears only
 * inside a month ("03/2015") is not in the text either: the text writes the
 * month, which a reader that returns the year alone has dropped, and the
 * benchmark scores a date at the label's precision. A day is no part of any
 * form, as `parseCvDate` reads none: "03/15/2015" and "June 15, 2015" write no
 * month here, while "15/03/2015" and "2015-03-15" still hold "03/2015" and
 * "2015-03".
 */
export function dateInText(date: CvDate, text: string): boolean {
  return dateInSource(date, sourceOf(text));
}

function dateInSource(date: CvDate, source: Source): boolean {
  const d = /^(\d{4})(?:-(\d{2}))?$/.exec(date);
  if (!d) return false;
  const month = d[2] == null ? null : Number(d[2]);
  if (month != null && (month < 1 || month > 12)) return false;
  source.dates ??= datesIn(source);
  return source.dates.some((m) => m.year === d[1] && m.month === month);
}

// ── A reading's values ──────────────────────────────────────────────────────

/**
 * The paths of the reading's values that `text` does not hold, in the format
 * of `scoreReading`'s open set and `readingGaps` (`resumeBench.ts`), in reading
 * order: each job's title (`jobs.2.title`), start (`jobs.2.start`) and end
 * (`jobs.2.end`; a current job's end is "present", not a date to look up), each
 * school's institution, qualification and end (`schools.0.institution`), and
 * each certificate (`certificates.3`). A value is held when it aligns at all
 * (`alignValue` with `options`), a date when `dateInText` finds it. An empty
 * field is no value to look up (`readingGaps` asks for a missing date), and
 * skills are neither scored nor looked up. The open set is both:
 * `new Set([...readingGaps(r), ...ungroundedPaths(r, text)])`.
 */
export function ungroundedPaths(reading: Reading, text: string, options: AlignOptions = {}): string[] {
  const s = settings(options);
  const source = sourceOf(text);
  const paths: string[] = [];
  const value = (path: string, v: string | null) => {
    if (v != null && !isBlank(v) && !align(v, source, s)) paths.push(path);
  };
  const date = (path: string, d: CvDate | null) => {
    if (d && !dateInSource(d, source)) paths.push(path);
  };
  reading.jobs.forEach((job, k) => {
    value(`jobs.${k}.title`, job.title);
    date(`jobs.${k}.start`, job.start);
    if (!job.current) date(`jobs.${k}.end`, job.end);
  });
  reading.schools.forEach((school, k) => {
    value(`schools.${k}.institution`, school.institution);
    value(`schools.${k}.qualification`, school.qualification);
    date(`schools.${k}.end`, school.end);
  });
  reading.certificates.forEach((c, k) => value(`certificates.${k}`, c));
  return paths;
}
