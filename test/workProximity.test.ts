// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { bloomOf } from '../src/services/work/bloom.js';
import { checkHirerRequest } from '../src/services/work/hire.js';
import { checkCells, checkDraft, h3ParentRes5, type ListingDraft, type ListingRecord, type ListingStore } from '../src/services/work/listings.js';
import { checkRing, MAX_RING_CELLS, recall, type RecallIntent } from '../src/services/work/recall.js';
import { fakeInference, memoryIndex } from './fixtures/work/fakes.js';

// Real H3 cells (h3-js 4.5.0): Macaé's at resolution 6, its parent, its first two rings, and Rio de Janeiro's.
const MACAE = { r6: '86a8b1a07ffffff', r5: '85a8b1a3fffffff' };
const MACAE_RING1 = ['86a8b1a27ffffff', '86a8b1a37ffffff', '86a8b1a17ffffff', '86a8b1a1fffffff', '86a8b1a0fffffff', '86a8b1a2fffffff'];
const MACAE_RING2_ONE = '86a8b1b0fffffff';
const RIO = { r6: '86a8a06a7ffffff', r5: '85a8a06bfffffff' };

const draft = (over: Partial<ListingDraft> = {}): ListingDraft => ({
  pseudonym: 'P',
  profileId: 'main',
  region: 'br',
  scope: 'onsite',
  tier: 1,
  lang: 'pt',
  titles: ['Eletricista'],
  skills: [],
  certificates: [],
  languages: [],
  ...over,
});

describe("an on-site listing's proximity cells (decision 0067, rule 8)", () => {
  it('takes a resolution-6 cell and its resolution-5 parent, as h3-js writes them', () => {
    expect(h3ParentRes5(MACAE.r6)).toBe(MACAE.r5);
    expect(h3ParentRes5(RIO.r6)).toBe(RIO.r5);
    expect(checkCells(MACAE)).toBe(true);
    expect(checkCells({ r6: MACAE.r6, r5: RIO.r5 })).toBe(false);
    expect(checkCells({ r6: MACAE.r5, r5: MACAE.r5 })).toBe(false);
    expect(checkCells({ r6: 'not a cell', r5: MACAE.r5 })).toBe(false);
  });

  it('refuses cells on a remote listing or cells out of shape, and takes an on-site listing with or without them', () => {
    expect(checkDraft(draft({ cells: MACAE }))).toBeNull();
    expect(checkDraft(draft())).toBeNull();
    expect(checkDraft(draft({ scope: 'remote', cells: MACAE }))).toBe('bad_cells');
    expect(checkDraft(draft({ cells: { r6: MACAE.r6, r5: RIO.r5 } }))).toBe('bad_cells');
  });

  it("checks a hirer's ring: one resolution, at most six rings and a hundred cells", () => {
    expect(checkRing({ res: 6, rings: [[MACAE.r6], MACAE_RING1] })).toBe(true);
    expect(checkRing({ res: 5, rings: [[MACAE.r6]] })).toBe(false);
    expect(checkRing({ res: 7, rings: [[MACAE.r6]] })).toBe(false);
    expect(checkRing({ res: 6, rings: [Array.from({ length: MAX_RING_CELLS + 1 }, () => MACAE.r6)] })).toBe(false);
    expect(checkRing({ res: 6, rings: [] })).toBe(false);
    const base = { sentence: 'Preciso de eletricista', lang: 'pt' as const, regions: ['br'] };
    expect(checkHirerRequest({ ...base, near: { res: 6, rings: [[MACAE.r6]] } })).toMatchObject({ ok: true });
    expect(checkHirerRequest({ ...base, near: { res: 6, rings: [['86']] } } as never)).toMatchObject({ ok: false, reason: 'near' });
  });
});

