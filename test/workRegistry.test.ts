// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  D1RegistryStore,
  DEFAULT_TAU,
  EMBED_DIMS_BY_MODEL,
  embedTexts,
  labelIdOf,
  labelNorm,
  parseTau,
  snap,
  tokenOf,
  tokenSlug,
  validPivot,
  type LabelKind,
  type RegistryDeps,
  type RegistryLabel,
  type TokenKind,
} from '../src/services/work/registry.js';
import { adjudicationQuestions } from '../src/services/work/clef.js';
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

async function registry(responses: FakeResponses = {}, calls: FakeCall[] = [], extra: SeedToken[] = []) {
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
  const deps: RegistryDeps = { inference: fakeInference(responses, calls), store, index, now: () => NOW, newId: () => `d${++n}` };
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

  it('keeps τ ordered and inside (0, 1]', () => {
    expect(parseTau(undefined, undefined)).toEqual(DEFAULT_TAU);
    expect(parseTau('0.9', '0.7')).toEqual({ auto: 0.9, low: 0.7 });
    expect(parseTau('0.6', '0.7')).toEqual(DEFAULT_TAU);
    expect(parseTau('2', 'x')).toEqual(DEFAULT_TAU);
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
    // A raw string's own shortcut still reads every language.
    expect((await store.tokensByLabel('instructor', 'pos')).map((t) => t.token)).toEqual(['pos:air-force-officer']);
    expect(await store.tokensByLabel('instructor', 'pos', 'en')).toEqual([]);
    expect(await snap(deps, { kind: 'pos', raw: 'Instrutor', lang: 'pt' })).toMatchObject({ decision: 'minted', token: 'pos:instructor', labelEn: 'instructor' });
    expect(calls.map((c) => c.op)).toEqual(['work-embed', 'work-pivot', 'work-embed']);
    // The string was observed on the new token, not on the air force officer.
    expect(await snap(deps, { kind: 'pos', raw: 'instrutor', lang: 'pt' })).toMatchObject({ decision: 'label', token: 'pos:instructor' });
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

describe('embedTexts', () => {
  const answer = (dims: number) => () => ({ shape: [1, dims], data: [new Array<number>(dims).fill(0.01)] });

  it("accepts the pinned model's vector size and fails closed on any other", async () => {
    const gemma = fakeInference({ 'work-embed': answer(768) }, [], { 'work-embed': '@cf/google/embeddinggemma-300m' });
    expect((await embedTexts(gemma, ['plumber'])).ok).toBe(true);
    expect((await embedTexts(fakeInference({ 'work-embed': answer(1024) }), ['plumber'])).ok).toBe(true);
    // bge-m3's indexes hold 1024 dimensions: a 768-dimension answer under that pin is a bad shape.
    expect((await embedTexts(fakeInference({ 'work-embed': answer(768) }), ['plumber'])).ok).toBe(false);
    const unknown = fakeInference({ 'work-embed': answer(1024) }, [], { 'work-embed': '@cf/some/other-model' });
    expect((await embedTexts(unknown, ['plumber'])).ok).toBe(false);
    expect(EMBED_DIMS_BY_MODEL['@cf/baai/bge-m3']).toBe(1024);
  });
});
