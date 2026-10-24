// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  BLOCK_MAX_CHARS,
  checkBlock,
  isPlaceholder,
  placeholdersIn,
  scanText,
  type BlockRefusal,
} from '../src/services/work/blocks.js';
import documents from './fixtures/work/documents.json';
import { FIXTURE_CVS, HIRER_PROMPTS, REFUSED_BLOCKS, fixtureBlocks } from './fixtures/work/index.js';

const block = (text: string, kind = 'experience', lang = 'en') => checkBlock({ kind, lang, text });
const reason = (text: string, kind = 'experience', lang = 'en') => {
  const r = block(text, kind, lang);
  return r.ok ? null : r.reason;
};

describe('checkBlock', () => {
  it('passes a de-identified block and normalizes it to NFC', () => {
    const decomposed = `Soldador de Tubulac${String.fromCharCode(0x327)}a${String.fromCharCode(0x303)}o – [ORG_1]\n03/2018 – atual`;
    const r = block(`  ${decomposed}  `, 'experience', 'pt');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.block.text).toBe(decomposed.normalize('NFC'));
      expect(r.block.text.startsWith('Soldador de Tubulação')).toBe(true);
      expect(r.block).toMatchObject({ kind: 'experience', lang: 'pt' });
    }
  });

  it('allows dates, year ranges, codes and trade numbers', () => {
    for (const text of [
      'Engine Cadet, [ORG_2]\n08/2016 - 05/2019',
      'Electrician Apprentice\n2016-2020, 2020-2024',
      'Caldeireiro\nfev/2014 – jan/2018',
      'NR-10 Básico; NR-35; ISO 9001:2015; NFPA 70E; OSHA 10-Hour',
      'Installed 200 A service upgrades and Level 2 EV chargers',
      'Operación de grúas telescópicas de hasta 60 toneladas',
      'C#, ASP.NET and VB.NET maintenance tools',
      'CNH categoria D; Cidade de atuação: litoral',
      'Licencia [ID_1]; credential [ID_2]',
    ]) {
      expect(reason(text), text).toBeNull();
    }
  });

  it('refuses what must stay on the phone, with a reason and never the text', () => {
    const cases: [string, BlockRefusal][] = [
      ['Write to me at someone@example.com', 'email'],
      ['Portfolio at www.example.net', 'url'],
      ['See gov.br/servicos for my licence', 'url'],
      ['Find me @tiago_solda', 'handle'],
      ['RG nº: 12.345.678-9', 'personal_field'],
      ['Fecha de nacimiento: 1990', 'personal_field'],
      ['Passaporte nº X1', 'personal_field'],
      ['Clave XEXX010101HNEXXXA4', 'id_number'],
      ['RFC XAXX010101000', 'id_number'],
      ['Licence AB-1234567', 'id_number'],
      ['Tel 555-0142', 'long_number'],
      ['+52 81 1234 5678', 'long_number'],
      ['Card 4111 1111 1111 1111', 'long_number'],
      ['CEP 22041-001', 'long_number'],
      [`Leak${String.fromCharCode(0x200b)}detection`, 'hidden_characters'],
    ];
    for (const [text, why] of cases) expect(reason(text), text).toBe(why);
  });

  it('refuses kinds that never leave the phone, unknown kinds and languages, and bad shapes', () => {
    for (const kind of ['header', 'contact', 'references', 'personal', 'photo']) expect(reason('[PERSON_1]', kind)).toBe('kind_not_allowed');
    expect(reason('Plombier', 'summary', 'fr')).toBe('lang_not_supported');
    expect(reason('  ')).toBe('empty');
    expect(reason('x'.repeat(BLOCK_MAX_CHARS + 1))).toBe('too_long');
    for (const bad of [null, 'text', 42, { kind: 'summary', lang: 'en' }, { kind: 'summary', lang: 'en', text: 7 }]) {
      expect(checkBlock(bad)).toEqual({ ok: false, reason: 'bad_shape' });
    }
  });

  it('reads placeholders and never counts their numbers', () => {
    expect(placeholdersIn('Plumber, [ORG_1], [PLACE_12]; [NAME_1]')).toEqual(['[ORG_1]', '[PLACE_12]']);
    expect(isPlaceholder('[ORG_3]')).toBe(true);
    expect(isPlaceholder('[ORG_3]', ['PLACE'])).toBe(false);
    expect(isPlaceholder('[ORG_0]')).toBe(false);
    expect(isPlaceholder('at [ORG_3]')).toBe(false);
    expect(scanText('[ID_1] [ID_2] [ID_3] [ID_4]')).toBeNull();
  });
});

