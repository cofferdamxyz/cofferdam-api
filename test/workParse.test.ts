// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The whole-CV parse under evaluation (`src/services/work/parse.ts`) and its
 * scoring (`test/work-eval/parseScore.ts`), offline: the request per model
 * family, the fail-closed reader, and the scorer on the synthetic CVs.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PARSE_JSON_SCHEMA, PARSE_SYSTEM, ParseShapeError, expiryDate, parseRequest, readParse, type ParsedCv } from '../src/services/work/parse.js';
import { scoreParse, sectionScore, type ParseTruth } from './work-eval/parseScore.js';
import {
  createLocalAi,
  LocalAiError,
  localAnswerKey,
  localAnswersPending,
  localRequest,
  parseLocalReaders,
  SCHEMA_IN_PROMPT,
  THINKING_MAX_TOKENS,
  withSchemaInPrompt,
  type LocalReader,
} from './work-eval/localAi.js';
import {
  answerOf,
  parsePhoneReaders,
  parsePhoneResults,
  PDF_PLAN_PAGE,
  pdfPlan,
  phoneAnswers,
  phonePlan,
  phoneReport,
  scorePhoneRuns,
  textAgreement,
  wordAgreement,
} from './work-eval/phoneBench.js';
import { schemaRegex, withSchemaAsRegex } from './work-eval/schemaRegex.js';

interface FixtureCv {
  id: string;
  image: string;
  ocr: string[];
  truth: ParseTruth;
}

const CVS = (JSON.parse(readFileSync(join(__dirname, 'fixtures/work/parse/cvs.json'), 'utf8')) as { cvs: FixtureCv[] }).cvs;
const NOW = Date.parse('2026-10-27T12:00:00Z');

/** What a perfect model would answer for a truth, in the schema's own fields. */
function answerFor(t: ParseTruth): Record<string, unknown> {
  return {
    name: t.identity.name,
    email: t.identity.email,
    phone: t.identity.phone,
    location: t.identity.location,
    headline_title: t.headline.title,
    years_experience: t.headline.years,
    experience: t.experience.map((e) => ({ title: e.title, employer: e.employer, location: null, start: e.start, end: e.current ? 'atual' : e.end, current: e.current, skills: [] })),
    education: t.education,
    skills: t.skills,
    certificates: t.certificates.map((c) => ({ name: c.name, expires: c.expires })),
    languages: t.languages.map((l) => ({ name: { pt: 'Português', en: 'Inglês', es: 'Espanhol' }[l.code], level: l.level })),
  };
}

const asChat = (o: unknown) => ({ choices: [{ message: { content: JSON.stringify(o) } }], usage: { prompt_tokens: 1200, completion_tokens: 400 } });

