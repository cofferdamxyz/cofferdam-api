// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  D1RegistryStore,
  DEFAULT_TAU,
  DEFAULT_TAU_BY_MODEL,
  EMBED_DIMS_BY_MODEL,
  EMBED_PROMPTS_BY_MODEL,
  embedTexts,
  labelIdOf,
  labelLangs,
  labelNorm,
  parseTau,
  snap,
  tauFor,
  tokenOf,
  tokenSlug,
  validPivot,
  type Candidate,
  type LabelKind,
  type RegistryDeps,
  type RegistryLabel,
  type TokenKind,
} from '../src/services/work/registry.js';
import { adjudicationQuestions } from '../src/services/work/clef.js';
import type { InferenceOp } from '../src/services/inference/index.js';
import { WorkCallsError } from '../src/services/work/fields.js';
import { sqliteD1 } from './fixtures/work/d1.js';
import { axis, embedAnswer, fakeInference, jsonModeResult, memoryIndex, near, type FakeCall, type FakeResponses } from './fixtures/work/fakes.js';

const NOW = Date.parse('2026-10-24T12:00:00Z');

interface SeedToken {
  token: string;
  kind: TokenKind;
  labelEn: string;
  /** A label is preferred unless it names its kind. */
  labels: [lang: string, label: string, vector: number[], kind?: LabelKind][];
}

const SEED: SeedToken[] = [
  { token: 'pos:electrician', kind: 'pos', labelEn: 'electrician', labels: [['en', 'electrician', axis(0)], ['pt', 'eletricista', near(0, 9, 0.99)]] },
  { token: 'pos:plumber', kind: 'pos', labelEn: 'plumber', labels: [['en', 'plumber', axis(1)], ['es', 'plomero', near(1, 9, 0.99)]] },
  { token: 'pos:welder', kind: 'pos', labelEn: 'welder', labels: [['en', 'welder', axis(2)]] },
  { token: 'skill:leak-repair', kind: 'skill', labelEn: 'leak repair', labels: [['en', 'leak repair', axis(3)]] },
  { token: 'cert:bosiet', kind: 'cert', labelEn: 'BOSIET', labels: [['en', 'BOSIET', axis(4)]] },
];

async function registry(responses: FakeResponses = {}, calls: FakeCall[] = [], extra: SeedToken[] = [], models: Partial<Record<InferenceOp, string>> = {}) {
  const db = sqliteD1();
  const store = new D1RegistryStore(db.d1);
  const index = memoryIndex();
  for (const t of [...SEED, ...extra]) {
    const labels: RegistryLabel[] = [];
    for (const [lang, label, , kind = 'preferred'] of t.labels) {
      labels.push({ labelId: await labelIdOf(t.token, lang, labelNorm(label)), token: t.token, lang, label, labelNorm: labelNorm(label), kind, embedded: true });
    }
    expect(await store.insertToken({ token: t.token, kind: t.kind, source: 'seed', labelEn: t.labelEn, escoUri: null, iscoCode: null, status: 'active', mergedInto: null }, labels, 0)).toBe(true);
    await index.upsert(labels.map((l, i) => ({ id: l.labelId, values: t.labels[i]![2], metadata: { token: t.token, kind: t.kind, lang: l.lang, label: l.label, source: 'seed' } })));
  }
  let n = 0;
  const deps: RegistryDeps = { inference: fakeInference(responses, calls, models), store, index, now: () => NOW, newId: () => `d${++n}` };
  const decisions = () => db.sqlite.prepare('SELECT decision, token, specialization, probability, raw FROM registry_decisions ORDER BY id').all();
  return { deps, store, index, db, decisions };
}

const clef = (choice: string, p: number, specialization = 0.1) => ({
  model: 'clef-flash',
  answers: { match: { type: 'choice', choice, probabilities: { [choice]: p } }, specialization: { type: 'noul', noul: specialization } },
  usage: { input_tokens: 180 },
});

describe('the token shape', () => {
  it('is lower case, folded, hyphenated and prefixed', () => {
    expect(tokenSlug('Marine Engineer')).toBe('marine-engineer');
    expect(tokenOf('skill', 'Soldagem TIG')).toBe('skill:soldagem-tig');
    expect(tokenOf('pos', "Plumber's helper")).toBe('pos:plumber-s-helper');
    expect(tokenSlug('x'.repeat(80)).length).toBeLessThanOrEqual(56);
    expect(labelNorm('  Eletricista   de Manutenção! ')).toBe('eletricista de manutencao');
  });

  it('gives each label a stable id a Vectorize id can hold', async () => {
    const id = await labelIdOf('pos:plumber', 'es', 'plomero');
    expect(id).toBe(await labelIdOf('pos:plumber', 'es', 'plomero'));
    expect(id).not.toBe(await labelIdOf('pos:plumber', 'pt', 'plomero'));
    expect(id).toMatch(/^l[A-Za-z0-9_-]{43}$/);
  });

  it('keeps τ ordered and inside (0, 1], and takes what the environment leaves from the model', () => {
    expect(parseTau(undefined, undefined)).toEqual({});
    expect(parseTau('0.9', '0.7')).toEqual({ auto: 0.9, low: 0.7 });
    expect(parseTau('2', 'x')).toEqual({});
    const bge = '@cf/baai/bge-m3';
    const gemma = '@cf/google/embeddinggemma-300m';
    expect(tauFor(bge)).toEqual(DEFAULT_TAU);
    expect(tauFor(gemma)).toEqual(DEFAULT_TAU_BY_MODEL[gemma]);
    expect(tauFor('@cf/some/other-model')).toEqual(DEFAULT_TAU);
    expect(tauFor(bge, parseTau('0.9', '0.7'))).toEqual({ auto: 0.9, low: 0.7 });
    expect(tauFor(bge, parseTau('0.9', undefined))).toEqual({ auto: 0.9, low: DEFAULT_TAU.low });
    // A pair with low not below auto keeps the model's.
    expect(tauFor(bge, parseTau('0.6', '0.7'))).toEqual(DEFAULT_TAU);
    expect(tauFor(gemma, parseTau(undefined, '0.99'))).toEqual(DEFAULT_TAU_BY_MODEL[gemma]);
  });

  it('takes a pivot only as a short plain English name', () => {
    expect(validPivot(' Marine Engineer ')).toBe('marine engineer');
    expect(validPivot("plumber's helper")).toBe("plumber's helper");
    for (const bad of ['ingeniero marino 3', 'pos:marine-engineer', 'a', 'one two three four five six seven', 'ingénieur']) expect(validPivot(bad), bad).toBeNull();
  });
});

describe('the registry in D1', () => {
  it('enforces where codes come from and how a merge is written', () => {
    const { sqlite } = sqliteD1();
    const insert = (token: string, kind: string, source: string, esco: string | null, isco: string | null, status = 'active', merged: string | null = null) =>
      sqlite
        .prepare('INSERT INTO registry_tokens (token, kind, source, label_en, esco_uri, isco_code, status, merged_into, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)')
        .run(token, kind, source, token, esco, isco, status, merged);
    expect(() => insert('cert:x', 'cert', 'emergent', null, null)).toThrow(/CHECK/);
    expect(() => insert('pos:a', 'pos', 'esco', null, '9990')).toThrow(/CHECK/);
    expect(() => insert('pos:b', 'pos', 'esco', 'http://data.europa.eu/esco/occupation/test-b', '99')).toThrow(/CHECK/);
    expect(() => insert('pos:c', 'pos', 'seed', null, null, 'merged', null)).toThrow(/CHECK/);
    insert('pos:d', 'pos', 'esco', 'http://data.europa.eu/esco/occupation/test-d', '9990');
    expect(() => insert('pos:e', 'pos', 'esco', 'http://data.europa.eu/esco/occupation/test-d', '9990')).toThrow(/UNIQUE/);
  });

  it('follows merges to the live token, and refuses a second token of one name', async () => {
    const { store, db } = await registry();
    db.sqlite.prepare("INSERT INTO registry_tokens VALUES ('pos:electricista', 'pos', 'emergent', 'electricista', NULL, NULL, 'merged', 'pos:electrician', 0, 0)").run();
    const found = await store.tokens(['pos:electricista', 'pos:none']);
    expect([...found.entries()].map(([k, v]) => [k, v.token])).toEqual([['pos:electricista', 'pos:electrician']]);
    expect(await store.insertToken({ token: 'pos:plumber', kind: 'pos', source: 'seed', labelEn: 'x', escoUri: null, iscoCode: null, status: 'active', mergedInto: null }, [], 1)).toBe(false);
  });
});

