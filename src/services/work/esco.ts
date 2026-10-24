// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one-time ESCO import (workspace decision 0018): the official ESCO
 * classification export, CSV, one file per pillar and language
 * (`occupations_en.csv`, `skills_pt.csv`, ...), into registry rows (D1) and
 * `token-registry-v1` label vectors. Every `esco:` URI and `isco:` code in the
 * registry comes from here, read from the export; none is written by a model
 * or by hand. The download (esco.ec.europa.eu, Use ESCO, Download: version,
 * content "classification", language, file type CSV) asks for an email
 * address and a privacy statement, so the founder fetches it.
 *
 * Columns are found by name in each file's header row; a file without the
 * ones the import needs stops it, naming the columns it has. Labels inside a
 * cell are one per line. An occupation's ISCO-08 unit group is its
 * `iscoGroup` (a code or a URI ending in one), else the four digits before
 * the dot of its ESCO `code`. Concepts not `released` are skipped.
 *
 * The plan is pure: `test/esco.import.test.ts` (opt-in, from the Mac) reads
 * the files, embeds the labels with `bge-m3` and writes the SQL and NDJSON
 * that `wrangler d1 execute` and `wrangler vectorize insert` load.
 */

import { labelIdOf, labelNorm, tokenSlug, type LabelKind, type RegistryLabel, type RegistryToken, type TokenKind } from './registry.js';

// ── CSV ─────────────────────────────────────────────────────────────────────

/** RFC 4180: commas, quoted cells with doubled quotes, and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ── ESCO files ──────────────────────────────────────────────────────────────

export type EscoPillar = 'occupation' | 'skill';

export interface EscoConcept {
  uri: string;
  preferred: string;
  alternatives: string[];
  hidden: string[];
  /** ISCO-08 unit group, occupations only. */
  isco: string | null;
}

/** Header names the import accepts, compared without case, spaces or underscores. */
const COLUMNS = {
  uri: ['concepturi', 'uri'],
  preferred: ['preferredlabel', 'conceptpt', 'preferredterm'],
  alternatives: ['altlabels', 'alternativelabels', 'alternativelabel'],
  hidden: ['hiddenlabels', 'hiddenlabel'],
  isco: ['iscogroup', 'iscocode'],
  code: ['code'],
  status: ['status'],
} as const;

const header = (h: string) => h.toLowerCase().replace(/[\s_]/g, '');

export class EscoFormatError extends Error {}

function locate(head: string[], names: readonly string[]): number {
  return head.findIndex((h) => names.includes(header(h)));
}

