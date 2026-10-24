// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The token registry (S3; workspace decision 0018, `docs/product/engine.md`,
 * Token registry): any title, skill or certificate, in any language, to one
 * token, through retrieve-then-choose.
 *
 *  1. An exact known label (ESCO's, the seed's, or one observed before) snaps
 *     without a model.
 *  2. Otherwise `bge-m3` (`work-embed`) embeds the raw string and
 *     `token-registry-v1` returns the nearest labels of the same kind. At or
 *     above τ_auto the best token is taken; in the band down to τ_low,
 *     `clef-flash` (`work-adjudicate`) chooses one candidate or none and says
 *     whether the title is a specialization of it; below the band, or when
 *     Clef chooses none at or above its floor, an occupation or a skill is
 *     minted and a certificate stays unmatched (certificates are never
 *     minted). A Clef call that fails or answers nothing leaves the string
 *     unmatched; one that answers below its floor is undecided, and the
 *     string may still reach an existing token through the pivot, but never
 *     mints.
 *  3. A mint asks the JSON-mode model (`work-pivot`) for the international-
 *     English name, the token's pivot, and the new token is `pending`: it
 *     snaps from then on, and waits for review and an `isco:` code.
 *
 * No model ever writes an ESCO or ISCO code: those come only from the ESCO
 * export (`esco.ts`). Clef answers which of the candidates it was shown, by
 * key. Every decision past the exact-label shortcut is recorded
 * (`registry_decisions`), and every snap adds the raw string as an observed
 * alias, so the same string snaps by label next time. Raw strings come from published listings and intents,
 * never from a CV, and no account, document or listing id is stored with
 * them.
 */

import type { Inference } from '../inference/index.js';
import { fold, scanText, type BlockLang } from './blocks.js';
import { adjudicationQuestions, adjudicationState, clefInput, readChoice, readNoul } from './clef.js';
import { failureCode, type ExecutorOptions } from './executor.js';
import { estimatedUsage, fieldsRequest, readFieldsAnswer, usageOrEstimate, withCalls, type FieldSet, type WorkCall } from './fields.js';

export const TOKEN_KINDS = ['pos', 'skill', 'cert'] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

export type TokenSource = 'esco' | 'emergent' | 'seed';
export type TokenStatus = 'active' | 'pending' | 'merged';

export interface RegistryToken {
  token: string;
  kind: TokenKind;
  source: TokenSource;
  /** The international-English pivot (`industry_english_title`). */
  labelEn: string;
  escoUri: string | null;
  iscoCode: string | null;
  status: TokenStatus;
  mergedInto: string | null;
}

export type LabelKind = 'preferred' | 'alternative' | 'hidden' | 'observed';

export interface RegistryLabel {
  /** Also the label's `token-registry-v1` vector id when `embedded`. */
  labelId: string;
  token: string;
  lang: string;
  label: string;
  labelNorm: string;
  kind: LabelKind;
  embedded: boolean;
}

// ── Token shape ─────────────────────────────────────────────────────────────

/** The longest slug after the prefix; Vectorize indexes the first 64 bytes of a string. */
export const SLUG_MAX = 56;

