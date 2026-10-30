// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A job read into a work profile's shape (`services/work/jobProfile.ts`), offline: the request per model family,
 * the reader's checks against the request's own words, the text a job embeds, and the call's metering.
 */

import { describe, expect, it } from 'vitest';

import type { Inference, InferenceOp } from '../src/services/inference/index.js';
import {
  effortFor,
  inRequest,
  JOB_PROFILE_SYSTEM,
  jobProfileRequest,
  MAX_JOB_TEXT,
  MAX_PROFILE_SKILLS,
  SHORT_REQUEST_CHARS,
  postedIn,
  profileText,
  readJob,
  readJobProfile,
  words,
} from '../src/services/work/jobProfile.js';
import { listingText, type ListingDraft } from '../src/services/work/listings.js';
import localeCases from './fixtures/work/locale-cases.json';

const DEEPSEEK = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';

/** A synthetic vacancy, as the phone would send it once the privacy gate ran. */
const AD = [
  'Técnico Electricista. Empresa de servicios en Guadalajara solicita técnico electricista.',
  'Funciones: **instalación y mantenimiento de tableros eléctricos**, cableado en baja tensión y reportes de servicio.',
  'Requisitos: 2 años de experiencia, conocimiento de la NOM-001-SEDE, inglés básico y disponibilidad para viajar.',
  'Ofrecemos prestaciones de ley y bonos por productividad.',
].join('\n');

/** The model's answer as DeepSeek returns it through the OpenAI wrapper. */
const answer = (obj: unknown) => ({ choices: [{ message: { content: JSON.stringify(obj) } }], usage: { prompt_tokens: 900, completion_tokens: 300 } });

const GOOD = {
  occupation: { en: 'Electrical Technician', source: 'Técnico Electricista' },
  skills: [
    { en: 'travel for work', source: 'disponibilidad para viajar', required: false },
    { en: 'Install and maintain electrical panels', source: 'instalación y mantenimiento de tableros eléctricos', required: true },
    { en: 'low voltage wiring', source: 'cableado en baja tensión', required: true },
  ],
  certificates: [{ en: 'NOM-001-SEDE', source: 'NOM-001-SEDE' }],
  languages: [{ code: 'EN', source: 'inglés básico' }],
  experienceYears: { min: 2, source: '2 años de experiencia' },
  scope: 'onsite',
};

describe('the request', () => {
  it('names the language and the hiring market, as context', () => {
    expect(postedIn({ lang: 'es', market: 'mx-jal' })).toBe('written in Mexican Spanish by someone hiring in Mexico (mx-jal)');
    expect(postedIn({ lang: 'pt' })).toBe('written in Portuguese');
    expect(postedIn({ lang: 'en', market: 'not a region' })).toBe('written in English');
  });

  it('takes each model family’s shape: reasoning off by default on DeepSeek, the least on gpt-oss, JSON mode elsewhere', () => {
    const ds = jobProfileRequest(DEEPSEEK, AD, { lang: 'es', market: 'mx-jal' });
    expect(ds).toMatchObject({ reasoning_effort: 'none', max_completion_tokens: 1_500, response_format: { type: 'json_schema', json_schema: { name: 'job_profile', strict: true } } });
    expect(jobProfileRequest(DEEPSEEK, AD, { lang: 'es' }, 'low')).toMatchObject({ reasoning_effort: 'low', max_completion_tokens: 6_000 });
    // Without reasoning the reading is an extraction at temperature 0; a reasoning call keeps the model's own.
    expect(ds).toMatchObject({ temperature: 0 });
    expect(jobProfileRequest(DEEPSEEK, AD, { lang: 'es' }, 'low')).not.toHaveProperty('temperature');
    const messages = ds.messages as { role: string; content: string }[];
    expect(messages[0]!.content).toBe(JOB_PROFILE_SYSTEM);
    expect(messages[1]!.content).toBe(`A request for work written in Mexican Spanish by someone hiring in Mexico (mx-jal):\n\n${AD}`);
    // gpt-oss cannot turn reasoning off: its least is low.
    expect(jobProfileRequest('@cf/openai/gpt-oss-120b', AD, { lang: 'es' })).toMatchObject({ reasoning_effort: 'low', max_tokens: 6_000 });
    const llama = jobProfileRequest('@cf/meta/llama-3.3-70b-instruct-fp8-fast', AD, { lang: 'es' });
    expect(llama).toMatchObject({ temperature: 0, response_format: { type: 'json_schema' } });
    expect(llama).not.toHaveProperty('reasoning_effort');
  });

  it('reads a short request at low effort and a pasted vacancy with reasoning off', () => {
    expect(effortFor('Se solicita velador')).toBe('low');
    expect(effortFor('x'.repeat(SHORT_REQUEST_CHARS))).toBe('low');
    expect(effortFor('x'.repeat(SHORT_REQUEST_CHARS + 1))).toBe('none');
  });

  it('teaches with no string the locale evaluation scores', () => {
    const raws = (localeCases.cases as { raw: string }[]).map((c) => c.raw.toLowerCase());
    for (const raw of raws) expect(JOB_PROFILE_SYSTEM.toLowerCase(), raw).not.toContain(`"${raw}"`);
  });
});

