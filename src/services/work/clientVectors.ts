// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The vectors a client embeds for the Work routes: EmbeddingGemma 2 on the
 * phone through LiteRT-LM, the app's embedder since 2026-10-30 and Cofferdam
 * Local's since 2026-11-12 (workspace decision 0084; its text-only
 * file, `EMBEDDINGGEMMA_2_LITERT`; workspace decision 0068), when the plane's
 * index generation is that model's: v2 (`token-registry-v2`,
 * `jobs-listings-v2`). The phone sends each text with the role's prompt, in
 * NFC and its white space as the Mac embedded the registry's labels, so a text
 * has the index's vector (decision 0068 records the phones against the Mac),
 * and a listing's text within the embedder's input (`listingTextWithin`).
 * Every vector names its model and size (`{ model, dims, values }`) and is
 * taken only for the pinned generation's model (`readClientVector`), so
 * vectors of two models never share an index; a refusal names the plane's
 * model, so the app can tell a generation it embeds for from one the plane
 * embeds for itself.
 *
 * - `PUT /v1/work/listing`: `vector`, the listing text's document vector, and
 *   `claims`, `[{ kind, text, query, document }]`, each claim string's query
 *   vector (the snap) and document vector (a mint's label). Claims are
 *   optional; one present carries both vectors and names a string of the
 *   draft. A string without one snaps as the plane can: by its own
 *   embedding, or under a pin it cannot run, by exact label only.
 * - `POST /v1/jobs/intent`: `vector`, the sentence's query vector.
 *
 * Under a pin the plane cannot embed for (`planeEmbeds`: a client-only model
 * with no stand-in), the listing's and the sentence's vectors are required.
 * Under any other they are optional and must still be the pinned model's: under
 * the v2 pin, a Cofferdam Cloud user's phone sends none and the plane embeds
 * the same texts with Workers AI's EmbeddingGemma 2 (`PLANE_STAND_INS`,
 * workspace decision 0084), while a Cofferdam Local user's phone still sends
 * the LiteRT-LM file's, which is taken. A vector is never taken under another
 * model's name: the stand-in's are made on the plane only.
 */

import type { ClaimVectors, ClientEmbeddings, ListingDraft } from './listings.js';
import { claimKey } from './listings.js';
import { planeEmbeds, readClientVector, type ClientVectorRefusal, type TokenKind } from './registry.js';

export type VectorRefusal =
  | { error: 'vector_required'; field: string; model: string }
  | { error: 'vector_rejected'; field: string; reason: ClientVectorRefusal; model: string }
  | { error: 'claim_rejected'; index: number; reason: 'bad_shape' | 'incomplete' | 'unknown' | 'repeated'; model: string };

export type Read<T> = { ok: true; value: T } | { ok: false; refusal: VectorRefusal };

const KINDS: ReadonlySet<string> = new Set(['pos', 'skill', 'cert']);

/** The sentence's query vector, or none; required only under a pin the plane cannot embed for. */
export function readSentenceVector(raw: unknown, model: string): Read<number[] | undefined> {
  if (raw === undefined || raw === null) {
    return planeEmbeds(model) ? { ok: true, value: undefined } : { ok: false, refusal: { error: 'vector_required', field: 'vector', model } };
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
