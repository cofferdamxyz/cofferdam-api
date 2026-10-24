// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { InferenceTimeout, MODEL_PRICES, OPS } from '../src/services/inference/index.js';
import { checkBlock, type DeidentifiedBlock } from '../src/services/work/blocks.js';
import { readChoice, readNoul, readScore } from '../src/services/work/clef.js';
import { assembleCv, CV_SCHEMA, languageCode, parseCvDate, type CvFragment } from '../src/services/work/cv.js';
import {
  BLOCK_SCHEMAS,
  classifyDocument,
  extractBlock,
  extractionRequest,
  readExtraction,
  toFragment,
  validateFields,
} from '../src/services/work/executor.js';
import { extractorFamily, jsonSchema, resolveSpan, usageOf, type WorkCall } from '../src/services/work/fields.js';
import { callCostMicroUsd, workUsageDeltas } from '../src/services/work/meter.js';
import { clairicResult, clefChoice, fakeInference, jsonModeResult, type FakeCall } from './fixtures/work/fakes.js';
import { fixtureBlocks } from './fixtures/work/index.js';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const LLAMA = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const CLAIRIC = '@cf/cloudflare/clairic';
const GPT_OSS = '@cf/openai/gpt-oss-120b';

function block(text: string, kind = 'experience', lang = 'en'): DeidentifiedBlock {
  const r = checkBlock({ kind, lang, text });
  if (!r.ok) throw new Error(`fixture refused: ${r.reason}`);
  return r.block;
}

const ENGINEER = block(
  'Third Assistant Engineer, [ORG_1], [PLACE_1]\nJun 2019 – Present\nStood engine room watches on DP2 platform supply vessels. Maintained main engines, ship service generators and purifiers, and kept the planned maintenance records.',
);

describe('parseCvDate', () => {
  it('reads the ways CVs write a month and a year, in three languages', () => {
    const cases: [string, string][] = [
      ['Jun 2019', '2019-06'],
      ['June 2019', '2019-06'],
      ['03/2018', '2018-03'],
      ['08/2016', '2016-08'],
      ['2019-06', '2019-06'],
      ['fev/2014', '2014-02'],
      ['ago. 2019', '2019-08'],
      ['abril de 2021', '2021-04'],
      ['Março de 2020', '2020-03'],
      ['ene. 2020', '2020-01'],
      ['mayo del 2021', '2021-05'],
      ['dic 2019', '2019-12'],
      ['2016', '2016'],
    ];
    for (const [span, date] of cases) expect(parseCvDate(span, NOW), span).toEqual({ present: false, date });
  });

  it('reads the words for a job that continues', () => {
    for (const span of ['Present', 'present', 'Current', 'atual', 'Atualmente', 'presente', 'actualidad', 'a la fecha', 'hoy'])
      expect(parseCvDate(span, NOW), span).toEqual({ present: true });
  });

  it('refuses days, ranges, years out of range and anything else', () => {
    for (const span of ['12/03/1990', 'Jun 2019 – Present', '1949', '2028', '13/2019', 'Smarch 2019', 'soon', ''])
      expect(parseCvDate(span, NOW), span).toBeNull();
  });
});

describe('languageCode', () => {
  it('maps language names in English, Portuguese and Spanish to ISO 639-1', () => {
    expect(languageCode('English')).toBe('en');
    expect(languageCode('Inglês')).toBe('en');
    expect(languageCode('Inglés (C2)')).toBe('en');
    expect(languageCode('Espanhol')).toBe('es');
    expect(languageCode('Español')).toBe('es');
    expect(languageCode('Portugués')).toBe('pt');
    expect(languageCode('Haitian Creole')).toBe('ht');
    expect(languageCode('Klingon')).toBeNull();
  });
});

describe('resolveSpan', () => {
  const text = 'Maintained main engines,\n  ship service generators and purifiers, and kept the planned maintenance records.';
  it('answers the block’s own text, ignoring runs of whitespace and case', () => {
    expect(resolveSpan(text, 'ship service generators')).toBe('ship service generators');
    expect(resolveSpan(text, 'engines, ship service')).toBe('engines, ship service');
    expect(resolveSpan(text, 'Kept the planned maintenance records')).toBe('kept the planned maintenance records');
  });
  it('refuses what the block does not say', () => {
    expect(resolveSpan(text, 'maintained the main engine')).toBeNull();
    expect(resolveSpan(text, 'kept planned maintenance records')).toBeNull();
    expect(resolveSpan(text, '   ')).toBeNull();
  });
  it('refuses a span that starts or ends inside a word, and takes a later one that does not', () => {
    expect(resolveSpan('Stood engine room watches', 'St')).toBeNull();
    expect(resolveSpan('Manutenção preventiva e corretiva', 'Manuten')).toBeNull();
    expect(resolveSpan('Manutenção preventiva e corretiva', 'reventiva')).toBeNull();
    expect(resolveSpan('Aparejador (Rigger) – [ORG_1]', 'Rigger')).toBe('Rigger');
    expect(resolveSpan('Stood watches; St Louis yard', 'St')).toBe('St');
  });
});

