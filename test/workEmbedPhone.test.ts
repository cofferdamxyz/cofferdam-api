// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { INTENT_MAX_CHARS } from '../src/services/work/intent.js';
import { DRAFT_LIMITS } from '../src/services/work/listings.js';
import {
  abbreviate,
  buildPlan,
  cosine,
  decodeVector,
  LONG_TEXT_CHARS,
  misspell,
  planDigest,
  planeClaim,
  planeSentence,
  planeTakesClaim,
  sameCandidates,
  sameDecision,
  sameTop,
  seeded,
  snapOf,
  spread,
  type ReplicaRow,
  type Snap,
} from './work-eval/embedPhone.js';

const FIXTURES = join(__dirname, 'fixtures', 'work');

/** A small replica: each kind in three languages, and two US-layer rows. */
const rows: ReplicaRow[] = [];
for (const kind of ['pos', 'skill']) {
  for (const lang of ['en', 'pt', 'es']) {
    for (let i = 0; i < 30; i++) rows.push({ id: `${kind}-${lang}-${i}`, token: `${kind}:t${i}`, kind, lang, label: `${kind} ${lang} label ${i}`, source: 'esco' });
  }
}
rows.push({ id: 'us-1', token: 'pos:us1', kind: 'pos', lang: 'en', label: 'Roustabout', source: 'onet' });
rows.push({ id: 'us-2', token: 'pos:us2', kind: 'pos', lang: 'en', label: 'Derrick Operator', source: 'onet' });
const regions = { [rows.length - 2]: 'us', [rows.length - 1]: 'us' };

describe('the embed check plan', () => {
  const { plan, meta } = buildPlan({ fixtures: FIXTURES, rows, regions });
  const texts = plan.embed.texts;

  it('writes a plan the app reads: embed texts alone, ids unique, each within the limits', () => {
    expect(plan).toMatchObject({ v: 1, runs: 1, cvs: [], readers: [] });
    expect(new Set(texts.map((t) => t.id)).size).toBe(texts.length);
    expect(texts.every((t) => t.text.length > 0 && t.text.length <= 20_000 && (t.role === 'query' || t.role === 'document'))).toBe(true);
    expect(meta.map((m) => m.id)).toEqual(texts.map((t) => t.id));
  });

  it('holds each set, a claim in both roles, sentences up to the cap, and listings up to the most a draft allows', () => {
    const count = (set: string) => meta.filter((m) => m.set === set).length;
    expect(count('label')).toBe(6 * 30 + 2);
    expect(count('claim')).toBeGreaterThanOrEqual(500);
    expect(meta.filter((m) => m.set === 'claim' && m.role === 'query').length).toBe(count('claim') / 2);
    expect(count('listing')).toBe(200);
    expect(count('sentence')).toBe(300);
    const sentences = texts.filter((t) => t.id.startsWith('S'));
    expect(Math.max(...sentences.map((t) => t.text.length))).toBeLessThanOrEqual(INTENT_MAX_CHARS);
    expect(Math.max(...sentences.map((t) => t.text.length))).toBeGreaterThan(900);
    const listings = texts.filter((t) => t.id.startsWith('J'));
    expect(Math.max(...listings.map((t) => t.text.length))).toBeGreaterThan(DRAFT_LIMITS.chars * 40);
    expect(Math.min(...listings.map((t) => t.text.length))).toBeLessThan(200);
  });

  it("pairs each awkward text with its clean form, and knows where the plane holds the two as one text", () => {
    const awkward = meta.filter((m) => m.cleanId);
    expect(awkward.length).toBeGreaterThan(60);
    for (const m of awkward) expect(meta.some((c) => c.id === m.cleanId && c.role === m.role)).toBe(true);
    const nfd = awkward.filter((m) => m.change === 'decomposed accents (NFD)');
    expect(nfd.length).toBeGreaterThan(0);
    expect(nfd.every((m) => m.planeSame)).toBe(true);
    expect(awkward.filter((m) => m.change === 'emoji').every((m) => !m.planeSame)).toBe(true);
    expect(meta.some((m) => m.change === 'long, 6000 characters')).toBe(true);
  });

  it('times a listing of 20 claims within the draft limits: their queries in one call, their documents and the listing text in another', () => {
    expect(plan.embed.listing.queries).toHaveLength(20);
    expect(plan.embed.listing.documents).toHaveLength(21);
    const textOf = new Map(texts.map((t) => [t.id, t.text]));
    const kindOf = new Map(meta.filter((m) => m.set === 'claim' && m.role === 'query').map((m) => [textOf.get(m.id)!, m.kind]));
    expect(meta.filter((m) => m.set === 'claim' && m.role === 'query' && m.kind === 'pos' && m.lang === 'pt').length).toBeGreaterThan(DRAFT_LIMITS.titles);
    // The draft the timing listing stands for holds no more titles than a draft may.
    const titles = plan.embed.listing.queries.filter((q) => kindOf.get(q) === 'pos');
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.length).toBeLessThanOrEqual(DRAFT_LIMITS.titles);
  });

  it('puts every text past LONG_TEXT_CHARS last, each set in its order, so a run ended on one has embedded the rest', () => {
    const firstLong = texts.findIndex((t) => t.text.length > LONG_TEXT_CHARS);
    expect(firstLong).toBeGreaterThan(0);
    expect(texts.slice(firstLong).every((t) => t.text.length > LONG_TEXT_CHARS)).toBe(true);
    const sentences = texts.filter((t) => t.id.startsWith('S')).map((t) => Number(t.id.slice(1)));
    expect(sentences).toEqual([...sentences].sort((a, b) => a - b));
    // The digest holds the texts, not their order.
    expect(planDigest([...texts].reverse())).toBe(planDigest(texts));
    expect(planDigest(texts.map((t, i) => (i ? t : { ...t, text: `${t.text} ` })))).not.toBe(planDigest(texts));
  });

  it('holds an awkward claim the draft check would refuse (past 120 characters as sent) as no longer one text', () => {
    for (const m of meta.filter((x) => x.cleanId && x.set === 'awkward')) {
      const text = texts.find((t) => t.id === m.id)!.text;
      const clean = texts.find((t) => t.id === m.cleanId)!.text;
      const claimLike = meta.find((x) => x.id === m.cleanId)?.set === 'claim';
      if (claimLike && !planeTakesClaim(text)) expect(m.planeSame).toBe(false);
      if (claimLike && m.planeSame) expect(planeClaim(text)).toBe(planeClaim(clean));
    }
  });

  it('is the same plan for the same inputs', () => {
    expect(buildPlan({ fixtures: FIXTURES, rows, regions }).plan).toEqual(plan);
  });
});