describe('parseRequest', () => {
  it('sends an image as an OpenAI content part with a data URI', () => {
    const r = parseRequest('@cf/meta/llama-4-scout-17b-16e-instruct', { kind: 'image', pages: [{ mime: 'image/png', base64: 'AAAA' }] }) as any;
    const parts = r.messages[1].content;
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
    expect(r.response_format).toEqual({ type: 'json_schema', json_schema: PARSE_JSON_SCHEMA });
    expect(r.reasoning_effort).toBeUndefined();
  });

  it('sends every page in order, and refuses none or more than four', () => {
    const page = (b: string) => ({ mime: 'image/jpeg' as const, base64: b });
    const r = parseRequest('@cf/zai-org/glm-5.3-flash', { kind: 'image', pages: [page('P1'), page('P2')] }) as any;
    const parts = r.messages[1].content;
    expect(parts[0].text).toBe('The CV is the 2 attached page images, in order.');
    expect(parts.slice(1).map((x: any) => x.image_url.url)).toEqual(['data:image/jpeg;base64,P1', 'data:image/jpeg;base64,P2']);
    expect(() => parseRequest('@cf/zai-org/glm-5.3-flash', { kind: 'image', pages: [] })).toThrow(RangeError);
    expect(() => parseRequest('@cf/zai-org/glm-5.3-flash', { kind: 'image', pages: [1, 2, 3, 4, 5].map((n) => page(String(n))) })).toThrow(RangeError);
  });

  it('wraps the schema and turns thinking off outside llama', () => {
    const glm = parseRequest('@cf/zai-org/glm-5.3-flash', { kind: 'text', text: 'Rafael' }) as any;
    expect(glm.response_format.json_schema).toMatchObject({ name: 'cofferdam_cv_parse', strict: true, schema: PARSE_JSON_SCHEMA });
    expect(glm.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(glm.messages[1].content).toContain('Rafael');
    const ds = parseRequest('@cf/deepseek-ai/deepseek-v4.1-flash-1017', { kind: 'text', text: 'x' }) as any;
    expect(ds.reasoning_effort).toBe('none');
  });

  it('carries the CV and nothing else in the user turn', () => {
    const r = parseRequest('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { kind: 'text', text: 'LINE' }) as any;
    expect(r.messages).toHaveLength(2);
    expect(r.messages[1].content).toBe('The CV, as OCR lines:\n\nLINE');
  });
});

describe('readParse', () => {
  it('reads a perfect answer into a perfect score, on both CVs', () => {
    for (const cv of CVS) {
      const parsed = readParse(asChat(answerFor(cv.truth)), NOW);
      expect(parsed.dropped).toEqual([]);
      const s = scoreParse(parsed, cv.truth);
      expect(s.fields.filter((f) => !f.correct), cv.id).toEqual([]);
      expect(s.accuracy, cv.id).toBe(1);
    }
  });

  it('reads Workers AI JSON mode and a fenced string', () => {
    const t = CVS[0]!.truth;
    expect(readParse({ response: answerFor(t) }, NOW).identity.name).toBe('Rafael Exemplo');
    const fenced = { response: '```json\n' + JSON.stringify(answerFor(t)) + '\n```' };
    expect(readParse(fenced, NOW).claimed.experience).toHaveLength(2);
  });

  it('fails closed on an answer out of shape', () => {
    expect(() => readParse({ response: 'I cannot read this' })).toThrow(ParseShapeError);
    expect(() => readParse(asChat({ experience: 'many' }))).toThrow(ParseShapeError);
    expect(() => readParse(asChat([1, 2]))).toThrow(ParseShapeError);
  });

  it('drops what it cannot read and never repairs it', () => {
    const p = readParse(
      asChat({
        name: '  Rafael   Exemplo ',
        years_experience: 99,
        experience: [{ title: 'Eletricista', employer: 'null', start: '15/03/2021', end: 'actualidad', current: false, skills: ['megômetro'] }],
        skills: ['• Painéis', 'painéis', ''],
        certificates: [{ name: 'NR-10', expires: 'soon' }, { name: null, expires: null }],
        languages: [{ name: 'Inglés', level: 'intermediate' }, { name: 'Español', level: 'fluent' }],
      }),
      NOW,
    );
    expect(p.identity.name).toBe('Rafael Exemplo');
    expect(p.claimed.headline.years).toBeNull();
    const e = p.claimed.experience[0]!;
    expect(e).toMatchObject({ employer: null, start: null, end: null, current: true });
    expect(p.claimed.skills).toEqual([{ raw: 'Painéis' }]);
    expect(p.claimed.certificates).toEqual([{ raw: 'NR-10', expires: null }]);
    expect(p.claimed.languages).toEqual([{ raw: 'Español', code: 'es', level: 'fluent' }]);
    expect(p.dropped.map((d) => d.path)).toEqual([
      'years_experience',
      'experience.0.start',
      'certificates.0.expires',
      'languages.0.level',
    ]);
  });

  it('drops empty or malformed entries and overlong values, and records each', () => {
    const p = readParse(
      asChat({
        name: 'x'.repeat(301),
        experience: ['Eletricista', null, {}, { title: 'Eletricista', employer: null, start: null, end: null, current: false, skills: [] }],
        education: [{ qualification: null, institution: null, end: '2016' }],
        certificates: [{ name: 'NR-10', expires: '2027-03-15' }, { name: 'nr-10', expires: null }],
      }),
      NOW,
    );
    expect(p.identity.name).toBeNull();
    expect(p.claimed.experience).toHaveLength(1);
    expect(p.claimed.education).toEqual([]);
    expect(p.claimed.certificates).toEqual([{ raw: 'NR-10', expires: '2027-03' }]);
    expect(p.dropped).toEqual([
      { path: 'experience.0', reason: 'shape' },
      { path: 'experience.1', reason: 'shape' },
      { path: 'experience.2', reason: 'empty' },
      { path: 'education.0', reason: 'empty' },
      { path: 'name', reason: 'length' },
    ]);
  });
});

describe('expiryDate', () => {
  it('keeps the month of a full day and reads years ahead', () => {
    expect(expiryDate('2027-03-15', NOW)).toBe('2027-03');
    expect(expiryDate('15/03/2027', NOW)).toBe('2027-03');
    expect(expiryDate('2028-01', NOW)).toBe('2028-01');
    expect(expiryDate('marzo 2035', NOW)).toBe('2035-03');
    expect(expiryDate('2045-01-01', NOW)).toBeNull();
    // One ceiling for every form: 2041 is fifteen years ahead, 2042 is not.
    expect(expiryDate('2041-12-01', NOW)).toBe('2041-12');
    expect(expiryDate('jan 2042', NOW)).toBeNull();
    expect(expiryDate('2042', NOW)).toBeNull();
    // Day first unless only the US order can be read.
    expect(expiryDate('11/30/2026', NOW)).toBe('2026-11');
    expect(expiryDate('03/04/2027', NOW)).toBe('2027-04');
    expect(expiryDate('2027-13-01', NOW)).toBeNull();
    expect(expiryDate('atual', NOW)).toBeNull();
    expect(expiryDate('soon', NOW)).toBeNull();
  });
});

describe('scoreParse', () => {
  const es = CVS.find((c) => c.id === 'cv-es-sidebar')!;

  it('scores nothing right for no parse', () => {
    const s = scoreParse(null, es.truth);
    // phone, location and the certificate list are not null in the truth, so only empty-vs-empty counts
    expect(s.accuracy).toBe(0);
  });

  it('marks the sidebar failure: the name missed, a sidebar skill read into a job', () => {
    const a = answerFor(es.truth);
    a.name = null;
    const exp = a.experience as Record<string, unknown>[];
    exp[0]!.skills = ['Análisis de riesgos (HAZOP)'];
    a.skills = (a.skills as string[]).slice(1);
    a.experience = [...exp, { title: 'Primeros auxilios', employer: null, location: null, start: null, end: null, current: false, skills: [] }];
    const s = scoreParse(readParse(asChat(a), NOW) as ParsedCv, es.truth);
    expect(sectionScore(s, 'identity')).toEqual({ right: 3, total: 4 });
    expect(s.spurious.experience).toBe(1);
    expect(s.lists.find((l) => l.list === 'skills')).toMatchObject({ tp: 4, goldCount: 5 });
    expect(s.accuracy).toBeLessThan(1);
  });

  it('pairs two jobs at one employer by title, whatever their order', () => {
    const truth: ParseTruth = {
      ...es.truth,
      experience: [
        { title: 'Supervisora de Seguridad', employer: 'Petroquímica del Golfo', start: '2022', end: null, current: true },
        { title: 'Inspectora de Seguridad', employer: 'Petroquímica del Golfo', start: '2019', end: '2022', current: false },
      ],
    };
    const a = answerFor(truth);
    a.experience = [...(a.experience as unknown[])].reverse();
    const s = scoreParse(readParse(asChat(a), NOW), truth);
    expect(sectionScore(s, 'experience')).toEqual({ right: 10, total: 10 });
  });

  it('accepts the city alone for a full address, and a phone without its spaces', () => {
    const a = answerFor(es.truth);
    a.location = 'CDMX';
    a.phone = '+525512345678';
    const s = scoreParse(readParse(asChat(a), NOW), es.truth);
    expect(sectionScore(s, 'identity')).toEqual({ right: 4, total: 4 });
  });
});

describe('local readers (the on-device candidates on the Mac)', () => {
  const reader = { label: 'Gemma 4 E2B (LiteRT-LM)', url: 'http://127.0.0.1:9379', model: 'gemma-4-E2B-it.litertlm,gpu' };

  it('reads WORK_PARSE_LOCAL and refuses what it cannot use', () => {
    expect(parseLocalReaders(undefined)).toEqual([]);
    expect(parseLocalReaders('  ')).toEqual([]);
    expect(parseLocalReaders('[{"label":"a","url":"http://127.0.0.1:8080/v1/","model":"m","paths":["image","text"]}]')).toEqual([
      { label: 'a', url: 'http://127.0.0.1:8080', model: 'm', paths: ['image', 'text'] },
    ]);
    expect(() => parseLocalReaders('{"label":"a"}')).toThrow(/JSON array/);
    expect(() => parseLocalReaders('[{"label":"a","url":"127.0.0.1:8080","model":"m"}]')).toThrow(/url/);
    expect(() => parseLocalReaders('[{"label":"a","url":"http://x","model":""}]')).toThrow(/model/);
    expect(() => parseLocalReaders('[{"label":"a","url":"http://x","model":"m","paths":["pdf"]}]')).toThrow(/paths/);
    expect(parseLocalReaders('[{"label":"a","url":"http://x:8080/v1/chat/completions","model":"m","paths":["image","image"]}]')).toEqual([
      { label: 'a', url: 'http://x:8080', model: 'm', paths: ['image'] },
    ]);
    expect(() => parseLocalReaders('[{"label":"a","url":"http://x","model":"m"},{"label":"a","url":"http://y","model":"n"}]')).toThrow(/twice/);
    expect(parseLocalReaders('[{"label":"a","url":"http://x","model":"m","thinking":true},{"label":"b","url":"http://x","model":"m","thinking":false}]')).toEqual([
      { label: 'a', url: 'http://x', model: 'm', thinking: true },
      { label: 'b', url: 'http://x', model: 'm' },
    ]);
    expect(() => parseLocalReaders('[{"label":"a","url":"http://x","model":"m","thinking":"yes"}]')).toThrow(/thinking/);
    expect(parseLocalReaders('[{"label":"a","url":"http://x","model":"m","schema":"prompt"},{"label":"b","url":"http://x","model":"m","schema":"grammar"}]')).toEqual([
      { label: 'a', url: 'http://x', model: 'm', schema: 'prompt' },
      { label: 'b', url: 'http://x', model: 'm' },
    ]);
    expect(() => parseLocalReaders('[{"label":"a","url":"http://x","model":"m","schema":"system"}]')).toThrow(/schema/);
    expect(parseLocalReaders('[{"label":"a","answers":"/tmp/a.json","model":"m","schema":"regex"}]')).toEqual([{ label: 'a', answers: '/tmp/a.json', model: 'm', schema: 'regex' }]);
    expect(() => parseLocalReaders('[{"label":"a","url":"http://x","model":"m","schema":"regex"}]')).toThrow(/for LiteRT-LM/);
    // The Android test app hands the regex to LiteRT-LM's Kotlin API: its model names a .litertlm file.
    expect(parseLocalReaders('[{"label":"p","url":"http://127.0.0.1:9379","model":"g.litertlm,npu,act=f32","schema":"regex"}]')).toEqual([
      { label: 'p', url: 'http://127.0.0.1:9379', model: 'g.litertlm,npu,act=f32', schema: 'regex' },
    ]);
    expect(parseLocalReaders('[{"label":"a","url":"http://x","model":"m","maxTokens":4000,"sampling":{"repeat_penalty":1.1},"pages":"each"}]')).toEqual([
      { label: 'a', url: 'http://x', model: 'm', maxTokens: 4000, sampling: { repeat_penalty: 1.1 }, pages: 'each' },
    ]);
    expect(() => parseLocalReaders('[{"label":"a","url":"http://x","model":"m","maxTokens":100}]')).toThrow(/maxTokens/);
    expect(() => parseLocalReaders('[{"label":"a","url":"http://x","model":"m","sampling":{"repeat_penalty":"high"}}]')).toThrow(/sampling/);
    expect(() => parseLocalReaders('[{"label":"a","url":"http://x","model":"m","pages":"all"}]')).toThrow(/pages/);
    expect(parseLocalReaders('[{"label":"a","url":"http://x","model":"m","paths":["text"],"textSource":"ocr"},{"label":"b","url":"http://x","model":"m","paths":["text"],"textSource":"pdf"}]')).toEqual([
      { label: 'a', url: 'http://x', model: 'm', paths: ['text'], textSource: 'ocr' },
      { label: 'b', url: 'http://x', model: 'm', paths: ['text'] },
    ]);
    expect(() => parseLocalReaders('[{"label":"a","url":"http://x","model":"m","paths":["text"],"textSource":"scan"}]')).toThrow(/textSource/);
    expect(() => parseLocalReaders('[{"label":"a","url":"http://x","model":"m","textSource":"ocr"}]')).toThrow(/text path/);
    expect(() => parseLocalReaders('[{"label":"a","url":"http://x","model":"m","paths":["image","text"],"textSource":"ocr"}]')).toThrow(/text path alone/);
    expect(() => parseLocalReaders('[{"label":"a","url":"http://x","model":"m","paths":["text"],"pages":"each"}]')).toThrow(/image path/);
    expect(() => parseLocalReaders('[{"label":"a","url":"http://x","model":"m","sampling":{"max_tokens":64}}]')).toThrow(/max_tokens/);
    expect(() => parseLocalReaders('[{"label":"a","url":"http://x","model":"m","sampling":{"temperature":0.7,"top_k":40}}]')).toThrow(/temperature/);
    expect(parseLocalReaders('[{"label":"a","url":"http://x","model":"m","sampling":{"top_k":40}}]')).toEqual([{ label: 'a', url: 'http://x', model: 'm', sampling: { top_k: 40 } }]);
  });

  it('sends a reader\'s own cap and sampling settings beside the parse request', () => {
    const request = parseRequest('local:x', { kind: 'image', pages: [{ mime: 'image/png', base64: 'AAAA' }] });
    const body = localRequest({ ...reader, maxTokens: 4000, sampling: { repeat_penalty: 1.1, dry_multiplier: 0.8 } }, request) as any;
    expect(body).toMatchObject({ max_tokens: 4000, repeat_penalty: 1.1, dry_multiplier: 0.8, temperature: 0 });
    expect(localRequest(reader, request)).toMatchObject({ max_tokens: request.max_tokens });
  });

  it('writes the schema into the system prompt, in the LiteRT-LM test app\'s words, when the reader asks', () => {
    const request = parseRequest('local:x', { kind: 'image', pages: [{ mime: 'image/png', base64: 'AAAA' }] });
    const body = localRequest({ ...reader, schema: 'prompt' }, request) as any;
    expect(body.response_format).toBeUndefined();
    expect(body.messages[0]).toEqual({ role: 'system', content: PARSE_SYSTEM + SCHEMA_IN_PROMPT + JSON.stringify(PARSE_JSON_SCHEMA) });
    expect(SCHEMA_IN_PROMPT).toBe(
      '\n\nAnswer with one JSON object only, no Markdown fence, matching this JSON schema exactly: the same keys and nesting, and only the listed enum values.\n',
    );
    expect(body.messages[1]).toEqual(request.messages && (request.messages as unknown[])[1]);
    expect(body).toMatchObject({ stream: false, reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false }, temperature: 0 });
    // The cloud request is left as it was.
    expect((request.response_format as any).json_schema.schema).toBe(PARSE_JSON_SCHEMA);
    // A request with no system message gets one; one without a JSON schema only loses its format.
    expect(withSchemaInPrompt({ messages: [{ role: 'user', content: 'x' }], response_format: { type: 'json_schema', json_schema: { a: 1 } } })).toEqual({
      messages: [{ role: 'system', content: `${SCHEMA_IN_PROMPT}{"a":1}` }, { role: 'user', content: 'x' }],
    });
    expect(withSchemaInPrompt({ messages: [], response_format: { type: 'json_object' } })).toEqual({ messages: [] });
  });

  it('sends the schema as one regex whose whitespace takes U+2581 when the reader asks (LiteRT-LM #3510)', () => {
    const request = parseRequest('local:x', { kind: 'text', text: 'x' });
    const body = localRequest({ label: 'a', answers: '/tmp/a.json', model: 'm', schema: 'regex' }, request) as any;
    expect(body.response_format).toEqual({ type: 'regex', pattern: schemaRegex(PARSE_JSON_SCHEMA) });
    expect(body.messages[0]).toEqual((request.messages as unknown[])[0]);
    expect((request.response_format as any).json_schema.schema).toBe(PARSE_JSON_SCHEMA);
    expect(withSchemaAsRegex({ messages: [], response_format: { type: 'json_object' } })).toEqual({ messages: [], response_format: { type: 'json_object' } });

    // A synthetic answer in the parse schema: compact, indented, and as LiteRT-LM's token table spells it (U+2581 for a space).
    const job = { title: 'Pipe Welder', employer: 'Acme Fabrication', location: 'Houston, TX', start: '2015-03', end: null, current: true, skills: ['TIG welding'] };
    const cv = {
      name: 'Ana Souza', email: null, phone: null, location: 'Houston, TX', headline_title: 'Pipe Welder', years_experience: 12,
      experience: [job], education: [{ qualification: 'Welding certificate', institution: 'Lone Star College', end: '2013' }],
      skills: ['MIG', 'TIG'], certificates: [{ name: 'AWS D1.1', expires: null }], languages: [{ name: 'English', level: 'fluent' }],
    };
    const re = new RegExp(`^(?:${schemaRegex(PARSE_JSON_SCHEMA)})$`);
    const ok = (v: unknown) => re.test(typeof v === 'string' ? v : JSON.stringify(v));
    expect(ok(cv)).toBe(true);
    expect(ok(JSON.stringify(cv, null, 2))).toBe(true);
    expect(ok(JSON.stringify(cv, null, 2).replace(/ /g, '▁'))).toBe(true);
    expect(ok({ ...cv, experience: Array.from({ length: 20 }, () => job) })).toBe(true);
    // What the schema refuses, the regex refuses: a missing or extra key, a 21st job, a range or enum broken, a raw line break.
    expect(ok({ ...cv, phone: undefined })).toBe(false);
    expect(ok({ ...cv, extra: 1 })).toBe(false);
    expect(ok({ ...cv, experience: Array.from({ length: 21 }, () => job) })).toBe(false);
    expect(ok({ ...cv, years_experience: 61 })).toBe(false);
    expect(ok({ ...cv, languages: [{ name: 'English', level: 'native' }] })).toBe(false);
    expect(ok(JSON.stringify(cv).replace('Pipe Welder', 'Pipe\nWelder'))).toBe(false);
    // A string never holds '<', so a raw byte piece such as <0x0A> cannot land in one.
    expect(ok({ ...cv, name: '<0x0A>' })).toBe(false);
    expect(() => schemaRegex({ type: 'object', properties: { a: { type: 'string' } }, required: [], additionalProperties: false })).toThrow(/require every property/);
    expect(() => schemaRegex({ type: 'number' })).toThrow(/unsupported/);
    // What it cannot enforce it refuses, rather than admit more than the schema does.
    const none = new RegExp(`^(?:${schemaRegex({ type: 'array', items: { type: 'string' }, maxItems: 0 })})$`);
    expect([none.test('[]'), none.test('[ ]'), none.test('[""]')]).toEqual([true, true, false]);
    expect(() => schemaRegex({ type: 'array', items: { type: 'string' }, minItems: 1 })).toThrow(/minItems/);
    expect(() => schemaRegex({ type: 'string', pattern: 'x' })).toThrow(/pattern/);
    expect(() => schemaRegex({ type: 'integer', minimum: 0, maximum: 1000 })).toThrow(/integer range/);
    expect(() => schemaRegex({ type: 'integer', minimum: -5, maximum: 5 })).toThrow(/integer range/);
    expect(() => schemaRegex({ type: 'integer', minimum: 0 })).toThrow(/integer range/);
    expect(new RegExp(`^(?:${schemaRegex({ type: 'integer' })})$`).test('-12')).toBe(true);
  });

  it('turns thinking on with room for the reasoning when the reader asks', () => {
    const request = parseRequest('local:x', { kind: 'image', pages: [{ mime: 'image/png', base64: 'AAAA' }] });
    const body = localRequest({ ...reader, thinking: true }, request) as any;
    expect(body).toMatchObject({ stream: false, max_tokens: THINKING_MAX_TOKENS, reasoning_effort: 'low', chat_template_kwargs: { enable_thinking: true } });
    expect(body.response_format).toEqual(request.response_format);
  });

  it('turns thinking off in both servers\' words and keeps the image and the schema', () => {
    const request = parseRequest('local:x', { kind: 'image', pages: [{ mime: 'image/png', base64: 'AAAA' }] });
    // The cloud request asks for low effort, which LiteRT-LM reads as thinking on.
    expect(request.reasoning_effort).toBe('low');
    const body = localRequest(reader, request) as any;
    expect(body).toMatchObject({ model: 'gemma-4-E2B-it.litertlm,gpu', stream: false, reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } });
    expect(body.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
    expect(body.response_format).toEqual(request.response_format);
  });

  it('posts to the chat endpoint and answers what readParse reads', async () => {
    const calls: { url: string; body: any }[] = [];
    const answer = { choices: [{ message: { content: JSON.stringify(answerFor(CVS[0]!.truth)) } }], usage: { prompt_tokens: 900, completion_tokens: 300 } };
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(answer), { status: 200 });
    }) as unknown as typeof fetch;
    const ai = createLocalAi(reader, { fetch: fakeFetch });
    const result = await ai.run('ignored' as never, parseRequest('local:x', { kind: 'text', text: 'Rafael' }) as never);
    expect(calls[0]!.url).toBe('http://127.0.0.1:9379/v1/chat/completions');
    expect(calls[0]!.body.model).toBe('gemma-4-E2B-it.litertlm,gpu');
    expect(readParse(result, NOW).identity.name).toBe('Rafael Exemplo');
  });

  it('reads a reader answered in process, which names an answers file in place of a server', () => {
    expect(parseLocalReaders('[{"label":"a","answers":" /tmp/a.json ","model":"m","paths":["text"]}]')).toEqual([
      { label: 'a', answers: '/tmp/a.json', model: 'm', paths: ['text'] },
    ]);
    expect(() => parseLocalReaders('[{"label":"a","answers":"/tmp/a.json","url":"http://x","model":"m"}]')).toThrow(/give one/);
    expect(() => parseLocalReaders('[{"label":"a","answers":"  ","model":"m"}]')).toThrow(/answers/);
    expect(() => parseLocalReaders('[{"label":"a","model":"m"}]')).toThrow(/url/);
  });

  it('answers in process from its file, lists once what it lacks, and fails on an answer the script could not give', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'local-answers-')), 'answers.json');
    const inProcess = { label: 'LiteRT-LM', answers: file, model: 'gemma-4-e2b', paths: ['text' as const], sampling: { no_repeat_ngram_size: 24 } };
    const request = parseRequest('local:x', { kind: 'text', text: 'Rafael' }) as never;
    const ai = createLocalAi(inProcess);
    await expect(ai.run('x' as never, request)).rejects.toThrow(/answered pending/);
    await expect(ai.run('x' as never, request)).rejects.toThrow(/answered pending/);
    const lines = readFileSync(`${file}.pending.jsonl`, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const { key, body } = JSON.parse(lines[0]!) as { key: string; body: Record<string, unknown> };
    expect(key).toBe(localAnswerKey(JSON.stringify(body)));
    expect(body).toMatchObject({ model: 'gemma-4-e2b', no_repeat_ngram_size: 24, temperature: 0 });
    expect(localAnswersPending(inProcess)).toBe(1);
    const answer = { choices: [{ message: { role: 'assistant', content: '{}' } }], timing: { ms: 1234 } };
    writeFileSync(file, JSON.stringify({ [key]: answer }));
    await expect(createLocalAi(inProcess).run('x' as never, request)).resolves.toEqual(answer);
    writeFileSync(file, JSON.stringify({ [key]: { error: 'RuntimeError: out of memory' } }));
    await expect(createLocalAi(inProcess).run('x' as never, request)).rejects.toThrow(/answered answers: RuntimeError: out of memory/);
  });

  it('names the reader and the status when the server refuses or is down', async () => {
    const html = (async () => new Response('<html>busy</html>', { status: 200 })) as unknown as typeof fetch;
    await expect(createLocalAi(reader, { fetch: html }).run('x' as never, {} as never)).rejects.toThrow(/answered 200: not JSON: <html>busy/);
    const refuse = (async () => new Response('model not found', { status: 404 })) as unknown as typeof fetch;
    await expect(createLocalAi(reader, { fetch: refuse }).run('x' as never, {} as never)).rejects.toThrow(
      new LocalAiError(reader.label, 404, 'model not found'),
    );
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(createLocalAi(reader, { fetch: down }).run('x' as never, {} as never)).rejects.toThrow(/Gemma 4 E2B \(LiteRT-LM\) answered network/);
  });
});