describe('the extraction request', () => {
  it('follows the pinned model’s family', () => {
    expect(extractorFamily(LLAMA)).toBe('json-mode');
    expect(extractorFamily(CLAIRIC)).toBe('clairic');
    expect(extractorFamily(GPT_OSS)).toBe('chat-json');
  });

  it('asks Clairic for typed fields and never for a name', () => {
    const req = extractionRequest(CLAIRIC, 'experience', ENGINEER) as { model: string; state: string; fields: Record<string, { type: string }> };
    expect(req.model).toBe('clairic');
    expect(req.state).toBe(ENGINEER.text);
    expect(Object.keys(req.fields)).toEqual(['title', 'rank', 'start', 'end', 'skills']);
    expect(req.fields.rank).toMatchObject({ type: 'number', decimals: 0 });
    expect(req.fields.skills).toMatchObject({ type: 'list', items: 'text' });
    expect(req.fields.start).toMatchObject({ type: 'text' });
  });

  it('holds a JSON-mode model to a schema with every field and nothing else', () => {
    const req = extractionRequest(LLAMA, 'experience', ENGINEER) as { response_format: { json_schema: Record<string, unknown> }; messages: { content: string }[]; temperature: number };
    expect(req.response_format.json_schema).toEqual(jsonSchema(BLOCK_SCHEMAS.experience));
    expect(req.response_format.json_schema).toMatchObject({ required: ['title', 'rank', 'start', 'end', 'skills'], additionalProperties: false });
    expect(req.temperature).toBe(0);
    expect(req.messages[1]!.content).toContain(ENGINEER.text);
    expect(JSON.stringify(req)).not.toMatch(/account|document|0x/i);
    const oss = extractionRequest(GPT_OSS, 'skills', block('Leak detection; Drain cleaning', 'skills')) as { response_format: { json_schema: { name: string; strict: boolean } } };
    expect(oss.response_format.json_schema).toMatchObject({ name: 'cv_skills', strict: true });
  });
});

describe('reading an answer', () => {
  it('reads JSON mode from `response`, from the message content, and refuses anything out of shape', () => {
    const answer = { title: 'Third Assistant Engineer', rank: 3, start: 'Jun 2019', end: 'Present', skills: [] };
    expect(readExtraction(LLAMA, 'experience', jsonModeResult(answer))).toMatchObject({ ok: true });
    expect(readExtraction(GPT_OSS, 'experience', { choices: [{ message: { content: JSON.stringify(answer) } }] })).toMatchObject({ ok: true });
    expect(readExtraction(LLAMA, 'experience', { response: 'not json' })).toEqual({ ok: false, reason: 'not_json' });
    expect(readExtraction(LLAMA, 'experience', { response: [] })).toEqual({ ok: false, reason: 'not_an_object' });
    expect(readExtraction(LLAMA, 'experience', { response: { ...answer, employer: '[ORG_1]' } })).toEqual({ ok: false, reason: 'unexpected_key' });
    expect(readExtraction(LLAMA, 'experience', { response: { title: 'x' } })).toEqual({ ok: false, reason: 'missing_key' });
  });

  it('keeps Clairic’s confidence and p_null with each field', () => {
    const read = readExtraction(CLAIRIC, 'experience', clairicResult({ title: 'Third Assistant Engineer', rank: null, skills: ['main engines'] }));
    expect(read).toMatchObject({ ok: true, fields: { title: { value: 'Third Assistant Engineer', confidence: 0.9, pNull: 0.01 }, start: { value: null } } });
    expect(readExtraction(CLAIRIC, 'experience', { usage: {} })).toEqual({ ok: false, reason: 'no_answers' });
  });

  it('reads usage in every shape Workers AI reports it', () => {
    expect(usageOf(jsonModeResult({}))).toEqual({ tokensIn: 360, tokensOut: 80, neurons: 26.7 });
    expect(usageOf(clairicResult({}))).toEqual({ tokensIn: 1350, tokensOut: 0, neurons: null });
    expect(usageOf({ meta: { cost_metric_value_1: 18, neurons: 0.0193 } })).toEqual({ tokensIn: 18, tokensOut: 0, neurons: 0.0193 });
    expect(usageOf(null)).toEqual({ tokensIn: 0, tokensOut: 0, neurons: null });
  });
});