const lines = (cell: string | undefined) =>
  (cell ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** The ISCO-08 unit group of an occupation row, from the export only. */
export function iscoOf(iscoCell: string | undefined, codeCell: string | undefined): string | null {
  const fromGroup = /(\d{4})\s*$/.exec(iscoCell?.trim() ?? '');
  if (fromGroup) return fromGroup[1]!;
  const fromCode = /^(\d{4})\./.exec(codeCell?.trim() ?? '');
  return fromCode ? fromCode[1]! : null;
}

/** One ESCO file's released concepts. */
export function readEscoFile(text: string, pillar: EscoPillar): EscoConcept[] {
  const [head, ...rows] = parseCsv(text);
  if (!head) throw new EscoFormatError('empty file');
  const at = {
    uri: locate(head, COLUMNS.uri),
    preferred: locate(head, COLUMNS.preferred),
    alternatives: locate(head, COLUMNS.alternatives),
    hidden: locate(head, COLUMNS.hidden),
    isco: locate(head, COLUMNS.isco),
    code: locate(head, COLUMNS.code),
    status: locate(head, COLUMNS.status),
  };
  const missing = [
    at.uri < 0 && 'conceptUri',
    at.preferred < 0 && 'preferredLabel',
    pillar === 'occupation' && at.isco < 0 && at.code < 0 && 'iscoGroup or code',
  ].filter(Boolean);
  if (missing.length) throw new EscoFormatError(`missing ${missing.join(', ')}; the header has: ${head.join(', ')}`);
  const concepts: EscoConcept[] = [];
  for (const r of rows) {
    const uri = r[at.uri]?.trim() ?? '';
    const preferred = r[at.preferred]?.trim() ?? '';
    if (!uri || !preferred) continue;
    if (at.status >= 0 && r[at.status] && r[at.status]!.trim().toLowerCase() !== 'released') continue;
    concepts.push({
      uri,
      preferred,
      alternatives: at.alternatives >= 0 ? lines(r[at.alternatives]) : [],
      hidden: at.hidden >= 0 ? lines(r[at.hidden]) : [],
      isco: pillar === 'occupation' ? iscoOf(at.isco >= 0 ? r[at.isco] : undefined, at.code >= 0 ? r[at.code] : undefined) : null,
    });
  }
  return concepts;
}

// ── The plan ────────────────────────────────────────────────────────────────

export const ESCO_LANGS = ['en', 'pt', 'es'] as const;
export type EscoLang = (typeof ESCO_LANGS)[number];

export interface EscoFiles {
  /** File contents by language; English is required, it names the tokens. */
  occupations: Partial<Record<EscoLang, string>>;
  skills?: Partial<Record<EscoLang, string>>;
}

export interface EscoPlan {
  tokens: RegistryToken[];
  labels: RegistryLabel[];
  counts: { occupations: number; skills: number; labels: number; withoutIsco: number; renamed: number };
}

/** The last characters of a URI, to tell two concepts with one English name apart. */
const uriTail = (uri: string) => uri.replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase();

/**
 * Tokens and labels from the export. A token is named by its English
 * preferred label; two concepts with the same name get the URI's tail as a
 * suffix, in URI order, so a re-run names them the same.
 */
export async function planEscoImport(files: EscoFiles, opts: { hidden?: boolean } = {}): Promise<EscoPlan> {
  const hidden = opts.hidden ?? true;
  const tokens: RegistryToken[] = [];
  const labels: RegistryLabel[] = [];
  const counts = { occupations: 0, skills: 0, labels: 0, withoutIsco: 0, renamed: 0 };
  const taken = new Set<string>();

  const pillars: [EscoPillar, TokenKind, Partial<Record<EscoLang, string>> | undefined][] = [
    ['occupation', 'pos', files.occupations],
    ['skill', 'skill', files.skills],
  ];
  for (const [pillar, kind, byLang] of pillars) {
    if (!byLang) continue;
    const english = byLang.en;
    if (!english) throw new EscoFormatError(`the English ${pillar} file is required`);
    const base = readEscoFile(english, pillar).sort((a, b) => a.uri.localeCompare(b.uri));
    const others = new Map<string, Map<string, EscoConcept>>();
    for (const lang of ESCO_LANGS) {
      if (lang === 'en' || !byLang[lang]) continue;
      others.set(lang, new Map(readEscoFile(byLang[lang], pillar).map((c) => [c.uri, c])));
    }
    for (const concept of base) {
      let token = `${kind}:${tokenSlug(concept.preferred)}`;
      if (token === `${kind}:`) continue;
      if (taken.has(token)) {
        token = `${kind}:${tokenSlug(concept.preferred).slice(0, 49)}-${uriTail(concept.uri)}`;
        counts.renamed++;
      }
      taken.add(token);
      if (pillar === 'occupation') {
        counts.occupations++;
        if (!concept.isco) counts.withoutIsco++;
      } else counts.skills++;
      tokens.push({ token, kind, source: 'esco', labelEn: concept.preferred, escoUri: concept.uri, iscoCode: concept.isco, status: 'active', mergedInto: null });
      const seen = new Set<string>();
      const add = async (lang: string, label: string, labelKind: LabelKind) => {
        const norm = labelNorm(label);
        const key = `${lang}\u0000${norm}`;
        if (!norm || seen.has(key)) return;
        seen.add(key);
        labels.push({ labelId: await labelIdOf(token, lang, norm), token, lang, label, labelNorm: norm, kind: labelKind, embedded: true });
      };
      for (const [lang, c] of [['en', concept] as const, ...[...others].map(([l, m]) => [l, m.get(concept.uri)] as const)]) {
        if (!c) continue;
        await add(lang, c.preferred, 'preferred');
        for (const a of c.alternatives) await add(lang, a, 'alternative');
        if (hidden) for (const h of c.hidden) await add(lang, h, 'hidden');
      }
    }
  }
  counts.labels = labels.length;
  return { tokens, labels, counts };
}

// ── What wrangler loads ─────────────────────────────────────────────────────

const sql = (v: string | number | null) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`);

/** Rows per INSERT, well under D1's statement size. */
const SQL_ROWS = 100;

/** The plan as SQL for `wrangler d1 execute cofferdam-work --remote --file=…`; a re-run inserts nothing twice. */
export function registrySql(plan: EscoPlan, at: number): string {
  const out: string[] = [];
  for (let i = 0; i < plan.tokens.length; i += SQL_ROWS) {
    const rows = plan.tokens
      .slice(i, i + SQL_ROWS)
      .map((t) => `(${[t.token, t.kind, t.source, t.labelEn, t.escoUri, t.iscoCode, t.status, t.mergedInto, at, at].map(sql).join(', ')})`);
    out.push(
      `INSERT INTO registry_tokens (token, kind, source, label_en, esco_uri, isco_code, status, merged_into, created_at, updated_at) VALUES\n${rows.join(',\n')}\nON CONFLICT DO NOTHING;`,
    );
  }
  for (let i = 0; i < plan.labels.length; i += SQL_ROWS) {
    const rows = plan.labels
      .slice(i, i + SQL_ROWS)
      .map((l) => `(${[l.labelId, l.embedded ? 1 : 0, l.token, l.lang, l.label, l.labelNorm, l.kind, at].map(sql).join(', ')})`);
    out.push(`INSERT INTO registry_labels (label_id, embedded, token, lang, label, label_norm, kind, created_at) VALUES\n${rows.join(',\n')}\nON CONFLICT DO NOTHING;`);
  }
  return out.join('\n') + '\n';
}

/** Vector metadata keeps 64 indexed bytes per string and 10 KiB in all; a label is cut to this. */
const LABEL_META_MAX = 200;

/** One NDJSON line per label vector for `wrangler vectorize insert token-registry-v1 --file=…`. */
export function vectorLine(label: RegistryLabel, token: RegistryToken, values: number[]): string {
  const metadata: Record<string, string> = {
    token: label.token,
    kind: token.kind,
    lang: label.lang,
    label: label.label.slice(0, LABEL_META_MAX),
    source: token.source,
    ...(token.iscoCode ? { isco: token.iscoCode } : {}),
  };
  return JSON.stringify({ id: label.labelId, values: values.map((v) => Math.round(v * 1e6) / 1e6), metadata });
}
