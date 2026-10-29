// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The real-resume benchmark's pure parts (workspace decision 0021, the
 * founder's exception of 2026-10-28; `docs/product/engine.md`, Whole-document
 * parse). Kaggle's public resume dataset (`snehaanbhawal/resume-dataset`:
 * LiveCareer resumes with employers and names removed by the site) labels each
 * job's title and dates and each school in its HTML, so a reading is scored
 * against those labels with no hand labels. Nothing here touches the network
 * or the disk; `test/workResume.eval.test.ts` does. No resume's text, title or
 * date enters the repository: the tests use made-up resumes, and the report
 * carries counts only.
 *
 * The cloud pipeline it measures, the founder's of 2026-10-28 with the
 * refinements proposed the same day: two readers in parallel, code merging
 * what they agree on (`mergeReadings`), `clef-flash` choosing between the two
 * values of a disputed field over the document's own text
 * (`disputeQuestions`), DeepSeek at high effort on what Clef leaves unsure
 * (`arbiterRequest`), and a full check of the result (`reviewRequest`).
 * Whatever is still open would be a question to the worker.
 */

import { parseCvDate, type CvDate } from '../../src/services/work/cv.js';
import { FIT_FLOOR, OTHER_FLOOR, type ClefQuestion } from '../../src/services/work/clef.js';
import type { ParsedCv, ParsePage } from '../../src/services/work/parse.js';
import { COSINE_WEIGHT, RELATED_WEIGHT, SKILL_WEIGHT, type Finalist } from '../../src/services/work/recall.js';

// ── The dataset ─────────────────────────────────────────────────────────────

/** RFC 4180: quoted fields may hold commas, doubled quotes and line breaks. */
export function parseCsv(s: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          f += '"';
          i++;
        } else q = false;
      } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(f);
      f = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(f);
      rows.push(row);
      row = [];
      f = '';
    } else f += c;
  }
  if (f || row.length) {
    row.push(f);
    rows.push(row);
  }
  return rows;
}

export interface ResumeRecord {
  id: string;
  category: string;
  text: string;
  html: string;
}

/** The dataset's `Resume.csv` (`ID,Resume_str,Resume_html,Category`). */
export function readResumeCsv(csv: string): ResumeRecord[] {
  const [head, ...rows] = parseCsv(csv);
  if (!head) return [];
  const at = (name: string) => {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`Resume.csv has no ${name} column`);
    return i;
  };
  const [ID, TEXT, HTML, CAT] = [at('ID'), at('Resume_str'), at('Resume_html'), at('Category')];
  return rows.filter((r) => r.length === head.length).map((r) => ({ id: r[ID]!.trim(), category: r[CAT]!.trim(), text: r[TEXT]!, html: r[HTML]! }));
}

/** An email address or a US-style phone number: such a resume is left out of every run. */
export function hasContact(text: string): boolean {
  return /[\w.+-]+@[\w-]+\.[\w.]+/.test(text) || /\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(text);
}

// ── The labels in the HTML ──────────────────────────────────────────────────