describe('validateFields', () => {
  const raw = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: v }]));

  it('keeps spans as the block writes them and drops what is not in the block', () => {
    const { fields, violations } = validateFields(
      'experience',
      ENGINEER,
      raw({
        title: 'third assistant engineer',
        rank: 3,
        start: 'Jun 2019',
        end: 'Present',
        skills: ['Kept the planned maintenance records', 'engine room watches', 'Engine room watches', 'welding', '[ORG_1]'],
      }),
      NOW,
    );
    expect(fields.title!.value).toBe('Third Assistant Engineer');
    expect(fields.skills!.value).toEqual(['kept the planned maintenance records', 'engine room watches']);
    expect(violations).toEqual([
      { field: 'skills', reason: 'not_a_span' },
      { field: 'skills', reason: 'placeholder' },
    ]);
  });

  it('drops numbers out of range, unreadable dates and wrong types, never changing them', () => {
    const { fields, violations } = validateFields('experience', ENGINEER, raw({ title: 42, rank: 3.5, start: 'DP2', end: 'Present', skills: 'main engines' }), NOW);
    expect(fields).toMatchObject({ title: { value: null }, rank: { value: null }, start: { value: null }, end: { value: 'Present' }, skills: { value: null } });
    expect(violations.map((v) => `${v.field}:${v.reason}`)).toEqual(['title:not_a_string', 'rank:out_of_range', 'start:bad_date', 'skills:not_a_list']);
    expect(validateFields('summary', block('Plumber with 12 years.', 'summary'), raw({ title: 'Plumber', years: 120, skills: [] }), NOW).violations).toEqual([
      { field: 'years', reason: 'out_of_range' },
    ]);
  });
});

describe('toFragment', () => {
  it('reads names from the block’s placeholders and the end from the word for present', () => {
    const { fields } = validateFields('experience', ENGINEER, { title: { value: 'Third Assistant Engineer' }, rank: { value: 3 }, start: { value: 'Jun 2019' }, end: { value: 'Present' }, skills: { value: ['main engines'] } }, NOW);
    expect(toFragment('experience', ENGINEER, fields, NOW)).toEqual({
      kind: 'experience',
      experience: {
        title: { raw: 'Third Assistant Engineer', rank: 3 },
        employer: '[ORG_1]',
        location: '[PLACE_1]',
        start: '2019-06',
        end: null,
        current: true,
        skills: [{ raw: 'main engines' }],
      },
    });
  });

  it('gives each language its code and level', () => {
    const langs = block('Español (lengua materna); Inglés (C2); Portugués (básico)', 'languages', 'es');
    const { fields } = validateFields('languages', langs, { fluent: { value: ['Español', 'Inglés'] }, basic: { value: ['Portugués'] } }, NOW);
    expect(toFragment('languages', langs, fields, NOW)).toEqual({
      kind: 'languages',
      languages: [
        { raw: 'Español', code: 'es', level: 'fluent' },
        { raw: 'Inglés', code: 'en', level: 'fluent' },
        { raw: 'Portugués', code: 'pt', level: 'basic' },
      ],
    });
  });
});