/** A label as the exact-label shortcut compares it: accents folded, lower case, punctuation and runs of space collapsed. */
export function labelNorm(label: string): string {
  return fold(label)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Lower case, accents folded, hyphenated: "Marine Engineer" → `marine-engineer`. */
export function tokenSlug(label: string): string {
  return labelNorm(label).replace(/ /g, '-').slice(0, SLUG_MAX).replace(/-+$/, '');
}

export function tokenOf(kind: TokenKind, label: string): string {
  return `${kind}:${tokenSlug(label)}`;
}

/** A label's id, which is its vector's id: stable for (token, language, label), 44 characters. */
export async function labelIdOf(token: string, lang: string, norm: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${token}\u0000${lang}\u0000${norm}`)));
  let b64 = '';
  for (const b of bytes) b64 += String.fromCharCode(b);
  return `l${btoa(b64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

// ── The store (D1) ──────────────────────────────────────────────────────────

export interface SnapRecord {
  id: string;
  kind: TokenKind;
  raw: string;
  lang: string;
  decision: SnapDecision;
  token: string | null;
  specialization: boolean;
  score: number | null;
  probability: number | null;
  candidates: { token: string; score: number }[];
  model: string | null;
  at: number;
}

export interface RegistryStore {
  /** Tokens of the kind that hold this exact label, merges followed. */
  tokensByLabel(norm: string, kind: TokenKind): Promise<RegistryToken[]>;
  /** The tokens named, merges followed, keyed by the name asked for. */
  tokens(names: string[]): Promise<Map<string, RegistryToken>>;
  /** Insert a token with its labels; false, and nothing written, when the token exists. */
  insertToken(token: RegistryToken, labels: RegistryLabel[], at: number): Promise<boolean>;
  /** Add labels to tokens that exist; a label already known is left as it is. */
  addLabels(labels: RegistryLabel[], at: number): Promise<void>;
  /** The labels whose vectors are now in `token-registry-v1`. */
  markEmbedded(labelIds: string[]): Promise<void>;
  recordDecision(record: SnapRecord): Promise<void>;
}

interface TokenRow {
  token: string;
  kind: TokenKind;
  source: TokenSource;
  label_en: string;
  esco_uri: string | null;
  isco_code: string | null;
  status: TokenStatus;
  merged_into: string | null;
}

const rowToken = (r: TokenRow): RegistryToken => ({
  token: r.token,
  kind: r.kind,
  source: r.source,
  labelEn: r.label_en,
  escoUri: r.esco_uri,
  iscoCode: r.isco_code,
  status: r.status,
  mergedInto: r.merged_into,
});

/** How many merges are followed before a chain is called broken. */
const MERGE_HOPS = 5;

export class D1RegistryStore implements RegistryStore {
  constructor(private readonly db: D1Database) {}

  private async rows(names: string[]): Promise<Map<string, RegistryToken>> {
    const out = new Map<string, RegistryToken>();
    const unique = [...new Set(names)];
    for (let i = 0; i < unique.length; i += 50) {
      const chunk = unique.slice(i, i + 50);
      const { results } = await this.db
        .prepare(`SELECT * FROM registry_tokens WHERE token IN (${chunk.map(() => '?').join(', ')})`)
        .bind(...chunk)
        .all<TokenRow>();
      for (const r of results) out.set(r.token, rowToken(r));
    }
    return out;
  }

  async tokens(names: string[]): Promise<Map<string, RegistryToken>> {
    const found = await this.rows(names);
    const out = new Map<string, RegistryToken>();
    for (const name of names) {
      let t = found.get(name);
      for (let hop = 0; t && t.status === 'merged' && t.mergedInto && hop < MERGE_HOPS; hop++) {
        const next = t.mergedInto;
        t = found.get(next) ?? (await this.rows([next])).get(next);
        if (t) found.set(t.token, t);
      }
      if (t && t.status !== 'merged') out.set(name, t);
    }
    return out;
  }

  async tokensByLabel(norm: string, kind: TokenKind): Promise<RegistryToken[]> {
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT t.token FROM registry_labels l JOIN registry_tokens t ON t.token = l.token
         WHERE l.label_norm = ? AND t.kind = ?`,
      )
      .bind(norm, kind)
      .all<{ token: string }>();
    const resolved = await this.tokens(results.map((r) => r.token));
    const seen = new Map<string, RegistryToken>();
    for (const t of resolved.values()) seen.set(t.token, t);
    return [...seen.values()];
  }

  private labelStatement(l: RegistryLabel, at: number) {
    return this.db
      .prepare(
        `INSERT INTO registry_labels (label_id, embedded, token, lang, label, label_norm, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (label_id) DO NOTHING`,
      )
      .bind(l.labelId, l.embedded ? 1 : 0, l.token, l.lang, l.label, l.labelNorm, l.kind, at);
  }

  async insertToken(t: RegistryToken, labels: RegistryLabel[], at: number): Promise<boolean> {
    // One transaction; the insert itself says who created the token, so two
    // mints of one token at once leave one row (and the other's labels as aliases).
    const [inserted] = (await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO registry_tokens (token, kind, source, label_en, esco_uri, isco_code, status, merged_into, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (token) DO NOTHING`,
        )
        .bind(t.token, t.kind, t.source, t.labelEn, t.escoUri, t.iscoCode, t.status, t.mergedInto, at, at),
      ...labels.map((l) => this.labelStatement(l, at)),
    ])) as { meta?: { changes?: number } }[];
    return (inserted?.meta?.changes ?? 0) > 0;
  }

  async addLabels(labels: RegistryLabel[], at: number): Promise<void> {
    if (labels.length) await this.db.batch(labels.map((l) => this.labelStatement(l, at)));
  }

  async markEmbedded(labelIds: string[]): Promise<void> {
    const ids = [...new Set(labelIds)];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      await this.db
        .prepare(`UPDATE registry_labels SET embedded = 1 WHERE label_id IN (${chunk.map(() => '?').join(', ')})`)
        .bind(...chunk)
        .run();
    }
  }

  async recordDecision(r: SnapRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO registry_decisions (id, kind, raw, lang, decision, token, specialization, score, probability, candidates, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(r.id, r.kind, r.raw, r.lang, r.decision, r.token, r.specialization ? 1 : 0, r.score, r.probability, JSON.stringify(r.candidates), r.model, r.at)
      .run();
  }
}

// ── The index (Vectorize) ───────────────────────────────────────────────────

export interface IndexMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface IndexVector {
  id: string;
  values: number[];
  namespace?: string;
  metadata: Record<string, string | number | boolean>;
}

export interface VectorIndex {
  query(vector: number[], opts: { topK: number; namespace?: string; filter?: Record<string, string | number | boolean> }): Promise<IndexMatch[]>;
  upsert(vectors: IndexVector[]): Promise<void>;
  deleteByIds(ids: string[]): Promise<void>;
}

/** Vectorize metadata returns with every match ("all": the unindexed fields too); topK stays within its 50. */
export function vectorizeIndex(binding: Vectorize): VectorIndex {
  return {
    async query(vector, opts) {
      const res = await binding.query(vector, {
        topK: Math.min(50, opts.topK),
        returnMetadata: 'all',
        ...(opts.namespace ? { namespace: opts.namespace } : {}),
        ...(opts.filter ? { filter: opts.filter } : {}),
      });
      return res.matches.map((m) => ({ id: m.id, score: m.score, metadata: (m.metadata ?? {}) as Record<string, unknown> }));
    },
    async upsert(vectors) {
      for (let i = 0; i < vectors.length; i += 500) await binding.upsert(vectors.slice(i, i + 500));
    },
    async deleteByIds(ids) {
      for (let i = 0; i < ids.length; i += 500) await binding.deleteByIds(ids.slice(i, i + 500));
    },
  };
}

// ── Embeddings ──────────────────────────────────────────────────────────────

/** `bge-m3` dimensions; `token-registry-v1` and `jobs-listings-v1` are created with them. */
export const EMBED_DIMS = 1024;

export type Embedding = { ok: true; vectors: number[][]; call: WorkCall } | { ok: false; call: WorkCall };

/** Embed texts with `work-embed`; fails closed on a missing or misshapen answer. */
export async function embedTexts(inference: Inference, texts: string[], opts: ExecutorOptions = {}): Promise<Embedding> {
  const now = opts.now ?? Date.now;
  const model = await inference.model('work-embed');
  const t0 = now();
  const request = { text: texts };
  let result: unknown;
  try {
    result = await inference.run('work-embed', request, { signal: opts.signal });
  } catch (err) {
    opts.log?.({ event: 'work_embed_failed', model, reason: failureCode(err) });
    return { ok: false, call: { op: 'work-embed', model, ok: false, ms: now() - t0, usage: estimatedUsage(request) } };
  }
  const usage = usageOrEstimate(result, request);
  const data = (result as { data?: unknown } | null)?.data;
  const ok =
    Array.isArray(data) &&
    data.length === texts.length &&
    data.every((v) => Array.isArray(v) && v.length === EMBED_DIMS && v.every((x) => typeof x === 'number' && Number.isFinite(x)));
  const call: WorkCall = { op: 'work-embed', model, ok, ms: now() - t0, usage };
  if (!ok) {
    opts.log?.({ event: 'work_embed_failed', model, reason: 'bad_shape' });
    return { ok: false, call };
  }
  return { ok: true, vectors: data as number[][], call };
}

// ── Retrieve, then choose ───────────────────────────────────────────────────

export type SnapDecision = 'label' | 'auto' | 'chosen' | 'pivot' | 'minted' | 'unmatched';

export interface Tau {
  /** At or above: the best candidate is taken without a model. */
  auto: number;
  /** Down to here, Clef adjudicates; below, a mint (or no certificate). */
  low: number;
}

/**
 * Starting values before tuning on the seed set. Decision 0018's example
 * (`marine-electrician` 0.91 against `electrician`, adjudicated a
 * specialization) sits inside the band, so τ_auto is above it.
 */
export const DEFAULT_TAU: Tau = { auto: 0.95, low: 0.6 };

/** Clef's pick counts at or above this; below, the candidates are refused. */
export const ADJUDICATION_FLOOR = 0.5;
/** A chosen candidate is a specialization above this. */
export const SPECIALIZATION_FLOOR = 0.5;
/** Candidates Clef is shown at most, best first. */
export const ADJUDICATION_CANDIDATES = 5;
/** The longest raw string the registry takes. */
export const RAW_MAX_CHARS = 120;

/** τ from `WORK_TAU_AUTO` and `WORK_TAU_LOW`, each in (0, 1], low below auto; anything else keeps the default. */
export function parseTau(auto: string | undefined, low: string | undefined): Tau {
  const n = (raw: string | undefined, fallback: number) => {
    const v = Number(raw);
    return raw && Number.isFinite(v) && v > 0 && v <= 1 ? v : fallback;
  };
  const t = { auto: n(auto, DEFAULT_TAU.auto), low: n(low, DEFAULT_TAU.low) };
  return t.low < t.auto ? t : DEFAULT_TAU;
}

export interface SnapInput {
  kind: TokenKind;
  raw: string;
  lang: BlockLang;
  /** False for a hirer's words: an intent snaps to what exists and never mints. Default true. */
  mint?: boolean;
}

export interface Candidate {
  token: string;
  labelEn: string;
  /** The label that matched, as written, and its language. */
  matched: string;
  matchedLang: string;
  score: number;
}

export interface SnapResult {
  decision: SnapDecision;
  token: string | null;
  labelEn: string | null;
  specialization: boolean;
  score: number | null;
  probability: number | null;
  candidates: Candidate[];
  calls: WorkCall[];
}

export interface RegistryDeps {
  inference: Inference;
  store: RegistryStore;
  index: VectorIndex;
  tau?: Tau;
  now?: () => number;
  /** A new decision id (default: a random UUID). */
  newId?: () => string;
  log?: (fields: Record<string, unknown>) => void;
}

/** The JSON-mode request for a new token's English pivot. */
export const PIVOT_FIELDS = {
  english: {
    type: 'text',
    instructions: 'The plain international English name, singular and in lower case, without rank, grade, employer or place.',
  },
} satisfies FieldSet;

const PIVOT_SYSTEM: Record<TokenKind, string> = {
  pos: 'You name occupations. Given a job title in any language, answer only with JSON: the plain international English name of the occupation ("Terceiro Oficial de Máquinas" is "marine engineer", "Plomero Oficial" is "plumber").',
  skill: 'You name skills. Given a skill in any language, answer only with JSON: its plain international English name ("soldagem TIG" is "tig welding").',
  cert: '',
};

const PIVOT_OK = /^[a-z][a-z' -]{0,58}[a-z]$/;

/** A pivot as the registry takes it: lower case Latin letters, spaces, hyphens and apostrophes, two to six words. */
export function validPivot(english: string): string | null {
  const v = english.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
  const words = v.split(' ').length;
  return PIVOT_OK.test(v) && words <= 6 ? v : null;
}

async function pivot(deps: RegistryDeps, input: SnapInput, calls: WorkCall[]): Promise<string | null> {
  const now = deps.now ?? Date.now;
  const model = await deps.inference.model('work-pivot');
  const t0 = now();
  // The pivot is free text by nature, so it never reads a field back as a span:
  // the request is JSON mode, and its one answer is validated as a pivot.
  const req = fieldsRequest(model, PIVOT_FIELDS, { name: 'pivot', system: PIVOT_SYSTEM[input.kind], user: input.raw, state: input.raw });
  try {
    const result = await deps.inference.run('work-pivot', req);
    const read = readFieldsAnswer(model, PIVOT_FIELDS, result);
    calls.push({ op: 'work-pivot', model, ok: read.ok, ms: now() - t0, usage: usageOrEstimate(result, req) });
    if (!read.ok || typeof read.fields.english?.value !== 'string') return null;
    return validPivot(read.fields.english.value);
  } catch (err) {
    calls.push({ op: 'work-pivot', model, ok: false, ms: now() - t0, usage: estimatedUsage(req) });
    deps.log?.({ event: 'work_pivot_failed', model, reason: failureCode(err) });
    return null;
  }
}

/** The nearest tokens of the kind, best score per token, active or pending only, best first. */
export async function candidatesFor(deps: Pick<RegistryDeps, 'store' | 'index'>, kind: TokenKind, vector: number[]): Promise<Candidate[]> {
  const matches = await deps.index.query(vector, { topK: 20, filter: { kind } });
  const best = new Map<string, IndexMatch>();
  for (const m of matches) {
    const token = m.metadata?.token;
    if (typeof token !== 'string' || !token.startsWith(`${kind}:`)) continue;
    const had = best.get(token);
    if (!had || m.score > had.score) best.set(token, m);
  }
  const live = await deps.store.tokens([...best.keys()]);
  const out = new Map<string, Candidate>();
  for (const [asked, m] of best) {
    const t = live.get(asked);
    if (!t) continue;
    const had = out.get(t.token);
    if (had && had.score >= m.score) continue;
    out.set(t.token, {
      token: t.token,
      labelEn: t.labelEn,
      matched: typeof m.metadata?.label === 'string' ? m.metadata.label : t.labelEn,
      matchedLang: typeof m.metadata?.lang === 'string' ? m.metadata.lang : 'en',
      score: m.score,
    });
  }
  return [...out.values()].sort((a, b) => b.score - a.score);
}

/**
 * Retrieve, then choose: see the module comment. Never throws on a model
 * failure (the decision says what happened); a store or index failure throws
 * a `WorkCallsError` carrying the calls already made.
 */
export async function snap(deps: RegistryDeps, input: SnapInput): Promise<SnapResult> {
  return withCalls((calls) => snapWith(deps, input, calls));
}

async function snapWith(deps: RegistryDeps, input: SnapInput, calls: WorkCall[]): Promise<SnapResult> {
  const now = deps.now ?? Date.now;
  const tau = deps.tau ?? DEFAULT_TAU;
  const raw = input.raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  const result = (r: Omit<SnapResult, 'calls'>): SnapResult => ({ ...r, calls });
  const none = { token: null, labelEn: null, specialization: false, score: null, probability: null, candidates: [] };
  if (!raw || raw.length > RAW_MAX_CHARS || scanText(raw)) return result({ decision: 'unmatched', ...none });
  const norm = labelNorm(raw);
  const at = now();
  const record = async (r: Omit<SnapResult, 'calls'>, model: string | null) => {
    await deps.store.recordDecision({
      id: deps.newId?.() ?? crypto.randomUUID(),
      kind: input.kind,
      raw,
      lang: input.lang,
      decision: r.decision,
      token: r.token,
      specialization: r.specialization,
      score: r.score,
      probability: r.probability,
      candidates: r.candidates.map((c) => ({ token: c.token, score: Math.round(c.score * 1e4) / 1e4 })),
      model,
      at,
    });
    return result(r);
  };
  const observe = async (token: string) =>
    deps.store.addLabels([{ labelId: await labelIdOf(token, input.lang, norm), token, lang: input.lang, label: raw, labelNorm: norm, kind: 'observed', embedded: false }], at);

  // 1. An exact known label.
  const labelled = await deps.store.tokensByLabel(norm, input.kind);
  if (labelled.length === 1) {
    const t = labelled[0]!;
    return result({ decision: 'label', token: t.token, labelEn: t.labelEn, specialization: false, score: 1, probability: null, candidates: [] });
  }

  // 2. The nearest labels.
  const embedding = await embedTexts(deps.inference, [raw], { now, log: deps.log });
  calls.push(embedding.call);
  if (!embedding.ok) return result({ decision: 'unmatched', ...none });
  const vector = embedding.vectors[0]!;
  const candidates = (await candidatesFor(deps, input.kind, vector)).slice(0, ADJUDICATION_CANDIDATES);
  const top = candidates[0];

  if (top && top.score >= tau.auto) {
    await observe(top.token);
    return record({ decision: 'auto', token: top.token, labelEn: top.labelEn, specialization: false, score: top.score, probability: null, candidates }, embedding.call.model);
  }

  let clefModel: string | null = null;
  /** Clef answered in the band, but below its floor: the pivot may find an existing token, never mint one. */
  let undecided: number | null = null;
  if (top && top.score >= tau.low) {
    clefModel = await deps.inference.model('work-adjudicate');
    const request = clefInput(clefModel, adjudicationState(input.kind, raw, input.lang), adjudicationQuestions(input.kind, candidates));
    const t0 = now();
    let answer: unknown;
    try {
      answer = await deps.inference.run('work-adjudicate', request);
    } catch (err) {
      calls.push({ op: 'work-adjudicate', model: clefModel, ok: false, ms: now() - t0, usage: estimatedUsage(request) });
      deps.log?.({ event: 'work_adjudicate_failed', model: clefModel, reason: failureCode(err) });
      // Fail closed: no adjudication is no snap.
      return record({ decision: 'unmatched', ...none, score: top.score, candidates }, clefModel);
    }
    const keys = [...candidates.map((_, i) => `c${i}`), 'none'];
    const pick = readChoice(answer, 'match', keys, ADJUDICATION_FLOOR);
    const answered = pick.p > 0 || Object.keys(pick.probabilities).length > 0;
    calls.push({ op: 'work-adjudicate', model: clefModel, ok: answered, ms: now() - t0, usage: { ...usageOrEstimate(answer, request), neurons: null } });
    if (pick.choice && pick.choice !== 'none') {
      const chosen = candidates[Number(pick.choice.slice(1))]!;
      const specialization = (readNoul(answer, 'specialization') ?? 0) > SPECIALIZATION_FLOOR;
      await observe(chosen.token);
      return record({ decision: 'chosen', token: chosen.token, labelEn: chosen.labelEn, specialization, score: top.score, probability: pick.p, candidates }, clefModel);
    }
    // Only Clef's own "none", at or above the floor, sends the string on to a
    // mint. No answer is no snap; an answer below the floor goes on undecided.
    if (!answered) {
      deps.log?.({ event: 'work_adjudicate_failed', model: clefModel, reason: 'no_answer' });
      return record({ decision: 'unmatched', ...none, score: top.score, candidates }, clefModel);
    }
    if (pick.choice !== 'none') undecided = pick.p;
  }

  // 3. Nothing matched: certificates (and anything a hirer wrote) stay unmatched; occupations and skills mint.
  const score = top?.score ?? null;
  if (input.kind === 'cert' || input.mint === false) return record({ decision: 'unmatched', ...none, score, probability: undecided, candidates }, clefModel);
  const english = await pivot(deps, { ...input, raw }, calls);
  if (!english) return record({ decision: 'unmatched', ...none, score, probability: undecided, candidates }, clefModel);
  const token = tokenOf(input.kind, english);
  const existing = (await deps.store.tokens([token])).get(token);
  if (existing) {
    await observe(existing.token);
    return record({ decision: 'pivot', token: existing.token, labelEn: existing.labelEn, specialization: false, score, probability: null, candidates }, clefModel);
  }
  if (undecided != null) return record({ decision: 'unmatched', ...none, score, probability: undecided, candidates }, clefModel);
  const labels: RegistryLabel[] = [
    { labelId: await labelIdOf(token, 'en', labelNorm(english)), token, lang: 'en', label: english, labelNorm: labelNorm(english), kind: 'preferred', embedded: false },
  ];
  if (input.lang !== 'en' || labelNorm(english) !== norm) {
    labels.push({ labelId: await labelIdOf(token, input.lang, norm), token, lang: input.lang, label: raw, labelNorm: norm, kind: 'observed', embedded: false });
  }
  const minted: RegistryToken = { token, kind: input.kind, source: 'emergent', labelEn: english, escoUri: null, iscoCode: null, status: 'pending', mergedInto: null };
  if (!(await deps.store.insertToken(minted, labels, at))) {
    // Another request minted it a moment ago: it is a pivot match now.
    return record({ decision: 'pivot', token, labelEn: english, specialization: false, score, probability: null, candidates }, clefModel);
  }
  // The new token's own labels join the index, so the next snap finds it by vector too.
  const pivotEmbedding = labels.length > 1 ? await embedTexts(deps.inference, [english], { now, log: deps.log }) : null;
  if (pivotEmbedding) calls.push(pivotEmbedding.call);
  const vectors: IndexVector[] = [];
  const pivotVector = labels.length > 1 ? (pivotEmbedding?.ok ? pivotEmbedding.vectors[0] : undefined) : vector;
  if (pivotVector) vectors.push({ id: labels[0]!.labelId, values: pivotVector, metadata: { token, kind: input.kind, lang: 'en', label: english, source: 'emergent' } });
  if (labels[1]) vectors.push({ id: labels[1].labelId, values: vector, metadata: { token, kind: input.kind, lang: input.lang, label: raw, source: 'emergent' } });
  // A label is marked embedded only once its vector is in: a failed pivot
  // embedding leaves the English label for the backfill to find.
  await deps.index.upsert(vectors);
  await deps.store.markEmbedded(vectors.map((v) => v.id));
  return record({ decision: 'minted', token, labelEn: english, specialization: false, score, probability: null, candidates }, clefModel);
}
