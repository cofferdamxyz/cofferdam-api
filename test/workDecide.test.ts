// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Matching v2 (workspace decision 0069): occupations' ISCO-08 unit groups on
 * listings and in plans, a plan that keeps an occupation, and the decision
 * pass (S8) in which Clef, not flash, classifies each finalist against the
 * job, with the job's needed skills breaking a tie between two groups.
 */

import { describe, expect, it } from 'vitest';

import { FIT_STATE_MAX_ITEMS, fitQuestions, fitState, OTHER_FLOOR } from '../src/services/work/clef.js';
import { planHire, type HireDeps } from '../src/services/work/hire.js';
import { bloomOf } from '../src/services/work/bloom.js';
import { D1ListingStore, LISTING_METADATA_VERSION, listingIdOf, namespaceOf, publishListing, type ListingDraft, type PublishDeps } from '../src/services/work/listings.js';
import { fitProfileOf, recall, type RecallDeps } from '../src/services/work/recall.js';
import { D1RegistryStore, labelIdOf, labelNorm, type RegistryDeps, type TokenKind } from '../src/services/work/registry.js';
import { sqliteD1 } from './fixtures/work/d1.js';
import { fakeInference, jsonModeResult, memoryIndex, type FakeCall, type FakeResponses } from './fixtures/work/fakes.js';

// One geometry for labels, listings and sentences: pipe work and electrical work.
const FEATURES: [RegExp, number][] = [
  [/plumb|pipe|leak|sink/i, 0],
  [/weld/i, 1],
  [/electric|wiring/i, 2],
];
function vectorOf(text: string): number[] {
  const v = new Array<number>(1024).fill(0);
  for (const [re, d] of FEATURES) if (re.test(text)) v[d]! += 1;
  v[1023] = 0.05;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}
const embed = (input: Record<string, unknown>) => ({ data: (input.text as string[]).map(vectorOf), meta: { neurons: 0.001 } });

const SEED: { token: string; kind: TokenKind; label: string; isco: string | null }[] = [
  { token: 'pos:plumber', kind: 'pos', label: 'plumber', isco: '7126' },
  { token: 'pos:pipefitter', kind: 'pos', label: 'pipefitter', isco: '7126' },
  { token: 'pos:electrician', kind: 'pos', label: 'electrician', isco: '7411' },
  { token: 'pos:welder', kind: 'pos', label: 'welder', isco: '7212' },
  { token: 'skill:leak-repair', kind: 'skill', label: 'leak repair', isco: null },
  { token: 'skill:pipe-welding', kind: 'skill', label: 'pipe welding', isco: null },
];

/** Clef on the request: safe, on site, and each needed candidate's probability by its label. */
const requestAndNeeds = (needs: Record<string, number>) => (input: Record<string, unknown>) => {
  const questions = input.questions as Record<string, { instructions: string }>;
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (id === 'scope') answers[id] = { choice: 'onsite', probabilities: { onsite: 0.95 } };
    else if (id === 'harmful' || id === 'injection') answers[id] = { noul: 0.02 };
    else if (id.startsWith('need_')) {
      const label = Object.keys(needs).find((l) => q.instructions.includes(l));
      answers[id] = { noul: label ? needs[label] : 0.05 };
    }
  }
  return { answers, usage: { input_tokens: 300 } };
};

/** Clef's fit, by the occupation the state names. */
const decides = (fits: Record<string, [string, number]>) => (input: Record<string, unknown>) => {
  const state = String(input.state);
  const occupations = state.match(/Occupations: ([^.]*)\./)?.[1] ?? '';
  const hit = Object.entries(fits).find(([occ]) => occupations.includes(occ));
  const [choice, p] = hit ? hit[1] : ['other', 0.9];
  return { answers: { fit: { choice, probabilities: { [choice]: p, fit: choice === 'fit' ? p : 1 - p } } }, usage: { input_tokens: 200 } };
};

