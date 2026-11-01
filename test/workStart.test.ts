// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { readStart } from '../src/services/work/start.js';

// Sunday 1 November 2026, where the job is.
const TODAY = '2026-11-01';
const at = (date: string | null, time: string | null = null) => ({ date, time });

describe("a job's start, read from its words and the local day", () => {
  it('reads English days and times', () => {
    expect(readStart('tomorrow at 9am', TODAY, 'en')).toEqual(at('2026-11-02', '09:00'));
    expect(readStart('today 3pm', TODAY, 'en')).toEqual(at('2026-11-01', '15:00'));
    expect(readStart('Friday 2:30 pm', TODAY, 'en')).toEqual(at('2026-11-06', '14:30'));
    expect(readStart('on Sunday', TODAY, 'en')).toEqual(at('2026-11-01'));
    expect(readStart('next Sunday', TODAY, 'en')).toEqual(at('2026-11-08'));
    expect(readStart('next Monday', TODAY, 'en')).toEqual(at('2026-11-02'));
    expect(readStart('Fri at 7', TODAY, 'en')).toEqual(at('2026-11-06', '07:00'));
    expect(readStart('11/15', TODAY, 'en')).toEqual(at('2026-11-15'));
    expect(readStart('3/4', TODAY, 'en')).toEqual(at('2027-03-04'));
    expect(readStart('November 20th at noon', TODAY, 'en')).toEqual(at('2026-11-20', '12:00'));
    expect(readStart('October 5', TODAY, 'en')).toEqual(at('2027-10-05'));
    expect(readStart('the 3rd', TODAY, 'en')).toEqual(at('2026-11-03'));
    expect(readStart('2026-12-24 at 8 in the evening', TODAY, 'en')).toEqual(at('2026-12-24', '20:00'));
    expect(readStart('12am', TODAY, 'en')).toEqual(at(null, '00:00'));
  });

  it('reads Portuguese days and times', () => {
    expect(readStart('amanhã às 9h', TODAY, 'pt')).toEqual(at('2026-11-02', '09:00'));
    expect(readStart('amanhã de manhã', TODAY, 'pt')).toEqual(at('2026-11-02'));
    expect(readStart('hoje à tarde', TODAY, 'pt')).toEqual(at('2026-11-01'));
    expect(readStart('às 3 da tarde', TODAY, 'pt')).toEqual(at(null, '15:00'));
    expect(readStart('segunda-feira', TODAY, 'pt')).toEqual(at('2026-11-02'));
    expect(readStart('sexta que vem às 14h30', TODAY, 'pt')).toEqual(at('2026-11-06', '14:30'));
    expect(readStart('dia 15', TODAY, 'pt')).toEqual(at('2026-11-15'));
    expect(readStart('15/11', TODAY, 'pt')).toEqual(at('2026-11-15'));
    expect(readStart('15 de novembro às 14h30', TODAY, 'pt')).toEqual(at('2026-11-15', '14:30'));
    expect(readStart('depois de amanhã ao meio-dia', TODAY, 'pt')).toEqual(at('2026-11-03', '12:00'));
    expect(readStart('9 da manhã', TODAY, 'pt')).toEqual(at(null, '09:00'));
  });

  it('reads Spanish days and times, telling "mañana" from "de la mañana"', () => {
    expect(readStart('mañana a las 9', TODAY, 'es')).toEqual(at('2026-11-02', '09:00'));
    expect(readStart('mañana a las 9 de la mañana', TODAY, 'es')).toEqual(at('2026-11-02', '09:00'));
    expect(readStart('el viernes a las 3 de la tarde', TODAY, 'es')).toEqual(at('2026-11-06', '15:00'));
    expect(readStart('pasado mañana', TODAY, 'es')).toEqual(at('2026-11-03'));
    expect(readStart('el próximo lunes', TODAY, 'es')).toEqual(at('2026-11-02'));
    expect(readStart('el 20', TODAY, 'es')).toEqual(at('2026-11-20'));
    expect(readStart('20 de noviembre a las 3 de la tarde', TODAY, 'es')).toEqual(at('2026-11-20', '15:00'));
    expect(readStart('hoy a mediodía', TODAY, 'es')).toEqual(at('2026-11-01', '12:00'));
    expect(readStart('5/12', TODAY, 'es')).toEqual(at('2026-12-05'));
  });

  it('gives nothing rather than a guess: no day or time, a span of time, a day that does not exist, no local day', () => {
    expect(readStart('ASAP', TODAY, 'en')).toBeNull();
    expect(readStart('o quanto antes', TODAY, 'pt')).toBeNull();
    expect(readStart('por la mañana', TODAY, 'es')).toBeNull();
    expect(readStart('in 2h', TODAY, 'en')).toBeNull();
    expect(readStart('em 3 horas', TODAY, 'pt')).toBeNull();
    expect(readStart('31/11', TODAY, 'pt')).toBeNull();
    expect(readStart('at 25:00', TODAY, 'en')).toBeNull();
    expect(readStart('tomorrow', null, 'en')).toBeNull();
    expect(readStart('tomorrow', '2026-13-01', 'en')).toBeNull();
    expect(readStart(null, TODAY, 'en')).toBeNull();
  });

  it('turns over a month and a year', () => {
    expect(readStart('tomorrow', '2026-12-31', 'en')).toEqual(at('2027-01-01'));
    expect(readStart('dia 2', '2026-11-30', 'pt')).toEqual(at('2026-12-02'));
    expect(readStart('el 31', '2026-11-30', 'es')).toEqual(at('2026-12-31'));
  });
});