/** An HTML fragment's text: tags dropped, the common entities decoded, white space as single spaces. */
export function htmlText(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** A label's date, as LiveCareer writes them (`03/2015`, `March 2015`, `Mar 2015`, `2015`, `Current`), through the parse's own date reader. */
export function labelDate(text: string): { present: true } | { present: false; date: CvDate } | null {
  const t = text.trim();
  if (!t) return null;
  if (/^(current|present|now|to date|today)$/i.test(t)) return { present: true };
  return parseCvDate(t);
}

export interface TruthJob {
  title: string | null;
  start: CvDate | null;
  end: CvDate | null;
  current: boolean;
}

export interface TruthSchool {
  school: string | null;
  degree: string | null;
  end: CvDate | null;
}

export interface ResumeTruth {
  jobs: TruthJob[];
  schools: TruthSchool[];
  /** The certificate keywords the resume's certifications section names. */
  certificates: string[];
  /** The resume's latest date: the "Current" a job runs to, since the resume's own date is not in the data. */
  anchor: CvDate | null;
  /** The skills section's items, split on commas, semicolons, bullets and line breaks: free text, for the Work Profile only. */
  skills: string[];
}

/** The section of the HTML whose id starts `SECTION_<code>`, up to the next section, or empty. */
export function sectionHtml(html: string, code: string): string {
  const at = html.search(new RegExp(`id="SECTION_${code}`));
  if (at < 0) return '';
  // Whole tags at both ends: the section's own opening tag, and nothing of the next one's.
  const rest = html.slice(Math.max(0, html.lastIndexOf('<', at)));
  const next = rest.slice(1).search(/<[^<>]*\bid="SECTION_[A-Z]+/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** The labelled spans of a section by field code and entry number: `…JTIT2` is the second job's title. */
function labelled(section: string, codes: readonly string[]): Map<number, Map<string, string>> {
  const out = new Map<number, Map<string, string>>();
  const re = new RegExp(`<span\\b[^>]*\\bid="[^"]*?(${codes.join('|')})(\\d+)"[^>]*>([\\s\\S]*?)</span>`, 'g');
  for (const m of section.matchAll(re)) {
    const n = Number(m[2]);
    const entry = out.get(n) ?? new Map<string, string>();
    if (!entry.has(m[1]!)) entry.set(m[1]!, htmlText(m[3]!));
    out.set(n, entry);
  }
  return out;
}

/** Certificate keywords read in a certifications section; a reading is scored on these only. */
export const CERTIFICATE_KEYWORDS: Record<string, RegExp> = {
  OSHA: /\bOSHA\b/i,
  CDL: /\bCDL\b/,
  CPR: /\bCPR\b/,
  'First Aid': /\bfirst aid\b/i,
  forklift: /\bforklift\b/i,
  ServSafe: /\bServSafe\b/i,
  FAA: /\bFAA\b/,
  'A&P': /\bA ?& ?P\b/,
  NCCER: /\bNCCER\b/i,
  EPA: /\bEPA\b/,
  TWIC: /\bTWIC\b/i,
  LEED: /\bLEED\b/,
  PMP: /\bPMP\b/,
  HAZWOPER: /\bHAZWOPER\b/i,
  NCCCO: /\bNCCCO\b/i,
  ASE: /\bASE\b/,
};

export function certificateKeywords(text: string): string[] {
  return Object.entries(CERTIFICATE_KEYWORDS)
    .filter(([, re]) => re.test(text))
    .map(([k]) => k);
}

const laterDate = (a: CvDate | null, b: CvDate | null): CvDate | null => {
  if (!a) return b;
  if (!b) return a;
  return monthIndex(a) >= monthIndex(b) ? a : b;
};

/** The labels of one resume: its jobs in the resume's order, its schools, its certificate keywords and its anchor. */
export function resumeTruth(html: string): ResumeTruth {
  const jobs: TruthJob[] = [];
  let anchor: CvDate | null = null;
  const expr = labelled(sectionHtml(html, 'EXPR'), ['JTIT', 'JSTD', 'EDDT']);
  for (const n of [...expr.keys()].sort((a, b) => a - b)) {
    const e = expr.get(n)!;
    const start = labelDate(e.get('JSTD') ?? '');
    const end = labelDate(e.get('EDDT') ?? '');
    const job: TruthJob = {
      title: e.get('JTIT') || null,
      start: start && !start.present ? start.date : null,
      end: end && !end.present ? end.date : null,
      current: end?.present === true,
    };
    if (!job.title && !job.start && !job.end && !job.current) continue;
    jobs.push(job);
    anchor = laterDate(laterDate(anchor, job.start), job.end);
  }
  const schools: TruthSchool[] = [];
  const educ = labelled(sectionHtml(html, 'EDUC'), ['SCHO', 'DGRE', 'STUY', 'GRYR']);
  for (const n of [...educ.keys()].sort((a, b) => a - b)) {
    const e = educ.get(n)!;
    const end = labelDate(e.get('GRYR') ?? '');
    const degree = [e.get('DGRE'), e.get('STUY')].filter((x): x is string => !!x).join(' ') || null;
    const school: TruthSchool = { school: e.get('SCHO') || null, degree, end: end && !end.present ? end.date : null };
    if (!school.school && !school.degree) continue;
    schools.push(school);
    anchor = laterDate(anchor, school.end);
  }
  const skillsHtml = sectionHtml(html, 'SKLL').replace(/<\/(li|p|div|span)>/gi, ',').replace(/<br\s*\/?>/gi, ',');
  const skillItems = htmlText(skillsHtml)
    .replace(/^\s*skills\s*/i, '')
    .split(/[,;•|·]|\s{2,}/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && x.length <= 60);
  return { jobs, schools, certificates: certificateKeywords(htmlText(sectionHtml(html, 'CERT'))), anchor, skills: distinctSkills(skillItems) };
}

// ── Sampling ────────────────────────────────────────────────────────────────

/** mulberry32: a small seeded generator, so a sample is the same on every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `CONSTRUCTION:15,ENGINEERING:25` as a plan. */
export function readPlan(raw: string): Record<string, number> {
  const plan: Record<string, number> = {};
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [cat, n] = part.split(':');
    if (!cat || !n || !/^\d+$/.test(n)) throw new Error(`a plan entry is CATEGORY:N, not ${part}`);
    plan[cat.trim()] = Number(n);
  }
  return plan;
}

/** `plan[category]` records per category among the eligible ones, in a seeded order, ids sorted inside a category first. */
export function pickSample(records: readonly ResumeRecord[], plan: Record<string, number>, seed: number, eligible: (r: ResumeRecord) => boolean): ResumeRecord[] {
  const out: ResumeRecord[] = [];
  for (const [category, n] of Object.entries(plan)) {
    const pool = records.filter((r) => r.category === category && eligible(r)).sort((a, b) => a.id.localeCompare(b.id));
    const next = rng(seed + [...category].reduce((s, c) => s + c.charCodeAt(0), 0));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    out.push(...pool.slice(0, n));
  }
  return out;
}

/** The report's groups: the trades, engineering and IT. */
export const GROUPS: Record<string, string> = {
  CONSTRUCTION: 'trades',
  AVIATION: 'trades',
  AUTOMOBILE: 'trades',
  AGRICULTURE: 'trades',
  CHEF: 'trades',
  ENGINEERING: 'engineering',
  'INFORMATION-TECHNOLOGY': 'IT',
};

// ── Dates as months ─────────────────────────────────────────────────────────

/** A date as a month count; a bare year counts as its middle (June). */
export function monthIndex(d: CvDate): number {
  const [y, m] = d.split('-');
  return Number(y) * 12 + (m ? Number(m) - 1 : 5);
}

/** A job's length in months, a current job running to `anchor`; null when it cannot be told. */
export function jobMonths(job: { start: CvDate | null; end: CvDate | null; current: boolean }, anchor: CvDate | null): number | null {
  if (!job.start) return null;
  const end = job.current ? anchor : job.end;
  if (!end) return null;
  const n = monthIndex(end) - monthIndex(job.start);
  return n >= 0 ? n : null;
}

// ── A reading, as the pipeline compares and scores it ───────────────────────

export interface ReadingJob {
  title: string | null;
  start: CvDate | null;
  end: CvDate | null;
  current: boolean;
}

export interface ReadingSchool {
  institution: string | null;
  qualification: string | null;
  end: CvDate | null;
}

/** What the benchmark scores of a parse: jobs, schools and certificate names; and the skills a Work Profile publishes. */
export interface Reading {
  jobs: ReadingJob[];
  schools: ReadingSchool[];
  certificates: string[];
  /** The CV's skills and its jobs' skills, as written, first seen first; not scored (the labels hold them only as free text). */
  skills?: string[];
}

/** Distinct skills, first seen first, by `normText`. */
export function distinctSkills(all: readonly (string | null | undefined)[], max = 30): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of all) {
    const t = (raw ?? '').replace(/\s+/g, ' ').trim();
    const k = normText(t);
    if (!k || k.length < 2 || t.length > 120 || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export function readingOf(p: ParsedCv): Reading {
  return {
    jobs: p.claimed.experience.map((e) => ({ title: e.title?.raw ?? null, start: e.start, end: e.end, current: e.current })),
    schools: p.claimed.education.map((e) => ({ institution: e.institution, qualification: e.qualification, end: e.end })),
    certificates: p.claimed.certificates.map((c) => c.raw),
    skills: distinctSkills([...p.claimed.skills.map((c) => c.raw), ...p.claimed.experience.flatMap((e) => e.skills.map((c) => c.raw))]),
  };
}

/** Lower case, accents and punctuation off, single spaces: two spellings of one title compare equal. */
export function normText(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9&+#]+/g, ' ')
    .trim();
}

/** Word overlap (Jaccard) of two strings after `normText`; 1 for two empty strings. */
export function overlap(a: string | null, b: string | null): number {
  const A = new Set(normText(a).split(' ').filter(Boolean));
  const B = new Set(normText(b).split(' ').filter(Boolean));
  if (!A.size && !B.size) return 1;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

const sameTitle = (a: string | null, b: string | null) => normText(a) === normText(b) || overlap(a, b) >= 0.75;

/**
 * A school read right: its name, with or without the location or program a
 * reader appends ("Liberty University - City, State"), which the field should
 * not hold but which does not change the school.
 */
export const sameSchool = (read: string | null, label: string | null) => {
  const r = normText(read);
  const l = normText(label);
  return !!l && (r === l || overlap(read, label) >= 0.75 || ` ${r} `.includes(` ${l} `));
};

/** Greedy pairing by score, best first: each left and right item at most once, pairs below `min` left out. */
export function pairUp<A, B>(left: readonly A[], right: readonly B[], score: (a: A, b: B) => number, min: number): [number, number][] {
  const all: [number, number, number][] = [];
  left.forEach((a, i) => right.forEach((b, j) => all.push([i, j, score(a, b)])));
  all.sort((x, y) => y[2] - x[2] || x[0] - y[0] || x[1] - y[1]);
  const usedL = new Set<number>();
  const usedR = new Set<number>();
  const out: [number, number][] = [];
  for (const [i, j, s] of all) {
    if (s < min || usedL.has(i) || usedR.has(j)) continue;
    usedL.add(i);
    usedR.add(j);
    out.push([i, j]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

/** How alike two jobs are: their titles, and their dates when they agree. */
export function jobLikeness(a: { title: string | null; start: CvDate | null; end: CvDate | null }, b: { title: string | null; start: CvDate | null; end: CvDate | null }): number {
  let s = overlap(a.title, b.title);
  if (a.start && a.start === b.start) s += 0.5;
  if (a.end && a.end === b.end) s += 0.25;
  return s;
}

// ── Merging two readings (the cloud pipeline's first step) ──────────────────

export type DisputeKind = 'value' | 'presence';

/** A field the two readers read differently, or a job, school or certificate only one of them read. */
export interface Dispute {
  /** `d<n>`, the question's id at Clef and at the arbiter. */
  id: string;
  kind: DisputeKind;
  /** Where it sits in the merged reading: `jobs.2.start`, `schools.0`, `certificates.3`. */
  path: string;
  /** For a value: the two readings (null when a reader left it empty). For a presence: the item, as one reader read it. */
  a: string | null;
  b: string | null;
  /** The plain-words subject for the question ("the start date of the job 'Site Supervisor'"). */
  subject: string;
}

export interface Merged {
  reading: Reading;
  disputes: Dispute[];
}

const dateText = (d: CvDate | null, current = false) => (current ? 'present' : (d ?? null));
const jobName = (j: ReadingJob) => `the job "${j.title ?? 'untitled'}"${j.start ? ` from ${j.start}` : ''}`;

/**
 * Two readers' readings merged: what both read alike is kept, every other
 * field is a dispute and keeps reader A's value until it is settled, and an
 * item only one reader read is kept with a presence dispute.
 */
export function mergeReadings(a: Reading, b: Reading): Merged {
  const disputes: Dispute[] = [];
  const add = (d: Omit<Dispute, 'id'>) => disputes.push({ id: `d${disputes.length + 1}`, ...d });
  const jobs: ReadingJob[] = [];
  const jobPairs = pairUp(a.jobs, b.jobs, jobLikeness, 0.5);
  const pairedB = new Set(jobPairs.map(([, j]) => j));
  const byA = new Map(jobPairs);
  a.jobs.forEach((ja, i) => {
    const k = jobs.length;
    jobs.push({ ...ja });
    const j = byA.get(i);
    if (j == null) {
      add({ kind: 'presence', path: `jobs.${k}`, a: `${ja.title ?? 'untitled'} (${ja.start ?? '?'} to ${dateText(ja.end, ja.current) ?? '?'})`, b: null, subject: jobName(ja) });
      return;
    }
    const jb = b.jobs[j]!;
    if (!sameTitle(ja.title, jb.title)) add({ kind: 'value', path: `jobs.${k}.title`, a: ja.title, b: jb.title, subject: `the title of ${jobName(ja)}` });
    if (ja.start !== jb.start) add({ kind: 'value', path: `jobs.${k}.start`, a: ja.start, b: jb.start, subject: `the start date of the job "${ja.title ?? jb.title ?? 'untitled'}"` });
    if (ja.current !== jb.current || (!ja.current && ja.end !== jb.end)) {
      add({ kind: 'value', path: `jobs.${k}.end`, a: dateText(ja.end, ja.current), b: dateText(jb.end, jb.current), subject: `the end date of the job "${ja.title ?? jb.title ?? 'untitled'}" (or "present")` });
    }
  });
  b.jobs.forEach((jb, j) => {
    if (pairedB.has(j)) return;
    const k = jobs.length;
    jobs.push({ ...jb });
    add({ kind: 'presence', path: `jobs.${k}`, a: null, b: `${jb.title ?? 'untitled'} (${jb.start ?? '?'} to ${dateText(jb.end, jb.current) ?? '?'})`, subject: jobName(jb) });
  });

  const schools: ReadingSchool[] = [];
  const schoolPairs = new Map(pairUp(a.schools, b.schools, (x, y) => overlap(x.institution, y.institution) + 0.5 * overlap(x.qualification, y.qualification), 0.5));
  const pairedSchools = new Set(schoolPairs.values());
  a.schools.forEach((sa, i) => {
    const k = schools.length;
    schools.push({ ...sa });
    const j = schoolPairs.get(i);
    if (j == null) {
      add({ kind: 'presence', path: `schools.${k}`, a: [sa.qualification, sa.institution].filter(Boolean).join(', ') || null, b: null, subject: `the education "${sa.qualification ?? ''} ${sa.institution ?? ''}"`.replace(/\s+/g, ' ') });
      return;
    }
    const sb = b.schools[j]!;
    if (!sameTitle(sa.institution, sb.institution)) add({ kind: 'value', path: `schools.${k}.institution`, a: sa.institution, b: sb.institution, subject: `the school of the education "${sa.qualification ?? sb.qualification ?? ''}"` });
  });
  b.schools.forEach((sb, j) => {
    if (pairedSchools.has(j)) return;
    const k = schools.length;
    schools.push({ ...sb });
    add({ kind: 'presence', path: `schools.${k}`, a: null, b: [sb.qualification, sb.institution].filter(Boolean).join(', ') || null, subject: `the education "${sb.qualification ?? ''} ${sb.institution ?? ''}"`.replace(/\s+/g, ' ') });
  });

  const certificates: string[] = [];
  const certPairs = new Map(pairUp(a.certificates, b.certificates, (x, y) => overlap(x, y), 0.5));
  const pairedCerts = new Set(certPairs.values());
  a.certificates.forEach((ca, i) => {
    const k = certificates.length;
    certificates.push(ca);
    if (!certPairs.has(i)) add({ kind: 'presence', path: `certificates.${k}`, a: ca, b: null, subject: `the certificate "${ca}"` });
  });
  b.certificates.forEach((cb, j) => {
    if (pairedCerts.has(j)) return;
    const k = certificates.length;
    certificates.push(cb);
    add({ kind: 'presence', path: `certificates.${k}`, a: null, b: cb, subject: `the certificate "${cb}"` });
  });
  return { reading: { jobs, schools, certificates, skills: distinctSkills([...(a.skills ?? []), ...(b.skills ?? [])]) }, disputes };
}

/** Fields a reading leaves open by the code's own checks: a job with no start, a past job with no end, an end before its start. */
export function readingGaps(r: Reading): string[] {
  const gaps: string[] = [];
  r.jobs.forEach((j, k) => {
    if (!j.start) gaps.push(`jobs.${k}.start`);
    if (!j.current && !j.end) gaps.push(`jobs.${k}.end`);
    if (j.start && j.end && !j.current && monthIndex(j.end) < monthIndex(j.start)) gaps.push(`jobs.${k}.start`, `jobs.${k}.end`);
  });
  return [...new Set(gaps)];
}

// ── Settling a dispute ──────────────────────────────────────────────────────

/** Most resumes' text fits (the median is about 5,900 characters); a longer one is cut, and the report counts how often. */
export const CLEF_STATE_MAX_CHARS = 12_000;

export function clefState(pageText: string): string {
  const t = pageText.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return `A resume, as the text of its pages:\n\n${t.slice(0, CLEF_STATE_MAX_CHARS)}`;
}

/** One Clef question per dispute: a choice between the two readings for a value, yes or no for an item only one reader read. */
export function disputeQuestions(disputes: readonly Dispute[]): Record<string, ClefQuestion> {
  const q: Record<string, ClefQuestion> = {};
  for (const d of disputes) {
    if (d.kind === 'presence') {
      q[d.id] = { type: 'noul', instructions: `Does the resume list ${d.subject}: ${d.a ?? d.b}?` };
    } else {
      q[d.id] = {
        type: 'choice',
        instructions: `What does the resume give for ${d.subject}?`,
        criteria: {
          a: d.a == null ? 'It does not state it.' : `"${d.a}"`,
          b: d.b == null ? 'It does not state it.' : `"${d.b}"`,
          other: 'Something else than both of these.',
        },
      };
    }
  }
  return q;
}

export type Settlement =
  /** The value or presence the pipeline settled on, and by which step. */
  | { by: 'clef' | 'arbiter'; value: string | null; present?: boolean }
  /** Still open: a question to the worker. */
  | { by: 'open' };

/** The arbiter's request: the pages and the open questions, DeepSeek reasoning at high effort, JSON out. */
export function arbiterRequest(pages: readonly ParsePage[], open: readonly Dispute[]): Record<string, unknown> {
  const lines = open.map((d) =>
    d.kind === 'presence'
      ? `${d.id}: does the resume list ${d.subject}: ${d.a ?? d.b}? Answer present true or false.`
      : `${d.id}: what does the resume give for ${d.subject}? One reader read ${d.a == null ? 'nothing' : `"${d.a}"`}, another ${d.b == null ? 'nothing' : `"${d.b}"`}. Answer the value exactly as the resume writes it (a date as month and year when it gives both, "present" for a job that continues), or null if it does not state it.`,
  );
  return {
    messages: [
      { role: 'system', content: 'You check values two readers disagreed on, against the resume in the attached page images. Read the pages carefully and answer each question from what the resume itself says. Never guess.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: `The questions:\n${lines.join('\n')}\n\nThe resume is the attached page images, in order.` },
          ...pages.map((p) => ({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.base64}` } })),
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'cofferdam_resume_check',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['answers'],
          properties: {
            answers: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'value', 'present'],
                properties: { id: { type: 'string' }, value: { type: ['string', 'null'] }, present: { type: ['boolean', 'null'] } },
              },
            },
          },
        },
      },
    },
    reasoning_effort: 'high',
    max_tokens: 8_000,
  };
}

/** The JSON object of a chat answer (a string, possibly fenced, or an object), or null. */
export function answerObject(result: unknown): Record<string, unknown> | null {
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

/** The arbiter's answers by dispute id. */
export function readArbiter(result: unknown): Map<string, { value: string | null; present: boolean | null }> {
  const out = new Map<string, { value: string | null; present: boolean | null }>();
  const answers = answerObject(result)?.answers;
  if (!Array.isArray(answers)) return out;
  for (const a of answers) {
    if (!a || typeof a !== 'object') continue;
    const { id, value, present } = a as Record<string, unknown>;
    if (typeof id !== 'string') continue;
    out.set(id, { value: typeof value === 'string' && value.trim() ? value.trim() : null, present: typeof present === 'boolean' ? present : null });
  }
  return out;
}

/** A settled value written into the reading at its path; a presence settled as absent drops the item afterwards (`dropAbsent`). */
export function applyValue(r: Reading, path: string, value: string | null): void {
  const [list, k, field] = path.split('.');
  const i = Number(k);
  if (list === 'jobs' && r.jobs[i]) {
    const job = r.jobs[i]!;
    if (field === 'title') job.title = value;
    if (field === 'start') job.start = dateOf(value);
    if (field === 'end') {
      if (value && /^(present|current|now)$/i.test(value.trim())) {
        job.current = true;
        job.end = null;
      } else {
        job.current = false;
        job.end = dateOf(value);
      }
    }
  }
  if (list === 'schools' && r.schools[i] && field === 'institution') r.schools[i]!.institution = value;
}

/** A value as the reader of the parse would take it: a date through `parseCvDate`, so the arbiter's "March 2015" is `2015-03`. */
function dateOf(value: string | null): CvDate | null {
  if (!value) return null;
  if (/^\d{4}(-\d{2})?$/.test(value)) return value;
  const d = parseCvDate(value);
  return d && !d.present ? d.date : null;
}

/** Items whose presence was settled as absent, dropped; the paths of later items in the same list shift, so this runs last. */
export function dropAbsent(r: Reading, absent: readonly string[]): Reading {
  const drop = (list: string) => new Set(absent.filter((p) => p.startsWith(`${list}.`)).map((p) => Number(p.split('.')[1])));
  const [j, s, c] = [drop('jobs'), drop('schools'), drop('certificates')];
  return { jobs: r.jobs.filter((_, i) => !j.has(i)), schools: r.schools.filter((_, i) => !s.has(i)), certificates: r.certificates.filter((_, i) => !c.has(i)), skills: r.skills };
}

// ── The full check (the founder's last step) ────────────────────────────────

/** Every scored field of a reading under a short id (`j0.start`, `s1.institution`), for the full check. */
export function reviewFields(r: Reading): Record<string, string | null> {
  const f: Record<string, string | null> = {};
  r.jobs.forEach((j, k) => {
    f[`j${k}.title`] = j.title;
    f[`j${k}.start`] = j.start;
    f[`j${k}.end`] = j.current ? 'present' : j.end;
  });
  r.schools.forEach((s, k) => {
    f[`s${k}.institution`] = s.institution;
  });
  return f;
}

/** The full check's request: the pages and the reading, corrections and missing jobs out, DeepSeek at high effort. */
export function reviewRequest(pages: readonly ParsePage[], r: Reading): Record<string, unknown> {
  return {
    messages: [
      {
        role: 'system',
        content:
          'You check a resume reading against the resume in the attached page images. Report only what is wrong: a field whose value differs from what the resume writes (dates as month and year when the resume gives both, "present" for a job that continues), and any job the reading left out. Never change a value the resume supports.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `The reading, by field id:\n${JSON.stringify(reviewFields(r), null, 1)}\n\nThe resume is the attached page images, in order.` },
          ...pages.map((p) => ({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.base64}` } })),
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'cofferdam_resume_review',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['corrections', 'missing_jobs'],
          properties: {
            corrections: {
              type: 'array',
              items: { type: 'object', additionalProperties: false, required: ['id', 'value'], properties: { id: { type: 'string' }, value: { type: ['string', 'null'] } } },
            },
            missing_jobs: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['title', 'start', 'end'],
                properties: { title: { type: ['string', 'null'] }, start: { type: ['string', 'null'] }, end: { type: ['string', 'null'] } },
              },
            },
          },
        },
      },
    },
    reasoning_effort: 'high',
    max_tokens: 8_000,
  };
}

/** The reading after the full check's corrections, and how many it made. */
export function applyReview(r: Reading, result: unknown): { reading: Reading; corrections: number; added: number } {
  const out: Reading = { jobs: r.jobs.map((j) => ({ ...j })), schools: r.schools.map((s) => ({ ...s })), certificates: [...r.certificates], skills: r.skills };
  const o = answerObject(result);
  let corrections = 0;
  let added = 0;
  for (const c of Array.isArray(o?.corrections) ? o.corrections : []) {
    const { id, value } = (c ?? {}) as Record<string, unknown>;
    const m = typeof id === 'string' ? id.match(/^([js])(\d+)\.(title|start|end|institution)$/) : null;
    if (!m) continue;
    const path = `${m[1] === 'j' ? 'jobs' : 'schools'}.${m[2]}.${m[3]}`;
    applyValue(out, path, typeof value === 'string' && value.trim() ? value.trim() : null);
    corrections++;
  }
  for (const j of Array.isArray(o?.missing_jobs) ? o.missing_jobs : []) {
    const { title, start, end } = (j ?? {}) as Record<string, unknown>;
    if (typeof title !== 'string' || !title.trim()) continue;
    const job: ReadingJob = { title: title.trim(), start: dateOf(typeof start === 'string' ? start : null), end: null, current: false };
    applyValue({ jobs: [job], schools: [], certificates: [] }, 'jobs.0.end', typeof end === 'string' ? end : null);
    out.jobs.push(job);
    added++;
  }
  return { reading: out, corrections, added };
}

// ── Scoring against the labels ──────────────────────────────────────────────

/** right: correct and not asked; asked-right: correct, but the worker would be asked; asked-wrong: wrong and asked; silent: wrong and not asked. */
export type Outcome = 'right' | 'asked-right' | 'asked-wrong' | 'silent';
export type ScoredField = 'job' | 'title' | 'start' | 'end' | 'months' | 'school' | 'certificate';

export interface ResumeScore {
  outcomes: Record<ScoredField, Record<Outcome, number>>;
  jobs: { truth: number; found: number; spurious: number };
  schools: { truth: number; found: number; spurious: number };
  certificates: { truth: number; found: number };
  /** The questions the worker would get: every open field. */
  questions: number;
}

const FIELDS: ScoredField[] = ['job', 'title', 'start', 'end', 'months', 'school', 'certificate'];
export const emptyOutcomes = (): Record<ScoredField, Record<Outcome, number>> =>
  Object.fromEntries(FIELDS.map((f) => [f, { right: 0, 'asked-right': 0, 'asked-wrong': 0, silent: 0 }])) as Record<ScoredField, Record<Outcome, number>>;

/** A date read right at the label's precision: a month and year must both match, a bare year its year. */
const sameDate = (pred: CvDate | null, truth: CvDate | null) => pred === truth;

/**
 * One reading scored against one resume's labels. `open` holds the reading's
 * paths still open after the pipeline (`jobs.2.start`, `jobs.1`, `schools.0`):
 * a field under an open path counts as asked.
 */
export function scoreReading(r: Reading, truth: ResumeTruth, open: ReadonlySet<string>): ResumeScore {
  const outcomes = emptyOutcomes();
  const tally = (field: ScoredField, correct: boolean, asked: boolean) => {
    outcomes[field][correct ? (asked ? 'asked-right' : 'right') : asked ? 'asked-wrong' : 'silent']++;
  };
  const isOpen = (path: string) => open.has(path) || open.has(path.split('.').slice(0, 2).join('.'));

  const pairs = pairUp(truth.jobs, r.jobs, (t, p) => jobLikeness(t, p), 0.5);
  const byTruth = new Map(pairs);
  const pairedPred = new Set(pairs.map(([, j]) => j));
  truth.jobs.forEach((t, i) => {
    const j = byTruth.get(i);
    if (j == null) {
      tally('job', false, false);
      tally('title', false, false);
      if (t.start) tally('start', false, false);
      if (t.current || t.end) tally('end', false, false);
      if (jobMonths(t, truth.anchor) != null) tally('months', false, false);
      return;
    }
    const p = r.jobs[j]!;
    tally('job', true, isOpen(`jobs.${j}`));
    tally('title', sameTitle(p.title, t.title), isOpen(`jobs.${j}.title`));
    // A date the label lacks is not scored: some resumes write a job's dates outside the labelled spans.
    if (t.start) tally('start', sameDate(p.start, t.start), isOpen(`jobs.${j}.start`));
    if (t.current || t.end) tally('end', t.current ? p.current : !p.current && sameDate(p.end, t.end), isOpen(`jobs.${j}.end`));
    const tm = jobMonths(t, truth.anchor);
    const pm = jobMonths(p, truth.anchor);
    if (tm != null) tally('months', pm != null && Math.abs(pm - tm) <= 1, isOpen(`jobs.${j}.start`) || isOpen(`jobs.${j}.end`));
  });
  const spurious = r.jobs.filter((_, j) => !pairedPred.has(j)).length;

  const schoolPairs = pairUp(truth.schools, r.schools, (t, p) => overlap(t.school, p.institution) + 0.5 * overlap(t.degree, p.qualification), 0.5);
  const schoolByTruth = new Map(schoolPairs);
  truth.schools.forEach((t, i) => {
    const j = schoolByTruth.get(i);
    if (!t.school) return;
    if (j == null) {
      tally('school', false, false);
      return;
    }
    tally('school', sameSchool(r.schools[j]!.institution, t.school), isOpen(`schools.${j}`) || isOpen(`schools.${j}.institution`));
  });

  const readCerts = certificateKeywords(r.certificates.join(' ; '));
  let certsFound = 0;
  for (const k of truth.certificates) {
    const found = readCerts.includes(k);
    if (found) certsFound++;
    tally('certificate', found, false);
  }

  return {
    outcomes,
    jobs: { truth: truth.jobs.length, found: pairs.length, spurious },
    schools: { truth: truth.schools.filter((s) => s.school).length, found: schoolPairs.length, spurious: Math.max(0, r.schools.length - schoolPairs.length) },
    certificates: { truth: truth.certificates.length, found: certsFound },
    questions: open.size,
  };
}

/** Scores summed. */
export function addScores(scores: readonly ResumeScore[]): ResumeScore {
  const total: ResumeScore = { outcomes: emptyOutcomes(), jobs: { truth: 0, found: 0, spurious: 0 }, schools: { truth: 0, found: 0, spurious: 0 }, certificates: { truth: 0, found: 0 }, questions: 0 };
  for (const s of scores) {
    for (const f of FIELDS) for (const o of Object.keys(s.outcomes[f]) as Outcome[]) total.outcomes[f][o] += s.outcomes[f][o];
    for (const k of ['truth', 'found', 'spurious'] as const) {
      total.jobs[k] += s.jobs[k];
      total.schools[k] += s.schools[k];
    }
    total.certificates.truth += s.certificates.truth;
    total.certificates.found += s.certificates.found;
    total.questions += s.questions;
  }
  return total;
}

// ── The decision pass, replayed ─────────────────────────────────────────────

/** One finalist the decision pass considered for one search, kept or not: numbers only. */
export interface Considered {
  /** The resume's own listing, the one the search is for. */
  right: boolean;
  /** The token gate's tier, before Clef. */
  gateTier: 1 | 2;
  /** It matched one of the plan's occupations or their ISCO unit groups; a skill alone is not one, nor an occupation kept under Clef's floor. */
  occupationHit: boolean;
  /** Every hard requirement (`allOf`) held exactly. */
  meetsAllOf: boolean;
  score: number;
  /** Clef's choice, or null when the call failed. */
  choice: 'fit' | 'related' | 'other' | null;
  pFit: number;
  pRelated: number;
  pOther: number;
  /** The share of the job's needed skills the listing holds. */
  skillShare: number;
}

export interface ConsideredSearch {
  mode: 'instant' | 'curated';
  considered: Considered[];
}

/** What recall's finalists, kept and left out, say of one search. */
export function consideredOf(
  finalists: readonly Finalist[],
  intent: { allOf: readonly string[]; anyOf: readonly string[]; keptOccupation?: string },
  held: (listingId: string) => readonly string[],
  rightId: string | undefined,
): Considered[] {
  const needed = intent.anyOf.filter((t) => t.startsWith('skill:')).length;
  return finalists.map((f) => {
    const tokens = held(f.listingId);
    return {
      right: f.listingId === rightId,
      gateTier: f.fit?.promoted ? 2 : f.gateTier,
      occupationHit: !intent.keptOccupation && f.matched.some((t) => t.startsWith('pos:') || t.startsWith('isco:')),
      meetsAllOf: intent.allOf.every((t) => tokens.includes(t)),
      score: f.score,
      choice: f.fit?.choice ?? null,
      pFit: f.fit?.pFit ?? 0,
      pRelated: f.fit?.pRelated ?? 0,
      pOther: f.fit?.pOther ?? 0,
      skillShare: (f.fit?.skillsHeld ?? 0) / Math.max(1, needed),
    };
  });
}

/** A rule over one considered finalist: kept or not, its tier, its rank within the tier (higher first), and whether Clef is asked at all (default yes). */
export type DecisionRule = (c: Considered, mode: 'instant' | 'curated') => { keep: boolean; tier: 1 | 2; rank: number; asked?: boolean };

const builtRank = (c: Considered) => c.pFit + RELATED_WEIGHT * c.pRelated + SKILL_WEIGHT * c.skillShare + COSINE_WEIGHT * c.score;

/** The built rule with one part changed: what drops a finalist, the fit that promotes a miss, or the rank. */
function ruleWith(drops: (c: Considered) => boolean, fitFloor = FIT_FLOOR, rank: (c: Considered) => number = builtRank): DecisionRule {
  return (c, mode) => {
    const tier: 1 | 2 = c.gateTier === 1 || (c.choice !== null && c.pFit >= fitFloor && c.meetsAllOf) ? 1 : 2;
    return { keep: !(c.choice !== null && drops(c)) && (mode === 'curated' || tier === 1), tier, rank: rank(c) };
  };
}

const built = ruleWith((c) => c.pOther >= OTHER_FLOOR);
/** EmbeddingGemma 2's tier-2 floor, measured on its own scale (2026-10-27); recall's is still bge-m3's 0.5. */
export const GEMMA_TIER2_FLOOR = 0.65;

/** The rules the benchmark replays on the same decisions; the second is `recall.ts` as built. */
export const DECISION_RULES: Record<string, DecisionRule> = {
  'The gate alone, by cosine': (c, mode) => ({ keep: mode === 'curated' || c.gateTier === 1, tier: c.gateTier, rank: c.score, asked: false }),
  [`As built: other at ${OTHER_FLOOR} drops, a fit at ${FIT_FLOOR} promotes`]: built,
  [`As built, misses from cosine ${GEMMA_TIER2_FLOOR} (EmbeddingGemma 2's floor)`]: (c, mode) =>
    c.gateTier === 2 && c.score < GEMMA_TIER2_FLOOR ? { keep: false, tier: 2, rank: 0, asked: false } : built(c, mode),
  'Other drops at 0.7': ruleWith((c) => c.pOther >= 0.7),
  'Other drops at 0.9': ruleWith((c) => c.pOther >= 0.9),
  'Other drops only a finalist with no occupation hit': ruleWith((c) => !c.occupationHit && c.pOther >= OTHER_FLOOR),
  'Nothing dropped; a fit promotes': ruleWith(() => false),
  'A fit at 0.4 promotes': ruleWith((c) => c.pOther >= OTHER_FLOOR, 0.4),
  'As built, ranked by cosine within a tier': ruleWith((c) => c.pOther >= OTHER_FLOOR, FIT_FLOOR, (c) => c.score),
};

/** A rule replayed over searches: the right listing found, first, in the top five; the finalists kept and the Clef calls made, in all. */
export function replayRule(searches: readonly ConsideredSearch[], rule: DecisionRule): { found: number; first: number; top5: number; kept: number; asked: number } {
  let found = 0;
  let first = 0;
  let top5 = 0;
  let kept = 0;
  let asked = 0;
  for (const s of searches) {
    const all = s.considered.map((c) => ({ c, ...rule(c, s.mode) }));
    asked += all.filter((x) => x.asked !== false).length;
    const out = all.filter((x) => x.keep).sort((a, b) => a.tier - b.tier || b.rank - a.rank);
    kept += out.length;
    const at = out.findIndex((x) => x.c.right);
    if (at < 0) continue;
    found++;
    if (at === 0) first++;
    if (at < 5) top5++;
  }
  return { found, first, top5, kept, asked };
}
