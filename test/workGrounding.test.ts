// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Source grounding (`test/work-eval/grounding.ts`, LangExtract's alignment
 * ported), offline on made-up text: no resume enters the repository.
 */

import { describe, expect, it } from 'vitest';

import { parseCvDate } from '../src/services/work/cv.js';
import { alignValue, dateInText, ungroundedPaths, type Alignment } from './work-eval/grounding.js';
import { readingGaps, scoreReading, type Reading, type ResumeTruth } from './work-eval/resumeBench.js';

/** The text an alignment covers. */
const covered = (text: string, a: Alignment | null) => (a ? text.slice(a.start, a.end) : null);

describe('aligning a value', () => {
  it('matches exactly, ignoring case, spacing and the punctuation around it', () => {
    const text = 'EXPERIENCE\n• SITE SUPERVISOR, Harbor Works (2019)\nSales Associate / Cashier, Site\nForeman';
    const a = alignValue('Site Supervisor', text);
    expect(a?.status).toBe('exact');
    expect(covered(text, a)).toBe('SITE SUPERVISOR');
    expect(covered(text, alignValue('site foreman', text))).toBe('Site\nForeman');
    expect(covered(text, alignValue('Sales Associate/Cashier', text))).toBe('Sales Associate / Cashier');
  });

  it('folds accents, compatibility forms and decomposed letters as the parse does, its offsets in the text as given', () => {
    expect(alignValue('Técnico de Segurança', 'TECNICO DE SEGURANCA DO TRABALHO')?.status).toBe('exact');
    expect(alignValue('Financial Analyst', 'ﬁnancial analyst')?.status).toBe('exact');
    const decomposed = 'Universidade de São Paulo';
    expect(covered(decomposed, alignValue('São Paulo', decomposed))).toBe('São Paulo');
  });

  it('aligns a plural through the light stem, fuzzily', () => {
    const text = 'Certified welder, 2012';
    const a = alignValue('Welders', text);
    expect(a?.status).toBe('fuzzy');
    expect(covered(text, a)).toBe('welder');
    expect(alignValue('Welder', 'Welders wanted')?.status).toBe('fuzzy');
    // The stem leaves a word of three characters, and one ending in "ss", whole.
    expect(alignValue('Gas', 'ga')).toBeNull();
    expect(alignValue('Bass', 'bas')).toBeNull();
  });

  it('accepts a fuzzy span holding 0.75 of the value and refuses one holding less', () => {
    const value = 'Senior Heavy Equipment Mechanic';
    const text = 'Lead heavy equipment mechanic for the yard';
    const a = alignValue(value, text);
    expect(a?.status).toBe('fuzzy');
    expect(covered(text, a)).toBe('heavy equipment mechanic');
    expect(alignValue(value, 'Lead equipment mechanic for the yard')).toBeNull();
  });

  it('accepts a fuzzy span at a density of 1/3 and refuses a sparser one', () => {
    const value = 'Senior Pipe Welding Inspector';
    // pipe … inspector: three of the value's four tokens in nine.
    const text = 'pipe fitting crews and welding shop staff met inspector';
    expect(alignValue(value, text)).toEqual({ status: 'fuzzy', start: 0, end: text.length });
    // Three in ten.
    expect(alignValue(value, 'pipe fitting crews and the welding shop staff met inspector')).toBeNull();
    // Every token in a span too sparse gives way to three in a dense one; by default "Senior" alone is a lesser match first.
    const spread = 'Senior staff on site; later, out on the yard, pipe welding inspector';
    expect(covered(spread, alignValue(value, spread))).toBe('Senior');
    expect(alignValue(value, spread)?.status).toBe('lesser');
    expect(covered(spread, alignValue(value, spread, { acceptMatchLesser: false }))).toBe('pipe welding inspector');
  });

  it('aligns a value mentioned twice at its first mention', () => {
    const text = 'Cashier 2016 to 2018. Shift Lead 2018 to 2019. Cashier 2019 to Current.';
    expect(alignValue('cashier', text)).toEqual({ status: 'exact', start: 0, end: 7 });
    expect(alignValue('2018', text)).toEqual({ status: 'exact', start: 16, end: 20 });
  });

  it('takes a run of the value’s first tokens as a lesser match, or sends the value to the fuzzy pass when told', () => {
    const text = 'Project Coordinator, Bayside Builders. Electrician helper on commercial jobs.';
    expect(alignValue('Project Manager', text)).toEqual({ status: 'lesser', start: 0, end: 7 });
    expect(alignValue('Project Manager', text, { acceptMatchLesser: false })).toBeNull();
    // A plural after the first token: lesser on "Electrician", or fuzzy on both words without the lesser match.
    expect(covered(text, alignValue('Electrician Helpers', text))).toBe('Electrician');
    const fuzzy = alignValue('Electrician Helpers', text, { acceptMatchLesser: false });
    expect(fuzzy?.status).toBe('fuzzy');
    expect(covered(text, fuzzy)).toBe('Electrician helper');
  });

  it('turns the fuzzy pass off or moves its thresholds, and refuses a threshold outside [0, 1]', () => {
    expect(alignValue('Welders', 'Certified welder', { enableFuzzyAlignment: false })).toBeNull();
    expect(alignValue('Senior Heavy Equipment Mechanic', 'Lead equipment mechanic', { fuzzyAlignmentThreshold: 0.5 })?.status).toBe('fuzzy');
    expect(alignValue('Senior Pipe Welding Inspector', 'pipe fitting crews and the welding shop staff met inspector', { fuzzyAlignmentMinDensity: 0.3 })?.status).toBe('fuzzy');
    expect(() => alignValue('Welder', 'welder', { fuzzyAlignmentThreshold: 1.5 })).toThrow(RangeError);
    expect(() => alignValue('Welder', 'welder', { fuzzyAlignmentMinDensity: Number.NaN })).toThrow(RangeError);
    // Upstream checks them only with the fuzzy pass on.
    expect(alignValue('Welder', 'welder', { enableFuzzyAlignment: false, fuzzyAlignmentThreshold: 2 })?.status).toBe('exact');
  });

  it('aligns nothing in an empty text, and nothing for a blank value', () => {
    expect(alignValue('Welder', '')).toBeNull();
    expect(alignValue('Welder', ' \n\t')).toBeNull();
    expect(alignValue(' ​\n', 'welder ​')).toBeNull();
  });
});

