// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The vectors a client embeds for the Work routes: EmbeddingGemma 2 on the
 * phone (llama.rn), when the plane's index generation is that model's
 * (`token-registry-v3`, `jobs-listings-v3`). Every vector names its model and
 * size (`{ model, dims, values }`) and is taken only for the pinned
 * generation's model (`readClientVector`), so vectors of two models never
 * share an index; a refusal names the plane's model, so the app can tell a
 * generation it embeds for from one the plane embeds for itself.
 *
 * - `PUT /v1/work/listing`: `vector`, the listing text's document vector, and
 *   `claims`, `[{ kind, text, query, document }]`, each claim string's query
 *   vector (the snap) and document vector (a mint's label). Claims are
 *   optional; one present carries both vectors and names a string of the
 *   draft. A string without one snaps as the plane can: by its own
 *   embedding, or under a pin it cannot run, by exact label only.
 * - `POST /v1/jobs/intent`: `vector`, the sentence's query vector.
 *
 * Under a pin the plane cannot run (`CLIENT_EMBED_MODELS`), the listing's and
 * the sentence's vectors are required; under any other they are optional and
 * must still be the pinned model's.
 */

import type { ClaimVectors, ClientEmbeddings, ListingDraft } from './listings.js';
import { claimKey } from './listings.js';
import { CLIENT_EMBED_MODELS, readClientVector, type ClientVectorRefusal, type TokenKind } from './registry.js';

export type VectorRefusal =
  | { error: 'vector_required'; field: string; model: string }
  | { error: 'vector_rejected'; field: string; reason: ClientVectorRefusal; model: string }
  | { error: 'claim_rejected'; index: number; reason: 'bad_shape' | 'incomplete' | 'unknown' | 'repeated'; model: string };

export type Read<T> = { ok: true; value: T } | { ok: false; refusal: VectorRefusal };

const KINDS: ReadonlySet<string> = new Set(['pos', 'skill', 'cert']);

/** The sentence's query vector, or none; required under a pin the plane cannot run. */
export function readSentenceVector(raw: unknown, model: string): Read<number[] | undefined> {
  if (raw === undefined || raw === null) {
    return CLIENT_EMBED_MODELS.has(model) ? { ok: false, refusal: { error: 'vector_required', field: 'vector', model } } : { ok: true, value: undefined };
  }
  const v = readClientVector(raw, model);
  return v.ok ? { ok: true, value: v.values } : { ok: false, refusal: { error: 'vector_rejected', field: 'vector', reason: v.reason, model } };
}

/** A listing's client vectors: its own and its claims', each checked; see the module comment. */
export function readListingVectors(
  body: { vector?: unknown; claims?: unknown },
  draft: Pick<ListingDraft, 'titles' | 'skills' | 'certificates'>,
  model: string,
): Read<ClientEmbeddings> {
  const listing = readSentenceVector(body.vector, model);
  if (!listing.ok) return listing;
  if (body.claims === undefined || body.claims === null) return { ok: true, value: listing.value ? { listing: listing.value } : {} };
  if (!Array.isArray(body.claims)) return { ok: false, refusal: { error: 'claim_rejected', index: -1, reason: 'bad_shape', model } };
  const strings: Record<TokenKind, ReadonlySet<string>> = { pos: new Set(draft.titles), skill: new Set(draft.skills), cert: new Set(draft.certificates) };
  const claims = new Map<string, ClaimVectors>();
  for (const [index, raw] of (body.claims as unknown[]).entries()) {
    const c = raw as { kind?: unknown; text?: unknown; query?: unknown; document?: unknown } | null;
    if (!c || typeof c !== 'object' || typeof c.kind !== 'string' || !KINDS.has(c.kind) || typeof c.text !== 'string') {
      return { ok: false, refusal: { error: 'claim_rejected', index, reason: 'bad_shape', model } };
    }
    const kind = c.kind as TokenKind;
    if (!strings[kind].has(c.text)) return { ok: false, refusal: { error: 'claim_rejected', index, reason: 'unknown', model } };
    if (c.query === undefined || c.query === null || c.document === undefined || c.document === null) {
      return { ok: false, refusal: { error: 'claim_rejected', index, reason: 'incomplete', model } };
    }
    const key = claimKey(kind, c.text);
    if (claims.has(key)) return { ok: false, refusal: { error: 'claim_rejected', index, reason: 'repeated', model } };
    const query = readClientVector(c.query, model);
    if (!query.ok) return { ok: false, refusal: { error: 'vector_rejected', field: `claims[${index}].query`, reason: query.reason, model } };
    const document = readClientVector(c.document, model);
    if (!document.ok) return { ok: false, refusal: { error: 'vector_rejected', field: `claims[${index}].document`, reason: document.reason, model } };
    claims.set(key, { query: query.values, document: document.values });
  }
  return { ok: true, value: { ...(listing.value ? { listing: listing.value } : {}), claims } };
}
