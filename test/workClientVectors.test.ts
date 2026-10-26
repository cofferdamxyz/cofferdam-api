// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Vectors the client embeds (EmbeddingGemma 2 on the phone) for the Work
 * routes, under the v3 generation's pin: checked against the pinned model,
 * required where the plane cannot embed, and used in place of the plane's own
 * for the listing, its claims' snaps and mints, and the hirer's recall and
 * needs. Synthetic vectors over the test world's keyword geometry.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createJobsRoutes } from '../src/routes/jobs.js';
import { createWorkListingRoutes } from '../src/routes/workListing.js';
import type { AuthorityCheck } from '../src/services/authorityCheck.js';
import { createAuthorityMemo } from '../src/services/chat/authorityMemo.js';
import { readListingVectors, readSentenceVector } from '../src/services/work/clientVectors.js';
import { claimKey, listingIdOf, publishListing, type ListingDraft } from '../src/services/work/listings.js';
import { workPseudonym } from '../src/services/work/pseudonym.js';
import { EMBEDDINGGEMMA_2_GGUF, embedTexts, readClientVector, snap } from '../src/services/work/registry.js';
import { fakeInference, jsonModeResult, type FakeCall } from './fixtures/work/fakes.js';
import { clefSays, intentAnswer, keywordVector, workWorld } from './fixtures/work/world.js';
import fixtures from './fixtures/sdk-attestations.json';

const GGUF = EMBEDDINGGEMMA_2_GGUF;
const BGE_M3 = '@cf/baai/bge-m3';
const fxAccount = fixtures.fields.accountAddress as string;
const now = (fixtures.fields.issuedAt as number) + 5_000;
const bearer = { authorization: `Bearer ${fixtures.p256.token}` };
const HIGH: AuthorityCheck = { status: 'active', authorityId: 0, module: fxAccount as `0x${string}`, tier: 3 };
const KEY = 'synthetic-work-pseudonym-key-for-tests-0001';
const STAGING = { ENVIRONMENT: 'staging', AI_GATEWAY_ID: 'cofferdam-strict', WORK_PSEUDONYM_KEY: KEY };

/** A 768-dimension unit vector over the keyword geometry, as the phone would send it. */
function unit768(text: string): number[] {
  const v = keywordVector(text).slice(0, 768);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}
/** A unit vector along one axis no seed label uses. */
function axis768(i: number): number[] {
  const v = new Array<number>(768).fill(0);
  v[i] = 1;
  return v;
}
const vec = (text: string, model = GGUF) => ({ model, dims: 768, values: unit768(text) });
const claim = (kind: string, text: string) => ({ kind, text, query: vec(text), document: vec(text) });

const DRAFT = {
  profileId: 'main',
  region: 'us-tx',
  scope: 'onsite',
  tier: 0,
  lang: 'en',
  titles: ['Service Plumber'],
  skills: ['Leak detection'],
  certificates: [] as string[],
  languages: ['en'],
};

async function world(model: string, responses = {}) {
  const calls: FakeCall[] = [];
  const w = await workWorld({ 'work-intent': intentAnswer(), 'work-classify': clefSays(/plumber|leak/), ...responses }, calls, { 'work-embed': model });
  const deps = {
    attestationMaxAgeMs: 3_600_000,
    now: () => now,
    authorityCheck: async () => HIGH,
    authorityMemo: createAuthorityMemo({ edge: null }),
    inference: () => w.inference,
    stores: () => w.stores,
    accountBound: async () => true,
  };
  const h = new Hono();
  h.route('/v1/work', createWorkListingRoutes(deps));
  h.route('/v1/jobs', createJobsRoutes(deps));
  const request = (method: string, path: string) => (body: unknown) =>
    h.request(path, { method, headers: { 'content-type': 'application/json', ...bearer }, body: JSON.stringify({ account: fxAccount, ...(body as object) }) }, STAGING as never);
  const embedCalls = () => calls.filter((c) => c.op === 'work-embed').length;
  return { ...w, calls, embedCalls, put: request('PUT', '/v1/work/listing'), post: request('POST', '/v1/jobs/intent') };
}