describe('dates', () => {
  /** Each language's words for each month, the full name first. */
  const MONTHS: Record<'en' | 'pt' | 'es', string[][]> = {
    en: [['January', 'Jan'], ['February', 'Feb'], ['March', 'Mar'], ['April', 'Apr'], ['May'], ['June', 'Jun'], ['July', 'Jul'], ['August', 'Aug'], ['September', 'Sep', 'Sept'], ['October', 'Oct'], ['November', 'Nov'], ['December', 'Dec']],
    pt: [['janeiro', 'jan'], ['fevereiro', 'fev'], ['março', 'mar'], ['abril', 'abr'], ['maio', 'mai'], ['junho', 'jun'], ['julho', 'jul'], ['agosto', 'ago'], ['setembro', 'set'], ['outubro', 'out'], ['novembro', 'nov'], ['dezembro', 'dez']],
    es: [['enero', 'ene'], ['febrero', 'feb'], ['marzo', 'mar'], ['abril', 'abr'], ['mayo', 'may'], ['junio', 'jun'], ['julio', 'jul'], ['agosto', 'ago'], ['septiembre', 'setiembre', 'sep', 'sept', 'set'], ['octubre', 'oct'], ['noviembre', 'nov'], ['diciembre', 'dic']],
  };
  /** How each language writes a month with its year, W standing for the month word. */
  const FORMS: Record<'en' | 'pt' | 'es', string[]> = {
    en: ['W 2015', 'W. 2015', 'W, 2015', 'W-2015', 'W/2015'],
    pt: ['W de 2015', 'W. de 2015', 'W/2015', 'W 2015'],
    es: ['W de 2015', 'W del 2015', 'W. 2015', 'W-2015'],
  };

  it('finds a month written as its name or abbreviation with the year, in English, Portuguese and Spanish, as the parse reads it', () => {
    for (const lang of ['en', 'pt', 'es'] as const) {
      MONTHS[lang].forEach((words, m) => {
        const date = `2015-${String(m + 1).padStart(2, '0')}`;
        const next = `2015-${String(((m + 1) % 12) + 1).padStart(2, '0')}`;
        for (const word of words) {
          for (const form of FORMS[lang]) {
            const written = form.replace('W', word);
            for (const text of [`Clerk, ${written}, Dock 4`, `CLERK ${written.toUpperCase()} TO CURRENT`]) {
              expect(dateInText(date, text), `${date} in "${text}"`).toBe(true);
              expect(dateInText(next, text), `${next} in "${text}"`).toBe(false);
            }
            // The parse's own date reader takes the same words; it reads no comma.
            if (!written.includes(',')) expect(parseCvDate(written), written).toEqual({ present: false, date });
          }
        }
      });
    }
  });

  it('finds a month written in numbers: MM/YYYY, M/YYYY, MM-YYYY, MM.YYYY, YYYY-MM and YYYY/MM', () => {
    for (const written of ['03/2015', '3/2015', '03-2015', '03.2015', '2015-03', '2015/03']) {
      expect(dateInText('2015-03', `Clerk ${written} to 06/2017`), written).toBe(true);
      expect(dateInText('2015-06', `Clerk ${written} to 06/2017`), written).toBe(false);
      expect(parseCvDate(written), written).toEqual({ present: false, date: '2015-03' });
    }
    expect(dateInText('2015-12', 'Clerk 12/2015')).toBe(true);
    // Those forms only: one digit only before a slash, two after the year, no space inside and no digit glued on.
    for (const written of ['3-2015', '3.2015', '2015-3', '2015.03', '03 / 2015', '103/2015', '03/20151']) {
      expect(dateInText('2015-03', `Clerk ${written}`), written).toBe(false);
    }
  });

  it('reads a range left to right, each number in one date', () => {
    const text = 'Clerk 03/2015-06/2017; Lead 2012-2014';
    expect(dateInText('2015-03', text)).toBe(true);
    expect(dateInText('2017-06', text)).toBe(true);
    expect(dateInText('2015-06', text)).toBe(false);
    expect(dateInText('2012', text)).toBe(true);
    expect(dateInText('2014', text)).toBe(true);
  });

  it('takes a year-only date where its year is written alone, not inside a month', () => {
    expect(dateInText('2015', 'Welding certificate, 2015')).toBe(true);
    expect(dateInText('2015', 'Clerk 2015 to Current')).toBe(true);
    expect(dateInText('2015', 'Clerk 03/2015 to 06/2017')).toBe(false);
    expect(dateInText('2015', 'Clerk March 2015 to June 2017')).toBe(false);
    expect(dateInText('2015', 'Order 20150')).toBe(false);
  });

  it('does not take a month date whose year alone is written: the reader may have invented the month', () => {
    expect(dateInText('2015-03', 'Cashier, 2015 to 2017')).toBe(false);
    expect(dateInText('2015-03', 'Cashier, June 2015 to 2017')).toBe(false);
  });

  it('reads no day: a date with one holds a month only where a form does', () => {
    expect(dateInText('2015-03', 'Hired 15/03/2015')).toBe(true);
    expect(dateInText('2015-03', 'Hired 2015-03-15')).toBe(true);
    expect(dateInText('2015-03', 'Hired 03/15/2015')).toBe(false);
    expect(dateInText('2015-06', 'Hired June 15, 2015')).toBe(false);
  });

  it('finds no malformed date', () => {
    expect(dateInText('2015-13', 'Clerk 13/2015')).toBe(false);
    expect(dateInText('March 2015', 'Clerk March 2015')).toBe(false);
  });
});

