// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { D1ListingStore, listingIdOf, MAX_WORK_PROFILES, publishListing, type ListingDraft, type ListingRecord, type PublishDeps } from '../src/services/work/listings.js';
import { recall, type RecallIntent } from '../src/services/work/recall.js';
import { sqliteD1 } from './fixtures/work/d1.js';
import { workWorld } from './fixtures/work/world.js';

const draft = (over: Partial<ListingDraft>): ListingDraft => ({
  pseudonym: 'p1',
  profileId: 'main',
  region: 'us-tx',
  scope: 'onsite',
  tier: 1,
  lang: 'en',
  titles: ['Service Plumber'],
  skills: ['Leak detection'],
  certificates: [],
  languages: ['en'],
  ...over,
});

type World = Awaited<ReturnType<typeof workWorld>>;

const publishDeps = (w: World): PublishDeps => ({
  inference: w.inference,
  registry: { inference: w.inference, store: w.registry, index: w.tokenIndex, now: () => 1_000 },
  listings: w.listings,
  index: w.listingIndex,
  now: () => 2_000,
});

const record = (pseudonym: string, profileId: string, over: Partial<ListingRecord> = {}): ListingRecord => ({
  listingId: `L-${pseudonym}-${profileId}`,
  pseudonym,
  profileId,
  region: 'us-tx',
  scope: 'onsite',
  namespace: 'us-tx:onsite',
  tier: 1,
  tokens: ['pos:plumber'],
  embedModel: '@cf/baai/bge-m3',
  publishedAt: 1,
  updatedAt: 1,
  ...over,
});

describe('Work Profiles: three listings per pseudonym (decision 0060)', () => {
  it('refuses a fourth profile before any model call, and still republishes the three', async () => {
    const w = await workWorld();
    expect(MAX_WORK_PROFILES).toBe(3);
    for (const profileId of ['main', 'mechanic', 'driver']) expect((await publishListing(publishDeps(w), draft({ profileId }))).ok).toBe(true);
    w.calls.length = 0;
    expect(await publishListing(publishDeps(w), draft({ profileId: 'cook' }))).toEqual({ ok: false, error: 'profile_limit', limit: 3, calls: [] });
    expect(w.calls).toEqual([]);
    expect((await publishListing(publishDeps(w), draft({ profileId: 'driver', region: 'us-la' }))).ok).toBe(true);
    // Another pseudonym's profiles never count against this one.
    expect((await publishListing(publishDeps(w), draft({ pseudonym: 'p2', profileId: 'cook' }))).ok).toBe(true);
    expect(w.listingIndex.vectors.size).toBe(4);
  });

  it('holds the limit when two new profiles publish at once, and leaves no vector without its record', async () => {
    const w = await workWorld();
    for (const profileId of ['main', 'mechanic']) await publishListing(publishDeps(w), draft({ profileId }));
    const both = await Promise.all(['driver', 'cook'].map((profileId) => publishListing(publishDeps(w), draft({ profileId }))));
    expect(both.map((o) => o.ok).sort()).toEqual([false, true]);
    const refused = both.find((o) => !o.ok)!;
    expect(refused).toMatchObject({ ok: false, error: 'profile_limit', limit: 3 });
    // It ran its snaps and its embedding before the write refused it: the calls stay on the outcome for the meter.
    expect(refused.calls.some((c) => c.op === 'work-embed')).toBe(true);
    const ids = (w.db.sqlite.prepare('SELECT listing_id FROM listings').all() as { listing_id: string }[]).map((r) => r.listing_id);
    expect(ids).toHaveLength(3);
    expect([...w.listingIndex.vectors.keys()].sort()).toEqual([...ids].sort());
  });

  it('writes a record under the limit in one statement, and names the profiles a pseudonym holds', async () => {
    const db = sqliteD1();
    const store = new D1ListingStore(db.d1);
    expect(await store.put(record('p1', 'a'), 2)).toBe(true);
    expect(await store.put(record('p1', 'b'), 2)).toBe(true);
    expect(await store.put(record('p1', 'c'), 2)).toBe(false);
    expect(await store.put(record('p1', 'b', { tier: 2, updatedAt: 5 }), 2)).toBe(true);
    expect(await store.profilesOf('p1')).toEqual(['a', 'b']);
    expect(await store.profilesOf('p2')).toEqual([]);
    expect((await store.get(['L-p1-b'])).get('L-p1-b')).toMatchObject({ tier: 2, updatedAt: 5, publishedAt: 1 });
    expect(await store.put(record('p1', 'c'))).toBe(true);
  });
});

describe('recall leaves out the hirer’s own listings', () => {
  it('drops every listing of the excluded pseudonym and keeps the rest', async () => {
    const w = await workWorld();
    for (const d of [draft({ pseudonym: 'p-hirer' }), draft({ pseudonym: 'p-hirer', profileId: 'helper', titles: ["Plumber's Helper"] }), draft({ pseudonym: 'p-other' })]) {
      expect((await publishListing(publishDeps(w), d)).ok).toBe(true);
    }
    const sink: RecallIntent = { scope: 'onsite', regions: ['us-tx'], queryText: 'kitchen sink is leaking; plumber; leak repair', allOf: [], anyOf: ['pos:plumber', 'skill:leak-repair'], mode: 'instant' };
    const deps = { inference: w.inference, index: w.listingIndex, listings: w.listings };
    const everyone = await recall(deps, sink);
    expect(everyone.ok && everyone.finalists).toHaveLength(2);
    const others = await recall({ ...deps, excludePseudonym: 'p-hirer' }, sink);
    expect(others.ok && others.finalists.map((f) => f.listingId)).toEqual([await listingIdOf('p-other', 'main')]);
  });
});
