// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * When a job starts, read from the hirer's own words (the intent's `when`, a span of the sentence) and the day it is
 * where the job is (`today`, the phone's local date), for the chat's hiring card and the MCP connector's job draft
 * (workspace decision 0065; the founder, 2026-10-31: the card holds the start date and time). Code, not a model: the
 * intent's extractor copies spans only, as it copies a CV's dates, and the day arithmetic ("next Thursday" from a
 * Sunday) is code's to do. It reads what is plainly there in English, Portuguese and Spanish: a day (today, tomorrow,
 * the day after, a weekday, a day of the month, a date written in numbers or with its month's name) and a time (9am,
 * 14h30, "às 9 da manhã", "a las 3 de la tarde", noon, midnight), and leaves the rest to the hirer, who sets the start
 * on the card: no guess, and a word it does not know gives nothing rather than a wrong day.
 */

export interface JobStart {
  /** The day, `YYYY-MM-DD`, where the job is; null when the words name only a time. */
  date: string | null;
  /** The wall-clock time, `HH:mm`; null when the words name only a day. */
  time: string | null;
}

/** A local date as the phone sends it. */
export const ISO_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}:/.\- ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Weekdays by their folded names, Sunday 0 (`Date.getUTCDay`). */
const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
  domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6,
  lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5,
};

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
  enero: 1, febrero: 2, mayo: 5, junio: 6, julio: 7, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

/** Words that put a weekday that is today a week on: "next Monday", "segunda que vem", "el próximo lunes". */
const NEXT_WEEK = /\b(next|proxim[oa]|que vem|siguiente)\b/;
/** "de la mañana" (and "por la", "en la") is the morning; "mañana" alone is tomorrow. */
const SPANISH_MORNING = /\b(de|por|en) la manana\b/g;
/** A span of time, not a time of day: "in 2h", "em 3 horas", "dentro de 30 min". */
const DURATION = /\b(em|in|en|within|dentro de|daqui a|after|depois de|apos) \d+\s?(h|hrs?|hours?|horas?|min|mins|minutes?|minutos?)\b/g;
/** The afternoon or the evening, which put an hour under 12 past noon. */
const LATE = /\b(da tarde|da noite|de la tarde|de la noche|a tarde|a noite|pela tarde|pela noite|por la tarde|por la noche|in the afternoon|in the evening|at night|tonight)\b/;

const pad = (n: number) => String(n).padStart(2, '0');
const isoOf = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));

/** A calendar day, or null when it does not exist (31 November). */
function dayOf(year: number, month: number, day: number): Date | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d : null;
}

/** A day and month without a year: this year's, or next year's once this year's has passed. */
function nextOf(today: Date, month: number, day: number): Date | null {
  const year = today.getUTCFullYear();
  const d = dayOf(year, month, day);
  if (d && d.getTime() >= today.getTime()) return d;
  return dayOf(year + 1, month, day);
}

/** A day of the month alone: this month's, or next month's once this month's has passed. */
function dayOfMonth(today: Date, day: number): Date | null {
  const here = dayOf(today.getUTCFullYear(), today.getUTCMonth() + 1, day);
  if (here && here.getTime() >= today.getTime()) return here;
  const next = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
  return dayOf(next.getUTCFullYear(), next.getUTCMonth() + 1, day);
}

function readDay(s: string, today: Date, lang: 'en' | 'pt' | 'es'): Date | null {
  let m: RegExpMatchArray | null;
  if ((m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) return dayOf(+m[1]!, +m[2]!, +m[3]!);
  // Numbers: day first in Portuguese and Spanish, month first in English (the hirer's own language).
  if ((m = s.match(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{4}|\d{2}))?\b/))) {
    const [a, b] = [+m[1]!, +m[2]!];
    const [day, month] = lang === 'en' ? [b, a] : [a, b];
    if (m[3]) return dayOf(m[3].length === 2 ? 2000 + +m[3] : +m[3], month, day);
    return nextOf(today, month, day);
  }
  // A month's name with its day: "november 15", "15 november", "15 de novembro", "15 de noviembre".
  for (const [name, month] of Object.entries(MONTHS)) {
    const day = s.match(new RegExp(`\\b${name}\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b`))?.[1] ?? s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?: de| of)? ${name}\\b`))?.[1];
    if (day) return nextOf(today, month, +day);
  }
  if (/\b(day after tomorrow|depois de amanha|pasado manana)\b/.test(s)) return addDays(today, 2);
  if (/\b(tomorrow|amanha|manana)\b/.test(s.replace(SPANISH_MORNING, ' '))) return addDays(today, 1);
  if (/\b(today|tonight|hoje|hoy)\b/.test(s)) return today;
  // A day of the month alone: "dia 15", "el 15", "el día 15", "the 15th".
  if ((m = s.match(/\bdia (\d{1,2})\b/) ?? s.match(/\bel (?:dia )?(\d{1,2})\b/) ?? s.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/))) return dayOfMonth(today, +m[1]!);
  for (const [name, weekday] of Object.entries(WEEKDAYS)) {
    if (!new RegExp(`\\b${name}(-feira| feira)?\\b`).test(s)) continue;
    let ahead = (weekday - today.getUTCDay() + 7) % 7;
    if (ahead === 0 && NEXT_WEEK.test(s)) ahead = 7;
    return addDays(today, ahead);
  }
  return null;
}

function readTime(s: string): string | null {
  const t = s.replace(DURATION, ' ');
  if (/\b(noon|midday|meio[ -]dia|mediodia)\b/.test(t)) return '12:00';
  if (/\b(midnight|meia[ -]noite|medianoche)\b/.test(t)) return '00:00';
  // An hour with its minutes or a clock word: "9am", "9:30 pm", "14:30", "14h30", "às 9", "a las 9", "9 da manhã".
  const m =
    t.match(/\b(\d{1,2})(?::(\d{2}))?\s?(am|pm|a\.m\.|p\.m\.)(?!\p{L})/u) ??
    t.match(/\b(\d{1,2}):(\d{2})\b/) ??
    t.match(/\b(\d{1,2})h(\d{2})?\b/) ??
    t.match(/\b(?:as|a las|a la|at|las)\s+(\d{1,2})(?::(\d{2}))?\b/) ??
    t.match(/\b(\d{1,2})(?::(\d{2}))? (?:da|de la|in the) (?:manha|tarde|noite|manana|noche|morning|afternoon|evening)\b/);
  if (!m) return null;
  let hour = +m[1]!;
  const minute = m[2] ? +m[2] : 0;
  const meridiem = m[3]?.replace(/\./g, '');
  if (meridiem === 'am' && hour === 12) hour = 0;
  else if ((meridiem === 'pm' || (!meridiem && LATE.test(t))) && hour < 12) hour += 12;
  if (hour > 23 || minute > 59) return null;
  return `${pad(hour)}:${pad(minute)}`;
}

/** The job's start from its `when` and the local day, or null when the words name neither a day nor a time. */
export function readStart(when: string | null | undefined, today: string | null | undefined, lang: 'en' | 'pt' | 'es'): JobStart | null {
  if (!when || !today || !ISO_DAY.test(today)) return null;
  const [y, mo, d] = today.split('-').map(Number) as [number, number, number];
  const day0 = dayOf(y, mo, d);
  if (!day0) return null;
  const s = fold(when);
  const date = readDay(s, day0, lang);
  const time = readTime(s);
  if (!date && !time) return null;
  return { date: date ? isoOf(date) : null, time };
}