describe('the phone benchmark (the app reads, the Mac scores)', () => {
  const readers = [
    { label: 'LFM3-VL-2B, full page', model: 'lfm3-vl-2b', imageMaxTokens: null, schema: 'grammar' as const },
    { label: 'Gemma 4 E2B, schema in the prompt', model: 'gemma-4-e2b', imageMaxTokens: 1120, schema: 'prompt' as const },
  ];

  it('plans the cloud parse\'s own request for the phone', () => {
    const plan = phonePlan(CVS, readers, 5, 'test');
    const request = parseRequest('local:x', { kind: 'image', pages: [{ mime: 'image/png', base64: 'AAAA' }] });
    expect(plan.system).toBe(PARSE_SYSTEM);
    expect(plan.user).toBe(((request.messages as any[])[1].content as any[])[0].text);
    expect(plan.schema).toBe(PARSE_JSON_SCHEMA);
    expect(plan).toMatchObject({ v: 1, schemaInPrompt: SCHEMA_IN_PROMPT, maxTokens: request.max_tokens, temperature: 0, runs: 5, readers });
    expect(plan.cvs).toEqual(CVS.map((cv) => ({ id: cv.id, file: cv.image })));
    expect(() => phonePlan(CVS, [], 5, 'test')).toThrow(/reader/);
    expect(() => phonePlan(CVS, readers, 0, 'test')).toThrow(/runs/);
  });

  it('plans the text path for text readers, as the Mac\'s in-process LiteRT-LM reader gets it', () => {
    const litert = { label: 'Gemma 4 E2B, LiteRT-LM, Metal, MTP', model: 'gemma-4-e2b', imageMaxTokens: null, schema: 'regex' as const, input: 'text' as const, litert: { file: 'gemma-4-E2B-it.litertlm', backend: 'gpu' as const, mtp: true } };
    expect(phonePlan(CVS, readers, 5, 'test').text).toBeNull();
    const plan = phonePlan(CVS, [litert], 3, 'test');
    // The Mac's reader: `WORK_PARSE_LOCAL` with `schema: "regex"` and `maxTokens: 4000` on the text path.
    const mac = (cv: FixtureCv) =>
      localRequest({ label: 'mac', model: 'gemma-4-e2b-litert', answers: '/tmp/a.json', paths: ['text'], schema: 'regex', maxTokens: 4000 }, parseRequest('local:x', { kind: 'text', text: cv.ocr.join('\n') }));
    const first = mac(CVS[0]!);
    expect(plan.text).toMatchObject({ system: PARSE_SYSTEM, maxTokens: first.max_tokens, temperature: first.temperature });
    expect(plan.text!.regex).toBe((first.response_format as { pattern: string }).pattern);
    expect(plan.text!.users).toEqual(CVS.map((cv) => ({ id: cv.id, user: ((mac(cv).messages as { content: string }[])[1]!).content })));
    expect(() => phonePlan([{ id: 'x', image: 'x.png' }], [litert], 1, 'test')).toThrow(/no OCR lines/);
  });

  it('reads WORK_PARSE_PHONE_READERS and refuses what the app cannot run', () => {
    expect(
      parsePhoneReaders(
        '[{"label":"l","model":"gemma-4-e2b","schema":"regex","input":"text","litert":{"file":"g.litertlm","backend":"gpu","mtp":true}},{"label":"t","model":"gemma-4-e2b","schema":"json","input":"text"}]',
      ),
    ).toEqual([
      { label: 'l', model: 'gemma-4-e2b', imageMaxTokens: null, schema: 'regex', input: 'text', litert: { file: 'g.litertlm', backend: 'gpu', mtp: true } },
      { label: 't', model: 'gemma-4-e2b', imageMaxTokens: null, schema: 'json', input: 'text' },
    ]);
    const lit = (o: Record<string, unknown>) => JSON.stringify([{ label: 'l', model: 'm', schema: 'regex', input: 'text', litert: { file: 'g.litertlm', backend: 'gpu', mtp: true, ...o } }]);
    expect(() => parsePhoneReaders(lit({ file: '../g.litertlm' }))).toThrow(/litertlm file name/);
    expect(() => parsePhoneReaders(lit({ backend: 'tpu' }))).toThrow(/backend/);
    // The Pixel's reader: the TPU with its fixed context, and the CPU as the engine that reads again what it cuts.
    const cpu = { file: 'c.litertlm', backend: 'cpu', mtp: true, activation: 'f32' };
    expect(parsePhoneReaders(lit({ backend: 'npu', contextLimit: 4096, fallback: cpu }))[0]!.litert).toEqual({
      file: 'g.litertlm',
      backend: 'npu',
      mtp: true,
      contextLimit: 4096,
      fallback: cpu,
    });
    expect(() => parsePhoneReaders(lit({ contextLimit: 0 }))).toThrow(/contextLimit/);
    expect(() => parsePhoneReaders(lit({ fallback: { ...cpu, backend: 'tpu' } }))).toThrow(/fallback.backend/);
    expect(() => parsePhoneReaders(lit({ mtp: 1 }))).toThrow(/mtp/);
    expect(() => parsePhoneReaders(lit({ activation: 'bf16' }))).toThrow(/activation/);
    expect(parsePhoneReaders(lit({ activation: 'f32' }))[0]!.litert).toEqual({ file: 'g.litertlm', backend: 'gpu', mtp: true, activation: 'f32' });
    expect(() => parsePhoneReaders('[{"label":"l","model":"m","schema":"regex","input":"text"}]')).toThrow(/for LiteRT-LM/);
    expect(() => parsePhoneReaders('[{"label":"l","model":"m","schema":"regex","litert":{"file":"g.litertlm","backend":"cpu","mtp":false}}]')).toThrow(/reads text/);
    expect(parsePhoneReaders('[{"label":"a","model":"lfm3-vl-2b","imageMaxTokens":1024},{"label":"b","model":"gemma-4-e2b","schema":"prompt"}]')).toEqual([
      { label: 'a', model: 'lfm3-vl-2b', imageMaxTokens: 1024, schema: 'grammar' },
      { label: 'b', model: 'gemma-4-e2b', imageMaxTokens: null, schema: 'prompt' },
    ]);
    expect(() => parsePhoneReaders('[]')).toThrow(/non-empty/);
    expect(() => parsePhoneReaders('[{"label":"a","model":"m","imageMaxTokens":0}]')).toThrow(/imageMaxTokens/);
    expect(() => parsePhoneReaders('[{"label":"a","model":"m","schema":"system"}]')).toThrow(/schema/);
    expect(() => parsePhoneReaders('[{"label":"a","model":"m"},{"label":"a","model":"n"}]')).toThrow(/twice/);
  });

  it('scores the phone\'s answers like the Mac\'s, a failed call or a broken answer at zero', () => {
    const [pt, es] = CVS as [FixtureCv, FixtureCv];
    const run = (cv: string, n: number, text: string, ok = true, content: string | null = null) => ({
      reader: readers[0]!.label, cv, run: n, ok, error: ok ? null : 'jetsam', text, content, msToJson: 30_000 + n, msFirstToken: 4_000,
      promptTokens: 2_700, predictedTokens: 600, peakFootprint: 2.1e9, minAvailable: 3e9, thermalBefore: 'nominal', thermalAfter: 'fair', stoppedLimit: false,
    });
    const raw = {
      v: 1,
      device: { model: 'iPhone17,3', os: 'iOS 27.0', totalMemory: 7.7e9 },
      app: { version: '1.0.0', build: '1' },
      runtime: { llamaRn: '0.13.0-rc.8', llamaCpp: 'b11946' },
      startedAt: '2026-10-28T13:00:00.000Z',
      finishedAt: '2026-10-28T13:30:00.000Z',
      readers: [{ label: readers[0]!.label, model: 'lfm3-vl-2b', loadMs: 1_500, gpu: true, reasonNoGPU: '', error: null, loadedFootprint: 1.4e9 }],
      runs: [
        run(pt.id, 0, JSON.stringify(answerFor(pt.truth))),
        run(pt.id, 1, '{"experience": "many"}'),
        run(es.id, 0, '', false),
        run(es.id, 1, '```json\n' + JSON.stringify(answerFor(es.truth)) + '\n```'),
        // llama.rn's parsed content is the answer when it gives one; its stream opens with the template's assistant header.
        run(es.id, 2, '<|im_start|>assistant\n' + JSON.stringify(answerFor(es.truth)), true, JSON.stringify(answerFor(es.truth))),
        run(es.id, 3, '<|im_start|>assistant\n' + JSON.stringify(answerFor(es.truth))),
      ],
    };
    const results = parsePhoneResults(raw);
    const scored = scorePhoneRuns(results, new Map(CVS.map((cv) => [cv.id, cv.truth])), NOW);
    expect(scored.map((r) => r.score?.accuracy ?? 0)).toEqual([1, 0, 0, 1, 1, 1]);
    // Only a known header is taken off: anything else before the JSON is the model's and fails the read.
    expect(answerOf({ text: '<|im_start|>assistant\n{}', content: null })).toBe('{}');
    expect(answerOf({ text: 'Sure! {}', content: null })).toBe('Sure! {}');
    expect(answerOf({ text: '<|im_start|>assistant\n{"a":1}', content: '{"b":2}' })).toBe('{"b":2}');
    expect(scored[1]!.failure).toMatch(/^shape:/);
    expect(scored[2]!.failure).toBe('jetsam');
    const md = phoneReport(results, scored, CVS.map((cv) => ({ id: cv.id, locale: 'x', layout: 'y' })), { date: '2026-10-28', title: 'iPhone 16' });
    // OK counts the answers that parsed, as the Mac's report does; the times count every call that answered.
    expect(md).toContain('| LFM3-VL-2B, full page | 4/6 | 67% | 50% | 4.0, 30.0 | 4.0 | 30.0 | 30.0 | — | 2.10 | 3.00 | nominal, fair |');
    expect(md).toContain('| failed 100% 100% 100% |');
    expect(md).toContain('| 100% failed |');
    expect(() => parsePhoneResults({ v: 2 })).toThrow(/v: 1/);
    expect(() => parsePhoneResults({ v: 1, runs: [{}], readers: [] })).toThrow(/runs\[0\]/);
    expect(() => scorePhoneRuns(parsePhoneResults({ ...raw, runs: [run('cv-x', 0, '{}')] }), new Map())).toThrow(/cv-x/);
  });
});

