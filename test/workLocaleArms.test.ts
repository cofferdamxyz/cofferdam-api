// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { adjudicationQuestions, adjudicationState, clefInput } from '../src/services/work/clef.js';
import { fieldsRequest } from '../src/services/work/fields.js';
import { PIVOT_FIELDS, type Candidate } from '../src/services/work/registry.js';
import { armsOf, bandKey, causeOf, judgeMessages, judgePick, marketPhrases, namesMarket, signTest, stringKey, termRelation, withBandRetries, withoutMarket, type ArmSnap } from './work-eval/localeArms.js';

// The real-vacancy benchmark's markets (`test/workJobs.eval.test.ts`, REGIONS).
const REGIONS = ['us-tx', 'us-la', 'us-fl', 'br-rj', 'br-sp', 'mx-nle', 'mx-cam', 'mx-ver'];
const LOCALES = (['en', 'pt', 'es'] as const).flatMap((lang) => REGIONS.map((region) => ({ lang, region })));
const PIVOT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const CLEF_MODEL = '@cf/cloudflare/clef';

describe('the locale arms of the real-vacancy benchmark', () => {
  it('reads JOBS_ARMS: production by default, both arms in the order given, nothing else', () => {
    expect(armsOf(undefined)).toEqual(['market']);
    expect(armsOf('market, language')).toEqual(['market', 'language']);
    expect(armsOf('language')).toEqual(['language']);
    for (const bad of ['', 'markets', 'market,market', 'market,language,before']) expect(() => armsOf(bad), bad).toThrow(/JOBS_ARMS/);
  });

  it('sends Clef what production sends of the string without a market, and changes nothing else', () => {
    const phrases = marketPhrases(LOCALES);
    const candidates: Candidate[] = [
      { token: 'pos:plumber', labelEn: 'plumber', matched: 'canalizador', matchedLang: 'pt', score: 0.88 },
      { token: 'pos:firefighter', labelEn: 'firefighter', matched: 'bombeiro', matchedLang: 'pt', score: 0.86 },
      { token: 'pos:cargo-vehicle-driver', labelEn: 'cargo vehicle driver', matched: 'truck driver', matchedLang: 'en', matchedRegion: 'us', score: 0.84 },
    ];
    for (const { lang, region } of LOCALES) {
      for (const kind of ['pos', 'skill'] as const) {
        const questions = adjudicationQuestions(kind, candidates, { labelLocales: true });
        const production = clefInput(CLEF_MODEL, adjudicationState(kind, 'Bombeiro hidráulico', { lang, market: region }), questions);
        expect(namesMarket(production), `${lang} ${region}`).toBe(true);
        const sent = withoutMarket(production, phrases);
        expect(sent, `${lang} ${region}`).toEqual(clefInput(CLEF_MODEL, adjudicationState(kind, 'Bombeiro hidráulico', { lang }), questions));
        expect(namesMarket(sent)).toBe(false);
        // The candidates keep their labels' locales: "matched "truck driver", American English" is no market of the worker's.
        expect(JSON.stringify(sent)).toContain('American English');
      }
    }
    // Production's own phrase without a market is left as it is.
    const hirer = clefInput(CLEF_MODEL, adjudicationState('pos', 'Encanador', { lang: 'pt' }), {});
    expect(withoutMarket(hirer, phrases)).toEqual(hirer);
  });

  it('sends the pivot the message production sends without a market, under the same system prompt', () => {
    const phrases = marketPhrases(LOCALES);
    const request = (user: string) => fieldsRequest(PIVOT_MODEL, PIVOT_FIELDS, { name: 'pivot', system: 'You name it in English, with the language it is written in and, when known, where the worker who wrote it is.', user, state: 'Montacarguista' });
    for (const { lang, region } of LOCALES) {
      const production = request(adjudicationState('pos', 'Montacarguista', { lang, market: region }));
      const sent = withoutMarket(production, phrases);
      expect(sent, `${lang} ${region}`).toEqual(request(adjudicationState('pos', 'Montacarguista', { lang })));
      expect(namesMarket(sent)).toBe(false);
    }
  });

  it('has no phrase for a market that is not a region, and leaves a request with no market alone', () => {
    expect(marketPhrases([{ lang: 'es', region: 'mexico' }]).size).toBe(0);
    const phrases = marketPhrases([{ lang: 'es', region: 'mx-nle' }]);
    expect([...phrases]).toEqual([['written in Mexican Spanish by a worker in Mexico (mx-nle)', 'written in Spanish by a worker or a hirer']]);
    const other = { messages: [{ role: 'user', content: 'Soldador TIG, Monterrey' }], max_tokens: 5 };
    expect(withoutMarket(other, phrases)).toEqual(other);
  });

  it('reads the string a band request is about, the same in both arms, by its exact spelling', () => {
    const phrases = marketPhrases(LOCALES);
    const state = adjudicationState('skill', 'Manutenção  Elétrica', { lang: 'pt', market: 'br-rj' });
    const key = stringKey('skill', 'pt', 'Manutenção Elétrica');
    expect(bandKey({ state })).toBe(key);
    expect(bandKey(withoutMarket({ state }, phrases))).toBe(key);
    expect(bandKey({ messages: [{ role: 'system', content: 'Fields: english' }, { role: 'user', content: state }] })).toBe(key);
    // Two spellings of one label are two strings: the arms may snap them in either order.
    expect(bandKey(adjudicationState('pos', 'Welder', { lang: 'en', market: 'us-tx' }))).toBe(stringKey('pos', 'en', 'Welder'));
    expect(stringKey('pos', 'en', 'Welder')).not.toBe(stringKey('pos', 'en', 'WELDER'));
    expect(bandKey(adjudicationState('cert', 'NR-10', { lang: 'pt' }))).toBe(stringKey('cert', 'pt', 'NR-10'));
    expect(bandKey({ messages: [{ role: 'user', content: 'Soldador TIG' }] })).toBeNull();
  });

  it('reads a leak only in a band state, never in a claim or a sentence that says "by a worker in"', () => {
    expect(namesMarket({ state: adjudicationState('skill', 'Soldagem', { lang: 'pt', market: 'br-sp' }) })).toBe(true);
    expect(namesMarket({ messages: [{ role: 'user', content: adjudicationState('pos', 'Montacarguista', { lang: 'es', market: 'mx-ver' }) }] })).toBe(true);
    expect(namesMarket({ state: adjudicationState('skill', 'Soldagem', { lang: 'pt' }) })).toBe(false);
    expect(namesMarket({ state: adjudicationState('skill', 'Tasks assigned by a worker in charge', { lang: 'en' }) })).toBe(false);
    expect(namesMarket({ messages: [{ role: 'user', content: 'Welder, supervised by a worker in Houston' }] })).toBe(false);
  });

  it('places a title’s token against the term that found its ad', () => {
    expect(termRelation('soldador', '7212')).toBe('right');
    expect(termRelation('welder', '7214')).toBe('near');
    expect(termRelation('plumber', '7115')).toBe('industry');
    expect(termRelation('plumber', '7411')).toBe('far');
    expect(termRelation('truck driver', '2221')).toBe('far');
    expect(termRelation('registered nurse', '3221')).toBe('right');
    expect(termRelation('welder', null)).toBeNull();
    expect(termRelation('astronaut', '7212')).toBeNull();
  });

  it('asks the judge with the ad’s words and every token by English name only, and reads its pick', () => {
    const [system, user] = judgeMessages({
      kind: 'pos',
      raw: 'Bombeiro hidráulico',
      lang: 'pt',
      region: 'br-sp',
      title: 'Bombeiro Hidráulico',
      excerpt: 'Instalação e reparo de tubulações de água e esgoto.',
      entries: ['firefighter', 'plumber'],
    });
    expect(system!.content).toContain('registry of occupations');
    expect(user!.content).toContain('An occupation from a job ad in Brazil (br-sp), written in Portuguese:\nBombeiro hidráulico');
    expect(user!.content).toContain('- e0: firefighter\n- e1: plumber\n- none: None of these: a different occupation');
    expect(user!.content).not.toMatch(/market|language arm|Clef/i);
    expect(judgePick('{"match": "e1", "reason": "pipes, not fires"}', 2)).toEqual({ pick: 1, reason: 'pipes, not fires' });
    expect(judgePick('{"match": "none", "reason": "a \\"helper\\" role"}', 2)).toEqual({ pick: 'none', reason: 'a "helper" role' });
    expect(judgePick('{"match": "e2"}', 2).pick).toBeNull();
    expect(judgePick('plumber', 2).pick).toBeNull();
  });

  it('tries a failed band call again twice, never a cancelled one or another op, and throws the third failure', async () => {
    const waits: number[] = [];
    const wait = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    const failing = (failures: number) => {
      let n = 0;
      const run = () => (++n <= failures ? Promise.reject(new Error(`work-adjudicate gave no answer within\n6000 ms (${n})`)) : Promise.resolve('answer'));
      return { run, count: () => n };
    };
    const heard: [string, boolean][] = [];
    const onError = (e: string, final: boolean) => heard.push([e, final]);

    const once = failing(1);
    await expect(withBandRetries('work-adjudicate', undefined, once.run, onError, wait)).resolves.toBe('answer');
    expect([once.count(), heard, waits]).toEqual([2, [['work-adjudicate gave no answer within 6000 ms (1)', false]], [1_000]]);

    heard.length = 0;
    waits.length = 0;
    const always = failing(9);
    await expect(withBandRetries('work-pivot', {}, always.run, onError, wait)).rejects.toThrow('(3)');
    expect([always.count(), heard.map(([, f]) => f), waits]).toEqual([3, [false, false, true], [1_000, 2_000]]);

    heard.length = 0;
    const cancelled = failing(9);
    const ctl = new AbortController();
    ctl.abort();
    await expect(withBandRetries('work-pivot', { signal: ctl.signal }, cancelled.run, onError, wait)).rejects.toThrow('(1)');
    const other = failing(9);
    await expect(withBandRetries('work-decide', undefined, other.run, onError, wait)).rejects.toThrow('(1)');
    expect([cancelled.count(), other.count(), heard]).toEqual([1, 1, []]);
  });

  it('puts each difference between the market arm and the language arm down to its first cause, on pairs the registry can make', () => {
    const nearest = ['skill:a', 'skill:b', 'skill:c'];
    const band = (outcome: string, entries = 'the nearest') => ({ entries, outcome });
    const snap = (over: Partial<ArmSnap>): ArmSnap => ({ decision: 'chosen', token: 'skill:a', nearest, clef: band('c0'), pivot: null, failed: false, overlapped: false, ...over });
    const named = (english: string | null) => ({ pivot: { english } });

    // A failed call says nothing of the market, whatever else differs; two snaps at once leave the answers unknown.
    expect(causeOf(snap({ failed: true }), snap({ nearest: ['skill:z'], token: 'skill:z' }))).toBe('failed');
    expect(causeOf(snap({}), snap({ overlapped: true, clef: band('c1'), token: 'skill:b' }))).toBe('overlap');
    // Other nearest candidates: an arm's earlier mint is behind it, even with the names differing.
    expect(causeOf(snap(named('x')), snap({ ...named('y'), nearest: ['skill:b', 'skill:a', 'skill:c'], token: 'skill:b' }))).toBe('registry');

    // The same band, two picks: the market in Clef's state, whatever the names.
    expect(causeOf(snap(named('x')), snap({ ...named('y'), clef: band('c1'), token: 'skill:b' }))).toBe('Clef');
    // A pick in the market arm against Clef's none in the language arm, which minted its name: the market in Clef's
    // state when the names agree (an English string's market arm, which picked, never asked the pivot: its name is
    // unknown, and counted as the same) ...
    const minted = (english: string) => ({ ...named(english), clef: band('none'), decision: 'minted', token: `skill:${english}` });
    expect(causeOf(snap(named('x')), snap(minted('x')))).toBe('Clef');
    expect(causeOf(snap({}), snap(minted('y')))).toBe('Clef');
    // ... and both moved when the names differ: the market's name would have gone on past Clef instead.
    expect(causeOf(snap(named('x')), snap(minted('y')))).toBe('Clef and pivot');
    // The other way round, the language arm picked: the market for the pivot alone would pick as it did.
    expect(causeOf(snap(minted('x')), snap(named('y')))).toBe('Clef');
    // Under the floor, step 3 took the token the arm's name named among the nearest (so no entry was added).
    const tookC = { ...named('c'), clef: band('neither'), decision: 'pivot', token: 'skill:c' };
    expect(causeOf(snap({ ...named('y'), clef: band('c1'), token: 'skill:b' }), snap(tookC))).toBe('Clef and pivot');
    expect(causeOf(snap(tookC), snap({ ...named('y'), clef: band('c1'), token: 'skill:b' }))).toBe('Clef');
    // The band differs by the token one name named, the names differing: both moved.
    expect(causeOf(snap({ ...named('x'), clef: band('c3', 'with the name'), token: 'skill:x' }), snap(named('y')))).toBe('Clef and pivot');
    // The same name, its token in one arm's band only: an earlier snap of that arm made the token.
    expect(causeOf(snap({ ...named('x'), clef: band('c3', 'with the name'), token: 'skill:x' }), snap(named('x')))).toBe('registry');

    // Clef answered alike, under its floor: step 3 took one name's token and found none for the other (no mint there).
    const under = band('neither');
    expect(causeOf(snap({ ...named('x'), clef: under, decision: 'pivot', token: 'skill:x' }), snap({ ...named('y'), clef: under, decision: 'unmatched', token: null }))).toBe('pivot');
    // Clef's none in both: one name minted, the other named a token among the nearest, which the none refused.
    const none = band('none');
    expect(causeOf(snap({ ...named('x'), clef: none, decision: 'minted', token: 'skill:x' }), snap({ ...named('b'), clef: none, decision: 'unmatched', token: null }))).toBe('pivot');
    // No band in either arm: the names decide alone, one of them refused as no valid name.
    expect(causeOf(snap({ ...named('x'), clef: null, decision: 'minted', token: 'skill:x' }), snap({ ...named(null), clef: null, decision: 'unmatched', token: null }))).toBe('pivot');
    // The same name under the floor in both, its token minted earlier in one arm only: the registry.
    expect(causeOf(snap({ ...named('x'), clef: under, decision: 'pivot', token: 'skill:x' }), snap({ ...named('x'), clef: under, decision: 'unmatched', token: null }))).toBe('registry');
    // Clef asked in one arm only, which the same nearest should not allow: counted as the registry.
    expect(causeOf(snap({}), snap({ clef: null, decision: 'auto', token: 'skill:b' }))).toBe('registry');
  });

  it('weighs a split between the arms with the exact two-sided sign test', () => {
    expect(signTest(0, 0)).toBe(1);
    expect(signTest(5, 5)).toBe(1);
    expect(signTest(0, 10)).toBeCloseTo(2 / 1024, 12);
    expect(signTest(8, 2)).toBeCloseTo(112 / 1024, 12);
    expect(signTest(2, 8)).toBe(signTest(8, 2));
    // Large splits stay finite where 2^n would not.
    expect(signTest(600, 600)).toBe(1);
    expect(signTest(700, 500)).toBeGreaterThan(0);
    expect(signTest(700, 500)).toBeLessThan(1e-7);
  });
});