describe('readJobProfile', () => {
  it('keeps what the request says, in English, the required skills first', () => {
    const read = readJobProfile(answer(GOOD), AD)!;
    expect(read.dropped).toEqual([]);
    expect(read.profile).toEqual({
      occupation: { en: 'electrical technician', source: 'Técnico Electricista' },
      skills: [
        { en: 'install and maintain electrical panels', source: 'instalación y mantenimiento de tableros eléctricos', required: true },
        { en: 'low voltage wiring', source: 'cableado en baja tensión', required: true },
        { en: 'travel for work', source: 'disponibilidad para viajar', required: false },
      ],
      certificates: [{ en: 'NOM-001-SEDE', source: 'NOM-001-SEDE' }],
      languages: [{ code: 'en', source: 'inglés básico' }],
      experienceYears: { min: 2, source: '2 años de experiencia' },
      scope: 'onsite',
    });
  });

  it('drops what the request does not say: a skill, a certificate, a language or years it never wrote', () => {
    const read = readJobProfile(
      answer({
        ...GOOD,
        skills: [...GOOD.skills, { en: 'safety awareness', source: 'conciencia de seguridad', required: true }],
        certificates: [{ en: 'OSHA 30', source: 'OSHA 30' }],
        languages: [{ code: 'pt', source: 'portugués' }],
        experienceYears: { min: 5, source: '5 años' },
      }),
      AD,
    )!;
    expect(read.profile.skills.map((s) => s.en)).not.toContain('safety awareness');
    expect(read.profile.certificates).toEqual([]);
    expect(read.profile.languages).toEqual([]);
    expect(read.profile.experienceYears).toBeNull();
    expect(read.dropped).toEqual([
      { field: 'skills', value: 'safety awareness', reason: 'not_in_text' },
      { field: 'certificates', value: 'OSHA 30', reason: 'not_in_text' },
      { field: 'languages', value: 'pt', reason: 'not_in_text' },
      { field: 'experienceYears', value: '5', reason: 'not_in_text' },
    ]);
  });

  it('reads the source as whole words, through accents, case, markdown and dashes, never a fragment', () => {
    const request = words('Técnico Electricista: **instalación y mantenimiento** de tableros eléctricos, NOM-001-SEDE. Horario de 10 am.').join(' ');
    expect(inRequest('TÉCNICO electricista', request)).toBe(true);
    expect(inRequest('**instalación** y mantenimiento', request)).toBe(true);
    expect(inRequest('NOM–001–SEDE', request)).toBe(true);
    // A fragment stands for nothing: no word of three characters, or a word cut short.
    expect(inRequest('de', request)).toBe(false);
    expect(inRequest('10', request)).toBe(false);
    expect(inRequest('tecnic', request)).toBe(false);
    expect(inRequest('t', request)).toBe(false);
    expect(inRequest('', request)).toBe(false);
    expect(inRequest('soldador', request)).toBe(false);
  });

  it('keeps an item only where its source says it: the years written, the language named, the certificate’s codes', () => {
    const text = 'Se solicita técnico con 2 años de experiencia, inglés básico. Horario de 10 am a 6 pm. Empresa con seguridad industrial.';
    const read = readJobProfile(
      answer({
        occupation: { en: 'technician', source: 'técnico' },
        skills: [{ en: 'forklift operation', source: 'de', required: true }],
        certificates: [{ en: 'OSHA 30', source: 'seguridad industrial' }],
        languages: [
          { code: 'fr', source: 'inglés básico' },
          { code: 'en', source: 'inglés básico' },
        ],
        experienceYears: { min: 5, source: '2 años de experiencia' },
        scope: 'onsite',
      }),
      text,
    )!;
    expect(read.profile.skills).toEqual([]);
    expect(read.profile.certificates).toEqual([]);
    expect(read.profile.languages).toEqual([{ code: 'en', source: 'inglés básico' }]);
    expect(read.profile.experienceYears).toBeNull();
    expect(read.dropped).toEqual([
      { field: 'skills', value: 'forklift operation', reason: 'not_in_text' },
      { field: 'certificates', value: 'OSHA 30', reason: 'not_in_text' },
      { field: 'languages', value: 'fr', reason: 'not_in_text' },
      { field: 'experienceYears', value: '5', reason: 'not_in_text' },
    ]);
    // Ten years from "10 am" stands for nothing; years written out in words do.
    const ten = readJobProfile(answer({ ...GOOD, experienceYears: { min: 10, source: '10' } }), text)!;
    expect(ten.profile.experienceYears).toBeNull();
    const spelled = readJobProfile(answer({ ...GOOD, occupation: { en: 'welder', source: 'soldador' }, experienceYears: { min: 2, source: 'dois anos de experiência' } }), 'Vaga: soldador com dois anos de experiência.')!;
    expect(spelled.profile.experienceYears).toEqual({ min: 2, source: 'dois anos de experiência' });
  });

  it('keeps a numbered code however the request writes it, and a class letter only as written', () => {
    const text = 'Vaga: soldador TIG com 6G. Exige NR10 e NR-35, CNH categoria D e Class A CDL.';
    const read = readJobProfile(
      answer({
        ...GOOD,
        occupation: { en: 'TIG welder', source: 'soldador TIG' },
        skills: [],
        certificates: [
          { en: 'NR-10', source: 'NR10' },
          { en: 'NR-35', source: 'NR-35' },
          { en: '6G welding certification', source: '6G' },
          { en: 'CDL Class B', source: 'Class A CDL' },
          { en: "Driver's license category D", source: 'CNH categoria D' },
        ],
        languages: [],
        experienceYears: { min: 0, source: '' },
      }),
      text,
    )!;
    expect(read.profile.certificates.map((c) => c.en)).toEqual(['NR-10', 'NR-35', '6G welding certification', "Driver's license category D"]);
    expect(read.dropped).toEqual([{ field: 'certificates', value: 'CDL Class B', reason: 'not_in_text' }]);
  });

  it('reads a source the model shortened with an ellipsis when its pieces are in the request, in order', () => {
    const request = words('Atividades: instalação e manutenção de quadros elétricos e painéis.').join(' ');
    expect(inRequest('instalação … de quadros elétricos', request)).toBe(true);
    expect(inRequest('instalação...painéis', request)).toBe(true);
    expect(inRequest('painéis … instalação', request)).toBe(false);
    expect(inRequest('instalação … soldagem', request)).toBe(false);
  });

  it('never lets a lone number vouch for a certificate, nor an ellipsis join a years or certificate source', () => {
    const text = 'Jornada de 2 turnos, R$ 2.500. Exige NR-10. Carga de 35 horas semanais. Turno de 5 días. Experiencia: 2 años de experiencia.';
    const read = readJobProfile(
      answer({
        ...GOOD,
        skills: [],
        certificates: [
          { en: 'Level 2 safety certificate', source: '2' },
          { en: 'NR-35', source: 'NR … 35' },
          { en: 'NR-10', source: 'NR-10' },
        ],
        languages: [],
        experienceYears: { min: 5, source: '5 … años de experiencia' },
      }),
      text,
      'es',
    )!;
    expect(read.profile.certificates.map((c) => c.en)).toEqual(['NR-10']);
    expect(read.profile.experienceYears).toBeNull();
  });

  it('reads "dos" as two only in a Spanish request: in Portuguese it is "of the"', () => {
    const years = (source: string, text: string, lang: string) => readJobProfile(answer({ ...GOOD, experienceYears: { min: 2, source } }), text, lang)!.profile.experienceYears;
    expect(years('ao longo dos anos', 'Experiência adquirida ao longo dos anos.', 'pt')).toBeNull();
    expect(years('dos años de experiencia', 'Con dos años de experiencia.', 'es')).toEqual({ min: 2, source: 'dos años de experiencia' });
    expect(years('dezesseis anos', 'Experiência de dezesseis anos.', 'pt')).toBeNull();
  });

  it('keeps years only where a number comes before a word for years, never from an article or a shift', () => {
    const years = (min: number, source: string, text: string) => readJobProfile(answer({ ...GOOD, experienceYears: { min, source } }), text)!.profile.experienceYears;
    expect(years(2, 'manutenção dos equipamentos', 'Experiência na manutenção dos equipamentos.')).toBeNull();
    expect(years(1, 'experiencia en un puesto similar', 'Con experiencia en un puesto similar.')).toBeNull();
    expect(years(2, '2 turnos', 'Trabajo en 2 turnos.')).toBeNull();
    expect(years(3, 'mínimo de 3 a 5 años', 'Experiencia mínimo de 3 a 5 años.')).toEqual({ min: 3, source: 'mínimo de 3 a 5 años' });
    expect(years(5, 'mínimo de 3 a 5 años', 'Experiencia mínimo de 3 a 5 años.')).toEqual({ min: 5, source: 'mínimo de 3 a 5 años' });
    expect(years(2, 'two years of experience', 'At least two years of experience.')).toEqual({ min: 2, source: 'two years of experience' });
  });

  it('reads no occupation and no years when the answer says none, and no profile from a shape it does not know', () => {
    const read = readJobProfile(answer({ ...GOOD, occupation: { en: '', source: '' }, experienceYears: { min: 0, source: '' } }), AD)!;
    expect(read.profile.occupation).toBeNull();
    expect(read.profile.experienceYears).toBeNull();
    expect(readJobProfile(answer({ ...GOOD, scope: 'remote' }), AD)!.profile.scope).toBe('remote');
    expect(readJobProfile(answer({ ...GOOD, scope: 'anywhere' }), AD)).toBeNull();
    expect(readJobProfile(answer({ ...GOOD, occupation: 'electrician' }), AD)).toBeNull();
    expect(readJobProfile(answer({ ...GOOD, experienceYears: 2 }), AD)).toBeNull();
  });

  it('caps the skills with the required ones kept, and drops duplicates and invalid names and codes', () => {
    const many = Array.from({ length: MAX_PROFILE_SKILLS + 3 }, (_, i) => ({ en: `skill number ${i}`, source: 'cableado en baja tensión', required: i % 2 === 0 }));
    const read = readJobProfile(
      answer({
        ...GOOD,
        skills: [...many, { en: 'Skill Number 0', source: 'cableado', required: true }, { en: 'x', source: 'cableado', required: true }],
        languages: [{ code: 'english', source: 'inglés' }],
        experienceYears: { min: 70, source: '2 años de experiencia' },
      }),
      AD,
    )!;
    expect(read.profile.skills).toHaveLength(MAX_PROFILE_SKILLS);
    expect(read.profile.skills.filter((s) => s.required)).toHaveLength(8);
    expect(read.dropped.filter((d) => d.reason === 'over_cap')).toHaveLength(3);
    expect(read.dropped).toContainEqual({ field: 'skills', value: 'skill number 0', reason: 'duplicate' });
    expect(read.dropped).toContainEqual({ field: 'skills', value: 'x', reason: 'invalid' });
    expect(read.dropped).toContainEqual({ field: 'languages', value: 'english', reason: 'invalid' });
    expect(read.dropped).toContainEqual({ field: 'experienceYears', value: '70', reason: 'invalid' });
  });

  it('reads no profile from an answer out of shape', () => {
    expect(readJobProfile({ choices: [{ message: { content: 'not json' } }] }, AD)).toBeNull();
    expect(readJobProfile(answer({ occupation: GOOD.occupation }), AD)).toBeNull();
    expect(readJobProfile(null, AD)).toBeNull();
    // Workers AI's JSON mode answers in `response`, as an object.
    expect(readJobProfile({ response: GOOD }, AD)?.profile.occupation?.en).toBe('electrical technician');
  });
});