describe('the reading’s ungrounded values', () => {
  const text = [
    'EXPERIENCE',
    'Site Supervisor 03/2019 to Current',
    'Harbor Works - City, State',
    'Forklift Operator Jan 2015 - Feb 2019',
    'Dockside Ltd - City, State',
    'Yard Hand 2012 to 2014',
    'EDUCATION',
    'Associate of Applied Science : Welding Technology , 2014',
    'Gulf Coast Community College - City, State',
    'CERTIFICATIONS',
    'OSHA 30, Forklift Certified',
  ].join('\n');

  it('lists every value the text does not hold, in the paths the benchmark scores', () => {
    const reading: Reading = {
      jobs: [
        // A current job's end is "present", not a date to look up, whatever the field holds.
        { title: 'Site Supervisor', start: '2019-03', end: '2030-01', current: true },
        { title: 'Forklift Operator', start: '2015-01', end: '2019-02', current: false },
        // Invented: a title with one of its two words in the text, a year the text lacks, a month the text does not write.
        { title: 'Crane Operator', start: '2013', end: '2014-06', current: false },
        // Empty fields are no values to look up (`readingGaps` asks for the dates).
        { title: null, start: null, end: null, current: false },
      ],
      schools: [
        { institution: 'Gulf Coast Community College', qualification: 'Associate of Applied Science: Welding Technology', end: '2014' },
        { institution: 'Northern Technical Institute', qualification: null, end: '2012-05' },
      ],
      certificates: ['OSHA 30', 'Forklift Certified', 'First Aid'],
    };
    expect(ungroundedPaths(reading, text)).toEqual(['jobs.2.title', 'jobs.2.start', 'jobs.2.end', 'schools.1.institution', 'schools.1.end', 'certificates.2']);
  });

  it('counts a lesser match as held, as upstream does, unless told not to', () => {
    // "State" (in "City, State") is the first token of "State University".
    const reading: Reading = { jobs: [], schools: [{ institution: 'State University', qualification: null, end: null }], certificates: [] };
    expect(ungroundedPaths(reading, text)).toEqual([]);
    expect(ungroundedPaths(reading, text, { acceptMatchLesser: false })).toEqual(['schools.0.institution']);
  });

  it('turns a wrong date it finds from silent into asked when the benchmark scores the reading', () => {
    const truth: ResumeTruth = {
      jobs: [
        { title: 'Site Supervisor', start: '2019-03', end: null, current: true },
        { title: 'Forklift Operator', start: '2015-01', end: '2019-02', current: false },
        { title: 'Yard Hand', start: '2012', end: '2014', current: false },
      ],
      schools: [],
      certificates: [],
      anchor: '2020-06',
      skills: [],
    };
    const reading: Reading = {
      jobs: [
        { title: 'Site Supervisor', start: '2019-03', end: null, current: true },
        { title: 'Forklift Operator', start: '2015-01', end: '2019-02', current: false },
        // Read wrong: a start the text lacks, and an end with a month the text does not write.
        { title: 'Yard Hand', start: '2013', end: '2014-06', current: false },
      ],
      schools: [],
      certificates: [],
    };
    const alone = scoreReading(reading, truth, new Set(readingGaps(reading)));
    expect(alone.outcomes.start.silent).toBe(1);
    expect(alone.outcomes.end.silent).toBe(1);
    const grounded = scoreReading(reading, truth, new Set([...readingGaps(reading), ...ungroundedPaths(reading, text)]));
    expect(grounded.outcomes.start).toEqual({ right: 2, 'asked-right': 0, 'asked-wrong': 1, silent: 0 });
    expect(grounded.outcomes.end).toEqual({ right: 2, 'asked-right': 0, 'asked-wrong': 1, silent: 0 });
    expect(grounded.outcomes.title).toEqual({ right: 3, 'asked-right': 0, 'asked-wrong': 0, silent: 0 });
  });
});