describe('the Work fixtures', () => {
  it('cover three CVs in each of en-US, pt-BR and es-MX, with unique ids', () => {
    const byLocale = new Map<string, number>();
    for (const cv of FIXTURE_CVS) byLocale.set(cv.locale, (byLocale.get(cv.locale) ?? 0) + 1);
    expect(Object.fromEntries(byLocale)).toEqual({ 'en-US': 3, 'pt-BR': 3, 'es-MX': 3 });
    const ids = fixtureBlocks().map(({ block }) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { cv, block } of fixtureBlocks()) {
      expect(block.id.startsWith(`${cv.id}/`)).toBe(true);
      expect(block.lang).toBe(cv.locale.slice(0, 2));
    }
  });

  it('pass the plane’s own de-identification check, block by block', () => {
    for (const { block } of fixtureBlocks()) {
      const r = checkBlock(block);
      expect(r.ok, `${block.id}: ${r.ok ? '' : r.reason}`).toBe(true);
      if (r.ok) expect(r.block.text).toBe(block.text);
    }
  });

  it('keep every gold string a span of its block, and every gold date YYYY or YYYY-MM', () => {
    const date = /^\d{4}(-(0[1-9]|1[0-2]))?$/;
    for (const { block } of fixtureBlocks()) {
      for (const [field, value] of Object.entries(block.expected)) {
        const values = Array.isArray(value) ? value : [value];
        for (const v of values) {
          if (typeof v !== 'string') continue;
          if (field === 'start' || field === 'end') expect(v, `${block.id}.${field}`).toMatch(date);
          else expect(block.text.includes(v), `${block.id}.${field}: ${v}`).toBe(true);
        }
      }
      if (block.kind === 'experience') {
        const e = block.expected;
        expect(typeof e.current, block.id).toBe('boolean');
        if (e.current) expect(e.end, block.id).toBeNull();
        for (const p of ['employer', 'location'] as const) if (e[p] != null) expect(isPlaceholder(String(e[p])), `${block.id}.${p}`).toBe(true);
      }
    }
  });

  it('publish coarse regions and scopes only', () => {
    for (const cv of FIXTURE_CVS) {
      expect(cv.listing.region, cv.id).toMatch(/^[a-z]{2}(-[a-z0-9]{1,3})?$/);
      expect(['onsite', 'remote']).toContain(cv.listing.scope);
      expect([0, 1, 2]).toContain(cv.listing.tier);
    }
  });

  it('refuse every negative fixture for its stated reason', () => {
    expect(REFUSED_BLOCKS.length).toBeGreaterThanOrEqual(15);
    for (const f of REFUSED_BLOCKS) expect(checkBlock(f.block), f.id).toEqual({ ok: false, reason: f.reason });
  });

  it('hold the other Vault documents as body blocks the plane accepts, one gold type each', () => {
    const types = new Set<string>();
    for (const d of documents.documents) {
      types.add(d.type);
      for (const b of d.blocks) {
        expect(b.kind, d.id).toBe('body');
        const r = checkBlock(b);
        expect(r.ok, `${d.id}: ${r.ok ? '' : r.reason}`).toBe(true);
      }
    }
    expect([...types].sort()).toEqual(['certificate', 'licence', 'other', 'passport']);
  });

  it('hold the hirer prompt set in three languages, spans exact and text de-identified', () => {
    const canonical = ['sink', 'ev-charger', 'rigger', 'translation', 'gardener', 'harmful', 'injection'];
    for (const suffix of ['en', 'pt', 'es']) {
      for (const id of canonical) expect(HIRER_PROMPTS.some((p) => p.id === `${id}-${suffix}`), `${id}-${suffix}`).toBe(true);
    }
    for (const p of HIRER_PROMPTS) {
      expect(scanText(p.text), p.id).toBeNull();
      expect(p.region, p.id).toMatch(/^[a-z]{2}(-[a-z0-9]{1,3})?$/);
      for (const key of ['task', 'when', 'credential', 'language', 'recurrence'] as const) {
        const v = p.expected[key];
        if (v != null) expect(p.text.includes(v), `${p.id}.${key}: ${v}`).toBe(true);
      }
      if (p.expected.refuse) expect(p.expected.task).toBeNull();
    }
  });
});