describe('the phones reading real resumes from their PDFs (test/workResumePhone.eval.test.ts)', () => {
  const litert = {
    label: 'Gemma 4 E2B, Metal, PDFKit',
    model: 'gemma-4-e2b',
    imageMaxTokens: null,
    schema: 'regex' as const,
    input: 'pdf' as const,
    litert: { file: 'gemma-4-E2B-it.litertlm', backend: 'gpu' as const, mtp: true, activation: 'f32' as const },
  };
  const reader: LocalReader = { label: 'phone', model: 'gemma-4-e2b-litert', answers: '/tmp/a.json', paths: ['text'], schema: 'regex', maxTokens: 4000, textDir: '/tmp/texts' };
  const keyOf = (text: string) => localAnswerKey(JSON.stringify(localRequest(reader, parseRequest(`local:${reader.label}`, { kind: 'text', text }))));

  it("plans the PDFs with the text path's prefix, so the phone sends what the Mac sends for the same text", () => {
    const plan = pdfPlan(['123', '456'], [litert], 1, 'test');
    expect(plan.cvs).toEqual([
      { id: '123', file: PDF_PLAN_PAGE, pdf: '123.pdf' },
      { id: '456', file: PDF_PLAN_PAGE, pdf: '456.pdf' },
    ]);
    expect(plan.readers).toEqual([litert]);
    expect(plan.text!.users).toEqual([]);
    const text = 'Maria\n\nElectrician\n\n';
    const request = localRequest(reader, parseRequest('local:phone', { kind: 'text', text }));
    expect(plan.text!.userPrefix! + text).toBe((request.messages as { content: string }[])[1]!.content);
    expect(plan.text!.regex).toBe((request.response_format as { pattern: string }).pattern);
    expect(plan.text).toMatchObject({ system: PARSE_SYSTEM, maxTokens: 4000, temperature: 0 });
    expect(() => pdfPlan(['1'], [{ ...litert, input: 'text' as const }], 1, 'test')).toThrow(/input is "pdf"/);
  });

  it("turns the phone's results into answers the benchmark finds by the request it sends", () => {
    const results = parsePhoneResults({
      v: 1,
      readers: [],
      runs: [
        { reader: 'p', cv: '123', run: 0, ok: true, text: '{"a":1}', content: '{"a":1}', msToJson: 15000, msFirstToken: 900, promptTokens: 1000, predictedTokens: 500, decodeTokensPerSec: 40, peakFootprint: 3.04e9, stoppedLimit: false },
        { reader: 'p', cv: '456', run: 0, ok: false, error: 'boom', text: '', content: null, msToJson: 0 },
        { reader: 'other', cv: '123', run: 0, ok: true, text: 'x', content: 'x', msToJson: 1 },
      ],
      texts: [
        { cv: '123', pages: 1, chars: 7, ms: 12, text: 'Maria\n\n', error: null },
        { cv: '456', pages: 1, chars: 4, ms: 9, text: 'Juan', error: null },
      ],
    });
    const { texts, answers } = phoneAnswers(results, 'p', reader);
    expect(texts).toEqual([
      { id: '123', text: 'Maria\n\n' },
      { id: '456', text: 'Juan' },
    ]);
    expect(answers[keyOf('Maria\n\n')]).toMatchObject({ choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }], timing: { ms: 15000, peakFootprintMb: 3040 } });
    expect(answers[keyOf('Juan')]).toEqual({ error: 'boom' });
    expect(Object.keys(answers)).toHaveLength(2);
  });

  it("compares a phone's text layer with the Mac's, counts only", () => {
    expect(textAgreement('a\nb\n\nc\n', 'a\nb\n\nc\n')).toEqual({ identical: true, macLines: 3, phoneLines: 3, sharedLines: 3, charDelta: 0 });
    expect(textAgreement('b\na  x\nc', 'a x\nb\nc')).toMatchObject({ identical: false, macLines: 3, phoneLines: 3, sharedLines: 2 });
  });

  it('reads a textDir only on the text path, and never beside textSource "ocr"', () => {
    const one = (o: Record<string, unknown>) => parseLocalReaders(JSON.stringify([{ label: 'l', answers: '/tmp/a.json', model: 'm', ...o }]));
    expect(one({ paths: ['text'], textDir: '/tmp/t' })[0]).toMatchObject({ textDir: '/tmp/t' });
    expect(() => one({ paths: ['text'], textDir: 'relative/t' })).toThrow(/absolute/);
    expect(() => one({ textDir: '/tmp/t' })).toThrow(/text path alone/);
    expect(() => one({ paths: ['text'], textDir: '/tmp/t', textSource: 'ocr' })).toThrow(/give one/);
  });

  it("counts the Mac's words a phone's text keeps in order: a split or a joined word costs one", () => {
    expect(wordAgreement('Line Cook at the Bistro', 'Line Cook at the Bistro')).toEqual({ macWords: 5, phoneWords: 5, sharedWords: 5 });
    expect(wordAgreement('Line Co ok at theBistro', 'Line Cook at the Bistro')).toEqual({ macWords: 5, phoneWords: 5, sharedWords: 2 });
  });

  it('plans the text paths alone, with no reader, or a reader on one path', () => {
    const extract = pdfPlan(['123'], [], 1, 'test', ['string', 'vision']);
    expect(extract).toMatchObject({ readers: [], extract: ['string', 'vision'], cvs: [{ id: '123', pdf: '123.pdf' }] });
    expect(extract.text!.userPrefix).toBe('The CV, as OCR lines:\n\n');
    expect(() => pdfPlan(['123'], [], 1, 'test')).toThrow(/extract/);
    const vision = { ...litert, pdfText: 'vision' as const };
    expect(pdfPlan(['123'], [vision], 1, 'test').readers).toEqual([vision]);
  });

  it("plans the Pixel's reader in the app, and times a CPU answer with the TPU's try before it", () => {
    const pixel = {
      ...litert,
      label: 'Pixel',
      pdfText: 'pdfbox' as const,
      litert: {
        file: 'gemma-4-E2B-it_Google_Tensor_G5.litertlm',
        backend: 'npu' as const,
        mtp: true,
        activation: 'f32' as const,
        contextLimit: 4096,
        fallback: { file: 'gemma-4-E2B-it.litertlm', backend: 'cpu' as const, mtp: true, activation: 'f32' as const },
      },
    };
    expect(pdfPlan(['123'], [pixel], 1, 'test').readers).toEqual([pixel]);
    const firstTry = { backend: 'npu', reason: 'context', error: null, msToJson: 40_000, promptTokens: 3500, predictedTokens: 596, contextTokens: 4096 };
    const results = parsePhoneResults({
      v: 1,
      readers: [],
      runs: [
        { reader: 'Pixel', cv: '123', run: 0, ok: true, text: '{"a":1}', content: '{"a":1}', msToJson: 60_000, backend: 'cpu', contextTokens: 5000, firstTry },
        { reader: 'Pixel', cv: '456', run: 0, ok: true, text: '{"a":1, \n\n', content: '{"a":1}', msToJson: 20_000, backend: 'npu', stalled: true },
      ],
      texts: [
        { cv: '123', method: 'pdfbox', pages: 1, chars: 7, ms: 100, text: 'Maria\n\n', error: null },
        { cv: '456', method: 'pdfbox', pages: 1, chars: 4, ms: 90, text: 'Juan', error: null },
      ],
    });
    expect(results.runs[0]).toMatchObject({ backend: 'cpu', contextTokens: 5000, firstTry });
    expect(results.runs[1]).toMatchObject({ backend: 'npu', stalled: true });
    const { answers } = phoneAnswers(results, 'Pixel', reader, 'pdfbox');
    expect(answers[keyOf('Maria\n\n')]).toMatchObject({ timing: { ms: 100_000, engine: 'cpu', firstTry: { backend: 'npu', reason: 'context', ms: 40_000 } } });
    // A stalled answer is scored as the app closed it.
    expect(answers[keyOf('Juan')]).toMatchObject({ choices: [{ message: { content: '{"a":1}' } }], timing: { ms: 20_000, engine: 'npu', stalled: true } });
  });
});

