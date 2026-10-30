// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The token registry (S3; workspace decision 0018, `docs/product/engine.md`,
 * Token registry): any title, skill or certificate, in any language, to one
 * token, through retrieve-then-choose.
 *
 *  1. An exact known label (ESCO's, a national layer's, or one observed
 *     before) snaps without a model, read in the string's own
 *     language and in English only (`labelLangs`): another language may use
 *     the word for something else, as ESCO's Spanish gives "instructor" to
 *     the air force officer and "coach" to the life coach.
 *  2. Otherwise `bge-m3` (`work-embed`) embeds the raw string and
 *     `token-registry-v1` returns the nearest labels of the same kind, in
 *     every language. The best token is taken when one of its labels in
 *     those two languages is at or above τ_auto; in the band down to τ_low,
 *     or when only another language's label reaches τ_auto (bge-m3 puts a
 *     word and its case variant near 0.95, and the same word at 1),
 *     `clef-flash` (`work-adjudicate`) chooses one candidate or none and says
 *     whether the title is a specialization of it; below the band, or when
 *     Clef chooses none at or above its floor, an occupation or a skill is
 *     minted and a certificate stays unmatched (certificates are never
 *     minted). A Clef call that fails or answers nothing leaves the string
 *     unmatched; one that answers below its floor is undecided, and the
 *     string may still reach an existing token through the pivot, but never
 *     mints.
 *  3. Before a mint, the JSON-mode model (`work-pivot`) gives the string's
 *     international-English name, the token's pivot. The name goes through
 *     the exact-label shortcut first, over English labels only: a label of
 *     exactly one token (ESCO's alternative labels and a national layer's
 *     titles among them) snaps to that token, and a name several tokens
 *     hold, or none, snaps only to the token whose slug it is. Only then is
 *     a new token minted, `pending`: it snaps from then on, and waits for
 *     review and an `isco:` code.
 *
 * The model steps read a string with its locale (`locale.ts`), as context:
 * Clef's band state names its language, and for a worker's occupation or
 * skill the variant and the market of their listing (`SnapInput.market`:
 * "An occupation written in Brazilian Portuguese by a worker in Brazil
 * (br-sp)"); each candidate shows the language of the label that matched,
 * and a national layer's region ("life coach (matched "coach", Spanish)");
 * and the pivot reads the same state, so a Brazilian "Bombeiro hidráulico"
 * names a plumber, not a firefighter. No step prefers a label of the
 * string's language or region because of it: ESCO's Portuguese is
 * Portugal's and its Spanish is Spain's, and its Spanish gives "instructor"
 * to the air force officer. The market decides nothing without a model, and
 * is not stored: a decision keeps the string's language only, and so does
 * the alias a snap observes, which then decides that string by label for
 * every market of its language.
 *
 * A certificate snaps as a skill does (workspace decision 0070, the
 * founder's rulings of 2026-10-30): the exact label, the nearest labels and
 * τ_auto, then Clef in the band. A worker's claim and a hirer's words reach
 * only a certificate token that exists: neither mints one, and neither goes
 * on to the pivot. Only a Vault document will mint a certificate (decision
 * 0070 (a), not built), so until then the registry holds none and every
 * certificate stays unmatched. A certificate claim reads no market
 * (`listings.ts` `claimSnapInput`).
 *
 * No model ever writes an ESCO or ISCO code: those come only from the ESCO
 * export (`esco.ts`). Clef answers which of the candidates it was shown, by
 * key. Every decision past the exact-label shortcut is recorded
 * (`registry_decisions`), and every snap of a worker's string adds it as an
 * observed alias in the string's language, so the same string snaps by label
 * next time: in that language, and in every language when it is English. A
 * hirer's words never become an alias. Raw strings come from published
 * listings and intents, never from a CV, and no account, document or listing
 * id is stored with them.
 */

import type { Inference } from '../inference/index.js';
import { fold, scanText, type BlockLang } from './blocks.js';
import { adjudicationQuestions, adjudicationState, clefInput, readChoice, readNoul } from './clef.js';
import { failureCode, type ExecutorOptions } from './executor.js';
import { estimatedUsage, fieldsRequest, readFieldsAnswer, usageOrEstimate, withCalls, type FieldSet, type WorkCall } from './fields.js';
import type { StringLocale } from './locale.js';

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

/**
 * The languages whose labels may decide a string in `lang` without a model
 * (founder, 2026-10-26): the exact-label shortcut reads only these, and a
 * best candidate at τ_auto is taken only through a label in one of them. The
 * string's own, so a word another language gives another occupation never
 * catches it, and English, so a Portuguese or Spanish CV's English title
 * still snaps.
 */
export function labelLangs(lang: string): string[] {
  return lang === 'en' ? ['en'] : [lang, 'en'];
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
  /**
   * Tokens of the kind that hold this exact label (in one of `langs` only,
   * when they are given), merges followed; where a curated label in those
   * languages holds it, the tokens that hold it there only as an observed
   * alias are left out.
   */
  tokensByLabel(norm: string, kind: TokenKind, langs?: readonly string[]): Promise<RegistryToken[]>;
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

  async tokensByLabel(norm: string, kind: TokenKind, langs?: readonly string[]): Promise<RegistryToken[]> {
    if (langs && !langs.length) return [];
    // `observed` is 1 for a token that holds the label, in the languages read, only as an alias a snap observed.
    const { results } = await this.db
      .prepare(
        `SELECT t.token, MIN(l.kind = 'observed') AS observed FROM registry_labels l JOIN registry_tokens t ON t.token = l.token
         WHERE l.label_norm = ? AND t.kind = ?${langs ? ` AND l.lang IN (${langs.map(() => '?').join(', ')})` : ''} GROUP BY t.token`,
      )
      .bind(norm, kind, ...(langs ?? []))
      .all<{ token: string; observed: number }>();
    // A curated label (ESCO's, a national layer's) outranks an observed alias (decision 0066 (4)).
    const curated = results.filter((r) => !r.observed);
    const resolved = await this.tokens((curated.length ? curated : results).map((r) => r.token));
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

/**
 * EmbeddingGemma 2 on the phone (llama.rn), as a model id the plane pins: the
 * GGUF artefact itself, since Workers AI does not run it. Its vectors come
 * from the client and from a Mac script (`scripts/work/embed-registry.mjs`),
 * never from the plane, and only an index generation of its own holds them
 * (`token-registry-v3`, `jobs-listings-v3`).
 */
export const EMBEDDINGGEMMA_2_GGUF = 'gguf:ggml-org/embeddinggemma-2-GGUF:Q8_0';

/**
 * The vector size of each model `work-embed` may be pinned to; any other model
 * fails closed. Each generation of indexes holds one model's vectors: v1
 * bge-m3's 1024, v2 EmbeddingGemma's 768 (decision 0067, rule 7), v3
 * EmbeddingGemma 2's 768 from the phone. Pinning another model in production
 * needs new indexes of its size and every label and listing embedded again.
 */
export const EMBED_DIMS_BY_MODEL: Readonly<Record<string, number>> = {
  '@cf/baai/bge-m3': 1024,
  '@cf/google/embeddinggemma-300m': 768,
  [EMBEDDINGGEMMA_2_GGUF]: 768,
};

/**
 * The models the plane cannot run: under such a pin `embedTexts` never calls
 * Workers AI and fails closed, so a text is embedded only where the client
 * sent its vector (`readClientVector`), and a snap without one meets the
 * registry by exact label only.
 */
export const CLIENT_EMBED_MODELS: ReadonlySet<string> = new Set([EMBEDDINGGEMMA_2_GGUF]);

/** How far a client vector's length may be from 1. */
export const UNIT_NORM_TOLERANCE = 1e-3;

export type ClientVectorRefusal = 'model' | 'dims' | 'values' | 'norm';

/**
 * A vector the client embedded for a request's text, as the body sends it
 * (`{ model, dims, values }`): taken only for the pinned generation's model,
 * at its size, with finite values of unit length (the phone L2-normalises).
 */
export function readClientVector(raw: unknown, model: string): { ok: true; values: number[] } | { ok: false; reason: ClientVectorRefusal } {
  const v = raw as { model?: unknown; dims?: unknown; values?: unknown } | null;
  if (!v || typeof v !== 'object' || v.model !== model) return { ok: false, reason: 'model' };
  const dims = EMBED_DIMS_BY_MODEL[model];
  if (dims === undefined || v.dims !== dims || !Array.isArray(v.values) || v.values.length !== dims) return { ok: false, reason: 'dims' };
  const values = v.values as unknown[];
  if (!values.every((x) => typeof x === 'number' && Number.isFinite(x))) return { ok: false, reason: 'values' };
  let n = 0;
  for (const x of values as number[]) n += x * x;
  if (Math.abs(Math.sqrt(n) - 1) > UNIT_NORM_TOLERANCE) return { ok: false, reason: 'norm' };
  return { ok: true, values: values as number[] };
}

export type Embedding = { ok: true; vectors: number[][]; call: WorkCall } | { ok: false; call: WorkCall };

/**
 * What a text is to the index: a `query` searched against stored labels and
 * listings (a snapped string, a hirer's task), or a `document` stored in it
 * (a label, a listing).
 */
export type EmbedRole = 'query' | 'document';

/**
 * A model's prompts per role, prefixed to every text it embeds. EmbeddingGemma
 * was trained with them (its model card's retrieval prompts, as the
 * 2026-10-25 encoder comparison used them); bge-m3 takes none.
 */
export const EMBED_PROMPTS_BY_MODEL: Readonly<Record<string, Readonly<Record<EmbedRole, string>>>> = {
  '@cf/google/embeddinggemma-300m': { query: 'task: search result | query: ', document: 'title: none | text: ' },
  // The phone and the Mac script prefix the same two (the coordinator's spec, 2026-10-26).
  [EMBEDDINGGEMMA_2_GGUF]: { query: 'task: search result | query: ', document: 'title: none | text: ' },
};

export interface EmbedOptions extends ExecutorOptions {
  role: EmbedRole;
}

/** Embed texts with `work-embed`, in their role; fails closed on a missing or misshapen answer. */
export async function embedTexts(inference: Inference, texts: string[], opts: EmbedOptions): Promise<Embedding> {
  const now = opts.now ?? Date.now;
  const model = await inference.model('work-embed');
  const t0 = now();
  const prompt = EMBED_PROMPTS_BY_MODEL[model]?.[opts.role] ?? '';
  const request = { text: prompt ? texts.map((t) => prompt + t) : texts };
  if (CLIENT_EMBED_MODELS.has(model)) {
    // No hosted call: the plane does not run this model, and the call is not metered.
    opts.log?.({ event: 'work_embed_failed', model, reason: 'no_plane_embedder' });
    return { ok: false, call: { op: 'work-embed', model, ok: false, ms: 0, usage: { tokensIn: 0, tokensOut: 0, neurons: null } } };
  }
  let result: unknown;
  try {
    result = await inference.run('work-embed', request, { signal: opts.signal });
  } catch (err) {
    opts.log?.({ event: 'work_embed_failed', model, reason: failureCode(err) });
    return { ok: false, call: { op: 'work-embed', model, ok: false, ms: now() - t0, usage: estimatedUsage(request) } };
  }
  const usage = usageOrEstimate(result, request);
  const data = (result as { data?: unknown } | null)?.data;
  const dims = EMBED_DIMS_BY_MODEL[model];
  const ok =
    dims !== undefined &&
    Array.isArray(data) &&
    data.length === texts.length &&
    data.every((v) => Array.isArray(v) && v.length === dims && v.every((x) => typeof x === 'number' && Number.isFinite(x)));
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
 * bge-m3's values, set before tuning on the seed set. Decision 0018's example
 * (`marine-electrician` 0.91 against `electrician`, adjudicated a
 * specialization) sits inside the band, so τ_auto is above it.
 */
export const DEFAULT_TAU: Tau = { auto: 0.95, low: 0.6 };

/**
 * τ follows the embedding model, since every model has its own cosine scale:
 * pinning another `work-embed` brings its values (decision 0067, rule 7).
 * A model without values here takes `DEFAULT_TAU`.
 *
 * EmbeddingGemma's were set against bge-m3's on 2,000 of ESCO's own
 * alternative and hidden labels, held out (`test/registry.tau.test.ts`,
 * `test/work-eval/tau-embeddinggemma-300m-2026-10-26.md`): at 0.81 it takes
 * no more strings without Clef than bge-m3 does at 0.95 (37.5% against 40.4%),
 * 92.1% of them right against 83.5% (an occupation 86.3% against 62.4%); at
 * 0.45 it leaves out of the band no more strings whose token was among the
 * best five (0.1%).
 */
export const DEFAULT_TAU_BY_MODEL: Readonly<Record<string, Tau>> = {
  '@cf/baai/bge-m3': DEFAULT_TAU,
  '@cf/google/embeddinggemma-300m': { auto: 0.81, low: 0.45 },
  // Version 2's own scale (unrelated labels 0.68 on average, crowded at the top), on held-out ESCO labels from
  // its llama-embedding vectors, the same at 768 and 512 dimensions (test/work-eval, 2026-10-27).
  [EMBEDDINGGEMMA_2_GGUF]: { auto: 0.96, low: 0.81 },
};

/** τ as `WORK_TAU_AUTO` and `WORK_TAU_LOW` set it: either, both or neither. */
export interface TauSetting {
  auto?: number;
  low?: number;
}

/** The model's τ, with what the environment sets in place of its values; a pair with low not below auto keeps the model's. */
export function tauFor(model: string, setting: TauSetting = {}): Tau {
  const base = DEFAULT_TAU_BY_MODEL[model] ?? DEFAULT_TAU;
  const t = { auto: setting.auto ?? base.auto, low: setting.low ?? base.low };
  return t.low < t.auto ? t : base;
}

/** Clef's pick counts at or above this; below, the candidates are refused. */
export const ADJUDICATION_FLOOR = 0.5;
/** A chosen candidate is a specialization above this. */
export const SPECIALIZATION_FLOOR = 0.5;
/** Candidates Clef is shown at most, best first. */
export const ADJUDICATION_CANDIDATES = 5;
/** The longest raw string the registry takes. */
export const RAW_MAX_CHARS = 120;

/** `WORK_TAU_AUTO` and `WORK_TAU_LOW`, each kept only in (0, 1]; `tauFor` joins them to the model's values. */
export function parseTau(auto: string | undefined, low: string | undefined): TauSetting {
  const n = (raw: string | undefined) => {
    const v = Number(raw);
    return raw && Number.isFinite(v) && v > 0 && v <= 1 ? v : undefined;
  };
  const out: TauSetting = {};
  const a = n(auto);
  const l = n(low);
  if (a !== undefined) out.auto = a;
  if (l !== undefined) out.low = l;
  return out;
}

export interface SnapInput {
  kind: TokenKind;
  raw: string;
  lang: BlockLang;
  /** False for a hirer's words: an intent snaps to what exists, never mints and leaves no alias. Default true. A certificate never mints either way. */
  mint?: boolean;
  /**
   * A worker's occupation or skill only: the coarse region of their listing
   * (`br-sp`, `mx`, `us-tx`), so the model steps read the string in its
   * regional variant ("Encanador" in Brazilian Portuguese). Context for Clef's
   * state and the pivot, never a rule: no step prefers a label of that
   * language or region, it decides nothing without a model, and it is not
   * stored. Never a certificate's: a claim names its own jurisdiction, and a
   * market never names one for it.
   */
  market?: string;
  /**
   * The string's vectors as the client embedded them (EmbeddingGemma 2 on the
   * phone), already checked against the pinned model (`readClientVector`):
   * the query the snap searches with, and the document a mint stores for the
   * string's own label. Without a query vector the plane embeds the string,
   * or, under a pin it cannot run, the snap ends at the exact label.
   */
  vectors?: { query?: number[]; document?: number[] };
}

export interface Candidate {
  token: string;
  labelEn: string;
  /** The label that matched, as written, and its language (null when its vector names none). */
  matched: string;
  matchedLang: string | null;
  /** The matched label's region, a national layer's (`us`); null or absent for ESCO's and a mint's labels. */
  matchedRegion?: string | null;
  score: number;
  /**
   * With the languages `candidatesFor` was given: the best score through one
   * of the nearest labels in them, null when none of those is.
   */
  scoped?: number | null;
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
  /** What the environment sets of τ; the rest is the embedding model's (`tauFor`). */
  tau?: TauSetting;
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

/** The message names the string's language, and for a worker's string the variant and the market (`adjudicationState`), as context. */
const PIVOT_SYSTEM: Record<'pos' | 'skill', string> = {
  pos: 'You name occupations. Given a job title in any language, with the language it is written in and, when known, where the worker who wrote it is, answer only with JSON: the plain international English name of the occupation ("Terceiro Oficial de Máquinas" is "marine engineer", "Plomero Oficial" is "plumber").',
  skill: 'You name skills. Given a skill in any language, with the language it is written in and, when known, where the worker who wrote it is, answer only with JSON: its plain international English name ("soldagem TIG" is "tig welding").',
};

const PIVOT_OK = /^[a-z][a-z' -]{0,58}[a-z]$/;

/** A pivot as the registry takes it: lower case Latin letters, spaces, hyphens and apostrophes, two to six words. */
export function validPivot(english: string): string | null {
  const v = english.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
  const words = v.split(' ').length;
  return PIVOT_OK.test(v) && words <= 6 ? v : null;
}

async function pivot(deps: RegistryDeps, kind: 'pos' | 'skill', raw: string, locale: StringLocale, calls: WorkCall[]): Promise<string | null> {
  const now = deps.now ?? Date.now;
  const model = await deps.inference.model('work-pivot');
  const t0 = now();
  // The pivot is free text by nature, so it never reads a field back as a span:
  // the request is JSON mode, and its one answer is validated as a pivot. Its
  // message is Clef's band state: the string with its locale.
  const req = fieldsRequest(model, PIVOT_FIELDS, { name: 'pivot', system: PIVOT_SYSTEM[kind], user: adjudicationState(kind, raw, locale), state: raw });
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

/**
 * The nearest tokens of the kind, best score per token, active or pending
 * only, best first. With `langs`, each also carries `scoped`, its best score
 * through a label in one of them, and of two labels of a token at one score
 * the one in `langs` is the match shown: ESCO gives many tokens one text in
 * two languages, two vectors at one score, listed in no set order. A label
 * whose vector names no language is in none. Each match carries its label's
 * language and, for a national layer's label, its region, from the vector.
 */
export async function candidatesFor(deps: Pick<RegistryDeps, 'store' | 'index'>, kind: TokenKind, vector: number[], langs?: readonly string[]): Promise<Candidate[]> {
  const matches = await deps.index.query(vector, { topK: 20, filter: { kind } });
  const inLangs = (m: IndexMatch) => langs !== undefined && typeof m.metadata?.lang === 'string' && langs.includes(m.metadata.lang);
  const best = new Map<string, IndexMatch>();
  const scoped = new Map<string, number>();
  for (const m of matches) {
    const token = m.metadata?.token;
    if (typeof token !== 'string' || !token.startsWith(`${kind}:`)) continue;
    const had = best.get(token);
    if (!had || m.score > had.score || (m.score === had.score && inLangs(m) && !inLangs(had))) best.set(token, m);
    if (inLangs(m) && m.score > (scoped.get(token) ?? -Infinity)) scoped.set(token, m.score);
  }
  const live = await deps.store.tokens([...best.keys()]);
  const out = new Map<string, Candidate>();
  // A merge can bring two names to one live token: it keeps the best of each score.
  const scopedLive = new Map<string, number>();
  for (const [asked, m] of best) {
    const t = live.get(asked);
    if (!t) continue;
    const s = scoped.get(asked);
    if (s !== undefined && s > (scopedLive.get(t.token) ?? -Infinity)) scopedLive.set(t.token, s);
    const had = out.get(t.token);
    if (had && had.score >= m.score) continue;
    out.set(t.token, {
      token: t.token,
      labelEn: t.labelEn,
      matched: typeof m.metadata?.label === 'string' ? m.metadata.label : t.labelEn,
      matchedLang: typeof m.metadata?.lang === 'string' ? m.metadata.lang : null,
      matchedRegion: typeof m.metadata?.region === 'string' ? m.metadata.region : null,
      score: m.score,
    });
  }
  if (langs) for (const c of out.values()) c.scoped = scopedLive.get(c.token) ?? null;
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
  const tau = tauFor(await deps.inference.model('work-embed'), deps.tau);
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
  // A worker's string becomes an alias of the token it snapped to. A hirer's words never do: a phrase that leaves a
  // licence's state open ("licensed electrician") would otherwise decide a state-bound licence for every worker's claim.
  const observe = async (token: string) => {
    if (input.mint === false) return;
    await deps.store.addLabels([{ labelId: await labelIdOf(token, input.lang, norm), token, lang: input.lang, label: raw, labelNorm: norm, kind: 'observed', embedded: false }], at);
  };

  const kind = input.kind;
  /** What the model steps are told of the string, as context: its language, and a worker's market, never a certificate's. */
  const locale: StringLocale = { lang: input.lang, ...(input.market && kind !== 'cert' ? { market: input.market } : {}) };

  // 1. An exact known label, in the string's own language or English.
  const langs = labelLangs(input.lang);
  const labelled = await deps.store.tokensByLabel(norm, input.kind, langs);
  if (labelled.length === 1) {
    const t = labelled[0]!;
    return result({ decision: 'label', token: t.token, labelEn: t.labelEn, specialization: false, score: 1, probability: null, candidates: [] });
  }

  // 2. The nearest labels, in every language: through the client's query vector when it sent one, else the plane's,
  // and under a model the plane cannot run, without one, no further than the exact label.
  const embedModel = await deps.inference.model('work-embed');
  let vector: number[];
  if (input.vectors?.query) vector = input.vectors.query;
  else if (CLIENT_EMBED_MODELS.has(embedModel)) return result({ decision: 'unmatched', ...none });
  else {
    const embedding = await embedTexts(deps.inference, [raw], { role: 'query', now, log: deps.log });
    calls.push(embedding.call);
    if (!embedding.ok) return result({ decision: 'unmatched', ...none });
    vector = embedding.vectors[0]!;
  }
  const candidates = (await candidatesFor(deps, input.kind, vector, langs)).slice(0, ADJUDICATION_CANDIDATES);
  const top = candidates[0];

  // Without a model only through a label the shortcut would read: bge-m3 puts
  // a word near 0.95 to its case variant and at 1 to itself, so an English
  // "Instructor" can reach ESCO's Spanish "instructor" (the air force officer)
  // at τ_auto. The best token is taken when one of its labels in those
  // languages is at τ_auto; when only another language's is, Clef decides, as in the band.
  if (top && top.scoped != null && top.scoped >= tau.auto) {
    await observe(top.token);
    return record({ decision: 'auto', token: top.token, labelEn: top.labelEn, specialization: false, score: top.score, probability: null, candidates }, embedModel);
  }

  let clefModel: string | null = null;
  /** Clef answered in the band, but below its floor: the pivot may find an existing token, never mint one. */
  let undecided: number | null = null;
  if (top && top.score >= tau.low) {
    clefModel = await deps.inference.model('work-adjudicate');
    const request = clefInput(clefModel, adjudicationState(kind, raw, locale), adjudicationQuestions(kind, candidates, { labelLocales: true }));
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

  // 3. Nothing matched: a certificate and anything a hirer wrote stay unmatched, never minted and never sent to the
  // pivot (decision 0070: only a Vault document will mint a certificate); a worker's occupations and skills mint.
  const score = top?.score ?? null;
  if (kind === 'cert' || input.mint === false) return record({ decision: 'unmatched', ...none, score, probability: undecided, candidates }, clefModel);
  const english = await pivot(deps, kind, raw, locale, calls);
  if (!english) return record({ decision: 'unmatched', ...none, score, probability: undecided, candidates }, clefModel);
  const englishNorm = labelNorm(english);
  // The name is a label far more often than a slug: "truck driver" is no
  // token's slug, but one of ESCO's alternative labels for its cargo vehicle
  // driver. Only English labels count, since another language may use the
  // word for something else (ESCO's Spanish gives "instructor" to its air
  // force officer). A label several tokens hold ("electrician", which ESCO
  // also gives three other occupations) leaves the choice to the slug.
  const named = await deps.store.tokensByLabel(englishNorm, input.kind, ['en']);
  const token = tokenOf(input.kind, english);
  const existing = named.length === 1 ? named[0] : (await deps.store.tokens([token])).get(token);
  if (existing) {
    await observe(existing.token);
    return record({ decision: 'pivot', token: existing.token, labelEn: existing.labelEn, specialization: false, score, probability: null, candidates }, clefModel);
  }
  if (undecided != null) return record({ decision: 'unmatched', ...none, score, probability: undecided, candidates }, clefModel);
  const labels: RegistryLabel[] = [
    { labelId: await labelIdOf(token, 'en', englishNorm), token, lang: 'en', label: english, labelNorm: englishNorm, kind: 'preferred', embedded: false },
  ];
  if (input.lang !== 'en' || englishNorm !== norm) {
    labels.push({ labelId: await labelIdOf(token, input.lang, norm), token, lang: input.lang, label: raw, labelNorm: norm, kind: 'observed', embedded: false });
  }
  const minted: RegistryToken = { token, kind: input.kind, source: 'emergent', labelEn: english, escoUri: null, iscoCode: null, status: 'pending', mergedInto: null };
  if (!(await deps.store.insertToken(minted, labels, at))) {
    // Another request minted it a moment ago: it is a pivot match now.
    return record({ decision: 'pivot', token, labelEn: english, specialization: false, score, probability: null, candidates }, clefModel);
  }
  // The new token's own labels join the index, so the next snap finds it by vector too. They are documents:
  // - a model with role prompts embeds them again as such, and one without reuses the query's vector;
  // - the string's own label takes the client's document vector when it sent one;
  // - under a model the plane cannot run, the rest (the English name) waits at embedded = 0 (no backfill is built yet).
  const planeEmbeds = !CLIENT_EMBED_MODELS.has(embedModel);
  const prompted = Boolean(EMBED_PROMPTS_BY_MODEL[embedModel]);
  const clientDoc = input.vectors?.document;
  const own = labels.length === 1 ? 0 : 1;
  const planned = !planeEmbeds ? [] : prompted ? labels.map((_, i) => i).filter((i) => !(clientDoc && i === own)) : labels.length > 1 ? [0] : [];
  const docEmbedding = planned.length ? await embedTexts(deps.inference, planned.map((i) => labels[i]!.label), { role: 'document', now, log: deps.log }) : null;
  if (docEmbedding) calls.push(docEmbedding.call);
  const docVector = (i: number): number[] | undefined => {
    const j = planned.indexOf(i);
    if (j >= 0) return docEmbedding?.ok ? docEmbedding.vectors[j] : undefined;
    if (i === own && clientDoc) return clientDoc;
    return !prompted && planeEmbeds ? vector : undefined;
  };
  const vectors: IndexVector[] = [];
  const pivotVector = docVector(0);
  if (pivotVector) vectors.push({ id: labels[0]!.labelId, values: pivotVector, metadata: { token, kind: input.kind, lang: 'en', label: english, source: 'emergent' } });
  const rawVector = labels[1] ? docVector(1) : undefined;
  if (labels[1] && rawVector) vectors.push({ id: labels[1].labelId, values: rawVector, metadata: { token, kind: input.kind, lang: input.lang, label: raw, source: 'emergent' } });
  // A label is marked embedded only once its vector is in: one whose document
  // call failed stays at embedded = 0, where the exact-label shortcut still
  // finds it and no vector holds it (nothing embeds it later yet).
  await deps.index.upsert(vectors);
  await deps.store.markEmbedded(vectors.map((v) => v.id));
  return record({ decision: 'minted', token, labelEn: english, specialization: false, score, probability: null, candidates }, clefModel);
}