describe('snap: retrieve, then choose', () => {
  it('snaps a known label without a model', async () => {
    const calls: FakeCall[] = [];
    const { deps } = await registry({}, calls);
    expect(await snap(deps, { kind: 'pos', raw: 'Eletricista', lang: 'pt' })).toMatchObject({ decision: 'label', token: 'pos:electrician', labelEn: 'electrician' });
    expect(calls).toEqual([]);
  });

  it('takes the best candidate at or above τ_auto, and knows the string next time', async () => {
    const calls: FakeCall[] = [];
    const { deps, decisions } = await registry({ 'work-embed': embedAnswer({ 'Journeyman Electrician': near(0, 10, 0.97) }) }, calls);
    const first = await snap(deps, { kind: 'pos', raw: 'Journeyman Electrician', lang: 'en' });
    expect(first).toMatchObject({ decision: 'auto', token: 'pos:electrician' });
    expect(first.candidates[0]).toMatchObject({ token: 'pos:electrician', matched: 'electrician' });
    expect(first.score).toBeCloseTo(0.97, 5);
    expect(calls.map((c) => c.op)).toEqual(['work-embed']);
    expect(await snap(deps, { kind: 'pos', raw: 'journeyman  electrician', lang: 'en' })).toMatchObject({ decision: 'label', token: 'pos:electrician' });
    expect(decisions()).toEqual([{ decision: 'auto', token: 'pos:electrician', specialization: 0, probability: null, raw: 'Journeyman Electrician' }]);
  });

  it('lets Clef choose in the band, with the candidates by key and a specialization flag', async () => {
    const calls: FakeCall[] = [];
    const { deps } = await registry({ 'work-embed': embedAnswer({ 'marine electrician': near(0, 10, 0.91) }), 'work-adjudicate': clef('c0', 0.88, 0.83) }, calls);
    const out = await snap(deps, { kind: 'pos', raw: 'marine electrician', lang: 'en' });
    expect(out).toMatchObject({ decision: 'chosen', token: 'pos:electrician', specialization: true, probability: 0.88 });
    const clefInput = calls.find((c) => c.op === 'work-adjudicate')!.input as { model: string; state: string; questions: { match: { criteria: Record<string, string> } } };
    expect(clefInput.model).toBe('clef-flash');
    expect(clefInput.state).toContain('marine electrician');
    expect(Object.keys(clefInput.questions.match.criteria)[0]).toBe('c0');
    expect(clefInput.questions.match.criteria.none).toMatch(/different occupation/);
    expect(JSON.stringify(clefInput)).not.toMatch(/esco|isco/i);
  });

  it('mints a pending occupation when Clef chooses none, through the English pivot, and finds it by label and vector after', async () => {
    const calls: FakeCall[] = [];
    const { deps, store, index } = await registry(
      {
        'work-embed': embedAnswer({ 'Confeiteiro': near(1, 11, 0.62), 'pastry chef': axis(12) }),
        'work-adjudicate': clef('none', 0.9),
        'work-pivot': jsonModeResult({ english: 'Pastry Chef' }),
      },
      calls,
    );
    const out = await snap(deps, { kind: 'pos', raw: 'Confeiteiro', lang: 'pt' });
    expect(out).toMatchObject({ decision: 'minted', token: 'pos:pastry-chef', labelEn: 'pastry chef' });
    expect(calls.map((c) => c.op)).toEqual(['work-embed', 'work-adjudicate', 'work-pivot', 'work-embed']);
    const minted = (await store.tokens(['pos:pastry-chef'])).get('pos:pastry-chef');
    expect(minted).toMatchObject({ source: 'emergent', status: 'pending', iscoCode: null, escoUri: null });
    expect([...index.vectors.values()].filter((v) => v.metadata.token === 'pos:pastry-chef').map((v) => v.metadata.lang).sort()).toEqual(['en', 'pt']);
    expect(await snap(deps, { kind: 'pos', raw: 'confeiteiro', lang: 'pt' })).toMatchObject({ decision: 'label', token: 'pos:pastry-chef' });
  });

  it('reads τ on the pinned model\'s scale: a cosine of 0.85 snaps under EmbeddingGemma and goes to Clef under bge-m3', async () => {
    const at85 = (dims: number) => near(0, 10, 0.85).slice(0, dims);
    const gemma = await registry({ 'work-embed': embedAnswer({ 'task: search result | query: house wireman': at85(768) }) }, [], [], { 'work-embed': '@cf/google/embeddinggemma-300m' });
    expect(await snap(gemma.deps, { kind: 'pos', raw: 'house wireman', lang: 'en' })).toMatchObject({ decision: 'auto', token: 'pos:electrician' });
    const calls: FakeCall[] = [];
    const bge = await registry({ 'work-embed': embedAnswer({ 'house wireman': at85(1024) }), 'work-adjudicate': clef('c0', 0.9) }, calls);
    expect(await snap(bge.deps, { kind: 'pos', raw: 'house wireman', lang: 'en' })).toMatchObject({ decision: 'chosen', token: 'pos:electrician' });
    expect(calls.map((c) => c.op)).toEqual(['work-embed', 'work-adjudicate']);
  });

  it("under EmbeddingGemma, embeds the snapped string as a query and a new token's labels again as documents", async () => {
    const calls: FakeCall[] = [];
    const QUERY = 'task: search result | query: ';
    const DOC = 'title: none | text: ';
    // The seed's vectors are 1024 axes; EmbeddingGemma answers 768, the same axes cut short.
    const cut = (v: number[]) => v.slice(0, 768);
    const table: Record<string, number[]> = {
      [`${QUERY}Confeiteiro`]: cut(near(1, 11, 0.62)),
      [`${DOC}pastry chef`]: cut(axis(12)),
      [`${DOC}Confeiteiro`]: cut(axis(13)),
    };
    const { deps, index } = await registry(
      { 'work-embed': embedAnswer(table), 'work-adjudicate': clef('none', 0.9), 'work-pivot': jsonModeResult({ english: 'Pastry Chef' }) },
      calls,
      [],
      { 'work-embed': '@cf/google/embeddinggemma-300m' },
    );
    const out = await snap({ ...deps, tau: { auto: 0.95, low: 0.5 } }, { kind: 'pos', raw: 'Confeiteiro', lang: 'pt' });
    expect(out).toMatchObject({ decision: 'minted', token: 'pos:pastry-chef' });
    expect(calls.filter((c) => c.op === 'work-embed').map((c) => c.input.text)).toEqual([[`${QUERY}Confeiteiro`], [`${DOC}pastry chef`, `${DOC}Confeiteiro`]]);
    // The raw string's label holds its document vector, not the query's.
    const stored = [...index.vectors.values()].filter((v) => v.metadata.token === 'pos:pastry-chef');
    expect(stored.find((v) => v.metadata.lang === 'pt')!.values).toEqual(table[`${DOC}Confeiteiro`]);
    expect(stored.find((v) => v.metadata.lang === 'en')!.values).toEqual(table[`${DOC}pastry chef`]);
  });

  it('marks a minted label embedded only once its vector is in the index', async () => {
    // No fake embedding for "pastry chef": the pivot's own vector fails.
    const { deps, db, index } = await registry({
      'work-embed': embedAnswer({ 'Confeiteiro': near(1, 11, 0.62) }),
      'work-adjudicate': clef('none', 0.9),
      'work-pivot': jsonModeResult({ english: 'Pastry Chef' }),
    });
    expect(await snap(deps, { kind: 'pos', raw: 'Confeiteiro', lang: 'pt' })).toMatchObject({ decision: 'minted', token: 'pos:pastry-chef' });
    const rows = db.sqlite.prepare("SELECT lang, embedded FROM registry_labels WHERE token = 'pos:pastry-chef' ORDER BY lang").all();
    expect(rows).toEqual([
      { lang: 'en', embedded: 0 },
      { lang: 'pt', embedded: 1 },
    ]);
    expect([...index.vectors.values()].filter((v) => v.metadata.token === 'pos:pastry-chef').map((v) => v.metadata.lang)).toEqual(['pt']);
  });

  it("under EmbeddingGemma, a mint whose document call fails stores no vector and marks no label embedded, never the query's vector in their place", async () => {
    const QUERY = 'task: search result | query: ';
    // Only the query has a fake embedding, so the call for the new labels as documents fails.
    const { deps, db, index } = await registry(
      { 'work-embed': embedAnswer({ [`${QUERY}Confeiteiro`]: near(1, 11, 0.62).slice(0, 768) }), 'work-adjudicate': clef('none', 0.9), 'work-pivot': jsonModeResult({ english: 'Pastry Chef' }) },
      [],
      [],
      { 'work-embed': '@cf/google/embeddinggemma-300m' },
    );
    expect(await snap({ ...deps, tau: { auto: 0.95, low: 0.5 } }, { kind: 'pos', raw: 'Confeiteiro', lang: 'pt' })).toMatchObject({ decision: 'minted', token: 'pos:pastry-chef' });
    expect(db.sqlite.prepare("SELECT lang, embedded FROM registry_labels WHERE token = 'pos:pastry-chef' ORDER BY lang").all()).toEqual([
      { lang: 'en', embedded: 0 },
      { lang: 'pt', embedded: 0 },
    ]);
    expect([...index.vectors.values()].filter((v) => v.metadata.token === 'pos:pastry-chef')).toEqual([]);
  });

  it('mints only on Clef’s own none at its floor: an empty or unknown answer in the band is no token', async () => {
    for (const answer of [{ answers: {} }, { answers: { match: { choice: 'c9', probabilities: { c9: 0.9 } } } }]) {
      const calls: FakeCall[] = [];
      const { deps, decisions } = await registry(
        { 'work-embed': embedAnswer({ 'Confeiteiro': near(1, 11, 0.62) }), 'work-adjudicate': answer, 'work-pivot': jsonModeResult({ english: 'pastry chef' }) },
        calls,
      );
      const out = await snap(deps, { kind: 'pos', raw: 'Confeiteiro', lang: 'pt' });
      expect(out, JSON.stringify(answer)).toMatchObject({ decision: 'unmatched', token: null });
      expect(calls.map((c) => c.op)).toEqual(['work-embed', 'work-adjudicate']);
      // A Clef call that reported no tokens is metered at its estimated input.
      expect(out.calls[1]!.usage.tokensIn).toBeGreaterThan(0);
      expect(out.calls[1]!.ok).toBe(false);
      expect(decisions()).toMatchObject([{ decision: 'unmatched', token: null }]);
    }
  });

  it('lets an answer below the floor reach an existing token through the pivot, and never mint', async () => {
    for (const answer of [clef('none', 0.4), clef('c0', 0.3)]) {
      const calls: FakeCall[] = [];
      const fresh = await registry(
        { 'work-embed': embedAnswer({ 'Confeiteiro': near(1, 11, 0.62) }), 'work-adjudicate': answer, 'work-pivot': jsonModeResult({ english: 'pastry chef' }) },
        calls,
      );
      const out = await snap(fresh.deps, { kind: 'pos', raw: 'Confeiteiro', lang: 'pt' });
      expect(out, JSON.stringify(answer)).toMatchObject({ decision: 'unmatched', token: null });
      expect(calls.map((c) => c.op)).toEqual(['work-embed', 'work-adjudicate', 'work-pivot']);
      expect((await fresh.store.tokens(['pos:pastry-chef'])).size).toBe(0);
      expect(fresh.decisions()).toMatchObject([{ decision: 'unmatched', token: null, probability: answer.answers.match.probabilities[answer.answers.match.choice] }]);
      const known = await registry({ 'work-embed': embedAnswer({ 'Encanador': near(1, 11, 0.62) }), 'work-adjudicate': answer, 'work-pivot': jsonModeResult({ english: 'plumber' }) });
      expect(await snap(known.deps, { kind: 'pos', raw: 'Encanador', lang: 'pt' })).toMatchObject({ decision: 'pivot', token: 'pos:plumber' });
    }
  });

  it('snaps to an existing token when the pivot names one', async () => {
    const { deps } = await registry({ 'work-embed': embedAnswer({ 'Encanador': near(1, 11, 0.5) }), 'work-pivot': jsonModeResult({ english: 'plumber' }) });
    expect(await snap(deps, { kind: 'pos', raw: 'Encanador', lang: 'pt' })).toMatchObject({ decision: 'pivot', token: 'pos:plumber' });
  });

  it('lets the pivot snap to the one token that holds its English name as a label, where no slug names it, and mints nothing', async () => {
    // As in ESCO: "truck driver" is an alternative label of the cargo vehicle driver, and no token is pos:truck-driver.
    const driver: SeedToken = {
      token: 'pos:cargo-vehicle-driver',
      kind: 'pos',
      labelEn: 'cargo vehicle driver',
      labels: [['en', 'cargo vehicle driver', axis(5)], ['en', 'truck driver', near(5, 14, 0.97), 'alternative']],
    };
    const cases = [
      { why: 'below the band', cos: 0.3, answer: null },
      { why: 'Clef’s own none at its floor', cos: 0.7, answer: clef('none', 0.9) },
      { why: 'an answer below the floor', cos: 0.7, answer: clef('none', 0.4) },
    ];
    for (const { why, cos, answer } of cases) {
      const calls: FakeCall[] = [];
      const { deps, store, decisions } = await registry(
        { 'work-embed': embedAnswer({ Caminhoneiro: near(5, 15, cos) }), 'work-adjudicate': answer, 'work-pivot': jsonModeResult({ english: 'truck driver' }) },
        calls,
        [driver],
      );
      expect(await snap(deps, { kind: 'pos', raw: 'Caminhoneiro', lang: 'pt' }), why).toMatchObject({ decision: 'pivot', token: 'pos:cargo-vehicle-driver', labelEn: 'cargo vehicle driver' });
      expect(calls.map((c) => c.op), why).toEqual(answer ? ['work-embed', 'work-adjudicate', 'work-pivot'] : ['work-embed', 'work-pivot']);
      expect((await store.tokens(['pos:truck-driver'])).size, why).toBe(0);
      expect(decisions(), why).toEqual([{ decision: 'pivot', token: 'pos:cargo-vehicle-driver', specialization: 0, probability: null, raw: 'Caminhoneiro' }]);
      // The string is observed on the token, so it snaps by label next time.
      expect(await snap(deps, { kind: 'pos', raw: 'caminhoneiro', lang: 'pt' }), why).toMatchObject({ decision: 'label', token: 'pos:cargo-vehicle-driver' });
    }
    // A hirer's words still never reach the pivot.
    const calls: FakeCall[] = [];
    const hirer = await registry({ 'work-embed': embedAnswer({ Caminhoneiro: near(5, 15, 0.3) }), 'work-pivot': jsonModeResult({ english: 'truck driver' }) }, calls, [driver]);
    expect(await snap(hirer.deps, { kind: 'pos', raw: 'Caminhoneiro', lang: 'pt', mint: false })).toMatchObject({ decision: 'unmatched', token: null });
    expect(calls.map((c) => c.op)).toEqual(['work-embed']);
  });

  it('leaves an English name several tokens hold to the slug, as before: the token of that slug, else a mint, and nothing on an undecided answer', async () => {
    // As in ESCO: "porter" is an alternative label of the hotel porter and the hospital porter, and no token is pos:porter.
    const porters: SeedToken[] = [
      { token: 'pos:hotel-porter', kind: 'pos', labelEn: 'hotel porter', labels: [['en', 'hotel porter', axis(6)], ['en', 'porter', near(6, 14, 0.9), 'alternative']] },
      { token: 'pos:hospital-porter', kind: 'pos', labelEn: 'hospital porter', labels: [['en', 'hospital porter', axis(7)], ['en', 'porter', near(7, 14, 0.9), 'alternative']] },
    ];
    const calls: FakeCall[] = [];
    const two = await registry({ 'work-embed': embedAnswer({ Bagageiro: near(6, 15, 0.3), porter: axis(16) }), 'work-pivot': jsonModeResult({ english: 'porter' }) }, calls, porters);
    expect((await two.store.tokensByLabel('porter', 'pos')).map((t) => t.token).sort()).toEqual(['pos:hospital-porter', 'pos:hotel-porter']);
    expect(await snap(two.deps, { kind: 'pos', raw: 'Bagageiro', lang: 'pt' })).toMatchObject({ decision: 'minted', token: 'pos:porter', labelEn: 'porter' });
    expect(calls.map((c) => c.op)).toEqual(['work-embed', 'work-pivot', 'work-embed']);
    expect((await two.store.tokens(['pos:porter'])).get('pos:porter')).toMatchObject({ source: 'emergent', status: 'pending' });

    const undecided = await registry(
      { 'work-embed': embedAnswer({ Bagageiro: near(6, 15, 0.7) }), 'work-adjudicate': clef('none', 0.4), 'work-pivot': jsonModeResult({ english: 'porter' }) },
      [],
      porters,
    );
    expect(await snap(undecided.deps, { kind: 'pos', raw: 'Bagageiro', lang: 'pt' })).toMatchObject({ decision: 'unmatched', token: null });
    expect((await undecided.store.tokens(['pos:porter'])).size).toBe(0);

    // ESCO also gives "electrician" to other occupations, the domestic electrician among them; the slug names the one the pivot snaps to.
    const domestic: SeedToken = {
      token: 'pos:domestic-electrician',
      kind: 'pos',
      labelEn: 'domestic electrician',
      labels: [['en', 'domestic electrician', axis(8)], ['en', 'electrician', near(8, 14, 0.9), 'alternative']],
    };
    const slugged = await registry({ 'work-embed': embedAnswer({ 'Eletricista predial': near(8, 15, 0.3) }), 'work-pivot': jsonModeResult({ english: 'electrician' }) }, [], [domestic]);
    expect((await slugged.store.tokensByLabel('electrician', 'pos')).map((t) => t.token).sort()).toEqual(['pos:domestic-electrician', 'pos:electrician']);
    expect(await snap(slugged.deps, { kind: 'pos', raw: 'Eletricista predial', lang: 'pt' })).toMatchObject({ decision: 'pivot', token: 'pos:electrician' });
  });

  it('reads the pivot against English labels only, so a word another language gives another occupation never catches it', async () => {
    // As in ESCO: "instructor" is a Spanish alternative label of the air force officer, and no English one.
    const officer: SeedToken = {
      token: 'pos:air-force-officer',
      kind: 'pos',
      labelEn: 'air force officer',
      labels: [['en', 'air force officer', axis(5)], ['es', 'instructor', near(5, 14, 0.9), 'alternative']],
    };
    const calls: FakeCall[] = [];
    const { deps, store } = await registry(
      { 'work-embed': embedAnswer({ Instrutor: near(5, 15, 0.3), instructor: axis(16) }), 'work-pivot': jsonModeResult({ english: 'instructor' }) },
      calls,
      [officer],
    );
    // The store reads every language unless it is told which.
    expect((await store.tokensByLabel('instructor', 'pos')).map((t) => t.token)).toEqual(['pos:air-force-officer']);
    expect(await store.tokensByLabel('instructor', 'pos', ['en'])).toEqual([]);
    expect(await snap(deps, { kind: 'pos', raw: 'Instrutor', lang: 'pt' })).toMatchObject({ decision: 'minted', token: 'pos:instructor', labelEn: 'instructor' });
    expect(calls.map((c) => c.op)).toEqual(['work-embed', 'work-pivot', 'work-embed']);
    // The string was observed on the new token, not on the air force officer.
    expect(await snap(deps, { kind: 'pos', raw: 'instrutor', lang: 'pt' })).toMatchObject({ decision: 'label', token: 'pos:instructor' });
  });

  describe('the languages a label decides without a model: the string’s own and English', () => {
    // As in ESCO v1.2.1: "instructor" is only a Spanish label, of the air force
    // officer; "truck driver" an English alternative label of the cargo vehicle driver.
    const officer: SeedToken = {
      token: 'pos:air-force-officer',
      kind: 'pos',
      labelEn: 'air force officer',
      labels: [['en', 'air force officer', axis(5)], ['es', 'instructor', axis(14), 'alternative']],
    };
    const driver: SeedToken = {
      token: 'pos:cargo-vehicle-driver',
      kind: 'pos',
      labelEn: 'cargo vehicle driver',
      labels: [['en', 'cargo vehicle driver', axis(6)], ['en', 'truck driver', axis(15), 'alternative']],
    };

    it('reads an exact label in the string’s own language and in English, never in a third', async () => {
      expect(labelLangs('en')).toEqual(['en']);
      expect(labelLangs('pt')).toEqual(['pt', 'en']);
      const calls: FakeCall[] = [];
      const { deps, store } = await registry({}, calls, [officer, driver]);
      // A Spanish label decides a Spanish string, and an English one every string: a Portuguese or Spanish CV's English title.
      expect(await snap(deps, { kind: 'pos', raw: 'Instructor', lang: 'es' })).toMatchObject({ decision: 'label', token: 'pos:air-force-officer' });
      for (const lang of ['en', 'pt', 'es'] as const) expect(await snap(deps, { kind: 'pos', raw: 'Truck Driver', lang }), lang).toMatchObject({ decision: 'label', token: 'pos:cargo-vehicle-driver' });
      expect(await snap(deps, { kind: 'pos', raw: 'Eletricista', lang: 'pt' })).toMatchObject({ decision: 'label', token: 'pos:electrician' });
      expect(calls).toEqual([]);
      // Neither an English nor a Portuguese string reads the Spanish one.
      expect(await store.tokensByLabel('instructor', 'pos', labelLangs('en'))).toEqual([]);
      expect(await store.tokensByLabel('instructor', 'pos', labelLangs('pt'))).toEqual([]);
      expect(await store.tokensByLabel('instructor', 'pos', [])).toEqual([]);
    });

    it('sends a best match through another language’s label to Clef even at τ_auto, so Clef’s none reaches the pivot, and a hirer’s words still never mint', async () => {
      for (const lang of ['en', 'pt'] as const) {
        const calls: FakeCall[] = [];
        const { deps, store, db, decisions } = await registry(
          { 'work-embed': embedAnswer({ Instructor: near(14, 16, 0.97), instructor: axis(17) }), 'work-adjudicate': clef('none', 0.9), 'work-pivot': jsonModeResult({ english: 'instructor' }) },
          calls,
          [officer],
        );
        const out = await snap(deps, { kind: 'pos', raw: 'Instructor', lang });
        expect(out, lang).toMatchObject({ decision: 'minted', token: 'pos:instructor', labelEn: 'instructor' });
        expect(out.score, lang).toBeCloseTo(0.97, 5);
        // Its best label in the languages read is the English "air force officer", far from the string.
        expect(out.candidates[0], lang).toMatchObject({ token: 'pos:air-force-officer', matched: 'instructor', matchedLang: 'es', scoped: 0 });
        expect(calls.map((c) => c.op), lang).toEqual(lang === 'en' ? ['work-embed', 'work-adjudicate', 'work-pivot'] : ['work-embed', 'work-adjudicate', 'work-pivot', 'work-embed']);
        const asked = calls.find((c) => c.op === 'work-adjudicate')!.input as { state: string; questions: { match: { criteria: Record<string, string> } } };
        // Clef is told the string's language and the language of the label that matched: context, never a preference.
        expect(asked.state, lang).toBe(`An occupation written in ${lang === 'en' ? 'English' : 'Portuguese'} by a worker or a hirer:\nInstructor`);
        expect(asked.questions.match.criteria.c0, lang).toBe('air force officer (matched "instructor", Spanish)');
        expect(decisions(), lang).toEqual([{ decision: 'minted', token: 'pos:instructor', specialization: 0, probability: null, raw: 'Instructor' }]);
        // Nothing was observed on the air force officer, and the next English string snaps to the new token by label.
        expect(db.sqlite.prepare("SELECT label FROM registry_labels WHERE token = 'pos:air-force-officer' AND kind = 'observed'").all(), lang).toEqual([]);
        expect((await store.tokensByLabel('instructor', 'pos', labelLangs('en'))).map((t) => t.token), lang).toEqual(['pos:instructor']);
      }

      // Clef below its floor: the pivot names no existing token, so nothing mints.
      const undecided = await registry(
        { 'work-embed': embedAnswer({ Instructor: near(14, 16, 0.97) }), 'work-adjudicate': clef('none', 0.4), 'work-pivot': jsonModeResult({ english: 'instructor' }) },
        [],
        [officer],
      );
      expect(await snap(undecided.deps, { kind: 'pos', raw: 'Instructor', lang: 'en' })).toMatchObject({ decision: 'unmatched', token: null });
      expect((await undecided.store.tokens(['pos:instructor'])).size).toBe(0);

      // A hirer's words: Clef's none is no token, before any pivot.
      const calls: FakeCall[] = [];
      const hirer = await registry({ 'work-embed': embedAnswer({ Instructor: near(14, 16, 0.97) }), 'work-adjudicate': clef('none', 0.9) }, calls, [officer]);
      expect(await snap(hirer.deps, { kind: 'pos', raw: 'Instructor', lang: 'en', mint: false })).toMatchObject({ decision: 'unmatched', token: null });
      expect(calls.map((c) => c.op)).toEqual(['work-embed', 'work-adjudicate']);
    });

    it('lets Clef take another language’s label: a Spanish word on a Portuguese CV', async () => {
      // SEED gives the plumber the Spanish "plomero"; ESCO's Portuguese has no such word.
      const calls: FakeCall[] = [];
      const { deps } = await registry({ 'work-embed': embedAnswer({ Plomero: near(1, 9, 0.92) }), 'work-adjudicate': clef('c0', 0.9) }, calls);
      const out = await snap(deps, { kind: 'pos', raw: 'Plomero', lang: 'pt' });
      expect(out).toMatchObject({ decision: 'chosen', token: 'pos:plumber', probability: 0.9 });
      expect(out.candidates[0]).toMatchObject({ token: 'pos:plumber', matched: 'plomero', matchedLang: 'es' });
      expect(out.candidates[0]!.score).toBeGreaterThanOrEqual(DEFAULT_TAU.auto);
      expect(calls.map((c) => c.op)).toEqual(['work-embed', 'work-adjudicate']);
      // Its alias is Portuguese now; a Spanish string had its own label all along.
      calls.length = 0;
      expect(await snap(deps, { kind: 'pos', raw: 'plomero', lang: 'pt' })).toMatchObject({ decision: 'label', token: 'pos:plumber' });
      expect(await snap(deps, { kind: 'pos', raw: 'Plomero', lang: 'es' })).toMatchObject({ decision: 'label', token: 'pos:plumber' });
      expect(calls).toEqual([]);
    });

    it('reads one text a token holds in two languages as the string’s own, whichever vector the index lists first', async () => {
      // ESCO gives 36 occupations and 215 skills a label whose text is the same in English and in Portuguese or Spanish ("chef", "Haskell"): two vectors at one score.
      for (const first of ['es', 'en'] as const) {
        const second = first === 'es' ? 'en' : 'es';
        const twins: SeedToken = { token: 'pos:chef', kind: 'pos', labelEn: 'chef', labels: [[first, 'chef', axis(18)], [second, 'chef', axis(18)]] };
        const calls: FakeCall[] = [];
        const { deps } = await registry({ 'work-embed': embedAnswer({ 'Chef de Partie': near(18, 19, 0.96) }) }, calls, [twins]);
        const out = await snap(deps, { kind: 'pos', raw: 'Chef de Partie', lang: 'en' });
        expect(out, first).toMatchObject({ decision: 'auto', token: 'pos:chef' });
        expect(out.candidates[0], first).toMatchObject({ matched: 'chef', matchedLang: 'en' });
        expect(out.candidates[0]!.scoped, first).toBeCloseTo(0.96, 5);
        expect(calls.map((c) => c.op), first).toEqual(['work-embed']);
      }
    });

    it('takes nothing without a model through a label whose vector names no language', async () => {
      const calls: FakeCall[] = [];
      const { deps, index } = await registry({ 'work-embed': embedAnswer({ 'Pipe Welder': near(19, 20, 0.97) }), 'work-adjudicate': clef('c0', 0.9) }, calls);
      await index.upsert([{ id: 'lno-language', values: axis(19), metadata: { token: 'pos:welder', kind: 'pos', label: 'pipe welder', source: 'seed' } }]);
      const out = await snap(deps, { kind: 'pos', raw: 'Pipe Welder', lang: 'en' });
      expect(out).toMatchObject({ decision: 'chosen', token: 'pos:welder' });
      // The welder's English label, "welder", is far from the string; the match without a language counts in none.
      expect(out.candidates[0]).toMatchObject({ token: 'pos:welder', matched: 'pipe welder', scoped: 0 });
      expect(calls.map((c) => c.op)).toEqual(['work-embed', 'work-adjudicate']);
    });

    it('takes a best match at τ_auto without a model through an English label or one in the string’s own language', async () => {
      const calls: FakeCall[] = [];
      const { deps } = await registry({ 'work-embed': embedAnswer({ 'Eletricista Industrial': near(0, 10, 0.97), 'Plomero Oficial': near(1, 9, 0.99), Plumbers: near(1, 9, 0.96) }) }, calls);
      const pt = await snap(deps, { kind: 'pos', raw: 'Eletricista Industrial', lang: 'pt' });
      expect(pt).toMatchObject({ decision: 'auto', token: 'pos:electrician' });
      expect(pt.candidates[0]).toMatchObject({ matched: 'electrician', matchedLang: 'en' });
      const es = await snap(deps, { kind: 'pos', raw: 'Plomero Oficial', lang: 'es' });
      expect(es).toMatchObject({ decision: 'auto', token: 'pos:plumber' });
      expect(es.candidates[0]).toMatchObject({ matched: 'plomero', matchedLang: 'es' });
      // The plumber's Spanish label is nearer, but its English one is at τ_auto too, so no model is needed to name it.
      const en = await snap(deps, { kind: 'pos', raw: 'Plumbers', lang: 'en' });
      expect(en).toMatchObject({ decision: 'auto', token: 'pos:plumber' });
      expect(en.candidates[0]).toMatchObject({ matched: 'plomero', matchedLang: 'es' });
      expect(en.candidates[0]!.scoped).toBeCloseTo(0.96, 5);
      expect(calls.map((c) => c.op)).toEqual(['work-embed', 'work-embed', 'work-embed']);
    });

    it('keeps an observed alias in its string’s language: one observed in English reaches every language, one in Portuguese only Portuguese', async () => {
      const calls: FakeCall[] = [];
      const { deps } = await registry({ 'work-embed': embedAnswer({ 'Journeyman Electrician': near(0, 10, 0.97), 'Eletricista Industrial': near(0, 11, 0.97) }) }, calls);
      expect(await snap(deps, { kind: 'pos', raw: 'Journeyman Electrician', lang: 'en' })).toMatchObject({ decision: 'auto', token: 'pos:electrician' });
      expect(await snap(deps, { kind: 'pos', raw: 'Eletricista Industrial', lang: 'pt' })).toMatchObject({ decision: 'auto', token: 'pos:electrician' });
      calls.length = 0;
      for (const lang of ['en', 'pt', 'es'] as const) expect(await snap(deps, { kind: 'pos', raw: 'journeyman electrician', lang }), lang).toMatchObject({ decision: 'label', token: 'pos:electrician' });
      expect(await snap(deps, { kind: 'pos', raw: 'eletricista industrial', lang: 'pt' })).toMatchObject({ decision: 'label', token: 'pos:electrician' });
      expect(calls).toEqual([]);
      // A Spanish string does not read the Portuguese alias: it goes through the embedding again.
      expect(await snap(deps, { kind: 'pos', raw: 'Eletricista Industrial', lang: 'es' })).toMatchObject({ decision: 'auto', token: 'pos:electrician' });
      expect(calls.map((c) => c.op)).toEqual(['work-embed']);
    });

    it('ranks a curated label over an observed alias among the languages it reads', async () => {
      const coaches: SeedToken[] = [
        { token: 'pos:life-coach', kind: 'pos', labelEn: 'life coach', labels: [['en', 'life coach', axis(5)], ['es', 'coach', axis(14), 'alternative']] },
        { token: 'pos:sports-coach', kind: 'pos', labelEn: 'sports coach', labels: [['en', 'sports coach', axis(6)]] },
      ];
      const calls: FakeCall[] = [];
      const { deps, store } = await registry({}, calls, coaches);
      // An English snap observed "Coach" on the sports coach.
      await store.addLabels([{ labelId: await labelIdOf('pos:sports-coach', 'en', 'coach'), token: 'pos:sports-coach', lang: 'en', label: 'Coach', labelNorm: 'coach', kind: 'observed', embedded: false }], 1);
      const holders = async (langs?: string[]) => (await store.tokensByLabel('coach', 'pos', langs)).map((t) => t.token);
      expect(await holders()).toEqual(['pos:life-coach']);
      expect(await holders(labelLangs('es'))).toEqual(['pos:life-coach']);
      expect(await holders(labelLangs('en'))).toEqual(['pos:sports-coach']);
      expect(await snap(deps, { kind: 'pos', raw: 'Coach', lang: 'en' })).toMatchObject({ decision: 'label', token: 'pos:sports-coach' });
      expect(await snap(deps, { kind: 'pos', raw: 'Coach', lang: 'es' })).toMatchObject({ decision: 'label', token: 'pos:life-coach' });
      expect(calls).toEqual([]);
    });

    it('reads a certificate’s labels in every language, since the seed gives each label one credential', async () => {
      const calls: FakeCall[] = [];
      const { deps, store } = await registry({}, calls);
      // A Portuguese claim kept as an alias of BOSIET, its words in an order no seed label has, so only the D1 label can read it.
      const alias = 'Segurança offshore BOSIET básico';
      await store.addLabels([{ labelId: await labelIdOf('cert:bosiet', 'pt', labelNorm(alias)), token: 'cert:bosiet', lang: 'pt', label: alias, labelNorm: labelNorm(alias), kind: 'observed', embedded: false }], 1);
      expect(await snap(deps, { kind: 'cert', raw: 'Segurança Offshore BOSIET Básico', lang: 'en' })).toMatchObject({ decision: 'label', token: 'cert:bosiet' });
      expect(calls).toEqual([]);
    });
  });

  it('never mints a certificate', async () => {
    const calls: FakeCall[] = [];
    const { deps, store } = await registry({ 'work-embed': embedAnswer({ 'TWIC card': near(4, 13, 0.7), 'NR-34': near(4, 13, 0.2) }), 'work-adjudicate': clef('none', 0.95) }, calls);
    expect(await snap(deps, { kind: 'cert', raw: 'TWIC card', lang: 'en' })).toMatchObject({ decision: 'unmatched', token: null });
    expect(await snap(deps, { kind: 'cert', raw: 'NR-34', lang: 'pt' })).toMatchObject({ decision: 'unmatched', token: null });
    expect(calls.map((c) => c.op)).not.toContain('work-pivot');
    expect((await store.tokensByLabel('twic card', 'cert')).length).toBe(0);
  });

  it('fails closed: no embedding, no Clef answer, a bad pivot or a refused string is no token', async () => {
    const calls: FakeCall[] = [];
    const down = await registry({ 'work-embed': new Error('down') }, calls);
    expect(await snap(down.deps, { kind: 'pos', raw: 'Pipe welder', lang: 'en' })).toMatchObject({ decision: 'unmatched' });
    const clefDown = await registry({ 'work-embed': embedAnswer({ 'Soldador TIG': near(2, 10, 0.8) }), 'work-adjudicate': new Error('down') });
    expect(await snap(clefDown.deps, { kind: 'pos', raw: 'Soldador TIG', lang: 'pt' })).toMatchObject({ decision: 'unmatched', token: null });
    const badPivot = await registry({ 'work-embed': embedAnswer({ 'Pâtissier': near(1, 10, 0.3) }), 'work-pivot': jsonModeResult({ english: 'pos:pastry-chef!' }) });
    expect(await snap(badPivot.deps, { kind: 'pos', raw: 'Pâtissier', lang: 'es' })).toMatchObject({ decision: 'unmatched' });
    const quiet: FakeCall[] = [];
    const refused = await registry({}, quiet);
    expect(await snap(refused.deps, { kind: 'pos', raw: 'Welder, call (713) 555-0142', lang: 'en' })).toMatchObject({ decision: 'unmatched' });
    expect(quiet).toEqual([]);
  });

  it('carries the calls it made on a store failure, so the route can still meter them', async () => {
    const { deps, store } = await registry({ 'work-embed': embedAnswer({ 'Journeyman Electrician': near(0, 10, 0.97) }) });
    store.recordDecision = async () => {
      throw new Error('d1 down');
    };
    const err = await snap(deps, { kind: 'pos', raw: 'Journeyman Electrician', lang: 'en' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkCallsError);
    expect((err as WorkCallsError).calls.map((c) => c.op)).toEqual(['work-embed']);
    expect((err as WorkCallsError).cause).toMatchObject({ message: 'd1 down' });
  });

  it('asks Clef about the kind it is snapping', () => {
    const q = adjudicationQuestions('skill', [{ token: 'skill:leak-repair', labelEn: 'leak repair', matched: 'reparación de fugas', matchedLang: 'es', score: 0.8 }]);
    expect(q.match).toMatchObject({ type: 'choice', criteria: { c0: 'leak repair (matched "reparación de fugas")', none: 'None of these: a different skill' } });
    expect(q.specialization).toMatchObject({ type: 'noul' });
  });
});

describe('the locale the model steps read', () => {
  // As in ESCO v1.2.1, whose Portuguese is Portugal's: the Brazilian "Encanador" is no label, and bge-m3 reads it
  // by its letters, near the assayer's Portuguese "Ensaiador" and the carpet fitter's Spanish "enmoquetador".
  const lookalikes: SeedToken[] = [
    { token: 'pos:assayer', kind: 'pos', labelEn: 'assayer', labels: [['en', 'assayer', axis(20)], ['pt', 'Ensaiador', axis(21), 'alternative']] },
    { token: 'pos:carpet-fitter', kind: 'pos', labelEn: 'carpet fitter', labels: [['en', 'carpet fitter', axis(22)], ['es', 'enmoquetador', axis(23), 'alternative']] },
  ];
  /** A unit vector at these cosines to these axes, the rest along axis 30. */
  const toward = (...parts: [axis: number, cos: number][]) => {
    const v = new Array<number>(1024).fill(0);
    for (const [a, cos] of parts) v[a] = cos;
    v[30] = Math.sqrt(Math.max(0, 1 - parts.reduce((s, [, cos]) => s + cos * cos, 0)));
    return v;
  };
  const encanador = toward([21, 0.74], [23, 0.66]);
  type Asked = { state: string; questions: { match: { instructions: string; criteria: Record<string, string> } } };
  type PivotAsked = { messages: { role: string; content: string }[] };
  const criteriaOf = (q: ReturnType<typeof adjudicationQuestions>) => (q.match as { criteria: Record<string, string> }).criteria;

  it('tells Clef and the pivot a worker’s string in its variant and market, and each candidate the language of its label', async () => {
    const calls: FakeCall[] = [];
    const { deps } = await registry(
      { 'work-embed': embedAnswer({ Encanador: encanador }), 'work-adjudicate': clef('none', 0.9), 'work-pivot': jsonModeResult({ english: 'plumber' }) },
      calls,
      lookalikes,
    );
    expect(await snap(deps, { kind: 'pos', raw: 'Encanador', lang: 'pt', market: 'br-sp' })).toMatchObject({ decision: 'pivot', token: 'pos:plumber' });
    const state = 'An occupation written in Brazilian Portuguese by a worker in Brazil (br-sp):\nEncanador';
    const asked = calls.find((c) => c.op === 'work-adjudicate')!.input as unknown as Asked;
    expect(asked.state).toBe(state);
    expect(asked.questions.match.criteria).toMatchObject({ c0: 'assayer (matched "Ensaiador", Portuguese)', c1: 'carpet fitter (matched "enmoquetador", Spanish)' });
    // The question is the one every string gets, whatever its language.
    expect(asked.questions.match.instructions).toBe((adjudicationQuestions('pos', []).match as { instructions: string }).instructions);
    // The pivot reads the same text, so a Brazilian word is read as Brazilian Portuguese.
    const pivoted = calls.find((c) => c.op === 'work-pivot')!.input as unknown as PivotAsked;
    expect(pivoted.messages.find((m) => m.role === 'user')!.content).toBe(state);
    expect(pivoted.messages[0]!.content).toContain('with the language it is written in and, when known, where the worker who wrote it is');
    // Context, never a preference: nothing tells a model to favour a language or a region.
    expect(JSON.stringify([asked, pivoted])).not.toMatch(/prefer|favou?r|priorit/i);

    // Without a market the state names the language alone, and so does the pivot.
    const plain: FakeCall[] = [];
    const without = await registry({ 'work-embed': embedAnswer({ Encanador: encanador }), 'work-adjudicate': clef('none', 0.9), 'work-pivot': jsonModeResult({ english: 'plumber' }) }, plain, lookalikes);
    await snap(without.deps, { kind: 'pos', raw: 'Encanador', lang: 'pt' });
    expect((plain.find((c) => c.op === 'work-adjudicate')!.input as unknown as Asked).state).toBe('An occupation written in Portuguese by a worker or a hirer:\nEncanador');
    expect((plain.find((c) => c.op === 'work-pivot')!.input as unknown as PivotAsked).messages[1]!.content).toBe('An occupation written in Portuguese by a worker or a hirer:\nEncanador');
  });

  it('shows a national layer’s label with its region, a label of no language with none, and the US layer’s import keeps its questions', async () => {
    const calls: FakeCall[] = [];
    // An O*NET title the US layer placed on the cargo vehicle driver: its vector names the region (`national.ts`).
    const driver: SeedToken = { token: 'pos:cargo-vehicle-driver', kind: 'pos', labelEn: 'cargo vehicle driver', labels: [['en', 'cargo vehicle driver', axis(24)]] };
    const { deps, index } = await registry({ 'work-embed': embedAnswer({ 'Tractor-Trailer Driver': toward([25, 0.9]) }), 'work-adjudicate': clef('c0', 0.9) }, calls, [driver]);
    await index.upsert([{ id: 'lonet-truck-driver', values: axis(25), metadata: { token: 'pos:cargo-vehicle-driver', kind: 'pos', lang: 'en', label: 'Truck Driver', source: 'esco', region: 'us', layer: 'onet' } }]);
    const out = await snap(deps, { kind: 'pos', raw: 'Tractor-Trailer Driver', lang: 'en', market: 'us-tx' });
    expect(out).toMatchObject({ decision: 'chosen', token: 'pos:cargo-vehicle-driver' });
    expect(out.candidates[0]).toMatchObject({ matched: 'Truck Driver', matchedLang: 'en', matchedRegion: 'us' });
    const asked = calls.find((c) => c.op === 'work-adjudicate')!.input as unknown as Asked;
    expect(asked.state).toBe('An occupation written in American English by a worker in the United States (us-tx):\nTractor-Trailer Driver');
    expect(asked.questions.match.criteria.c0).toBe('cargo vehicle driver (matched "Truck Driver", American English)');

    const shown: Candidate[] = [
      { token: 'pos:life-coach', labelEn: 'life coach', matched: 'coach', matchedLang: 'es', score: 0.9 },
      { token: 'pos:welder', labelEn: 'welder', matched: 'pipe welder', matchedLang: null, score: 0.8 },
      { token: 'pos:plumber', labelEn: 'plumber', matched: 'plumber', matchedLang: 'en', score: 0.7 },
      { token: 'pos:pipefitter', labelEn: 'pipefitter', matched: 'ayudante de tubero', matchedLang: 'es', matchedRegion: 'co', score: 0.66 },
      { token: 'pos:fitter', labelEn: 'fitter', matched: 'Monteur', matchedLang: 'de', matchedRegion: 'de-by', score: 0.65 },
    ];
    expect(criteriaOf(adjudicationQuestions('pos', shown, { labelLocales: true }))).toEqual({
      c0: 'life coach (matched "coach", Spanish)',
      c1: 'welder (matched "pipe welder")',
      c2: 'plumber',
      c3: 'pipefitter (matched "ayudante de tubero", Spanish, Colombia)',
      c4: 'fitter (matched "Monteur", de, de-by)',
      none: 'None of these: a different occupation',
    });
    // The US layer's import (`onet.ts`) asks without them, as it was calibrated on 2026-10-25.
    expect(criteriaOf(adjudicationQuestions('pos', shown)).c0).toBe('life coach (matched "coach")');
  });

  it('decides nothing by the market without a model: the exact label and τ_auto read the same languages with one or without', async () => {
    const officer: SeedToken = { token: 'pos:air-force-officer', kind: 'pos', labelEn: 'air force officer', labels: [['en', 'air force officer', axis(5)], ['es', 'instructor', axis(14), 'alternative']] };
    for (const market of [undefined, 'mx-cmx', 'us-tx', 'br-sp']) {
      const calls: FakeCall[] = [];
      const { deps } = await registry(
        { 'work-embed': embedAnswer({ 'Plomero Oficial': near(1, 9, 0.99), Instructor: near(14, 16, 0.97) }), 'work-adjudicate': clef('none', 0.9), 'work-pivot': jsonModeResult({ english: 'instructor' }) },
        calls,
        [officer],
      );
      const m = market ? { market } : {};
      // ESCO's Spanish label decides a Spanish string from any market: the locale is not its fix, and no curated list will be (workspace OD-28).
      expect(await snap(deps, { kind: 'pos', raw: 'Instructor', lang: 'es', ...m }), market).toMatchObject({ decision: 'label', token: 'pos:air-force-officer' });
      expect(await snap(deps, { kind: 'pos', raw: 'Plomero Oficial', lang: 'es', ...m }), market).toMatchObject({ decision: 'auto', token: 'pos:plumber' });
      expect(calls.map((c) => c.op), market).toEqual(['work-embed']);
      // Another language's label at τ_auto goes to Clef from every market.
      expect(await snap(deps, { kind: 'pos', raw: 'Instructor', lang: 'en', ...m }), market).toMatchObject({ decision: 'minted', token: 'pos:instructor' });
      expect(calls.map((c) => c.op), market).toEqual(['work-embed', 'work-embed', 'work-adjudicate', 'work-pivot']);
    }
  });

  it('fails closed with a market as without: no Clef answer, a bad pivot or no embedding is no token, an answer below the floor never mints, nor does a hirer or a certificate', async () => {
    const m = { market: 'br-sp' };
    for (const answer of [new Error('down'), { answers: {} }]) {
      const calls: FakeCall[] = [];
      const { deps } = await registry({ 'work-embed': embedAnswer({ Encanador: encanador }), 'work-adjudicate': answer, 'work-pivot': jsonModeResult({ english: 'plumber' }) }, calls, lookalikes);
      expect(await snap(deps, { kind: 'pos', raw: 'Encanador', lang: 'pt', ...m })).toMatchObject({ decision: 'unmatched', token: null });
      expect(calls.map((c) => c.op)).toEqual(['work-embed', 'work-adjudicate']);
    }
    for (const [english, expected] of [
      ['plumber', { decision: 'pivot', token: 'pos:plumber' }],
      ['pipe layer', { decision: 'unmatched', token: null }],
    ] as const) {
      const { deps, store } = await registry({ 'work-embed': embedAnswer({ Encanador: encanador }), 'work-adjudicate': clef('none', 0.4), 'work-pivot': jsonModeResult({ english }) }, [], lookalikes);
      expect(await snap(deps, { kind: 'pos', raw: 'Encanador', lang: 'pt', ...m }), english).toMatchObject(expected);
      expect((await store.tokens(['pos:pipe-layer'])).size, english).toBe(0);
    }
    const hirer = await registry({ 'work-embed': embedAnswer({ Encanador: encanador }), 'work-adjudicate': clef('none', 0.9), 'work-pivot': jsonModeResult({ english: 'plumber' }) }, [], lookalikes);
    expect(await snap(hirer.deps, { kind: 'pos', raw: 'Encanador', lang: 'pt', mint: false, ...m })).toMatchObject({ decision: 'unmatched', token: null });
    const badPivot = await registry({ 'work-embed': embedAnswer({ Encanador: encanador }), 'work-adjudicate': clef('none', 0.9), 'work-pivot': jsonModeResult({ english: 'pos:plumber!' }) }, [], lookalikes);
    expect(await snap(badPivot.deps, { kind: 'pos', raw: 'Encanador', lang: 'pt', ...m })).toMatchObject({ decision: 'unmatched', token: null });
    const down = await registry({ 'work-embed': new Error('down') }, [], lookalikes);
    expect(await snap(down.deps, { kind: 'pos', raw: 'Encanador', lang: 'pt', ...m })).toMatchObject({ decision: 'unmatched', token: null });
    const cert = await registry({ 'work-embed': embedAnswer({ 'TWIC card': near(4, 13, 0.7) }), 'work-adjudicate': clef('none', 0.95) });
    expect(await snap(cert.deps, { kind: 'cert', raw: 'TWIC card', lang: 'en', market: 'us-tx' })).toMatchObject({ decision: 'unmatched', token: null });
    expect((await cert.store.tokensByLabel('twic card', 'cert')).length).toBe(0);
  });

  it('keeps the market out of the registry: a decision keeps the string’s language, and an alias or a mint no region', async () => {
    const { deps, db } = await registry({ 'work-embed': embedAnswer({ Encanador: encanador }), 'work-adjudicate': clef('none', 0.9), 'work-pivot': jsonModeResult({ english: 'plumber' }) }, [], lookalikes);
    expect(await snap(deps, { kind: 'pos', raw: 'Encanador', lang: 'pt', market: 'br-sp' })).toMatchObject({ decision: 'pivot', token: 'pos:plumber' });
    const decisions = db.sqlite.prepare('SELECT * FROM registry_decisions').all();
    const observed = db.sqlite.prepare("SELECT * FROM registry_labels WHERE kind = 'observed'").all();
    expect(decisions).toMatchObject([{ raw: 'Encanador', lang: 'pt', decision: 'pivot', token: 'pos:plumber' }]);
    expect(observed).toMatchObject([{ token: 'pos:plumber', lang: 'pt', label: 'Encanador', region: null, source: null }]);
    expect(JSON.stringify([decisions, observed])).not.toMatch(/br-sp|Brazil/);

    const minted = await registry({ 'work-embed': embedAnswer({ Confeiteiro: near(1, 11, 0.62), 'pastry chef': axis(12) }), 'work-adjudicate': clef('none', 0.9), 'work-pivot': jsonModeResult({ english: 'pastry chef' }) });
    expect(await snap(minted.deps, { kind: 'pos', raw: 'Confeiteiro', lang: 'pt', market: 'br-sp' })).toMatchObject({ decision: 'minted', token: 'pos:pastry-chef' });
    const vectors = [...minted.index.vectors.values()].filter((v) => v.metadata.token === 'pos:pastry-chef');
    expect(vectors).toHaveLength(2);
    expect(JSON.stringify([vectors.map((v) => v.metadata), minted.db.sqlite.prepare('SELECT * FROM registry_labels WHERE token = ?').all('pos:pastry-chef')])).not.toMatch(/br-sp|Brazil|region":"/);
  });
});

describe('embedTexts', () => {
  const answer = (dims: number) => () => ({ shape: [1, dims], data: [new Array<number>(dims).fill(0.01)] });

  it("accepts the pinned model's vector size and fails closed on any other", async () => {
    const gemma = fakeInference({ 'work-embed': answer(768) }, [], { 'work-embed': '@cf/google/embeddinggemma-300m' });
    expect((await embedTexts(gemma, ['plumber'], { role: 'query' })).ok).toBe(true);
    expect((await embedTexts(fakeInference({ 'work-embed': answer(1024) }), ['plumber'], { role: 'query' })).ok).toBe(true);
    // bge-m3's indexes hold 1024 dimensions: a 768-dimension answer under that pin is a bad shape.
    expect((await embedTexts(fakeInference({ 'work-embed': answer(768) }), ['plumber'], { role: 'query' })).ok).toBe(false);
    const unknown = fakeInference({ 'work-embed': answer(1024) }, [], { 'work-embed': '@cf/some/other-model' });
    expect((await embedTexts(unknown, ['plumber'], { role: 'query' })).ok).toBe(false);
    expect(EMBED_DIMS_BY_MODEL['@cf/baai/bge-m3']).toBe(1024);
  });

  it("sends EmbeddingGemma its prompt for the role, and bge-m3 the texts as they are", async () => {
    const calls: FakeCall[] = [];
    const sent = () => calls.map((c) => c.input.text);
    const many = (dims: number) => (input: Record<string, unknown>) => ({ data: (input.text as string[]).map(() => new Array<number>(dims).fill(0.01)) });
    const gemma = fakeInference({ 'work-embed': many(768) }, calls, { 'work-embed': '@cf/google/embeddinggemma-300m' });
    await embedTexts(gemma, ['Plomero'], { role: 'query' });
    await embedTexts(gemma, ['plumber', 'pipe fitter'], { role: 'document' });
    expect(sent()).toEqual([['task: search result | query: Plomero'], ['title: none | text: plumber', 'title: none | text: pipe fitter']]);
    calls.length = 0;
    await embedTexts(fakeInference({ 'work-embed': many(1024) }, calls), ['Plomero'], { role: 'query' });
    await embedTexts(fakeInference({ 'work-embed': many(1024) }, calls), ['plumber'], { role: 'document' });
    expect(sent()).toEqual([['Plomero'], ['plumber']]);
    expect(EMBED_PROMPTS_BY_MODEL['@cf/baai/bge-m3']).toBeUndefined();
  });
});
