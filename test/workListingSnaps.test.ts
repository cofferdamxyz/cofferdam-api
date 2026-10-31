// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkCallsError } from '../src/services/work/fields.js';
import { publishListing, SNAP_CONCURRENCY, type ListingDraft, type ListingStore, type PublishDeps } from '../src/services/work/listings.js';
import type * as Registry from '../src/services/work/registry.js';
import type { RegistryDeps, SnapInput, SnapResult } from '../src/services/work/registry.js';
import { fakeInference, memoryIndex } from './fixtures/work/fakes.js';

// The registry's snap stands in here: each claim takes its own time, so the snaps finish out of order.
const snapCalls: SnapInput[] = [];
let running = 0;
let peak = 0;
let failOn: string | null = null;
vi.mock('../src/services/work/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Registry>();
  return {
    ...actual,
    snap: async (_deps: RegistryDeps, input: SnapInput): Promise<SnapResult> => {
      snapCalls.push(input);
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 2 + ((input.raw.length * 7) % 9)));
      running--;
      const call = { op: 'work-adjudicate', model: 'clef', usage: { inputTokens: 1, outputTokens: 1 } } as unknown as SnapResult['candidates'][number];
      if (input.raw === failOn) throw new WorkCallsError(new Error('store down'), [call as never]);
      const slug = input.raw.toLowerCase().replace(/[^a-z]+/g, '-');
      return { decision: 'auto', token: `${input.kind}:${slug}`, labelEn: input.raw, specialization: false, score: 1, probability: null, candidates: [], calls: [call as never] } as unknown as SnapResult;
    },
  };
});

const draft = (skills: string[]): ListingDraft => ({
  pseudonym: 'P',
  profileId: 'main',
  region: 'br',
  scope: 'onsite',
  tier: 0,
  lang: 'pt',
  titles: ['Eletricista'],
  skills,
  certificates: [],
  languages: [],
});

const deps = (): PublishDeps => {
  const records = new Map<string, unknown>();
  const listings: ListingStore = {
    put: async (r) => {
      records.set(r.listingId, r);
      return true;
    },
    get: async () => new Map(),
    profilesOf: async () => [],
    delete: async () => undefined,
  };
  const inference = fakeInference({});
  // The store answers no ISCO-08 group for the occupation; the snaps never reach it (`snap` is the fake above).
  const store = { tokens: async () => new Map() } as unknown as RegistryDeps['store'];
  return { inference, registry: { inference, store, index: memoryIndex() }, listings, index: memoryIndex() };
};

const SKILLS = ['Solda TIG', 'Leitura de desenho', 'Painéis elétricos', 'NR-10 prática', 'Montagem industrial', 'Manutenção preventiva', 'Comandos elétricos', 'Instrumentação'];

afterEach(() => {
  snapCalls.length = 0;
  running = 0;
  peak = 0;
  failOn = null;
});

describe("a listing's claims snap a few at a time", () => {
  it('runs at most SNAP_CONCURRENCY snaps at once and keeps every claim, whatever order they finish in', async () => {
    const out = await publishListing(deps(), draft(SKILLS), { listing: Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)) });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(SNAP_CONCURRENCY);
    expect(snapCalls.map((c) => c.raw)).toEqual(['Eletricista', ...SKILLS]);
    expect(out.ok && out.tokens).toEqual(expect.arrayContaining(['pos:eletricista', 'skill:solda-tig', 'skill:instrumenta-o']));
    // Every snap's call is metered, one each.
    expect(out.calls).toHaveLength(1 + SKILLS.length);
  });

  it('starts no new snap after a failure, and throws it with the calls made', async () => {
    failOn = 'Leitura de desenho';
    const err = await publishListing(deps(), draft(SKILLS), { listing: Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkCallsError);
    // The failed claim's call and those of the snaps that finished are all carried; claims after the failure never started.
    expect(snapCalls.length).toBeLessThan(1 + SKILLS.length);
    expect((err as WorkCallsError).calls.length).toBe(snapCalls.length);
  });
});
