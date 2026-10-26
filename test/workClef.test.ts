// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  adjudicationState,
  certificateState,
  documentQuestions,
  documentState,
  needQuestions,
  readRequest,
  requestQuestions,
  requestState,
  UNSAFE_FLOOR,
} from '../src/services/work/clef.js';
import { checkBlock, type DeidentifiedBlock } from '../src/services/work/blocks.js';
import { labelLocale, languageName, writtenIn } from '../src/services/work/locale.js';

const answers = (a: Record<string, unknown>) => ({ answers: a });

describe('the Clef catalogue', () => {
  it('asks the safety checks and the scope first, in one call, about the sentence only', () => {
    expect(Object.keys(requestQuestions())).toEqual(['harmful', 'injection', 'scope']);
    expect(requestQuestions().scope).toMatchObject({ type: 'choice', criteria: { onsite: expect.any(String), remote: expect.any(String) } });
    expect(requestState('Weekly gardener, $60 each visit.', 'en')).toBe('A hirer wrote this request, in en:\nWeekly gardener, $60 each visit.');
  });

  it('refuses above either safety floor, harmful first, and reads a missing check as no reading at all', () => {
    const scope = { type: 'choice', choice: 'remote', probabilities: { remote: 0.8, onsite: 0.2 } };
    expect(readRequest(answers({ harmful: { noul: 0.1 }, injection: { noul: 0.2 }, scope }))).toEqual({ ok: true, refuse: null, harmful: 0.1, injection: 0.2, scope: 'remote', scopeP: 0.8 });
    expect(readRequest(answers({ harmful: { noul: 0.9 }, injection: { noul: 0.95 }, scope }))).toMatchObject({ refuse: 'harmful' });
    expect(readRequest(answers({ harmful: { noul: UNSAFE_FLOOR }, injection: { noul: 0.51 }, scope }))).toMatchObject({ refuse: 'injection' });
    expect(readRequest(answers({ harmful: { noul: 0.1 }, scope }))).toEqual({ ok: false });
    expect(readRequest(null)).toEqual({ ok: false });
  });

  it('keeps the scope on-site when Clef is unsure, so a job never widens to the world by default', () => {
    const unsure = { type: 'choice', choice: 'remote', probabilities: { remote: 0.45, onsite: 0.4 } };
    expect(readRequest(answers({ harmful: { noul: 0.1 }, injection: { noul: 0.1 }, scope: unsure }))).toMatchObject({ scope: 'onsite', scopeP: 0.45 });
  });

  it('asks one yes or no per candidate token, in words fit for an occupation or a skill', () => {
    const q = needQuestions([
      { token: 'pos:plumber', label: 'plumber', kind: 'pos' },
      { token: 'skill:leak-repair', label: 'leak repair', kind: 'skill' },
    ]);
    expect(q).toEqual({
      need_0: { type: 'noul', instructions: 'Does this job need a plumber?' },
      need_1: { type: 'noul', instructions: 'Does this job need someone who can do leak repair?' },
    });
    expect(JSON.stringify(q)).not.toMatch(/pos:|skill:/);
  });

  it('names a registry string’s locale: its language, and a worker’s variant and market, the region’s code where the country is not listed', () => {
    expect(writtenIn({ lang: 'pt', market: 'br-sp' })).toBe('written in Brazilian Portuguese by a worker in Brazil (br-sp)');
    expect(writtenIn({ lang: 'es', market: 'mx' })).toBe('written in Mexican Spanish by a worker in Mexico (mx)');
    expect(writtenIn({ lang: 'en', market: 'us-tx' })).toBe('written in American English by a worker in the United States (us-tx)');
    expect(writtenIn({ lang: 'pt', market: 'pt-11' })).toBe('written in European Portuguese by a worker in Portugal (pt-11)');
    // A language the country does not speak is the language alone, said beside the market.
    expect(writtenIn({ lang: 'en', market: 'br-sp' })).toBe('written in English by a worker in Brazil (br-sp)');
    expect(writtenIn({ lang: 'es', market: 'us-tx' })).toBe('written in Spanish by a worker in the United States (us-tx)');
    expect(writtenIn({ lang: 'es', market: 'co' })).toBe('written in Spanish by a worker in Colombia (co)');
    expect(writtenIn({ lang: 'pt', market: 'de-by' })).toBe('written in Portuguese by a worker in de-by');
    // Without a market, or with one that is not a region, the language alone.
    expect(writtenIn({ lang: 'pt' })).toBe('written in Portuguese by a worker or a hirer');
    expect(writtenIn({ lang: 'pt', market: 'São Paulo' })).toBe('written in Portuguese by a worker or a hirer');
    expect(languageName('es', 'mx-nle')).toBe('Mexican Spanish');
    expect(languageName('es')).toBe('Spanish');
    expect(adjudicationState('pos', 'Encanador', { lang: 'pt', market: 'br-sp' })).toBe('An occupation written in Brazilian Portuguese by a worker in Brazil (br-sp):\nEncanador');
    expect(adjudicationState('skill', 'Soldagem TIG', { lang: 'pt' })).toBe('A skill written in Portuguese by a worker or a hirer:\nSoldagem TIG');
    // The certificate band's state is as it was: it reads no market.
    expect(certificateState('NR-10 Básico', 'pt')).toBe('A certificate or licence as a worker or a hirer wrote it, in pt:\nNR-10 Básico');
  });

  it('names a matched label’s language, and a national layer’s region', () => {
    expect(labelLocale('es')).toBe('Spanish');
    expect(labelLocale('pt', null)).toBe('Portuguese');
    expect(labelLocale('en', 'us')).toBe('American English');
    expect(labelLocale('pt', 'br')).toBe('Brazilian Portuguese');
    expect(labelLocale('es', 'mx')).toBe('Mexican Spanish');
    expect(labelLocale('es', 'co')).toBe('Spanish, Colombia');
    expect(labelLocale('en', 'not a region')).toBe('English');
    expect(labelLocale(null, 'us')).toBeNull();
  });

  it('labels each block with its kind in the document state', () => {
    const block = (text: string, kind: string) => (checkBlock({ kind, lang: 'en', text }) as { ok: true; block: DeidentifiedBlock }).block;
    expect(documentState([block('Plumber with 12 years.', 'summary'), block('Invoice [ID_1]', 'body')])).toBe('[summary]\nPlumber with 12 years.\n\n[body]\nInvoice [ID_1]');
    expect(Object.keys((documentQuestions().document as { criteria: Record<string, string> }).criteria)).toEqual(['cv', 'certificate', 'licence', 'passport', 'other']);
  });
});
