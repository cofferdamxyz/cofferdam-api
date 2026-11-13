// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cofferdam Cloud's embedder under the v2 pin (workspace decision 0084): a
 * request without the phone's vector is embedded on the plane by Workers AI's
 * EmbeddingGemma 2, the one stand-in the LiteRT-LM pin names
 * (`PLANE_STAND_INS`), through `work-embed-cloud` and the documents gateway;
 * a phone's vector is still taken. Synthetic vectors over the test world's
 * keyword geometry.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createJobsRoutes } from '../src/routes/jobs.js';
import { createWorkListingRoutes } from '../src/routes/workListing.js';
import type { AuthorityCheck } from '../src/services/authorityCheck.js';
import { createAuthorityMemo } from '../src/services/chat/authorityMemo.js';
import { aiOptions, DOCUMENT_OPS, MODEL_PRICES, modelCostMicroUsd, OPS } from '../src/services/inference/index.js';
import { readListingVectors, readSentenceVector } from '../src/services/work/clientVectors.js';
import { listingIdOf } from '../src/services/work/listings.js';
import { workPseudonym } from '../src/services/work/pseudonym.js';
import {
  EMBEDDINGGEMMA_2_GGUF,
  EMBEDDINGGEMMA_2_LITERT,
  embedTexts,
  PLANE_STAND_INS,
  planeEmbeds,
  snap,
  WORKERS_AI_EMBEDDINGGEMMA_2,
} from '../src/services/work/registry.js';
import { fakeInference, jsonModeResult, type FakeCall } from './fixtures/work/fakes.js';
import { clefSays, intentAnswer, keywordVector, workWorld } from './fixtures/work/world.js';
import fixtures from './fixtures/sdk-attestations.json';

const LITERT = EMBEDDINGGEMMA_2_LITERT;
const CLOUD = WORKERS_AI_EMBEDDINGGEMMA_2;
const fxAccount = fixtures.fields.accountAddress as string;
const now = (fixtures.fields.issuedAt as number) + 5_000;
const bearer = { authorization: `Bearer ${fixtures.p256.token}` };
const HIGH: AuthorityCheck = { status: 'active', authorityId: 0, module: fxAccount as `0x${string}`, tier: 3 };
const KEY = 'synthetic-work-pseudonym-key-for-tests-0001';
const STAGING = { ENVIRONMENT: 'staging', AI_GATEWAY_ID: 'cofferdam-strict', WORK_PSEUDONYM_KEY: KEY };

/** A 768-dimension unit vector over the keyword geometry; a text with no keyword gets an axis of its own, far from every seed label. */
function unit768(text: string): number[] {
  const v = keywordVector(text).slice(0, 768);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (n > 0) return v.map((x) => x / n);
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)!) % 600;
  return Array.from({ length: 768 }, (_, j) => (j === 100 + h ? 1 : 0));
}

/**
 * Workers AI's EmbeddingGemma 2 as it answers: OpenAI's shape, each vector with its index, here in reverse order and
 * at twice unit length, so the plane's reordering and normalising are what the tests see. The prompt is stripped
 * before the geometry reads the text.
 */
const cloudEmbed = (input: Record<string, unknown>) => {
  const texts = input.input as string[];
  return {
    object: 'list',
    data: texts.map((t, index) => ({ object: 'embedding', index, embedding: unit768(t.replace(/^(task: search result \| query: |title: none \| text: )/, '')).map((x) => 2 * x) })).reverse(),
    usage: { prompt_tokens: 7 * texts.length, total_tokens: 7 * texts.length, neurons: 0.001 },
  };
};

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

async function world(responses = {}, models: Record<string, string> = {}) {
  const calls: FakeCall[] = [];
  const w = await workWorld({ 'work-intent': intentAnswer(), 'work-classify': clefSays(/plumber|leak/), 'work-embed-cloud': cloudEmbed, ...responses }, calls, { 'work-embed': LITERT, ...models });
  // The seed's label vectors as the v2 index holds them: 768 values.
  for (const v of w.tokenIndex.vectors.values()) v.values = unit768(String(v.metadata.label));
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
  const cloudCalls = () => calls.filter((c) => c.op === 'work-embed-cloud');
  return { ...w, calls, cloudCalls, put: request('PUT', '/v1/work/listing'), post: request('POST', '/v1/jobs/intent') };
}