describe('readClientVector', () => {
  it("takes only the pinned model's vector, at its size, finite and of unit length", () => {
    expect(readClientVector(vec('plumber'), GGUF)).toMatchObject({ ok: true });
    expect(readClientVector(vec('plumber'), BGE_M3)).toEqual({ ok: false, reason: 'model' });
    expect(readClientVector(null, GGUF)).toEqual({ ok: false, reason: 'model' });
    expect(readClientVector({ ...vec('plumber'), dims: 1024 }, GGUF)).toEqual({ ok: false, reason: 'dims' });
    expect(readClientVector({ ...vec('plumber'), values: unit768('plumber').slice(1) }, GGUF)).toEqual({ ok: false, reason: 'dims' });
    expect(readClientVector({ ...vec('plumber'), values: [Number.NaN, ...unit768('plumber').slice(1)] }, GGUF)).toEqual({ ok: false, reason: 'values' });
    expect(readClientVector({ ...vec('plumber'), values: unit768('plumber').map((x) => x * 1.01) }, GGUF)).toEqual({ ok: false, reason: 'norm' });
  });
});

describe('reading the routes’ vectors', () => {
  it('requires the sentence’s and the listing’s vector only where the plane cannot embed, and names the plane’s model in a refusal', () => {
    expect(readSentenceVector(undefined, GGUF)).toEqual({ ok: false, refusal: { error: 'vector_required', field: 'vector', model: GGUF } });
    expect(readSentenceVector(undefined, BGE_M3)).toEqual({ ok: true, value: undefined });
    expect(readSentenceVector(vec('plumber'), BGE_M3)).toEqual({ ok: false, refusal: { error: 'vector_rejected', field: 'vector', reason: 'model', model: BGE_M3 } });
  });

  it("takes a claim's two vectors only for a string of the draft, once, and both", () => {
    const listing = vec('plumber leak');
    const read = (claims: unknown) => readListingVectors({ vector: listing, claims }, DRAFT, GGUF);
    const ok = read([claim('pos', 'Service Plumber'), claim('skill', 'Leak detection')]);
    expect(ok.ok && [...ok.value.claims!.keys()]).toEqual(['pos\u0000Service Plumber', 'skill\u0000Leak detection']);
    expect(read('x')).toMatchObject({ ok: false, refusal: { error: 'claim_rejected', reason: 'bad_shape' } });
    expect(read([claim('pos', 'Pipe Fitter')])).toMatchObject({ ok: false, refusal: { error: 'claim_rejected', index: 0, reason: 'unknown' } });
    expect(read([claim('skill', 'Service Plumber')])).toMatchObject({ ok: false, refusal: { reason: 'unknown' } });
    expect(read([{ kind: 'pos', text: 'Service Plumber', query: vec('plumber') }])).toMatchObject({ ok: false, refusal: { reason: 'incomplete' } });
    expect(read([claim('pos', 'Service Plumber'), claim('pos', 'Service Plumber')])).toMatchObject({ ok: false, refusal: { index: 1, reason: 'repeated' } });
    expect(read([{ ...claim('pos', 'Service Plumber'), document: vec('plumber', BGE_M3) }])).toMatchObject({
      ok: false,
      refusal: { error: 'vector_rejected', field: 'claims[0].document', reason: 'model', model: GGUF },
    });
    // Claims are optional: without them the listing's own vector is all.
    expect(readListingVectors({ vector: listing }, DRAFT, GGUF)).toEqual({ ok: true, value: { listing: listing.values } });
  });
});