describe('recall within a ring', () => {
  const vector = [1, 0, 0];
  const record = (id: string, region = 'br'): ListingRecord => ({
    listingId: id,
    pseudonym: `P-${id}`,
    profileId: 'main',
    region,
    scope: 'onsite',
    namespace: `${region}:onsite`,
    tier: 1,
    tokens: ['pos:electrician'],
    embedModel: 'm',
    publishedAt: 0,
    updatedAt: 0,
  });
  const setup = async () => {
    const index = memoryIndex();
    const listing = (id: string, score: number, cell?: string, region = 'br') => ({
      id,
      values: [score, Math.sqrt(1 - score * score), 0],
      namespace: `${region}:onsite`,
      metadata: { v: 1, region, scope: 'onsite', tier: 1, bloom: bloomOf(['pos:electrician']), model: 'm', ...(cell ? { cell6: cell } : {}) },
    });
    // The best match is in Rio, outside Macaé's ring; one next door; one two rings out; one with no cell (an older phone's).
    // Two more whose phones name another country (an app region set to the US): one next door, counted, and one in Rio, not.
    await index.upsert([
      listing('rio', 0.99, RIO.r6),
      listing('near', 0.8, MACAE_RING1[0]),
      listing('far', 0.95, MACAE_RING2_ONE),
      listing('none', 0.9),
      listing('near-us', 0.7, MACAE_RING1[1], 'us'),
      listing('rio-us', 0.98, RIO.r6, 'us'),
    ]);
    const regionOf: Record<string, string> = { 'near-us': 'us', 'rio-us': 'us' };
    const records = new Map(['rio', 'near', 'far', 'none', 'near-us', 'rio-us'].map((id) => [id, record(id, regionOf[id])]));
    const listings: ListingStore = {
      put: async () => true,
      get: async (ids) => new Map(ids.flatMap((id) => (records.has(id) ? [[id, records.get(id)!] as const] : []))),
      profilesOf: async () => [],
      delete: async () => undefined,
    };
    return { index, deps: { inference: fakeInference({}), index, listings } };
  };
  const intent = (over: Partial<RecallIntent> = {}): RecallIntent => ({
    scope: 'onsite',
    regions: ['br'],
    queryText: 'eletricista',
    vector,
    allOf: [],
    anyOf: ['pos:electrician'],
    mode: 'curated',
    ...over,
  });

  it("searches every launch country's on-site namespace with `cell $in` the ring and ranks the nearest first, whatever the score", async () => {
    const { index, deps } = await setup();
    const out = await recall(deps, intent({ near: { res: 6, rings: [[MACAE.r6], MACAE_RING1, [MACAE_RING2_ONE]] } }));
    // The hirer's own region first, then the other launch countries', each with the ring's filter.
    const filter = { cell6: { $in: [MACAE.r6, ...MACAE_RING1, MACAE_RING2_ONE] } };
    expect(index.queries.map((q) => [q.namespace, q.filter])).toEqual([
      ['br:onsite', filter],
      ['us:onsite', filter],
      ['mx:onsite', filter],
    ]);
    // A worker next door whose phone names the US is counted; one in Rio is not, whichever country names it.
    expect(out.ok && out.finalists.map((f) => [f.listingId, f.distance])).toEqual([
      ['near', 1],
      ['near-us', 1],
      ['far', 2],
    ]);
  });

  it('searches the whole namespace without a ring, and a remote search ignores one', async () => {
    const { index, deps } = await setup();
    const out = await recall(deps, intent());
    expect(index.queries[0]!.filter).toBeUndefined();
    expect(index.queries.map((q) => q.namespace)).toEqual(['br:onsite']);
    expect(out.ok && out.finalists.map((f) => f.listingId)).toEqual(['rio', 'far', 'none', 'near']);
    await recall({ ...deps, remoteCountries: ['br'] }, intent({ scope: 'remote', near: { res: 6, rings: [[MACAE.r6]] } }));
    expect(index.queries.at(-1)!.filter).toBeUndefined();
  });
});
