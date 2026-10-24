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
      // Ordinary CV text the first tripwire refused (review, 2026-10-24).
      'ISO-27001, ISO-17025, IEC-60079 and IEC-61131-3 audits',
      'Mar 2015 – Dec 2019\n- 120 inspections per month',
      '03/2016 - 2019\n- 300 workers on site',
      '2016 – 2019 – 300 obras entregues',
      'Gestão de orçamento de R$ 1.200.000 e contratos de R$ 5.000.000',
      'ISO 9001 2015',
    ]) {
      expect(reason(text), text).toBeNull();
    }
  });

  it('refuses what the first tripwire let through: other dashes, full-width digits, domains, handles and tags', () => {
    const tag = (s: string) => Array.from(s, (c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
    const cases: [string, BlockRefusal][] = [
      [`Call (713) 555${String.fromCharCode(0x2011)}0142`, 'long_number'],
      [`555${String.fromCharCode(0x2013)}123${String.fromCharCode(0x2013)}4567`, 'long_number'],
      [`SSN 123${String.fromCharCode(0x2013)}45${String.fromCharCode(0x2013)}6789`, 'long_number'],
      [`WhatsApp 98765${String.fromCharCode(0x2011)}4321`, 'long_number'],
      [`Cel. 55${String.fromCharCode(0x2011)}1234${String.fromCharCode(0x2011)}5678`, 'long_number'],
      [`Tel ${'５５５'}-${'０１４２'}`, 'long_number'],
      ['Portfolio at joaosilva.com.', 'url'],
      ['Links: linktr.ee/joaosilva', 'url'],
      ['Demo at soldas.ai', 'url'],
      ['JOAOSILVA.COM.BR/PROJETOS', 'url'],
      ['Instagram:@joaosilva_soldas', 'handle'],
      [`Leak detection ${tag('call 5551234567')}`, 'hidden_characters'],
      [`Soft${String.fromCharCode(0xad)}hyphen`, 'hidden_characters'],
    ];
    for (const [text, why] of cases) expect(reason(text), text).toBe(why);
  });

  // Review round 2 (2026-10-24): classes, not just the inputs round 1 named.
  const c = (...cps: number[]) => String.fromCodePoint(...cps);

  it('counts a number whole when a group reads like a year or it wraps across lines', () => {
    for (const text of [
      'Call (713) 555-2019',
      'Phone 713-555-1987',
      '713 555 2024',
      'Social 123-45-2001',
      'Cel 98765-2019',
      'Tel (11) 3456-2019',
      'Tel (11) 2019-3456',
      'Tel. 55 2019 5678',
      'Cel 81-1999-4567',
      'Call (713) 555-\n0142',
      'Call (713)\n555-0142',
      'Documento 123.456.\n789-00',
      `Tel 713${c(0xb7)}555${c(0xb7)}0142`,
      `Tel 713${c(0x2022)}555${c(0x2022)}0142`,
      'Tel 713_555_0142',
      'ISO 9001 2015 713 555 0142',
      'IMO 9876543',
    ]) {
      expect(reason(text), text).toBe('long_number');
    }
  });

  it('refuses addresses, domains and handles in the forms people write them', () => {
    const cases: [string, BlockRefusal][] = [
      ['joao@gmail', 'email'],
      ['joao@gmail .com', 'email'],
      ['joao at gmail dot com', 'email'],
      ['joaosilva arroba gmail ponto com', 'email'],
      ['Portfolio: joaosilva.pro', 'url'],
      ['see joao-silva.eu', 'url'],
      ['Links: lnk.bio/joaosilva', 'url'],
      ['taplink.cc/joaosilva', 'url'],
      ['is.gd/abc123', 'url'],
      ['joaosilva.com-portfolio', 'url'],
      ['joaosilva.com|Instagram', 'url'],
      [`joaosilva.com${c(0x2014)}soldas`, 'url'],
      [`joaosilva${c(0x3002)}com`, 'url'],
      ['joaosilva[.]com', 'url'],
      ['joaosilva dot com', 'url'],
      ['joaosilva . com', 'url'],
      ['Instagram "@joaosilva"', 'handle'],
      [`Me siga no Instagram ${c(0x201c)}@joaosoldas${c(0x201d)}`, 'handle'],
      ['Instagram [@joaosilva]', 'handle'],
      ['IG|@joaosilva', 'handle'],
      [`Instagram ${c(0xab)}@joaosilva${c(0xbb)}`, 'handle'],
      ['IG @j', 'handle'],
      ['Instagram: joaosilva_soldas', 'handle'],
      ['Skype: joao.silva85', 'handle'],
      ['GitHub: joaosilva', 'handle'],
      ['curp gomj800101hdfrrn09', 'id_number'],
      ['GOMJ 800101 HDFRRN09', 'id_number'],
      ['mi rfc es gomj800101ab1', 'id_number'],
    ];
    for (const [text, why] of cases) expect(reason(text), text).toBe(why);
  });

  it('refuses every character that hides text, and passes the ones emoji are made of', () => {
    for (const text of [
      `Leak repair${c(0xfe01, 0xfe02)}`,
      `Leak${c(0xfe01)}repair`,
      `Leak${c(0x34f)}repair`,
      `Leak${c(0x61c)}repair`,
      `Leak${c(0xfff9)}repair${c(0xfffa)}555${c(0xfffb)}`,
      `Tel 713${c(0x2800)}555`,
      `Leak${c(0x180b)}repair`,
      `Leak${c(0x200d)}repair`,
      `Leak${c(0x85)}repair`,
    ]) {
      expect(reason(text), JSON.stringify(text)).toBe('hidden_characters');
    }
    for (const text of [
      `Mec${c(0xe2)}nico ${c(0x1f468, 0x200d, 0x1f527)} de motores`,
      `Mec${c(0xe2)}nica ${c(0x1f469, 0x1f3fd, 0x200d, 0x1f527)}`,
      `Habilidades ${c(0x2714, 0xfe0f)} solda TIG`,
      `Etapas ${c(0x31, 0xfe0f, 0x20e3)} e ${c(0x32, 0xfe0f, 0x20e3)}`,
    ]) {
      expect(reason(text), JSON.stringify(text)).toBeNull();
    }
  });

  it('passes ordinary CV text that looks like a domain or an amount', () => {
    for (const text of [
      'Managed the crew.In 2019 I moved to Houston',
      `Respons${c(0xe1)}vel pela equipe.No projeto atuei como l${c(0xed)}der`,
      `Manuten${c(0xe7, 0xe3)}o preventiva.De 2015 a 2019 na obra`,
      'Fixed the pump.It ran for years',
      'Constructora S.A.de C.V. proyectos',
      'ASP.NET/C# developer',
      'Node.js, Socket.IO and Express',
      'Diagrams in draw.io and Visio',
      'Budget 1.200.000 reais',
      'Presupuesto de 2.500.000 pesos',
      'Budget US$ 1.234.567,89',
      '01/2015 ' + c(0x2013) + ' 12/2019 e 01/2020 ' + c(0x2013) + ' 06/2023',
      '3 x 1500 kW generators, 2 x 750 kW',
      '13.8 kV, 4160 V, 480 V and 120 V systems',
      'Caterpillar 3516B and 3512C engines',
      'Pressure @ 10 bar',
    ]) {
      expect(reason(text), text).toBeNull();
    }
  });

  // Review round 3 (2026-10-24): what round 2's patterns refused wrongly, and what they still let through.
  it('passes trade text that round 2 refused: ratings, quantities, Portuguese "ponto com", initials, short dates, OSHA sections', () => {
    for (const text of [
      'Motors 480V@60Hz, 3 phase',
      'Torque 250Nm@1500rpm',
      'Busco un@ plomer@ con experiencia',
      'Pressure tested BOP stack to 10000psi',
      'Installed 9000btu and 12000btu split units',
      'Motorista categoria E, 500000km rodados',
      'Obras de 50000m2',
      `Cria${c(0xe7, 0xe3)}o de novo ponto com tomada 20A`,
      'Passei o fio do quadro e cada ponto pro disjuntor',
      `En cada punto me asegur${c(0xe9)} del torque`,
      'Conducted DOT site inspections',
      'Promoted to Foreman.In 2019 I led 12 people',
      'Chief Engineer.At sea for 6 years',
      'Foreman.So I took over',
      `Aux.de Produ${c(0xe7, 0xe3)}o`,
      'Constructora S.de R.L. de C.V.',
      'Contratado por [ORG_1] Ltda.ME',
      'Asp.Net and C# maintenance tools',
      'Electrician, [ORG_1], 03/19 - 05/21',
      '03/19-05/21',
      `15/03/19 ${c(0x2013)} 20/05/21`,
      'Trained in OSHA 1910.147 lockout/tagout',
      '29 CFR 1926.501 fall protection',
      'HazCom 1910.1200',
      'NBR 5410 e NBR 14039',
      'NOM-001-SEDE-2012, NOM-035-STPS-2018',
      `Torres: 120 ${c(0x2022)} 300 ${c(0x2022)} 450`,
      `1.200.000 m${c(0xb3)} de concreto`,
      `Or${c(0xe7)}amento anual de R$ 1.200.000\n300 obras entregues`,
      'Threads: NPT, BSP and metric',
      'Instagram: Reels and Stories; Facebook: Ads Manager',
      'Inspections 2018\n1200 welds 2019',
      'YEAR 2019 10 MONTHS 12 CREW',
      'Can someone come today @3pm?',
    ]) {
      expect(reason(text), text).toBeNull();
    }
  });

  it('refuses what round 2 still let through', () => {
    const cases: [string, BlockRefusal][] = [
      ['Tel (11) 3456 - 2019', 'long_number'],
      ['Call (713) 555-\n2019', 'long_number'],
      ['Tel. 55 - 2019 - 5678', 'long_number'],
      ['CONTACTO EN 5512345678', 'long_number'],
      ['Call 1-800-PLUMBER', 'long_number'],
      ['joao.silva @ gmail', 'email'],
      ['joao.silva85 at hotmail', 'email'],
      ['joao (at) gmail (dot) com', 'email'],
      ['joaosilva.Com', 'url'],
      ['joaoplumbing.services', 'url'],
      ['Instagram - joaosilva_soldas', 'handle'],
      ['IG | joaosilva', 'handle'],
      ['Instagram joaosilva_soldas', 'handle'],
      ['linkedin /in/joaosilva', 'handle'],
      ['Data de nascimento 15/03/1985', 'personal_field'],
    ];
    for (const [text, why] of cases) expect(reason(text), text).toBe(why);
  });

  it('scans a crafted block at the size cap in milliseconds', () => {
    const fill = (unit: string) => unit.repeat(Math.ceil(BLOCK_MAX_CHARS / unit.length)).slice(0, BLOCK_MAX_CHARS);
    const gap = ' '.repeat(995);
    for (const text of [
      `ab${gap}at${gap}cd${gap}dot${gap}zz`,
      fill('joao ponto '),
      fill('instagram: ab '),
      fill('1 - '),
      fill('12\n'),
      fill('ab-'),
      fill('A1'),
      fill('a'),
    ]) {
      const t0 = performance.now();
      scanText(text);
      expect(performance.now() - t0, text.slice(0, 20)).toBeLessThan(100);
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