describe('extractBlock', () => {
  const answer = { title: 'Third Assistant Engineer', rank: 3, start: 'Jun 2019', end: 'Present', skills: ['engine room watches'] };

  it('extracts on the primary and reports the call with its bill', async () => {
    const calls: FakeCall[] = [];
    const out = await extractBlock(fakeInference({ 'work-extract': jsonModeResult(answer) }, calls), ENGINEER, { now: () => NOW });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.extraction).toMatchObject({ kind: 'experience', schema: CV_SCHEMA, model: LLAMA, op: 'work-extract', violations: [] });
    expect(out.calls).toEqual([{ op: 'work-extract', model: LLAMA, ok: true, ms: 0, usage: { tokensIn: 360, tokensOut: 80, neurons: 26.7 } }]);
    expect(calls.map((c) => c.op)).toEqual(['work-extract']);
  });

  it('falls back when the primary fails or answers out of shape, and fails when both do', async () => {
    const log: Record<string, unknown>[] = [];
    const ossAnswer = { choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 390, completion_tokens: 260, neurons: 30.7 } };
    const timedOut = await extractBlock(
      fakeInference({ 'work-extract': new InferenceTimeout('work-extract', 20_000), 'work-extract-fallback': ossAnswer }),
      ENGINEER,
      { now: () => NOW, log: (l) => log.push(l) },
    );
    expect(timedOut).toMatchObject({ ok: true, extraction: { op: 'work-extract-fallback', model: GPT_OSS } });
    expect(log).toEqual([{ event: 'work_extract_failed', op: 'work-extract', model: LLAMA, kind: 'experience', reason: 'timeout' }]);

    const misshapen = await extractBlock(fakeInference({ 'work-extract': { response: 'nope' }, 'work-extract-fallback': ossAnswer }), ENGINEER, { now: () => NOW });
    expect(misshapen.ok && misshapen.extraction.op).toBe('work-extract-fallback');
    expect(misshapen.calls.map((c) => c.ok)).toEqual([false, true]);

    const both = await extractBlock(fakeInference({ 'work-extract': new Error('down'), 'work-extract-fallback': new Error('down') }), ENGINEER);
    expect(both).toMatchObject({ ok: false, error: 'extraction_failed' });
    expect(both.calls).toHaveLength(2);
  });

  it('switches to Clairic’s request when the pin is Clairic', async () => {
    const calls: FakeCall[] = [];
    const out = await extractBlock(
      fakeInference({ 'work-extract': clairicResult({ title: 'Third Assistant Engineer', rank: 3, start: 'Jun 2019', end: 'Present', skills: ['main engines'] }) }, calls, { 'work-extract': CLAIRIC }),
      ENGINEER,
      { now: () => NOW },
    );
    expect(calls[0]!.input).toMatchObject({ model: 'clairic', state: ENGINEER.text });
    expect(out.ok && out.extraction.fields.title).toEqual({ value: 'Third Assistant Engineer', confidence: 0.9, pNull: 0.01 });
  });

  it('takes no schema for a body block', async () => {
    const out = await extractBlock(fakeInference({}), block('Certificate of completion, [ORG_1], 2024', 'body'));
    expect(out).toEqual({ ok: false, error: 'kind_not_extractable', calls: [] });
  });
});

describe('classifyDocument', () => {
  const blocks = [ENGINEER];

  it('names the type above the floor, and only a CV gets a schema', async () => {
    const calls: FakeCall[] = [];
    const cv = await classifyDocument(fakeInference({ 'work-classify': clefChoice('document', 'cv', { cv: 0.97, certificate: 0.01 }) }, calls), blocks);
    expect(cv).toMatchObject({ ok: true, type: 'cv', confidence: 0.97, schema: CV_SCHEMA });
    expect(calls[0]!.input).toMatchObject({ model: 'clef-flash' });
    expect(String(calls[0]!.input.state)).toContain('[experience]');
    const cert = await classifyDocument(fakeInference({ 'work-classify': clefChoice('document', 'certificate', { certificate: 0.8 }) }), blocks);
    expect(cert).toMatchObject({ ok: true, type: 'certificate', schema: null });
  });

  it('leaves the type open below the floor, and fails closed without an answer', async () => {
    expect(await classifyDocument(fakeInference({ 'work-classify': clefChoice('document', 'cv', { cv: 0.42, other: 0.4 }) }), blocks)).toMatchObject({ ok: true, type: null, confidence: 0.42 });
    expect(await classifyDocument(fakeInference({ 'work-classify': { answers: {} } }), blocks)).toMatchObject({ ok: false, error: 'classification_failed' });
    expect(await classifyDocument(fakeInference({ 'work-classify': new Error('down') }), blocks)).toMatchObject({ ok: false });
  });
});

describe('the Clef readers', () => {
  const result = { answers: { a: { choice: 'x', probabilities: { x: 0.7, y: 0.2, z: 'bad' } }, n: { noul: 0.81 }, s: { score: 2.4 }, bad: { choice: 'w' } } };
  it('read a choice at its floor, a yes or no, and a score, and fail closed', () => {
    expect(readChoice(result, 'a', ['x', 'y', 'z'], 0.5)).toEqual({ choice: 'x', p: 0.7, probabilities: { x: 0.7, y: 0.2 } });
    expect(readChoice(result, 'a', ['x', 'y'], 0.75).choice).toBeNull();
    expect(readChoice(result, 'bad', ['x'], 0.1)).toEqual({ choice: null, p: 0, probabilities: {} });
    expect(readChoice(null, 'a', ['x'], 0.1).choice).toBeNull();
    expect(readNoul(result, 'n')).toBe(0.81);
    expect(readNoul(result, 'a')).toBeNull();
    expect(readScore(result, 's', 4)).toBe(0.8);
    expect(readScore(result, 'n', 4)).toBeNull();
  });
});