describe('the variants and the plane', () => {
  it('misspells and abbreviates as a CV does', () => {
    const r = seeded(1);
    const m = misspell('Eletricista Offshore', r)!;
    expect(m).not.toBe('Eletricista Offshore');
    expect([...m].sort().join('')).toBe([...'Eletricista Offshore'].sort().join(''));
    expect(misspell('NR', r)).toBeNull();
    expect(abbreviate('Técnico em Segurança do Trabalho')).toBe('Téc. em Seg. do Trabalho');
    expect(abbreviate('Soldador')).toBeNull();
  });

  it("holds a claim and a sentence as the plane does: NFC, and a claim's white space as one space", () => {
    expect(planeClaim('  Técnico\tem\n  segurança ')).toBe('Técnico em segurança');
    expect(planeClaim('Técnico'.normalize('NFD'))).toBe('Técnico');
    expect(planeSentence(' Need  a welder ')).toBe('Need  a welder');
    // The draft check measures a claim as sent: NFD can carry a claim of 120 characters past it.
    const accented = 'é'.repeat(DRAFT_LIMITS.chars);
    expect(planeTakesClaim(accented)).toBe(true);
    expect(planeTakesClaim(accented.normalize('NFD'))).toBe(false);
  });
});

describe('the scoring', () => {
  it("reads a phone's base64 float32 vector", () => {
    const v = Float32Array.from([0.5, -0.25, 0.125]);
    expect(Array.from(decodeVector(Buffer.from(v.buffer).toString('base64')))).toEqual([0.5, -0.25, 0.125]);
  });

  it('reads the nearest labels as the plane does: each token at its best, scoped to the languages, the five for Clef', () => {
    const m = (token: string, score: number, lang = 'en') => ({ score, metadata: { token, lang } });
    const s = snapOf([m('pos:a', 0.9), m('pos:b', 0.95, 'es'), m('pos:a', 0.97, 'de'), m('pos:c', 0.5), m('pos:d', 0.4), m('pos:e', 0.3), m('pos:f', 0.2)], ['pt', 'en'])!;
    expect(s.token).toBe('pos:a');
    expect(s.score).toBe(0.97);
    // Its best label is German: τ_auto reads its best in Portuguese or English.
    expect(s.scoped).toBe(0.9);
    expect(s.scores.get('pos:b')).toBe(0.95);
    expect(s.candidates).toEqual(['pos:a', 'pos:b', 'pos:c', 'pos:d', 'pos:e']);
    expect(snapOf([])).toBeNull();
  });

  const t = { auto: 0.96, low: 0.81 };
  /** A snap from its tokens' best scores, the first the best; `scoped` defaults to the best. */
  const snapFrom = (scores: [string, number][], scoped?: number | null): Snap => ({
    token: scores[0]![0],
    score: scores[0]![1],
    scoped: scoped === undefined ? scores[0]![1] : scoped,
    scores: new Map(scores),
    candidates: scores.slice(0, 5).map(([k]) => k),
  });

  it('passes another step only within 0.001 of the threshold between them, τ_auto read on the scoped score', () => {
    expect(sameDecision(snapFrom([['a', 0.97], ['b', 0.9]]), snapFrom([['a', 0.9701], ['b', 0.9]]), t)).toEqual({ ok: true, flip: null, passed: false });
    expect(sameDecision(snapFrom([['a', 0.9604], ['b', 0.9]]), snapFrom([['a', 0.9598], ['b', 0.9]]), t)).toEqual({ ok: true, flip: 'side', passed: true });
    expect(sameDecision(snapFrom([['a', 0.962], ['b', 0.9]]), snapFrom([['a', 0.958], ['b', 0.9]]), t)).toMatchObject({ ok: false, flip: 'side' });
    // The same best score, but one side's best label in the string's languages is under τ_auto: taken against the band.
    expect(sameDecision(snapFrom([['a', 0.97]], 0.97), snapFrom([['a', 0.97]], 0.95), t)).toMatchObject({ ok: false, flip: 'side' });
    expect(sameDecision(snapFrom([['a', 0.97]], 0.95), snapFrom([['a', 0.9702]], 0.9502), t)).toEqual({ ok: true, flip: null, passed: false });
    expect(sameDecision(snapFrom([['a', 0.8104]]), snapFrom([['a', 0.8097]]), t)).toEqual({ ok: true, flip: 'side', passed: true });
    // Taken at τ_auto against left under τ_low: both thresholds lie between them.
    expect(sameDecision(snapFrom([['a', 0.97]]), snapFrom([['a', 0.8]]), t)).toMatchObject({ ok: false, flip: 'side' });
    // No snap reads the tier-2 floor: under τ_low on both sides, the floor between them changes nothing.
    expect(sameDecision(snapFrom([['a', 0.6512]]), snapFrom([['a', 0.6496]]), t)).toEqual({ ok: true, flip: null, passed: false });
  });

  it("passes a different token only on a tie, each side's token within 0.001 of the other's, and still holds it to the sides", () => {
    expect(sameDecision(snapFrom([['a', 0.9], ['b', 0.8995]]), snapFrom([['b', 0.9], ['a', 0.8996]]), t)).toEqual({ ok: true, flip: 'token', passed: true });
    // Not each other's runner-up within 0.001.
    expect(sameDecision(snapFrom([['a', 0.9], ['b', 0.85]]), snapFrom([['b', 0.9], ['a', 0.85]]), t)).toMatchObject({ ok: false, flip: 'token' });
    // The review's first case: a near tie on each side, but one is taken at τ_auto and the other goes to the band.
    expect(sameDecision(snapFrom([['x', 0.9612], ['y', 0.9606]]), snapFrom([['y', 0.9598], ['x', 0.9593]]), t)).toMatchObject({ ok: false, flip: 'side' });
    // Its second: another token 0.03 higher, which the Mac's nearest do not hold near the top.
    expect(sameDecision(snapFrom([['x', 0.9], ['w', 0.8995]]), snapFrom([['z', 0.93], ['v', 0.9295]]), t)).toMatchObject({ ok: false, flip: 'token' });
    // Under τ_low the next step reads the string, not the token: a different one changes nothing.
    expect(sameDecision(snapFrom([['x', 0.7], ['y', 0.6985]]), snapFrom([['y', 0.7003], ['x', 0.699]]), t)).toEqual({ ok: true, flip: null, passed: false });
  });

  it('holds a band snap to the candidates Clef is shown', () => {
    const mac: [string, number][] = [['a', 0.9], ['b', 0.88], ['c', 0.86], ['d', 0.85], ['e', 0.84], ['f', 0.838]];
    const phone: [string, number][] = [['a', 0.9], ['b', 0.88], ['c', 0.86], ['d', 0.85], ['f', 0.843], ['e', 0.838]];
    expect(sameDecision(snapFrom(mac), snapFrom(phone), t)).toEqual({ ok: false, flip: 'candidates', passed: false });
    const tie: [string, number][] = [['a', 0.9], ['b', 0.88], ['c', 0.86], ['d', 0.85], ['f', 0.8401], ['e', 0.8399]];
    expect(sameDecision(snapFrom([...mac.slice(0, 5), ['f', 0.8395]]), snapFrom(tie), t)).toEqual({ ok: true, flip: 'candidates', passed: true });
    // Taken at τ_auto, the candidates do not matter.
    expect(sameDecision(snapFrom([['a', 0.97], ['b', 0.5]]), snapFrom([['a', 0.97], ['c', 0.5]]), t)).toEqual({ ok: true, flip: null, passed: false });
  });

  it("compares the candidates Clef is shown, a swap at the fifth place passed only as a tie", () => {
    const five: [string, number][] = [['a', 0.9], ['b', 0.88], ['c', 0.86], ['d', 0.85], ['e', 0.84], ['f', 0.8395]];
    const swapped: [string, number][] = [['a', 0.9], ['b', 0.88], ['c', 0.86], ['d', 0.85], ['f', 0.8401], ['e', 0.8399]];
    expect(sameCandidates(snapFrom(five), snapFrom(five))).toEqual({ same: true, atEdge: false });
    expect(sameCandidates(snapFrom(five), snapFrom(swapped))).toEqual({ same: false, atEdge: true });
    const far: [string, number][] = [['a', 0.9], ['b', 0.88], ['c', 0.86], ['d', 0.85], ['g', 0.845], ['e', 0.8]];
    expect(sameCandidates(snapFrom(five), snapFrom(far))).toEqual({ same: false, atEdge: false });
  });

  it('counts a broken vector as below the bar: a NaN cosine, or two widths', () => {
    expect(spread([0.99999, NaN, 0.99995], 0.9998)).toMatchObject({ n: 3, below: 1 });
    expect(Number.isNaN(spread([0.99999, NaN], 0.9998).min)).toBe(true);
    expect(spread([], 0.9998)).toMatchObject({ n: 0, below: 0 });
    expect(cosine([1, 0, 0], [1, 0])).toBeNaN();
    expect(cosine([0, 0], [1, 0])).toBeNaN();
    expect(cosine([1, 0], [1, 0])).toBe(1);
  });

  it('compares two top lists: the same documents, the same sides of the floor, a swap at the edge passed', () => {
    const a = [
      { id: 'x', score: 0.8 },
      { id: 'y', score: 0.7 },
    ];
    expect(sameTop(a, a, 0.65)).toEqual({ ok: true, flips: 0, passed: 0 });
    expect(sameTop(a, [{ id: 'x', score: 0.8 }, { id: 'z', score: 0.6995 }], 0.65)).toEqual({ ok: true, flips: 2, passed: 2 });
    expect(sameTop(a, [{ id: 'x', score: 0.8 }, { id: 'z', score: 0.6 }], 0.65).ok).toBe(false);
    expect(sameTop([{ id: 'x', score: 0.6504 }], [{ id: 'x', score: 0.6498 }], 0.65)).toEqual({ ok: true, flips: 1, passed: 1 });
  });
});
