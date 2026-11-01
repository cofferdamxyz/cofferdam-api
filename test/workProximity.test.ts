// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { cellToCenterChild, cellToLatLng, cellToParent, getHexagonEdgeLengthAvg, greatCircleDistance, latLngToCell } from 'h3-js';
import { describe, expect, it } from 'vitest';

import { bloomOf } from '../src/services/work/bloom.js';
import { EDGE_KM } from '../src/services/work/h3.js';
import { checkHirerRequest, legacyRingCell } from '../src/services/work/hire.js';
import {
  checkCells,
  checkDraft,
  DEFAULT_WORKER_RADIUS_KM,
  H3_CELL,
  h3CenterChildAt,
  h3ParentAt,
  WORKER_RADIUS_STEPS_KM,
  type ListingDraft,
  type ListingRecord,
  type ListingStore,
} from '../src/services/work/listings.js';
import {
  CONTAINMENT_SLACK_KM,
  DISTANCE_BAND_KM,
  MAX_WORKER_RADIUS_KM,
  recall,
  SEARCH_RES,
  SEARCH_RINGS,
  searchReach,
  type RecallIntent,
} from '../src/services/work/recall.js';
import { fakeInference, memoryIndex } from './fixtures/work/fakes.js';

// Real H3 cells (h3-js 4.5.0): Macaé's at resolution 6, its parent, its first ring, and Rio de Janeiro's.
const MACAE = { r6: '86a8b1a07ffffff', r5: '85a8b1a3fffffff' };
const MACAE_RING1 = ['86a8b1a27ffffff', '86a8b1a37ffffff', '86a8b1a17ffffff', '86a8b1a1fffffff', '86a8b1a0fffffff', '86a8b1a2fffffff'];
const RIO = { r6: '86a8a06a7ffffff', r5: '85a8a06bfffffff' };

/** The point `km` from `[lat, lng]` on a bearing, on a sphere of the Earth's mean radius. */
function destination([lat, lng]: [number, number], km: number, bearingDeg: number): [number, number] {
  const R = 6371.0088;
  const rad = Math.PI / 180;
  const d = km / R;
  const b = bearingDeg * rad;
  const p1 = lat * rad;
  const l1 = lng * rad;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 / rad, ((((l2 / rad + 540) % 360) + 360) % 360) - 180];
}