/** Registry tokens with one English label each, and the label's vector in the registry's index. */
async function seed(store: D1RegistryStore, index: ReturnType<typeof memoryIndex>, tokens: typeof SEED) {
  for (const s of tokens) {
    const norm = labelNorm(s.label);
    const labelId = await labelIdOf(s.token, 'en', norm);
    await store.insertToken(
      { token: s.token, kind: s.kind, source: 'seed', labelEn: s.label, escoUri: null, iscoCode: s.isco, status: 'active', mergedInto: null },
      [{ labelId, token: s.token, lang: 'en', label: s.label, labelNorm: norm, kind: 'preferred', embedded: true }],
      0,
    );
    await index.upsert([{ id: labelId, values: vectorOf(s.label), metadata: { token: s.token, kind: s.kind, lang: 'en', label: s.label, source: 'seed' } }]);
  }
}

async function world(responses: FakeResponses = {}, calls: FakeCall[] = []) {
  const db = sqliteD1();
  const registryIndex = memoryIndex();
  const store = new D1RegistryStore(db.d1);
  await seed(store, registryIndex, SEED);
  const inference = fakeInference(
    { 'work-embed': embed, 'work-intent': jsonModeResult({ task: 'fix a leaking pipe under the sink', when: null, budget: null, credential: null, language: null, recurrence: null }), ...responses },
    calls,
  );
  const registry: RegistryDeps = { inference, store, index: registryIndex, now: () => 1_000 };
  const listings = new D1ListingStore(db.d1);
  const jobsIndex = memoryIndex();
  const publish: PublishDeps = { inference, registry, listings, index: jobsIndex, now: () => 2_000 };
  const recallDeps: RecallDeps = { inference, index: jobsIndex, listings, store };
  return { store, registryIndex, registry, listings, publish, recallDeps, hire: { registry, recall: recallDeps } as HireDeps };
}

const draft = (pseudonym: string, titles: string[], skills: string[]): ListingDraft => ({
  pseudonym,
  profileId: 'main',
  region: 'us-tx',
  scope: 'onsite',
  tier: 1,
  lang: 'en',
  titles,
  skills,
  certificates: [],
  languages: ['en'],
});

const SENTENCE = { sentence: 'Need someone to fix a leaking pipe under the sink', lang: 'en' as const, regions: ['us-tx'] };

describe('the decision pass’s question', () => {
  it('asks one choice over English names only, its lists cut short', () => {
    expect(Object.keys(fitQuestions())).toEqual(['fit']);
    const state = fitState({ task: 'fix a pipe', needs: ['plumber', 'leak repair'], certificates: [] }, { occupations: ['plumber'], skills: Array.from({ length: 20 }, (_, i) => `skill ${i}`), certificates: [] });
    expect(state).toContain('The job: fix a pipe');
    expect(state).toContain('It needs: plumber; leak repair.');
    expect(state).toContain('Occupations: plumber.');
    expect(state.match(/skill \d+/g)).toHaveLength(FIT_STATE_MAX_ITEMS);
  });

  it('puts the job’s needed skills first in a profile, since the state cuts each list short', () => {
    const tokens = [...Array.from({ length: 20 }, (_, i) => `skill:apply-${String(i).padStart(2, '0')}`), 'skill:use-welding-equipment', 'pos:welder'].sort();
    const profile = fitProfileOf(tokens, new Set(['skill:use-welding-equipment']), (t) => t.replace(/^[a-z]+:/, '').replace(/-/g, ' '));
    expect(profile.skills[0]).toBe('use welding equipment');
    expect(profile.occupations).toEqual(['welder']);
    expect(fitState({ task: 'weld a gate', needs: ['use welding equipment'], certificates: [] }, profile)).toContain('Skills: use welding equipment; apply 00;');
  });
});

