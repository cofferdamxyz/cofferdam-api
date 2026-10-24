// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { INTENT_FIELDS, intentRequest, parseIntent } from '../src/services/work/intent.js';
import { clairicResult, fakeInference, jsonModeResult, type FakeCall } from './fixtures/work/fakes.js';
import { HIRER_PROMPTS } from './fixtures/work/index.js';

const LLAMA = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const prompt = (id: string) => HIRER_PROMPTS.find((p) => p.id === id)!.text;

describe('parseIntent', () => {
  it('extracts spans and a dollar budget from a hirer’s sentence', async () => {
    const calls: FakeCall[] = [];
    const answer = { task: 'kitchen sink is leaking under the cabinet', when: 'today after 2pm', budget: 120, credential: null, language: null, recurrence: null };
    const out = await parseIntent(fakeInference({ 'work-intent': jsonModeResult(answer) }, calls), prompt('sink-en'));
    expect(out).toMatchObject({
      ok: true,
      model: LLAMA,
      violations: [],
      intent: { task: 'kitchen sink is leaking under the cabinet', when: 'today after 2pm', budgetUsd: 120, credential: null, languageCode: null },
    });
    expect(calls.map((c) => c.op)).toEqual(['work-intent']);
    expect(JSON.stringify(calls[0]!.input)).not.toMatch(/account|0x/);
  });

  it('reads no budget from an amount in another currency, whatever the model says', async () => {
    const answer = { task: 'trocar uma torneira', when: 'amanhã cedo', budget: 300, credential: null, language: null, recurrence: null };
    const out = await parseIntent(fakeInference({ 'work-intent': jsonModeResult(answer) }), prompt('reais-pt'));
    expect(out).toMatchObject({ ok: true, intent: { budgetUsd: null }, violations: [{ field: 'budget', reason: 'other_currency' }] });
    const pesos = await parseIntent(fakeInference({ 'work-intent': jsonModeResult({ ...answer, task: null, when: null, budget: 1500 }) }), prompt('pesos-es'));
    expect(pesos.ok && pesos.intent.budgetUsd).toBeNull();
    const bare = await parseIntent(fakeInference({ 'work-intent': jsonModeResult({ ...answer, task: null, when: null, budget: 60 }) }), prompt('gardener-pt'));
    expect(bare.ok && bare.intent.budgetUsd).toBe(60);
  });

  it('maps the language span to its code and keeps Clairic’s spans', async () => {
    const out = await parseIntent(
      fakeInference({ 'work-intent': clairicResult({ task: 'translate a 12-page contract', when: 'by Monday', budget: 150, language: 'Spanish' }) }, [], { 'work-intent': '@cf/cloudflare/clairic' }),
      prompt('translation-en'),
    );
    expect(out).toMatchObject({ ok: true, intent: { language: 'Spanish', languageCode: 'es', budgetUsd: 150 } });
  });

  it('drops a span the sentence does not hold', async () => {
    const answer = { task: 'fix the plumbing', when: null, budget: 120, credential: null, language: null, recurrence: null };
    const out = await parseIntent(fakeInference({ 'work-intent': jsonModeResult(answer) }), prompt('sink-en'));
    expect(out).toMatchObject({ ok: true, intent: { task: null }, violations: [{ field: 'task', reason: 'not_a_span' }] });
  });

  it('refuses text the phone should have kept before any call, and falls back when the intent op fails', async () => {
    const calls: FakeCall[] = [];
    expect(await parseIntent(fakeInference({}, calls), 'Plumber needed, call (713) 555-0142')).toEqual({ ok: false, error: 'text_refused', reason: 'long_number', calls: [] });
    expect(await parseIntent(fakeInference({}, calls), '  ')).toMatchObject({ ok: false, reason: 'empty' });
    expect(calls).toEqual([]);
    const oss = { choices: [{ message: { content: JSON.stringify({ task: 'gardener', when: null, budget: 60, credential: null, language: null, recurrence: 'Weekly' }) } }] };
    const out = await parseIntent(fakeInference({ 'work-intent': new Error('down'), 'work-extract-fallback': oss }), prompt('gardener-en'));
    expect(out).toMatchObject({ ok: true, model: '@cf/openai/gpt-oss-120b', intent: { recurrence: 'Weekly', budgetUsd: 60 } });
    expect(await parseIntent(fakeInference({ 'work-intent': new Error('down'), 'work-extract-fallback': new Error('down') }), prompt('gardener-en'))).toMatchObject({
      ok: false,
      error: 'intent_failed',
    });
  });

  it('reads a sentence that went through the chat’s on-device gate, and never keeps a placeholder in a field', async () => {
    const text = 'Need a plumber today for a leak under the sink, $120, text me at [PHONE_1] or [EMAIL_1]';
    const answer = { task: 'a leak under the sink', when: 'today', budget: 120, credential: null, language: null, recurrence: '[PHONE_1]' };
    const out = await parseIntent(fakeInference({ 'work-intent': jsonModeResult(answer) }), text);
    expect(out).toMatchObject({ ok: true, intent: { task: 'a leak under the sink', recurrence: null, budgetUsd: 120 } });
    expect(out.ok && out.violations).toEqual([{ field: 'recurrence', reason: 'placeholder' }]);
  });

  it('holds the request to the intent schema', () => {
    const req = intentRequest(LLAMA, prompt('sink-en')) as { response_format: { json_schema: { required: string[] } } };
    expect(req.response_format.json_schema.required).toEqual(Object.keys(INTENT_FIELDS));
  });
});
