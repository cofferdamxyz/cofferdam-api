// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { adjudicationQuestions, adjudicationState, clefInput } from '../src/services/work/clef.js';
import { fieldsRequest } from '../src/services/work/fields.js';
import { PIVOT_FIELDS, type Candidate } from '../src/services/work/registry.js';
import { armsOf, bandKey, judgeMessages, judgePick, marketPhrases, namesMarket, stringKey, termRelation, withoutMarket } from './work-eval/localeArms.js';

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
});