describe('profileText', () => {
  it('is the text a worker’s listing embeds for the same strings, so the two compare like with like', () => {
    const profile = readJobProfile(answer(GOOD), AD)!.profile;
    const draft: ListingDraft = {
      pseudonym: 'p',
      profileId: 'w1',
      region: 'mx-jal',
      scope: 'onsite',
      tier: 0,
      lang: 'en',
      titles: ['electrical technician'],
      skills: profile.skills.map((s) => s.en),
      certificates: ['NOM-001-SEDE'],
      languages: ['en'],
    };
    expect(profileText(profile)).toBe(listingText(draft, []));
    expect(profileText(profile)).toBe('electrical technician. install and maintain electrical panels; low voltage wiring; travel for work. NOM-001-SEDE');
    expect(profileText({ occupation: null, skills: [], certificates: [] })).toBe('');
  });
});

describe('readJob', () => {
  const inference = (run: () => unknown): Inference & { ops: InferenceOp[] } => {
    const ops: InferenceOp[] = [];
    return {
      ops,
      async model() {
        return DEEPSEEK;
      },
      async run(op) {
        ops.push(op);
        const v = run();
        if (v instanceof Error) throw v;
        return v;
      },
    } as Inference & { ops: InferenceOp[] };
  };

  it('reads the profile in one metered call, at the effort its length asks unless one is given', async () => {
    const inputs: Record<string, unknown>[] = [];
    const inf = inference(() => answer(GOOD));
    const run = inf.run.bind(inf);
    inf.run = async (op, input, call) => {
      inputs.push(input as Record<string, unknown>);
      return run(op, input, call);
    };
    const out = await readJob(inf, AD, { lang: 'es', market: 'mx-jal' });
    await readJob(inf, AD, { lang: 'es' }, { effort: 'none' });
    await readJob(inf, AD + ' ' + 'x'.repeat(SHORT_REQUEST_CHARS), { lang: 'es' });
    expect(inputs.map((i) => i.reasoning_effort)).toEqual([AD.length <= SHORT_REQUEST_CHARS ? 'low' : 'none', 'none', 'none']);
    expect(out.ok).toBe(true);
    expect(inf.ops).toEqual(['work-job-profile', 'work-job-profile', 'work-job-profile']);
    expect(out.calls).toEqual([{ op: 'work-job-profile', model: DEEPSEEK, ok: true, ms: expect.any(Number), usage: { tokensIn: 900, tokensOut: 300, neurons: null } }]);
  });

  it('fails closed, still metering the call: a throw, an answer out of shape; a request too long asks nothing', async () => {
    const logs: Record<string, unknown>[] = [];
    const thrown = await readJob(inference(() => new Error('boom')), AD, { lang: 'es' }, { log: (l) => logs.push(l) });
    expect(thrown).toMatchObject({ ok: false, error: 'profile_failed', calls: [{ op: 'work-job-profile', ok: false }] });
    expect(thrown.calls[0]!.usage.tokensIn).toBeGreaterThan(0);
    const shapeless = await readJob(inference(() => ({ response: 'nothing' })), AD, { lang: 'es' }, { log: (l) => logs.push(l) });
    expect(shapeless).toMatchObject({ ok: false, error: 'profile_failed', calls: [{ ok: false }] });
    expect(logs.map((l) => l.event)).toEqual(['work_job_profile_failed', 'work_job_profile_failed']);
    expect(logs[1]!.reason).toBe('out_of_shape');
    const inf = inference(() => answer(GOOD));
    expect(await readJob(inf, 'x'.repeat(MAX_JOB_TEXT + 1), { lang: 'en' })).toEqual({ ok: false, error: 'text_too_long', calls: [] });
    expect(inf.ops).toEqual([]);
  });
});