describe('the Work meter', () => {
  const call = (usage: WorkCall['usage'], model = LLAMA): WorkCall => ({ op: 'work-extract', model, ok: true, ms: 1, usage });

  it('prices a call by its neurons when reported, else by its tokens', () => {
    expect(callCostMicroUsd(call({ tokensIn: 360, tokensOut: 80, neurons: 26.68 }))).toBe(293);
    expect(callCostMicroUsd(call({ tokensIn: 1354, tokensOut: 0, neurons: null }, CLAIRIC))).toBe(135);
  });

  it('records no turn, only the model, its tokens and its cost, and skips calls that used nothing', () => {
    const deltas = workUsageDeltas([call({ tokensIn: 360, tokensOut: 80, neurons: 26.68 }), call({ tokensIn: 0, tokensOut: 0, neurons: null })], NOW);
    expect(deltas).toEqual([{ turns: 0, tokensIn: 360, tokensOut: 80, routerCalls: 0, estimatedMicroUsd: 293, model: LLAMA, modelMicroUsd: 293, at: NOW }]);
  });

  it('prices every Work op’s default model', () => {
    for (const op of ['work-classify', 'work-extract', 'work-extract-fallback'] as const) expect(MODEL_PRICES[OPS[op].model], op).toBeDefined();
    expect(MODEL_PRICES[CLAIRIC]).toEqual({ input: 0.1, output: 0 });
  });
});

describe('assembleCv', () => {
  it('merges a fixture CV’s gold fragments into one cofferdam.cv.v1', () => {
    const fragments: CvFragment[] = fixtureBlocks()
      .filter(({ cv }) => cv.id === 'en-marine-engineer')
      .map(({ block: b }) => goldFragment(b.kind, b.expected));
    const cv = assembleCv(fragments, { executor: 'cloud', models: [LLAMA], parsedAt: '2026-10-24T12:00:00Z' });
    expect(cv.schema).toBe('cofferdam.cv.v1');
    expect(cv.claimed.headline).toEqual({ title: { raw: 'Marine engineer', rank: null }, years: 9 });
    expect(cv.claimed.experience.map((e) => [e.title?.raw, e.current])).toEqual([
      ['Third Assistant Engineer', true],
      ['Engine Cadet', false],
    ]);
    // "Power management systems" appears in the summary and the skills block once each.
    expect(cv.claimed.skills.filter((s) => /power management/i.test(s.raw))).toHaveLength(1);
    expect(cv.claimed.languages).toEqual([
      { raw: 'English', code: 'en', level: 'fluent' },
      { raw: 'Spanish', code: 'es', level: 'basic' },
    ]);
    expect(cv.verified).toEqual([]);
  });

  it('keeps the fluent level when a language is claimed at both', () => {
    const cv = assembleCv(
      [
        { kind: 'languages', languages: [{ raw: 'Inglês', code: 'en', level: 'basic' }] },
        { kind: 'languages', languages: [{ raw: 'English', code: 'en', level: 'fluent' }] },
      ],
      { executor: 'cloud', models: [], parsedAt: '' },
    );
    expect(cv.claimed.languages).toEqual([{ raw: 'English', code: 'en', level: 'fluent' }]);
  });
});

/** A fragment straight from a fixture's gold fields (for the merge test). */
function goldFragment(kind: string, e: Record<string, unknown>): CvFragment {
  const claimsOf = (v: unknown) => ((v as string[] | undefined) ?? []).map((raw) => ({ raw }));
  switch (kind) {
    case 'summary':
      return { kind, headline: { title: e.title ? { raw: e.title as string, rank: null } : null, years: (e.years as number) ?? null }, skills: claimsOf(e.skills) };
    case 'experience':
      return {
        kind,
        experience: {
          title: { raw: e.title as string, rank: (e.rank as number | null) ?? null },
          employer: (e.employer as string | null) ?? null,
          location: (e.location as string | null) ?? null,
          start: (e.start as string | null) ?? null,
          end: (e.end as string | null) ?? null,
          current: e.current as boolean,
          skills: claimsOf(e.skills),
        },
      };
    case 'education':
      return { kind, education: { qualification: e.qualification as string, institution: (e.institution as string | null) ?? null, end: (e.end as string | null) ?? null } };
    case 'skills':
      return { kind, skills: claimsOf(e.skills) };
    case 'certificates':
      return { kind, certificates: claimsOf(e.certificates) };
    default:
      return {
        kind: 'languages',
        languages: [
          ...((e.fluent as string[]) ?? []).map((raw) => ({ raw, code: languageCode(raw), level: 'fluent' as const })),
          ...((e.basic as string[]) ?? []).map((raw) => ({ raw, code: languageCode(raw), level: 'basic' as const })),
        ],
      };
  }
}