describe('the stand-in in the seam', () => {
  it('pins Workers AI’s EmbeddingGemma 2 on its own op, through the documents gateway, priced at $0.0017 a million', () => {
    expect(OPS['work-embed-cloud']).toMatchObject({ model: CLOUD, envVar: 'WORK_EMBED_CLOUD_MODEL' });
    expect(PLANE_STAND_INS).toEqual({ [LITERT]: CLOUD });
    expect(DOCUMENT_OPS.has('work-embed-cloud')).toBe(true);
    expect(DOCUMENT_OPS.has('work-embed')).toBe(false);
    const options = aiOptions({ AI_GATEWAY_ID: 'cofferdam-strict', AI_GATEWAY_DOCUMENTS_ID: 'cofferdam-documents' }, 'work-embed-cloud', new AbortController().signal) as { gateway: Record<string, unknown> };
    expect(options.gateway).toMatchObject({ id: 'cofferdam-documents', skipCache: true, collectLog: false });
    expect(MODEL_PRICES[CLOUD]).toEqual({ input: 0.0017, output: 0 });
    expect(modelCostMicroUsd(CLOUD, 1_000_000, 0)).toBe(1_700);
  });

  it('says where the plane can embed: a model it runs, or a client-only pin with a stand-in', () => {
    expect(planeEmbeds(LITERT)).toBe(true);
    expect(planeEmbeds('@cf/baai/bge-m3')).toBe(true);
    expect(planeEmbeds(EMBEDDINGGEMMA_2_GGUF)).toBe(false);
  });
});

