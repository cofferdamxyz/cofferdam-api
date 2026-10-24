// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { BLOOM_BITS, bloomHas, bloomOf, bloomProbe } from '../src/services/work/bloom.js';
import type { BlockLang } from '../src/services/work/blocks.js';
import { hirerQuery, planHire, type HireDeps, type HirerRequest } from '../src/services/work/hire.js';
import {
  checkDraft,
  D1ListingStore,
  listingIdOf,
  namespaceOf,
  publishListing,
  unpublishListing,
  type ListingDraft,
  type PublishDeps,
} from '../src/services/work/listings.js';
import { namespacesFor, parseRemoteCountries, recall, RECALL_TOP_K, type RecallDeps, type RecallIntent } from '../src/services/work/recall.js';
import { WorkCallsError } from '../src/services/work/fields.js';
import { D1RegistryStore, labelIdOf, labelNorm, type RegistryDeps, type TokenKind } from '../src/services/work/registry.js';
import { sqliteD1 } from './fixtures/work/d1.js';
import { fakeInference, jsonModeResult, memoryIndex, type FakeCall, type FakeResponses } from './fixtures/work/fakes.js';

// ── A keyword embedder: one geometry for seed labels, listings and queries ──

const FEATURES: [RegExp, number][] = [
  [/electric|eletric/i, 0],
  [/plumb|encanad|plomer|sink|fregadero/i, 1],
  [/leak|vazament|fuga/i, 3],
  [/licen/i, 5],
  [/charger|carregador|cargador/i, 6],
  [/translat|tradu/i, 7],
  [/contract|contrato/i, 8],
];