describe('under the v3 pin, the plane embeds nothing', () => {
  it('fails embedTexts closed without a hosted call', async () => {
    const calls: FakeCall[] = [];
    const out = await embedTexts(fakeInference({}, calls, { 'work-embed': GGUF }), ['plumber'], { role: 'query' });
    expect(out.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('snaps a string without the client’s vector by exact label only, and with it through the vector', async () => {
    const w = await world(GGUF);
    const deps = { inference: w.inference, store: w.registry, index: w.tokenIndex };
    expect(await snap(deps, { kind: 'pos', raw: 'Plumber', lang: 'en' })).toMatchObject({ decision: 'label', token: 'pos:plumber' });
    expect(await snap(deps, { kind: 'pos', raw: 'Service Plumber', lang: 'en' })).toMatchObject({ decision: 'unmatched', token: null });
    expect(await snap(deps, { kind: 'pos', raw: 'Service Plumber', lang: 'en', vectors: { query: unit768('plumber') } })).toMatchObject({ decision: 'auto', token: 'pos:plumber' });
    expect(w.embedCalls()).toBe(0);
  });

  it("mints with the client's document vector on the string's own label, and leaves the English name for a backfill", async () => {
    const w = await world(GGUF, { 'work-pivot': jsonModeResult({ english: 'pastry chef' }) });
    const deps = { inference: w.inference, store: w.registry, index: w.tokenIndex };
    // A query near no seed label: below the band, so the pivot names it and it mints.
    const document = axis768(51);
    const out = await snap(deps, { kind: 'pos', raw: 'Confeiteiro', lang: 'pt', vectors: { query: axis768(50), document } });
    expect(out).toMatchObject({ decision: 'minted', token: 'pos:pastry-chef' });
    expect(w.db.sqlite.prepare("SELECT lang, embedded FROM registry_labels WHERE token = 'pos:pastry-chef' ORDER BY lang").all()).toEqual([
      { lang: 'en', embedded: 0 },
      { lang: 'pt', embedded: 1 },
    ]);
    expect([...w.tokenIndex.vectors.values()].find((v) => v.metadata.token === 'pos:pastry-chef')!.values).toEqual(document);
    expect(w.embedCalls()).toBe(0);
  });
});

describe('PUT /v1/work/listing with the client’s vectors', () => {
  it('publishes with the phone’s listing vector and claim vectors, and no hosted embedding', async () => {
    const w = await world(GGUF);
    const listing = vec('plumber leak');
    const res = await w.put({ ...DRAFT, vector: listing, claims: [claim('pos', 'Service Plumber'), claim('skill', 'Leak detection')] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: string[]; listingId: string };
    expect(body.tokens).toEqual(expect.arrayContaining(['pos:plumber', 'skill:leak-repair']));
    const stored = w.listingIndex.vectors.get(await listingIdOf(await workPseudonym(KEY, fxAccount), 'main'))!;
    expect(stored.values).toEqual(listing.values);
    expect(stored.metadata.model).toBe(GGUF);
    expect(w.db.sqlite.prepare('SELECT embed_model FROM listings').get()).toEqual({ embed_model: GGUF });
    expect(w.embedCalls()).toBe(0);
  });

  it('refuses a listing without its vector under the v3 pin, and any vector of another model', async () => {
    const w = await world(GGUF);
    const missing = await w.put(DRAFT);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ ok: false, error: 'vector_required', field: 'vector', model: GGUF });
    const bad = await w.put({ ...DRAFT, vector: { ...vec('plumber'), values: unit768('plumber').map((x) => x * 2) } });
    expect(await bad.json()).toMatchObject({ error: 'vector_rejected', reason: 'norm' });
    const unknown = await w.put({ ...DRAFT, vector: vec('plumber'), claims: [claim('pos', 'Pipe Fitter')] });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: 'claim_rejected', reason: 'unknown', index: 0 });
    expect(w.listingIndex.vectors.size).toBe(0);
    expect(w.calls).toHaveLength(0);

    // A generation the plane embeds for itself refuses the phone's vectors, naming its own model.
    const v2 = await world(BGE_M3);
    const res = await v2.put({ ...DRAFT, vector: vec('plumber') });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'vector_rejected', reason: 'model', model: BGE_M3 });
  });
});

describe('POST /v1/jobs/intent with the client’s vector', () => {
  it('finds a worker by the phone’s sentence vector, and refuses the query without it under the v3 pin', async () => {
    const w = await world(GGUF);
    // Another worker's listing, published with the phone's vectors.
    const claims = new Map([
      [claimKey('pos', 'Service Plumber'), { query: unit768('plumber'), document: unit768('plumber') }],
      [claimKey('skill', 'Leak detection'), { query: unit768('leak'), document: unit768('leak') }],
    ]);
    const listed = await publishListing(
      { inference: w.inference, registry: { inference: w.inference, store: w.registry, index: w.tokenIndex }, listings: w.listings, index: w.listingIndex },
      { ...DRAFT, pseudonym: 'p1' } as ListingDraft,
      { listing: unit768('plumber leak'), claims },
    );
    expect(listed).toMatchObject({ ok: true, tokens: expect.arrayContaining(['pos:plumber', 'skill:leak-repair']) });
    w.calls.length = 0;
    const sentence = { sentence: 'My kitchen sink is leaking under the cabinet, need someone today after 2pm. I’ll pay $120.', lang: 'en', regions: ['us-tx'] };
    const missing = await w.post(sentence);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ ok: false, error: 'vector_required', field: 'vector', model: GGUF });
    const res = await w.post({ ...sentence, vector: vec('sink leak plumb') });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: { anyOf: string[] }; finalists: { count: number } };
    expect(body.plan.anyOf).toEqual(expect.arrayContaining(['pos:plumber']));
    expect(body.finalists.count).toBe(1);
    expect(w.embedCalls()).toBe(0);
  });
});
