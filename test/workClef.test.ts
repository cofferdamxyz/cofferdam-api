// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  documentQuestions,
  documentState,
  needQuestions,
  readRequest,
  requestQuestions,
  requestState,
  UNSAFE_FLOOR,
} from '../src/services/work/clef.js';
import { checkBlock, type DeidentifiedBlock } from '../src/services/work/blocks.js';

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

  it('labels each block with its kind in the document state', () => {
    const block = (text: string, kind: string) => (checkBlock({ kind, lang: 'en', text }) as { ok: true; block: DeidentifiedBlock }).block;
    expect(documentState([block('Plumber with 12 years.', 'summary'), block('Invoice [ID_1]', 'body')])).toBe('[summary]\nPlumber with 12 years.\n\n[body]\nInvoice [ID_1]');
    expect(Object.keys((documentQuestions().document as { criteria: Record<string, string> }).criteria)).toEqual(['cv', 'certificate', 'licence', 'passport', 'other']);
  });
});