function keywordVector(text: string): number[] {
  const v = new Array<number>(1024).fill(0);
  for (const [re, dim] of FEATURES) if (re.test(text)) v[dim]! += 1;
  v[1023] = 0.05;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

const keywordEmbed = (input: Record<string, unknown>) => {
  const texts = input.text as string[];
  return { data: texts.map(keywordVector), meta: { cost_metric_value_1: 8 * texts.length, neurons: 0.001 } };
};

const SEED: { token: string; kind: TokenKind; label: string }[] = [
  { token: 'pos:plumber', kind: 'pos', label: 'plumber' },
  { token: 'pos:electrician', kind: 'pos', label: 'electrician' },
  { token: 'pos:translator', kind: 'pos', label: 'translator' },
  { token: 'skill:leak-repair', kind: 'skill', label: 'leak repair' },
  { token: 'skill:ev-charger-installation', kind: 'skill', label: 'EV charger installation' },
  { token: 'skill:legal-translation', kind: 'skill', label: 'contract translation' },
  { token: 'cert:plumber-license:us-tx', kind: 'cert', label: 'Texas journeyman plumber license' },
];

async function world(responses: FakeResponses = {}, calls: FakeCall[] = []) {
  const db = sqliteD1();
  const registryIndex = memoryIndex();
  const jobsIndex = memoryIndex();
  const registryStore = new D1RegistryStore(db.d1);
  for (const s of SEED) {
    const norm = labelNorm(s.label);
    const labelId = await labelIdOf(s.token, 'en', norm);
    await registryStore.insertToken(
      { token: s.token, kind: s.kind, source: 'seed', labelEn: s.label, escoUri: null, iscoCode: null, status: 'active', mergedInto: null },
      [{ labelId, token: s.token, lang: 'en', label: s.label, labelNorm: norm, kind: 'preferred', embedded: true }],
      0,
    );
    await registryIndex.upsert([{ id: labelId, values: keywordVector(s.label), metadata: { token: s.token, kind: s.kind, lang: 'en', label: s.label, source: 'seed' } }]);
  }
  const inference = fakeInference({ 'work-embed': keywordEmbed, ...responses }, calls);
  const registry: RegistryDeps = { inference, store: registryStore, index: registryIndex, now: () => 1_000 };
  const listings = new D1ListingStore(db.d1);
  const publish: PublishDeps = { inference, registry, listings, index: jobsIndex, now: () => 2_000 };
  const recallDeps: RecallDeps = { inference, index: jobsIndex, listings };
  return { db, registryIndex, jobsIndex, listings, publish, recallDeps, hire: { registry, recall: recallDeps } as HireDeps };
}

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

describe('the Bloom filter', () => {
  it('holds its tokens in 344 characters, and rarely anything else', () => {
    const tokens = Array.from({ length: 40 }, (_, i) => `skill:token-${i}`);
    const filter = bloomOf(tokens);
    expect(filter).toHaveLength(344);
    expect(BLOOM_BITS / 8).toBe(256);
    for (const t of tokens) expect(bloomHas(filter, bloomProbe(t))).toBe(true);
    let falsePositives = 0;
    for (let i = 0; i < 20_000; i++) if (bloomHas(filter, bloomProbe(`skill:other-${i}`))) falsePositives++;
    expect(falsePositives / 20_000).toBeLessThan(0.001);
    expect(bloomHas('not base64!', bloomProbe('skill:token-1'))).toBe(false);
    expect(bloomHas(bloomOf([]), bloomProbe('skill:token-1'))).toBe(false);
  });
});

describe('namespaces and drafts', () => {
  it('names a namespace by region for on-site work and by country for remote work', () => {
    expect(namespaceOf('us-tx', 'onsite')).toBe('us-tx:onsite');
    expect(namespaceOf('mx-nle', 'remote')).toBe('mx:remote');
    expect(namespaceOf('br', 'remote', 'eval:')).toBe('eval:br:remote');
    const onsite: RecallIntent = { scope: 'onsite', regions: ['us-tx', 'us-la', 'us-tx'], queryText: 'x', allOf: [], anyOf: [], mode: 'instant' };
    expect(namespacesFor(onsite)).toEqual(['us-tx:onsite', 'us-la:onsite']);
    expect(namespacesFor({ ...onsite, scope: 'remote' }, ['us', 'mx'])).toEqual(['us:remote', 'mx:remote']);
    expect(namespacesFor({ ...onsite, regions: [] })).toBeNull();
    expect(namespacesFor({ ...onsite, regions: ['Texas'] })).toBeNull();
    expect(namespacesFor({ ...onsite, regions: Array.from({ length: 9 }, (_, i) => `us-a${i}`) })).toBeNull();
    expect(parseRemoteCountries('US, br,xx-1')).toEqual(['us', 'br']);
    expect(parseRemoteCountries(undefined)).toEqual(['us', 'br', 'mx']);
  });

  it('refuses a draft with a position, a contact, or no claims', () => {
    expect(checkDraft(draft({}))).toBeNull();
    expect(checkDraft(draft({ region: '29.76,-95.37' }))).toBe('bad_region');
    expect(checkDraft(draft({ skills: ['Call (713) 555-0142'] }))).toBe('refused_pattern');
    expect(checkDraft(draft({ titles: [], skills: [] }))).toBe('no_claims');
    expect(checkDraft(draft({ profileId: 'Main Profile' }))).toBe('bad_shape');
    expect(checkDraft(draft({ pseudonym: 'p'.repeat(65) }))).toBe('bad_shape');
    expect(checkDraft(draft({ languages: ['english'] }))).toBe('bad_shape');
    expect(checkDraft(draft({ lang: 'fr' as BlockLang }))).toBe('bad_lang');
  });

  it('keys a listing by pseudonym and profile', async () => {
    expect(await listingIdOf('p1', 'main')).toBe(await listingIdOf('p1', 'main'));
    expect(await listingIdOf('p1', 'main')).not.toBe(await listingIdOf('p1', 'other'));
    expect(await listingIdOf('p1', 'main')).toMatch(/^L[A-Za-z0-9_-]{43}$/);
  });
});

describe('publishListing', () => {
  it('snaps the claims, embeds the listing in its namespace with coarse metadata only, and keeps the exact tokens in D1', async () => {
    const { publish, jobsIndex, listings } = await world();
    const out = await publishListing(publish, draft({ certificates: ['Texas Journeyman Plumber License'], languages: ['en', 'es'] }));
    expect(out).toMatchObject({ ok: true, namespace: 'us-tx:onsite', tokens: ['cert:plumber-license:us-tx', 'lang:en', 'lang:es', 'pos:plumber', 'skill:leak-repair'] });
    if (!out.ok) return;
    const v = jobsIndex.vectors.get(out.listingId)!;
    expect(v.namespace).toBe('us-tx:onsite');
    expect(Object.keys(v.metadata).sort()).toEqual(['bloom', 'model', 'region', 'scope', 'tier', 'v']);
    expect(v.metadata).toMatchObject({ v: 1, region: 'us-tx', scope: 'onsite', tier: 1, model: '@cf/baai/bge-m3' });
    expect(JSON.stringify(v.metadata)).not.toMatch(/p1|main|Plumber/);
    const record = (await listings.get([out.listingId])).get(out.listingId)!;
    expect(record).toMatchObject({ pseudonym: 'p1', profileId: 'main', namespace: 'us-tx:onsite', tokens: out.tokens, publishedAt: 2_000 });
  });

  it('moves a republished listing to its new namespace, and turning it off deletes both', async () => {
    const { publish, jobsIndex, listings } = await world();
    const first = await publishListing(publish, draft({}));
    const moved = await publishListing(publish, draft({ region: 'us-la' }));
    expect(first.ok && moved.ok && first.listingId === moved.listingId).toBe(true);
    if (!moved.ok) return;
    expect([...jobsIndex.vectors.values()].map((v) => v.namespace)).toEqual(['us-la:onsite']);
    await unpublishListing(publish, 'p1', 'main');
    expect(jobsIndex.vectors.size).toBe(0);
    expect((await listings.get([moved.listingId])).size).toBe(0);
  });

  it('publishes nothing when the embedding fails, and refuses a bad draft before any call', async () => {
    const calls: FakeCall[] = [];
    const { publish, jobsIndex } = await world({}, calls);
    expect(await publishListing(publish, draft({ region: 'x' }))).toMatchObject({ ok: false, error: 'draft_refused', reason: 'bad_region' });
    expect(calls).toEqual([]);
    const broken = await world({ 'work-embed': new Error('down') });
    expect(await publishListing(broken.publish, draft({}))).toMatchObject({ ok: false, error: 'embedding_failed' });
    expect(jobsIndex.vectors.size).toBe(0);
  });
});

describe('recall', () => {
  async function published() {
    const w = await world();
    const ids: Record<string, string> = {};
    const add = async (name: string, d: Partial<ListingDraft>) => {
      const out = await publishListing(w.publish, draft(d));
      if (!out.ok) throw new Error(`${name} not published`);
      ids[name] = out.listingId;
    };
    await add('plumberTx', { pseudonym: 'p1', certificates: ['Texas Journeyman Plumber License'] });
    await add('plumberTxHelper', { pseudonym: 'p1', profileId: 'helper', titles: ["Plumber's Helper"], skills: ['leak repair'] });
    await add('electricianTx', { pseudonym: 'p2', titles: ['Journeyman Electrician'], skills: ['EV charger installation'], languages: ['en', 'es'] });
    await add('plumberMx', { pseudonym: 'p3', region: 'mx-nle', lang: 'es', titles: ['Plomero Oficial'], skills: ['Reparación de fugas'], languages: ['es'] });
    await add('translatorMx', { pseudonym: 'p4', region: 'mx', scope: 'remote', lang: 'es', titles: ['Traductora'], skills: ['Traducción de contratos'], languages: ['es', 'en'] });
    return { ...w, ids };
  }

  const sink: RecallIntent = { scope: 'onsite', regions: ['us-tx'], queryText: 'kitchen sink is leaking; plumber; leak repair', allOf: [], anyOf: ['pos:plumber', 'skill:leak-repair'], mode: 'instant' };

  it('fans out one query per namespace at Vectorize’s 50, gates by the Bloom filter, and keeps one listing per pseudonym', async () => {
    const { recallDeps, jobsIndex, ids } = await published();
    const out = await recall(recallDeps, { ...sink, regions: ['us-tx', 'us-la'] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(jobsIndex.queries.map((q) => [q.namespace, q.topK])).toEqual([
      ['us-tx:onsite', RECALL_TOP_K],
      ['us-la:onsite', RECALL_TOP_K],
    ]);
    expect(out.recalled).toBe(3);
    expect(out.finalists.map((f) => f.listingId)).toHaveLength(1);
    expect([ids.plumberTx, ids.plumberTxHelper]).toContain(out.finalists[0]!.listingId);
    expect(out.finalists[0]).toMatchObject({ gateTier: 1, personhood: 1, namespace: 'us-tx:onsite' });
    expect(out.finalists.some((f) => f.listingId === ids.electricianTx || f.listingId === ids.plumberMx)).toBe(false);
  });

  it('confirms a required certificate against the exact list, never the filter', async () => {
    const { recallDeps, db, ids } = await published();
    const licensed = { ...sink, allOf: ['cert:plumber-license:us-tx'], mode: 'curated' as const };
    const before = await recall(recallDeps, licensed);
    expect(before.ok && before.finalists.map((f) => f.listingId)).toEqual([ids.plumberTx]);
    // A filter that says yes while the exact list says no (a false positive) awards nothing.
    db.sqlite.prepare('UPDATE listings SET tokens = ? WHERE listing_id = ?').run('["pos:plumber","skill:leak-repair"]', ids.plumberTx!);
    const after = await recall(recallDeps, licensed);
    expect(after.ok && after.finalists).toEqual([]);
  });

  it('labels a vector-strong token miss tier 2 in Curated only', async () => {
    const { recallDeps } = await published();
    const drains = { ...sink, anyOf: ['skill:drain-cleaning'] };
    const instant = await recall(recallDeps, drains);
    expect(instant.ok && instant.finalists).toEqual([]);
    const curated = await recall(recallDeps, { ...drains, mode: 'curated' });
    expect(curated.ok && curated.finalists.map((f) => f.gateTier)).toEqual([2]);
  });

  it('finds remote work in every launch country’s remote namespace', async () => {
    const { recallDeps, ids, jobsIndex } = await published();
    const out = await recall(recallDeps, { scope: 'remote', regions: [], queryText: 'translate a contract; translator', allOf: ['lang:es'], anyOf: ['pos:translator', 'skill:legal-translation'], mode: 'instant' });
    expect(out.ok && out.finalists.map((f) => f.listingId)).toEqual([ids.translatorMx]);
    expect(jobsIndex.queries.map((q) => q.namespace)).toEqual(['us:remote', 'br:remote', 'mx:remote']);
  });

  it('drops a listing whose record is gone, and refuses an intent with no namespace', async () => {
    const { recallDeps, db } = await published();
    db.sqlite.prepare('DELETE FROM listings').run();
    const out = await recall(recallDeps, sink);
    expect(out.ok && out.finalists).toEqual([]);
    expect(await recall(recallDeps, { ...sink, regions: [] })).toMatchObject({ ok: false, error: 'bad_intent' });
  });
});

describe('one hirer query', () => {
  const intentAnswer = (over: Record<string, unknown> = {}) =>
    jsonModeResult({ task: 'kitchen sink is leaking under the cabinet', when: 'today after 2pm', budget: 120, credential: null, language: null, recurrence: null, ...over });
  /** Clef: the safety checks it is given, the scope, and yes to every candidate whose label mentions the words given. */
  const clefSays = (yes: RegExp, scope = 'onsite', safety: { harmful?: number; injection?: number } = {}) => (input: Record<string, unknown>) => {
    const questions = input.questions as Record<string, { instructions: string }>;
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (id === 'scope') answers[id] = { type: 'choice', choice: scope, probabilities: { [scope]: 0.93 } };
      else if (id === 'harmful' || id === 'injection') answers[id] = { type: 'noul', noul: safety[id] ?? 0.02 };
      else if (id.startsWith('need_')) answers[id] = { type: 'noul', noul: yes.test(q.instructions) ? 0.9 : 0.05 };
    }
    return { answers, usage: { input_tokens: 300 } };
  };
  const SINK = 'My kitchen sink is leaking under the cabinet, need someone today after 2pm. I’ll pay $120.';

  it('plans the sink job as an Instant on-site intent that needs a plumber', async () => {
    const calls: FakeCall[] = [];
    const w = await world({ 'work-intent': intentAnswer(), 'work-classify': clefSays(/plumber|leak/) }, calls);
    const planned = await planHire(w.hire, { sentence: SINK, lang: 'en', regions: ['us-tx'] });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan).toMatchObject({ scope: 'onsite', certificate: null, language: null, missing: [] });
    expect(planned.plan.intent).toMatchObject({ mode: 'instant', allOf: [], regions: ['us-tx'] });
    expect(planned.plan.intent.anyOf.sort()).toEqual(['pos:plumber', 'skill:leak-repair']);
    const clefCall = calls.find((c) => c.op === 'work-classify')!.input as { questions: Record<string, unknown>; state: string };
    expect(clefCall.state).toContain('sink is leaking');
    expect(Object.keys(clefCall.questions)).toEqual(['harmful', 'injection', 'scope']);
    const needsCall = calls.filter((c) => c.op === 'work-classify')[1]!.input as { questions: Record<string, unknown> };
    expect(Object.keys(needsCall.questions).every((k) => k.startsWith('need_'))).toBe(true);
    expect(calls.map((c) => c.op)).not.toContain('work-pivot');
  });

  it('finds the plumber in Texas, and only one of their listings', async () => {
    const w = await world({ 'work-intent': intentAnswer(), 'work-classify': clefSays(/plumber|leak/) });
    for (const d of [draft({ certificates: ['Texas Journeyman Plumber License'] }), draft({ pseudonym: 'p2', titles: ['Journeyman Electrician'], skills: ['EV charger installation'] })]) {
      expect((await publishListing(w.publish, d)).ok).toBe(true);
    }
    const out = await hirerQuery(w.hire, { sentence: SINK, lang: 'en', regions: ['us-tx'] });
    expect(out.ok && out.recall.ok && out.recall.finalists.map((f) => f.matched.sort())).toEqual([['pos:plumber', 'skill:leak-repair']]);
  });

  it('requires the credential exactly, never mints from a hirer’s words, and goes Curated', async () => {
    const calls: FakeCall[] = [];
    const w = await world({ 'work-intent': intentAnswer({ credential: 'licensed plumber' }), 'work-classify': clefSays(/plumber/) }, calls);
    const planned = await planHire(w.hire, { sentence: `${SINK} Must be a licensed plumber.`, lang: 'en', regions: ['us-tx'] });
    expect(planned.ok && planned.plan).toMatchObject({ certificate: 'cert:plumber-license:us-tx', intent: { mode: 'curated', allOf: ['cert:plumber-license:us-tx'] } });
    const unknown = await world({ 'work-intent': intentAnswer({ credential: 'certified welder' }), 'work-classify': clefSays(/plumber/) }, calls);
    const noCert = await planHire(unknown.hire, { sentence: `${SINK} Must be a certified welder.`, lang: 'en', regions: ['us-tx'] });
    expect(noCert.ok && noCert.plan.certificate).toBeNull();
    // A credential the registry cannot name is still a requirement: a person checks it.
    expect(noCert.ok && noCert.plan.intent.mode).toBe('curated');
    expect(calls.map((c) => c.op)).not.toContain('work-pivot');
  });

  it('checks the sentence, its language and its regions before any hosted call', async () => {
    const calls: FakeCall[] = [];
    const w = await world({ 'work-intent': intentAnswer(), 'work-classify': clefSays(/plumber/) }, calls);
    const ask = (over: Partial<HirerRequest>) => planHire(w.hire, { sentence: SINK, lang: 'en', regions: ['us-tx'], ...over });
    const dash = String.fromCharCode(0x2011);
    expect(await ask({ sentence: `${SINK} Call me at (713) 555-0142.` })).toMatchObject({ ok: false, error: 'text_refused', reason: 'long_number' });
    expect(await ask({ sentence: `${SINK} Text 713${dash}555${dash}0142.` })).toMatchObject({ ok: false, error: 'text_refused', reason: 'long_number' });
    expect(await ask({ sentence: `${SINK} Details at joaosilva.com.br` })).toMatchObject({ ok: false, error: 'text_refused', reason: 'url' });
    expect(await ask({ sentence: '   ' })).toMatchObject({ ok: false, error: 'text_refused', reason: 'empty' });
    expect(await ask({ sentence: 'x'.repeat(1_001) })).toMatchObject({ ok: false, error: 'text_refused', reason: 'too_long' });
    expect(await ask({ lang: 'fr' as BlockLang })).toMatchObject({ ok: false, error: 'bad_request', reason: 'lang' });
    for (const regions of [[], ['29.76,-95.37'], Array.from({ length: 9 }, (_, i) => `us-a${i}`)]) {
      expect(await ask({ regions })).toMatchObject({ ok: false, error: 'bad_request', reason: 'regions' });
    }
    expect(calls).toEqual([]);
  });

  it('stops when Clef answers none of the needs, and goes Curated when the job needs none of them', async () => {
    const safeOnly = (input: Record<string, unknown>) => {
      const questions = input.questions as Record<string, unknown>;
      return 'harmful' in questions
        ? { answers: { harmful: { noul: 0.01 }, injection: { noul: 0.01 }, scope: { choice: 'onsite', probabilities: { onsite: 0.9 } } } }
        : { answers: {} };
    };
    const silent = await world({ 'work-intent': intentAnswer(), 'work-classify': safeOnly });
    const stopped = await planHire(silent.hire, { sentence: SINK, lang: 'en', regions: ['us-tx'] });
    expect(stopped).toMatchObject({ ok: false, error: 'classification_failed' });
    // Both Clef calls reported no tokens: each is metered at its estimated input, and the unanswered one failed.
    expect(stopped.calls.filter((c) => c.op === 'work-classify').map((c) => [c.ok, c.usage.tokensIn > 0])).toEqual([
      [true, true],
      [false, true],
    ]);
    const none = await world({ 'work-intent': intentAnswer(), 'work-classify': clefSays(/nothing here/) });
    const planned = await planHire(none.hire, { sentence: SINK, lang: 'en', regions: ['us-tx'] });
    expect(planned.ok && planned.plan.intent).toMatchObject({ anyOf: [], mode: 'curated' });
    const klingon = await world({ 'work-intent': intentAnswer({ language: 'Klingon' }), 'work-classify': clefSays(/plumber/) });
    const unnamed = await planHire(klingon.hire, { sentence: `${SINK} Must speak Klingon.`, lang: 'en', regions: ['us-tx'] });
    expect(unnamed.ok && unnamed.plan).toMatchObject({ language: null, intent: { mode: 'curated' } });
    // A requirement the hirer stated but the model rewrote (not a span of the sentence) is dropped, and still counts.
    for (const over of [{ credential: 'plumber license' }, { language: 'the Spanish language' }]) {
      const rewritten = await world({ 'work-intent': intentAnswer(over), 'work-classify': clefSays(/plumber|leak/) });
      const sentence = `${SINK} Must be a licensed plumber who speaks Spanish.`;
      const plan = await planHire(rewritten.hire, { sentence, lang: 'en', regions: ['us-tx'] });
      expect(plan.ok && plan.plan.intent, JSON.stringify(over)).toMatchObject({ mode: 'curated' });
      expect(plan.ok && plan.plan.fields.credential).toBeNull();
    }
  });

  it('carries every hosted call on a store or index failure, so the route can still meter them', async () => {
    const ops = (e: unknown) => (e instanceof WorkCallsError ? e.calls.map((c) => c.op) : e);
    const down = (what: string) => async () => {
      throw new Error(`${what} down`);
    };
    // Publish: the claims snapped and the listing embedded, then the record write failed.
    const p = await world();
    p.listings.put = down('d1');
    const published = ops(await publishListing(p.publish, draft({})).catch((e: unknown) => e)) as string[];
    expect(published.filter((op) => op === 'work-embed').length).toBeGreaterThanOrEqual(2);
    // The plan: the request checks, the parse and the task's embedding ran, then the registry's index failed.
    const h = await world({ 'work-intent': intentAnswer(), 'work-classify': clefSays(/plumber/) });
    h.registryIndex.query = down('vectorize');
    expect(ops(await planHire(h.hire, { sentence: SINK, lang: 'en', regions: ['us-tx'] }).catch((e: unknown) => e))).toEqual([
      'work-classify',
      'work-intent',
      'work-embed',
    ]);
    // The whole query: the plan's calls and recall's embedding, then the listing read failed.
    const q = await world({ 'work-intent': intentAnswer(), 'work-classify': clefSays(/plumber|leak/) });
    expect((await publishListing(q.publish, draft({}))).ok).toBe(true);
    q.listings.get = down('d1');
    expect(ops(await hirerQuery(q.hire, { sentence: SINK, lang: 'en', regions: ['us-tx'] }).catch((e: unknown) => e))).toEqual([
      'work-classify',
      'work-intent',
      'work-embed',
      'work-classify',
      'work-embed',
    ]);
  });

  it('meters a Clef call that threw at its estimated input', async () => {
    const down = await world({ 'work-intent': intentAnswer(), 'work-classify': new Error('down') });
    const out = await planHire(down.hire, { sentence: SINK, lang: 'en', regions: ['us-tx'] });
    expect(out).toMatchObject({ ok: false, error: 'classification_failed' });
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]).toMatchObject({ op: 'work-classify', ok: false });
    expect(out.calls[0]!.usage.tokensIn).toBeGreaterThan(50);
  });

  it('refuses a harmful request or an injection before anything is extracted, and stops when Clef is silent', async () => {
    for (const [safety, reason] of [[{ harmful: 0.91 }, 'harmful'], [{ injection: 0.88 }, 'injection']] as const) {
      const calls: FakeCall[] = [];
      const w = await world({ 'work-intent': intentAnswer(), 'work-classify': clefSays(/plumber/, 'onsite', safety) }, calls);
      expect(await planHire(w.hire, { sentence: SINK, lang: 'en', regions: ['us-tx'] })).toMatchObject({ ok: false, error: 'refused', reason });
      expect(calls.map((c) => c.op)).toEqual(['work-classify']);
      const questions = Object.keys((calls[0]!.input as { questions: object }).questions);
      expect(questions).toEqual(['harmful', 'injection', 'scope']);
    }
    const calls: FakeCall[] = [];
    const silent = await world({ 'work-intent': intentAnswer(), 'work-classify': new Error('down') }, calls);
    expect(await planHire(silent.hire, { sentence: SINK, lang: 'en', regions: ['us-tx'] })).toMatchObject({ ok: false, error: 'classification_failed' });
    expect(calls.map((c) => c.op)).toEqual(['work-classify']);
    const halfAnswered = await world({ 'work-intent': intentAnswer(), 'work-classify': { answers: { harmful: { noul: 0.01 } } } });
    expect(await planHire(halfAnswered.hire, { sentence: SINK, lang: 'en', regions: ['us-tx'] })).toMatchObject({ ok: false, error: 'classification_failed' });
  });

  it('refuses a budget under $50, asks for what is missing, and reads remote work', async () => {
    const low = await world({ 'work-intent': intentAnswer({ budget: 30 }), 'work-classify': clefSays(/plumber/) });
    expect(await planHire(low.hire, { sentence: SINK, lang: 'en', regions: ['us-tx'] })).toMatchObject({ ok: false, error: 'below_minimum' });
    const open = await world({ 'work-intent': intentAnswer({ budget: null, when: null }), 'work-classify': clefSays(/plumber/) });
    const planned = await planHire(open.hire, { sentence: 'My kitchen sink is leaking under the cabinet.', lang: 'en', regions: ['us-tx'] });
    expect(planned.ok && planned.plan.missing).toEqual(['budget', 'when']);
    const remote = await world({
      'work-intent': jsonModeResult({ task: 'translate a 12-page contract', when: 'by Monday', budget: 150, credential: null, language: 'Spanish', recurrence: null }),
      'work-classify': clefSays(/translat/, 'remote'),
    });
    const r = await planHire(remote.hire, { sentence: 'Someone fluent in Spanish to translate a 12-page contract by Monday, $150.', lang: 'en', regions: ['us-tx'] });
    expect(r.ok && r.plan.intent).toMatchObject({ scope: 'remote', allOf: ['lang:es'], mode: 'instant' });
  });
});