describe('ISCO unit groups (decision 0069)', () => {
  it('puts an occupation’s unit group on its listing', async () => {
    const w = await world();
    const out = await publishListing(w.publish, draft('p1', ['pipefitter'], ['pipe welding']));
    expect(out.ok && out.tokens).toEqual(['isco:7126', 'lang:en', 'pos:pipefitter', 'skill:pipe-welding']);
  });

  it('adds the needed occupation’s group to the plan, and keeps an occupation that did not pass the floor', async () => {
    const w = await world({ 'work-classify': requestAndNeeds({ plumber: 0.9, 'leak repair': 0.9 }) });
    const plan = await planHire(w.hire, SENTENCE);
    expect(plan.ok && plan.plan.intent.anyOf).toEqual(expect.arrayContaining(['pos:plumber', 'skill:leak-repair', 'isco:7126']));
    const kept = await planHire((await world({ 'work-classify': requestAndNeeds({ plumber: 0.3, 'leak repair': 0.9 }) })).hire, SENTENCE);
    expect(kept.ok && kept.plan.needs.map((n) => n.token)).toEqual(['skill:leak-repair', 'pos:plumber']);
    const none = await planHire((await world({ 'work-classify': requestAndNeeds({ plumber: 0.1, 'leak repair': 0.9 }) })).hire, SENTENCE);
    expect(none.ok && none.plan.needs.map((n) => n.token)).toEqual(['skill:leak-repair']);
  });

  it('lets a kept occupation widen the gate only: not the mode, the query or the decision pass’s job', async () => {
    const kept = await planHire((await world({ 'work-classify': requestAndNeeds({ plumber: 0.3, 'leak repair': 0.9 }) })).hire, SENTENCE);
    if (!kept.ok) throw new Error('no plan');
    expect(kept.plan.intent.anyOf).toEqual(expect.arrayContaining(['pos:plumber', 'isco:7126', 'skill:leak-repair']));
    expect(kept.plan.intent.keptOccupation).toBe('pos:plumber');
    expect(kept.plan.needs.at(-1)).toMatchObject({ token: 'pos:plumber', kept: true });
    expect(kept.plan.intent.needLabels).toEqual(['leak repair']);
    expect(kept.plan.intent.queryText).not.toContain('plumber');
    expect(kept.plan.intent.mode).toBe('instant');
    // Nothing over the floor: nothing is kept, and the gate stays open for a Curated job, as it always was.
    const weak = await planHire((await world({ 'work-classify': requestAndNeeds({ plumber: 0.3, 'leak repair': 0.3 }) })).hire, SENTENCE);
    if (!weak.ok) throw new Error('no plan');
    expect(weak.plan.needs).toEqual([]);
    expect(weak.plan.intent.anyOf).toEqual([]);
    expect(weak.plan.intent.keptOccupation).toBeUndefined();
    expect(weak.plan.intent.mode).toBe('curated');
  });
});