describe('embedTexts under the v2 pin', () => {
  it('runs the stand-in with the role’s prompt at the pin’s size, the vectors in order and of unit length, named by the stand-in', async () => {
    const calls: FakeCall[] = [];
    const out = await embedTexts(fakeInference({ 'work-embed-cloud': cloudEmbed }, calls, { 'work-embed': LITERT }), ['plumber', 'leak'], { role: 'query' });
    expect(calls).toEqual([{ op: 'work-embed-cloud', input: { input: ['task: search result | query: plumber', 'task: search result | query: leak'], dimensions: 768 } }]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.call).toMatchObject({ op: 'work-embed-cloud', model: CLOUD, ok: true, usage: { tokensIn: 14, neurons: 0.001 } });
    expect(out.vectors[0]!.map((x) => Math.round(x * 1e6))).toEqual(unit768('plumber').map((x) => Math.round(x * 1e6)));
    expect(out.vectors[1]!.map((x) => Math.round(x * 1e6))).toEqual(unit768('leak').map((x) => Math.round(x * 1e6)));
    const doc = await embedTexts(fakeInference({ 'work-embed-cloud': cloudEmbed }, calls, { 'work-embed': LITERT }), ['plumber'], { role: 'document' });
    expect(doc.ok).toBe(true);
    expect(calls[1]!.input).toEqual({ input: ['title: none | text: plumber'], dimensions: 768 });
  });

  it('sends each text as the phone writes it: NFC, each run of white space one space', async () => {
    const calls: FakeCall[] = [];
    await embedTexts(fakeInference({ 'work-embed-cloud': cloudEmbed }, calls, { 'work-embed': LITERT }), ['Encanador  hidra\u0301ulico\n'], { role: 'document' });
    expect(calls[0]!.input).toEqual({ input: ['title: none | text: Encanador hidráulico'], dimensions: 768 });
  });

  it('fails closed, with no hosted call, when another model is pinned on work-embed-cloud or the pin has no stand-in', async () => {
    const calls: FakeCall[] = [];
    const logged: Record<string, unknown>[] = [];
    const log = (f: Record<string, unknown>) => logged.push(f);
    const swapped = await embedTexts(fakeInference({ 'work-embed-cloud': cloudEmbed }, calls, { 'work-embed': LITERT, 'work-embed-cloud': '@cf/baai/bge-m3' }), ['plumber'], { role: 'query', log });
    expect(swapped.ok).toBe(false);
    const gguf = await embedTexts(fakeInference({ 'work-embed-cloud': cloudEmbed }, calls, { 'work-embed': EMBEDDINGGEMMA_2_GGUF }), ['plumber'], { role: 'query', log });
    expect(gguf.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(logged.map((l) => l.reason)).toEqual(['stand_in_mismatch', 'no_plane_embedder']);
  });

  it('fails closed on an answer of the wrong size, count or indices', async () => {
    const bad = [
      { data: [{ index: 0, embedding: unit768('plumber').slice(1) }] },
      { data: [] },
      { data: [{ index: 3, embedding: unit768('plumber') }] },
      { data: [{ index: 0, embedding: [Number.NaN, ...unit768('plumber').slice(1)] }] },
    ];
    for (const answer of bad) {
      const out = await embedTexts(fakeInference({ 'work-embed-cloud': answer }, [], { 'work-embed': LITERT }), ['plumber'], { role: 'query' });
      expect(out).toMatchObject({ ok: false, call: { op: 'work-embed-cloud', model: CLOUD, ok: false } });
    }
    const repeated = await embedTexts(
      fakeInference({ 'work-embed-cloud': { data: [{ index: 0, embedding: unit768('a') }, { index: 0, embedding: unit768('b') }] } }, [], { 'work-embed': LITERT }),
      ['a', 'b'],
      { role: 'query' },
    );
    expect(repeated.ok).toBe(false);
  });
});

describe('the routes’ vectors under the v2 pin', () => {
  it('takes a request without a vector, still takes the phone’s, and never one named by the stand-in', () => {
    expect(readSentenceVector(undefined, LITERT)).toEqual({ ok: true, value: undefined });
    expect(readListingVectors({}, DRAFT, LITERT)).toEqual({ ok: true, value: {} });
    expect(readSentenceVector({ model: LITERT, dims: 768, values: unit768('plumber') }, LITERT)).toMatchObject({ ok: true });
    expect(readSentenceVector({ model: CLOUD, dims: 768, values: unit768('plumber') }, LITERT)).toMatchObject({ ok: false, refusal: { error: 'vector_rejected', reason: 'model', model: LITERT } });
    expect(readSentenceVector(undefined, EMBEDDINGGEMMA_2_GGUF)).toMatchObject({ ok: false, refusal: { error: 'vector_required' } });
  });
});

describe('snaps and mints under the v2 pin without the phone’s vectors', () => {
  it('snaps through the stand-in’s query vector, on the pin’s τ', async () => {
    const w = await world();
    const deps = { inference: w.inference, store: w.registry, index: w.tokenIndex };
    const out = await snap(deps, { kind: 'pos', raw: 'Service Plumber', lang: 'en' });
    expect(out).toMatchObject({ decision: 'auto', token: 'pos:plumber' });
    expect(out.calls).toEqual([expect.objectContaining({ op: 'work-embed-cloud', model: CLOUD, ok: true })]);
  });

  it('mints with the stand-in’s document vectors on both labels, each named by its model', async () => {
    const w = await world({ 'work-pivot': jsonModeResult({ english: 'pastry chef' }) });
    const deps = { inference: w.inference, store: w.registry, index: w.tokenIndex };
    const out = await snap(deps, { kind: 'pos', raw: 'Confeiteiro', lang: 'pt' });
    expect(out).toMatchObject({ decision: 'minted', token: 'pos:pastry-chef' });
    expect(w.db.sqlite.prepare("SELECT lang, embedded FROM registry_labels WHERE token = 'pos:pastry-chef' ORDER BY lang").all()).toEqual([
      { lang: 'en', embedded: 1 },
      { lang: 'pt', embedded: 1 },
    ]);
    const minted = [...w.tokenIndex.vectors.values()].filter((v) => v.metadata.token === 'pos:pastry-chef');
    expect(minted.map((v) => v.metadata.model)).toEqual([CLOUD, CLOUD]);
    expect(w.cloudCalls().map((c) => (c.input.input as string[])[0]!.split(' | ')[0])).toEqual(['task: search result', 'title: none']);
  });

  it('names a mint’s own label by the pin when the phone sent its document vector', async () => {
    const w = await world({ 'work-pivot': jsonModeResult({ english: 'pastry chef' }) });
    const deps = { inference: w.inference, store: w.registry, index: w.tokenIndex };
    const axis = (i: number) => Array.from({ length: 768 }, (_, j) => (j === i ? 1 : 0));
    await snap(deps, { kind: 'pos', raw: 'Confeiteiro', lang: 'pt', vectors: { query: axis(50), document: axis(51) } });
    const minted = [...w.tokenIndex.vectors.values()].filter((v) => v.metadata.token === 'pos:pastry-chef');
    expect(Object.fromEntries(minted.map((v) => [v.metadata.lang, v.metadata.model]))).toEqual({ pt: LITERT, en: CLOUD });
  });
});

describe('a Cofferdam Cloud user’s listing and search under the v2 pin', () => {
  it('publishes without the phone’s vectors: the stand-in embeds the claims and the phone’s listing text, and names the vector', async () => {
    const w = await world();
    const res = await w.put(DRAFT);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: string[] };
    expect(body.tokens).toEqual(expect.arrayContaining(['pos:plumber']));
    const stored = w.listingIndex.vectors.get(await listingIdOf(await workPseudonym(KEY, fxAccount), 'main'))!;
    expect(stored.metadata.model).toBe(CLOUD);
    expect(w.db.sqlite.prepare('SELECT embed_model FROM listings').get()).toEqual({ embed_model: CLOUD });
    // The listing's text as the phone would embed it: the claims, without the registry's English names.
    const listingCall = w.cloudCalls().find((c) => (c.input.input as string[])[0]!.startsWith('title: none | text: Service Plumber'))!;
    expect(listingCall.input).toEqual({ input: ['title: none | text: Service Plumber. Leak detection'], dimensions: 768 });
    expect(w.calls.some((c) => c.op === 'work-embed')).toBe(false);
  });

  it('still takes a Cofferdam Local user’s vectors, with no hosted embedding', async () => {
    const w = await world();
    const vec = (t: string) => ({ model: LITERT, dims: 768, values: unit768(t) });
    const res = await w.put({ ...DRAFT, vector: vec('plumber leak'), claims: [{ kind: 'pos', text: 'Service Plumber', query: vec('plumber'), document: vec('plumber') }, { kind: 'skill', text: 'Leak detection', query: vec('leak'), document: vec('leak') }] });
    expect(res.status).toBe(200);
    expect(w.db.sqlite.prepare('SELECT embed_model FROM listings').get()).toEqual({ embed_model: LITERT });
    expect(w.cloudCalls()).toHaveLength(0);
  });

  it('counts a worker for a hirer who sent no vector', async () => {
    const w = await world();
    expect((await w.put(DRAFT)).status).toBe(200);
    w.calls.length = 0;
    const sentence = 'My kitchen sink is leaking under the cabinet, need someone today after 2pm. I’ll pay $120.';
    const res = await w.post({ sentence, lang: 'en', regions: ['us-tx'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: { anyOf: string[] } };
    expect(body.plan.anyOf).toEqual(expect.arrayContaining(['pos:plumber']));
    // What a Local phone embeds: the whole sentence as a query, once, read by the needs step and recall alike.
    const sentenceCalls = w.cloudCalls().filter((c) => (c.input.input as string[])[0]!.startsWith('task: search result | query: My kitchen sink'));
    expect(sentenceCalls).toHaveLength(1);
    expect(sentenceCalls[0]!.input).toEqual({ input: [`task: search result | query: ${sentence}`], dimensions: 768 });
  });
});