/** A seeded generator, so a failing sample can be found again. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

describe("an on-site listing's proximity cells and radius (decision 0067, rule 8, as amended)", () => {
  it('takes a resolution-6 cell and its resolution-5 parent as h3-js writes them, and adds their resolution-4 parent', () => {
    for (const cell of [MACAE.r6, RIO.r6, ...MACAE_RING1]) {
      expect(h3ParentAt(cell, 5)).toBe(cellToParent(cell, 5));
      expect(h3ParentAt(cell, 4)).toBe(cellToParent(cell, 4));
      expect(h3ParentAt(cellToParent(cell, 5), 4)).toBe(cellToParent(cell, 4));
      expect(H3_CELL[4].test(cellToParent(cell, 4))).toBe(true);
      expect(H3_CELL[4].test(cellToParent(cell, 5))).toBe(false);
      expect(h3CenterChildAt(cellToParent(cell, 5), 6)).toBe(cellToCenterChild(cellToParent(cell, 5), 6));
    }
    expect(checkCells(MACAE)).toBe(true);
    expect(checkCells({ r6: MACAE.r6, r5: RIO.r5 })).toBe(false);
    expect(checkCells({ r6: MACAE.r5, r5: MACAE.r5 })).toBe(false);
    expect(checkCells({ r6: 'not a cell', r5: MACAE.r5 })).toBe(false);
  });

  it("takes the circle's radius with the cells, as one of the map's steps", () => {
    expect(WORKER_RADIUS_STEPS_KM).toEqual([10, 25, 50, 100]);
    for (const radiusKm of WORKER_RADIUS_STEPS_KM) expect(checkDraft(draft({ cells: MACAE, radiusKm }))).toBeNull();
    // An older phone sends its cells without one: the app's default stands for it.
    expect(checkDraft(draft({ cells: MACAE }))).toBeNull();
    expect(DEFAULT_WORKER_RADIUS_KM).toBe(25);
    expect(checkDraft(draft())).toBeNull();
    expect(checkDraft(draft({ cells: MACAE, radiusKm: 30 }))).toBe('bad_radius');
    expect(checkDraft(draft({ cells: MACAE, radiusKm: '25' as never }))).toBe('bad_radius');
    expect(checkDraft(draft({ radiusKm: 25 }))).toBe('bad_radius');
    expect(checkDraft(draft({ scope: 'remote', cells: MACAE }))).toBe('bad_cells');
    expect(checkDraft(draft({ scope: 'remote', radiusKm: 25 }))).toBe('bad_radius');
    expect(checkDraft(draft({ cells: { r6: MACAE.r6, r5: RIO.r5 } }))).toBe('bad_cells');
  });
});

describe("a search's reach: the widest radius a worker can set, around the job's cell", () => {
  it("uses h3-js's mean edges, and filters by 61 resolution-4 cells under Vectorize's 2 KB", async () => {
    for (const res of [4, 5, 6] as const) expect(EDGE_KM[res]).toBeCloseTo(getHexagonEdgeLengthAvg(res, 'km'), 6);
    expect([SEARCH_RES, SEARCH_RINGS, MAX_WORKER_RADIUS_KM]).toEqual([4, 4, 100]);
    const reach = await searchReach(MACAE.r6);
    expect(reach.cells).toHaveLength(61);
    expect(reach.cells.every((c) => H3_CELL[4].test(c))).toBe(true);
    expect(JSON.stringify({ cell4: { $in: reach.cells } }).length).toBeLessThan(2048);
  });

  it('holds every worker whose circle can hold the job, across the launch markets (8,000 seeded pairs)', async () => {
    const random = seeded(67);
    let measured = 0;
    for (let i = 0; i < 8_000; i++) {
      // A job between Canada's border and Patagonia, and a worker up to the widest radius and its slack away.
      const job: [number, number] = [-50 + random() * 99, -125 + random() * 90];
      const worker = destination(job, random() * (MAX_WORKER_RADIUS_KM + CONTAINMENT_SLACK_KM + 8), random() * 360);
      const at = latLngToCell(job[0], job[1], 6);
      const cell6 = latLngToCell(worker[0], worker[1], 6);
      const km = greatCircleDistance(cellToLatLng(at), cellToLatLng(cell6), 'km');
      if (km > MAX_WORKER_RADIUS_KM + CONTAINMENT_SLACK_KM) continue;
      measured++;
      const reach = await searchReach(at);
      expect(reach.cells, `job ${at}, worker ${cell6}, ${km.toFixed(1)} km`).toContain(cellToParent(cell6, 4));
      expect(reach.kmTo({ cell6, radius: MAX_WORKER_RADIUS_KM })).toBeCloseTo(km, 6);
    }
    expect(measured).toBeGreaterThan(7_000);
  });

  it("keeps a listing only when its own circle holds the job's cell, within one cell's edge", async () => {
    const reach = await searchReach(MACAE.r6);
    const job = cellToLatLng(MACAE.r6);
    const at = (km: number) => {
      const [lat, lng] = destination(job, km, 90);
      return latLngToCell(lat, lng, 6);
    };
    const twenty = at(20);
    const km20 = greatCircleDistance(job, cellToLatLng(twenty), 'km');
    expect(reach.kmTo({ cell6: twenty, radius: 25 })).toBeCloseTo(km20, 6);
    expect(reach.kmTo({ cell6: twenty, radius: 10 })).toBeNull();
    expect(reach.kmTo({ cell6: MACAE.r6, radius: 10 })).toBe(0);
    // The slack: a cell whose centre is past a 10 km circle by less than one cell's edge still counts; one further does not.
    const cells = Array.from({ length: 200 }, (_, i) => at(8 + i * 0.05));
    const past = (cell: string) => greatCircleDistance(job, cellToLatLng(cell), 'km') - 10;
    const within = cells.find((c) => past(c) > 0 && past(c) <= CONTAINMENT_SLACK_KM)!;
    const beyond = Array.from({ length: 200 }, (_, i) => at(12 + i * 0.05)).find((c) => past(c) > CONTAINMENT_SLACK_KM)!;
    expect(within && beyond).toBeTruthy();
    expect(reach.kmTo({ cell6: within, radius: 10 })).toBeCloseTo(10 + past(within), 6);
    expect(reach.kmTo({ cell6: beyond, radius: 10 })).toBeNull();
    // A listing published before the radius reached the plane, or one out of shape, cannot be measured.
    expect(reach.kmTo({ cell6: twenty })).toBeNull();
    expect(reach.kmTo({ cell6: 'nope', radius: 100 })).toBeNull();
    expect(reach.kmTo(undefined)).toBeNull();
  });
});

describe("a hirer's request names the job's cell", () => {
  const base = { sentence: 'Preciso de eletricista', lang: 'pt' as const, regions: ['br'] };

  it('takes a resolution-6 cell, and refuses anything else', () => {
    expect(checkHirerRequest({ ...base, at: MACAE.r6 })).toMatchObject({ ok: true });
    expect(checkHirerRequest(base)).toMatchObject({ ok: true });
    expect(checkHirerRequest({ ...base, at: MACAE.r5 })).toMatchObject({ ok: false, reason: 'at' });
    expect(checkHirerRequest({ ...base, at: 42 } as never)).toMatchObject({ ok: false, reason: 'at' });
  });

  it("reads an older app's ring by its centre cell", () => {
    const ring6 = { res: 6 as const, rings: [[MACAE.r6], MACAE_RING1] };
    expect(checkHirerRequest({ ...base, near: ring6 })).toMatchObject({ ok: true });
    expect(legacyRingCell(ring6)).toBe(MACAE.r6);
    const ring5 = { res: 5 as const, rings: [[MACAE.r5]] };
    expect(checkHirerRequest({ ...base, near: ring5 })).toMatchObject({ ok: true });
    expect(legacyRingCell(ring5)).toBe(cellToCenterChild(MACAE.r5, 6));
    expect(checkHirerRequest({ ...base, near: { res: 6, rings: [['86']] } } as never)).toMatchObject({ ok: false, reason: 'near' });
    expect(checkHirerRequest({ ...base, near: { res: 6, rings: [] } } as never)).toMatchObject({ ok: false, reason: 'near' });
    expect(checkHirerRequest({ ...base, near: { res: 7, rings: [[MACAE.r6]] } } as never)).toMatchObject({ ok: false, reason: 'near' });
  });
});

describe("recall within the workers' own circles", () => {
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
  const job = cellToLatLng(MACAE.r6);
  const cellAt = (km: number, bearing = 90) => {
    const [lat, lng] = destination(job, km, bearing);
    return latLngToCell(lat, lng, 6);
  };
  const setup = async () => {
    const index = memoryIndex();
    const listing = (id: string, score: number, place?: { cell6: string; radius?: number }, region = 'br') => ({
      id,
      values: [score, Math.sqrt(1 - score * score), 0],
      namespace: `${region}:onsite`,
      metadata: {
        v: 1,
        region,
        scope: 'onsite',
        tier: 1,
        bloom: bloomOf(['pos:electrician']),
        model: 'm',
        ...(place
          ? { cell6: place.cell6, cell5: cellToParent(place.cell6, 5), cell4: cellToParent(place.cell6, 4), ...(place.radius ? { radius: place.radius } : {}) }
          : {}),
      },
    });
    // From Macaé's cell: Rio (about 145 km) with the widest circle, out of reach; one next door with 10 km; one 20 km out
    // with 25 km; one 40 km out with only 25 km, which the job is past; one 80 km out with 100 km; one with no cell (an
    // older phone's); one 20 km out published before the radius reached the plane; and one next door whose phone names the
    // US, counted, since the cells do the locality.
    await index.upsert([
      listing('rio', 0.99, { cell6: RIO.r6, radius: 100 }),
      listing('next', 0.6, { cell6: MACAE_RING1[0]!, radius: 10 }),
      listing('twenty', 0.9, { cell6: cellAt(20), radius: 25 }),
      listing('forty', 0.95, { cell6: cellAt(40, 200), radius: 25 }),
      listing('eighty', 0.97, { cell6: cellAt(80, 300), radius: 100 }),
      listing('none', 0.98),
      listing('older', 0.96, { cell6: cellAt(20, 45) }),
      listing('next-us', 0.7, { cell6: MACAE_RING1[1]!, radius: 25 }, 'us'),
    ]);
    const regionOf: Record<string, string> = { 'next-us': 'us' };
    const ids = ['rio', 'next', 'twenty', 'forty', 'eighty', 'none', 'older', 'next-us'];
    const records = new Map(ids.map((id) => [id, record(id, regionOf[id])]));
    const listings: ListingStore = {
      put: async () => true,
      get: async (wanted) => new Map(wanted.flatMap((id) => (records.has(id) ? [[id, records.get(id)!] as const] : []))),
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

  it("searches every launch country's on-site namespace within the widest reach, keeps the circles that hold the job, nearest band first", async () => {
    const { index, deps } = await setup();
    const out = await recall(deps, intent({ at: MACAE.r6 }));
    const filter = { cell4: { $in: (await searchReach(MACAE.r6)).cells } };
    expect(index.queries.map((q) => [q.namespace, q.filter])).toEqual([
      ['br:onsite', filter],
      ['us:onsite', filter],
      ['mx:onsite', filter],
    ]);
    // Out: Rio and the one 40 km out (their circles stop short), the one with no cell and the one with no radius.
    const band = (cell: string) => Math.floor(greatCircleDistance(job, cellToLatLng(cell), 'km') / DISTANCE_BAND_KM);
    expect(out.ok && out.finalists.map((f) => [f.listingId, f.distance])).toEqual([
      ['next-us', band(MACAE_RING1[1]!)],
      ['next', band(MACAE_RING1[0]!)],
      ['twenty', band(cellAt(20))],
      ['eighty', band(cellAt(80, 300))],
    ]);
  });

  it('searches the whole namespace without the job\'s cell, and a remote search ignores it', async () => {
    const { index, deps } = await setup();
    const out = await recall(deps, intent());
    expect(index.queries[0]!.filter).toBeUndefined();
    expect(index.queries.map((q) => q.namespace)).toEqual(['br:onsite']);
    expect(out.ok && out.finalists.map((f) => f.listingId)).toEqual(['rio', 'none', 'eighty', 'older', 'forty', 'twenty', 'next']);
    await recall({ ...deps, remoteCountries: ['br'] }, intent({ scope: 'remote', at: MACAE.r6 }));
    expect(index.queries.at(-1)!.filter).toBeUndefined();
  });
});