describe('the decision pass (S8)', () => {
  async function pool(responses: FakeResponses, calls: FakeCall[] = []) {
    const w = await world({ 'work-classify': requestAndNeeds({ plumber: 0.9, 'leak repair': 0.9 }), ...responses }, calls);
    await publishListing(w.publish, draft('pipefitter', ['pipefitter'], ['pipe welding']));
    await publishListing(w.publish, draft('plumber', ['plumber'], ['leak repair']));
    await publishListing(w.publish, draft('electrician', ['electrician'], ['pipe welding']));
    await publishListing(w.publish, draft('welder', ['welder'], ['pipe welding']));
    const planned = await planHire(w.hire, SENTENCE);
    if (!planned.ok) throw new Error('no plan');
    return { w, plan: planned.plan };
  }
  const who = async (w: Awaited<ReturnType<typeof world>>, ids: string[]) => [...(await w.listings.get(ids)).values()].map((r) => r.pseudonym);

  it('keeps the fits in tier 1, ranks the one holding the needed skill first, and drops other work', async () => {
    const calls: FakeCall[] = [];
    const { w, plan } = await pool({ 'work-decide': decides({ plumber: ['fit', 0.9], pipefitter: ['fit', 0.9], electrician: ['other', 0.85], welder: ['other', 0.85] }) }, calls);
    const out = await recall(w.recallDeps, plan.intent);
    if (!out.ok) throw new Error('recall failed');
    const names = new Map([...(await w.listings.get(out.finalists.map((f) => f.listingId))).values()].map((r) => [r.listingId, r.pseudonym]));
    expect(out.finalists.map((f) => [names.get(f.listingId), f.gateTier, f.fit?.choice])).toEqual([
      ['plumber', 1, 'fit'],
      ['pipefitter', 1, 'fit'],
    ]);
    expect(out.finalists[0]!.fit?.skillsHeld).toBe(1);
    expect(out.decided).toBe(4);
    // What the pass left out comes back for evaluations, with Clef's probability of other work.
    expect((await who(w, (out.dropped ?? []).map((f) => f.listingId))).sort()).toEqual(['electrician', 'welder']);
    expect(out.dropped!.every((f) => f.fit!.pOther >= OTHER_FLOOR && !f.fit!.promoted)).toBe(true);
    expect(calls.filter((c) => c.op === 'work-decide')).toHaveLength(4);
  });

  it('keeps a token hit Clef calls related, promotes a miss it calls a fit, and keeps a related miss only when the hirer curates', async () => {
    const { w, plan } = await pool({ 'work-decide': decides({ plumber: ['fit', 0.9], pipefitter: ['related', 0.7], electrician: ['fit', 0.8], welder: ['related', 0.7] }) });
    const instant = await recall(w.recallDeps, { ...plan.intent, mode: 'instant' });
    if (!instant.ok) throw new Error('recall failed');
    const names = await who(w, instant.finalists.map((f) => f.listingId));
    expect([...names].sort()).toEqual(['electrician', 'pipefitter', 'plumber']);
    expect(instant.finalists[0]!.fit?.choice).toBe('fit');
    expect(await who(w, instant.finalists.filter((f) => f.fit?.promoted).map((f) => f.listingId))).toEqual(['electrician']);
    expect(await who(w, (instant.dropped ?? []).map((f) => f.listingId))).toEqual(['welder']);
    const curated = await recall(w.recallDeps, { ...plan.intent, mode: 'curated' });
    if (!curated.ok) throw new Error('recall failed');
    expect(curated.finalists.map((f) => f.gateTier)).toEqual([1, 1, 1, 2]);
  });

  it('promotes no one who lacks a hard requirement: a language the plan needs is the gate’s, never Clef’s', async () => {
    const calls: FakeCall[] = [];
    const { w, plan } = await pool({ 'work-decide': decides({ plumber: ['fit', 0.9], pipefitter: ['fit', 0.9], electrician: ['fit', 0.8], welder: ['fit', 0.8] }) }, calls);
    const spanish = { ...plan.intent, allOf: [...plan.intent.allOf, 'lang:es'] };
    const instant = await recall(w.recallDeps, { ...spanish, mode: 'instant' });
    if (!instant.ok) throw new Error('recall failed');
    expect(instant.finalists).toEqual([]);
    // No call is spent on a miss an Instant search could never keep.
    expect(calls.filter((c) => c.op === 'work-decide')).toHaveLength(0);
    const curated = await recall(w.recallDeps, { ...spanish, mode: 'curated' });
    if (!curated.ok) throw new Error('recall failed');
    expect(curated.finalists).toHaveLength(4);
    expect(curated.finalists.every((f) => f.gateTier === 2 && f.fit?.choice === 'fit' && !f.fit.promoted)).toBe(true);
  });

  it('keeps a worker whose first profile Clef drops, through the same worker’s next one', async () => {
    const w = await world({ 'work-classify': requestAndNeeds({ plumber: 0.9, 'leak repair': 0.9 }), 'work-decide': decides({ plumber: ['other', 0.9], pipefitter: ['fit', 0.9] }) });
    await publishListing(w.publish, draft('w1', ['plumber'], ['leak repair']));
    await publishListing(w.publish, { ...draft('w1', ['pipefitter'], []), profileId: 'second' });
    const planned = await planHire(w.hire, SENTENCE);
    if (!planned.ok) throw new Error('no plan');
    const out = await recall(w.recallDeps, planned.plan.intent);
    if (!out.ok) throw new Error('recall failed');
    const rows = await w.listings.get(out.finalists.map((f) => f.listingId));
    expect([...rows.values()].map((r) => [r.pseudonym, r.profileId])).toEqual([['w1', 'second']]);
  });

  // Fifty listings of one kind at a higher cosine than one listing of a stronger kind, across two namespaces: ordered by
  // cosine alone the one would be the 51st and cut before Clef ever read it. Cosines: a welder holding leak repair 0.71, a
  // pipefitter alone 1.0, the one 0.58.
  const ONE_OCCUPATION: [string[], string[]] = [['plumber', 'electrician'], ['pipe welding']];
  const ONE_GROUP: [string[], string[]] = [['pipefitter', 'electrician', 'welder'], []];
  const SKILL_HITS: [string[], string[]] = [['welder'], ['leak repair']];
  const GROUP_HITS: [string[], string[]] = [['pipefitter'], []];
  it.each([
    ['an occupation hit ahead of skill hits', SKILL_HITS, ONE_OCCUPATION, 0.9, true],
    ['a unit-group hit ahead of skill hits', SKILL_HITS, ONE_GROUP, 0.9, true],
    ['an occupation hit ahead of unit-group hits', GROUP_HITS, ONE_OCCUPATION, 0.9, true],
    ['a kept occupation’s unit-group hit no higher than a skill hit', SKILL_HITS, ONE_GROUP, 0.3, false],
    ['a kept occupation’s own hit no higher than a skill hit', SKILL_HITS, ONE_OCCUPATION, 0.3, false],
  ] as const)('puts %s at the cut to fifty, whatever their cosine', async (_, many, one, plumberP, oneKept) => {
    const w = await world({
      'work-classify': requestAndNeeds({ plumber: plumberP, 'leak repair': 0.9 }),
      'work-decide': decides({ plumber: ['fit', 0.9], pipefitter: ['related', 0.6], welder: ['related', 0.6] }),
    });
    for (let i = 0; i < 50; i++) await publishListing(w.publish, { ...draft(`many-${i}`, [...many[0]], [...many[1]]), region: i % 2 ? 'us-tx' : 'us-ok' });
    await publishListing(w.publish, draft('one', [...one[0]], [...one[1]]));
    const planned = await planHire(w.hire, SENTENCE);
    if (!planned.ok) throw new Error('no plan');
    const out = await recall(w.recallDeps, { ...planned.plan.intent, regions: ['us-tx', 'us-ok'] });
    if (!out.ok) throw new Error('recall failed');
    expect(out.gated).toBe(51);
    expect(out.finalists).toHaveLength(50);
    expect((await who(w, out.finalists.map((f) => f.listingId))).includes('one')).toBe(oneKept);
  });

  it('shows Clef the needed skill first, however late it sorts among twenty others', async () => {
    const calls: FakeCall[] = [];
    const w = await world({ 'work-classify': requestAndNeeds({ plumber: 0.9, 'leak repair': 0.9 }), 'work-decide': decides({ plumber: ['fit', 0.9] }) }, calls);
    const caulking = Array.from({ length: 20 }, (_, i) => ({ token: `skill:caulking-${i}`, kind: 'skill' as const, label: `caulking ${i}`, isco: null }));
    await seed(w.store, w.registryIndex, caulking);
    await publishListing(w.publish, draft('plumber', ['plumber'], [...caulking.map((c) => c.label), 'leak repair']));
    const planned = await planHire(w.hire, SENTENCE);
    if (!planned.ok) throw new Error('no plan');
    await recall(w.recallDeps, planned.plan.intent);
    const states = calls.filter((c) => c.op === 'work-decide').map((c) => String(c.input.state));
    expect(states).toHaveLength(1);
    expect(states[0]).toContain('Skills: leak repair; caulking');
  });

  it('shows Clef the certificate the gate confirmed first, however many the worker holds', async () => {
    const calls: FakeCall[] = [];
    const w = await world({ 'work-classify': requestAndNeeds({ plumber: 0.9, 'leak repair': 0.9 }), 'work-decide': decides({ plumber: ['fit', 0.9] }) }, calls);
    const planned = await planHire(w.hire, SENTENCE);
    if (!planned.ok) throw new Error('no plan');
    // A listing written straight to the stores: twenty certificate tokens that sort ahead of the one the job requires.
    const tokens = ['cert:tx-plumbing', 'isco:7126', 'lang:en', 'pos:plumber', 'skill:leak-repair', ...Array.from({ length: 20 }, (_, i) => `cert:aaa-${String(i).padStart(2, '0')}`)].sort();
    const listingId = await listingIdOf('plumber', 'main');
    const namespace = namespaceOf('us-tx', 'onsite');
    await w.listings.put({ listingId, pseudonym: 'plumber', profileId: 'main', region: 'us-tx', scope: 'onsite', namespace, tier: 1, tokens, embedModel: 'test', publishedAt: 1, updatedAt: 1 });
    await w.recallDeps.index.upsert([
      { id: listingId, values: vectorOf('plumber leak repair'), namespace, metadata: { v: LISTING_METADATA_VERSION, region: 'us-tx', scope: 'onsite', tier: 1, bloom: bloomOf(tokens), model: 'test' } },
    ]);
    const out = await recall(w.recallDeps, { ...planned.plan.intent, allOf: ['cert:tx-plumbing'] });
    if (!out.ok) throw new Error('recall failed');
    expect(out.finalists).toHaveLength(1);
    const states = calls.filter((c) => c.op === 'work-decide').map((c) => String(c.input.state));
    expect(states).toHaveLength(1);
    expect(states[0]).toContain('Certificates: tx plumbing; aaa 00;');
  });

  it('opens the gate to every recalled listing when no need passed the floor', async () => {
    const { w, plan } = await pool({
      'work-classify': requestAndNeeds({ plumber: 0.3, 'leak repair': 0.3 }),
      'work-decide': decides({ plumber: ['fit', 0.9], pipefitter: ['fit', 0.9], electrician: ['fit', 0.9], welder: ['fit', 0.9] }),
    });
    expect(plan.intent.anyOf).toEqual([]);
    const out = await recall(w.recallDeps, plan.intent);
    if (!out.ok) throw new Error('recall failed');
    expect(out.finalists).toHaveLength(4);
    expect(out.finalists.every((f) => f.gateTier === 1 && !f.fit?.promoted)).toBe(true);
  });

  it('tells Clef only the certificates the gate confirmed: a credential the seed cannot name is a person’s to check', async () => {
    const calls: FakeCall[] = [];
    const w = await world(
      {
        'work-classify': requestAndNeeds({ plumber: 0.9, 'leak repair': 0.9 }),
        'work-intent': jsonModeResult({ task: 'fix a leaking pipe under the sink', when: null, budget: null, credential: 'licensed plumber', language: null, recurrence: null }),
        'work-decide': decides({ plumber: ['fit', 0.9] }),
      },
      calls,
    );
    await publishListing(w.publish, draft('plumber', ['plumber'], ['leak repair']));
    const planned = await planHire(w.hire, { ...SENTENCE, sentence: 'Need a licensed plumber to fix a leaking pipe under the sink' });
    if (!planned.ok) throw new Error('no plan');
    expect(planned.plan.certificate).toBeNull();
    expect(planned.plan.intent.mode).toBe('curated');
    const out = await recall(w.recallDeps, planned.plan.intent);
    if (!out.ok) throw new Error('recall failed');
    const states = calls.filter((c) => c.op === 'work-decide').map((c) => String(c.input.state));
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((s) => !s.split('\n')[1]!.includes('Certificates'))).toBe(true);
  });

  it('counts an answer with no choice in it as a failed call, and keeps the gate’s tier', async () => {
    const { w, plan } = await pool({ 'work-decide': { answers: {}, usage: { input_tokens: 100 } } });
    const out = await recall(w.recallDeps, { ...plan.intent, mode: 'instant' });
    if (!out.ok) throw new Error('recall failed');
    expect((await who(w, out.finalists.map((f) => f.listingId))).sort()).toEqual(['pipefitter', 'plumber']);
    const decideCalls = out.calls.filter((c) => c.op === 'work-decide');
    expect(decideCalls).toHaveLength(4);
    expect(decideCalls.every((c) => !c.ok)).toBe(true);
  });

  it('stops at its time limit: a call still running is cancelled and keeps the gate’s tier, never promoted', async () => {
    // Clef answers the plumber at once and takes far longer than the limit for everyone else, until cancelled.
    const slow = (input: Record<string, unknown>, call: { signal?: AbortSignal }) => {
      const quick = /Occupations: plumber\./.test(String(input.state));
      const answer = { answers: { fit: { choice: 'fit', probabilities: { fit: 0.9 } } }, usage: { input_tokens: 200 } };
      if (quick) return answer;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(answer), 5_000);
        call.signal?.addEventListener('abort', () => (clearTimeout(t), reject(new Error('aborted'))), { once: true });
      });
    };
    const { w, plan } = await pool({ 'work-decide': slow });
    const logs: Record<string, unknown>[] = [];
    const t0 = Date.now();
    const out = await recall({ ...w.recallDeps, decideBudgetMs: 50, log: (f) => logs.push(f) }, { ...plan.intent, mode: 'instant' });
    if (!out.ok) throw new Error('recall failed');
    expect(Date.now() - t0).toBeLessThan(2_000);
    const byName = new Map([...(await w.listings.get(out.finalists.map((f) => f.listingId))).values()].map((r) => [r.listingId, r.pseudonym]));
    // The plumber decided; the pipefitter's call was cancelled, so its token hit stands; the misses were never promoted.
    expect(out.finalists.map((f) => [byName.get(f.listingId), f.gateTier, f.fit?.choice ?? null])).toEqual([
      ['plumber', 1, 'fit'],
      ['pipefitter', 1, null],
    ]);
    expect(out.calls.filter((c) => c.op === 'work-decide' && !c.ok)).toHaveLength(3);
    expect(logs.some((l) => l.event === 'work_decide_budget')).toBe(true);
  });

  it('keeps the gate’s tier where Clef fails, and runs no pass without the store', async () => {
    const { w, plan } = await pool({ 'work-decide': new Error('clef down') });
    const failed = await recall(w.recallDeps, { ...plan.intent, mode: 'instant' });
    if (!failed.ok) throw new Error('recall failed');
    expect((await who(w, failed.finalists.map((f) => f.listingId))).sort()).toEqual(['pipefitter', 'plumber']);
    expect(failed.finalists.every((f) => f.fit?.choice === null)).toBe(true);
    const calls: FakeCall[] = [];
    const without = await recall({ ...w.recallDeps, store: undefined, inference: fakeInference({ 'work-embed': embed }, calls) }, { ...plan.intent, mode: 'instant' });
    if (!without.ok) throw new Error('recall failed');
    expect(without.finalists.every((f) => f.fit === undefined)).toBe(true);
    expect(calls.some((c) => c.op === 'work-decide')).toBe(false);
  });
});
