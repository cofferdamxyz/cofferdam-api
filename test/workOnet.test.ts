// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The US layer (workspace decision 0066), on synthetic files in the official
 * layouts: the ESCO URIs end in `test-…`, the ISCO codes (9990, 9991, 9992)
 * belong to no ISCO-08 unit group, and the O*NET codes (99-…) to no O*NET
 * occupation. Real codes enter the registry only from the founder's downloads.
 */

import { describe, expect, it } from 'vitest';

import { planEscoImport, registrySql } from '../src/services/work/esco.js';
import { nationalSqlFiles, nationalVectorLine } from '../src/services/work/national.js';
import {
  clefChooser,
  layerLabelSets,
  onetCandidates,
  OnetFormatError,
  planOnetLayer,
  readCrosswalk,
  readOnetTitles,
  titleForms,
  type OnetPlanDeps,
} from '../src/services/work/onet.js';
import { D1RegistryStore, labelIdOf } from '../src/services/work/registry.js';
import { sqliteD1 } from './fixtures/work/d1.js';
import { axis, clefChoice, fakeInference, near, type FakeCall } from './fixtures/work/fakes.js';

const OCC_HEADER = 'conceptType,conceptUri,iscoGroup,preferredLabel,altLabels,hiddenLabels,status,modifiedDate,regulatedProfessionNote,scopeNote,definition,inScheme,description,code';
const uri = (n: string) => `http://data.europa.eu/esco/occupation/test-${n}`;
const OCC_EN = [
  OCC_HEADER,
  `Occupation,${uri('01')},9990,pipe fitter,pipefitter,,released,,,,,,,9990.1`,
  `Occupation,${uri('02')},9990,plumber,plumbing technician,,released,,,,,,,9990.2`,
  `Occupation,${uri('03')},9990,sprinkler fitter,,,released,,,,,,,9990.3`,
  `Occupation,${uri('04')},9991,ship engineer,marine engineer,,released,,,,,,,9991.1`,
  `Occupation,${uri('05')},9991,deck officer,,,released,,,,,,,9991.2`,
  `Occupation,${uri('06')},9992,warehouse worker,,,released,,,,,,,9992.1`,
].join('\n');
const OCC_PT = [
  OCC_HEADER,
  `Occupation,${uri('04')},9991,oficial de máquinas,maquinista naval,,released,,,,,,,9991.1`,
  `Occupation,${uri('02')},9990,canalizador,tubista,,released,,,,,,,9990.2`,
].join('\n');

const CROSSWALK = [
  'Mapping project name,ESCO-O*NET Crosswalk,',
  'Mapping project version,1,',
  ',,',
  'O*NET Id,O*NET Title,O*NET Description,ESCO or ISCO URI,ESCO or ISCO Title,ESCO or ISCO Description,Type of Match',
  `99-0001.00,Synthetic Pipe Trades,"Lay, fit, repair",${uri('01')},pipe fitter,x,broadMatch`,
  `99-0001.00,Synthetic Pipe Trades,"Lay, fit, repair",${uri('02')},plumber,x,broadMatch`,
  `99-0001.00,Synthetic Pipe Trades,"Lay, fit, repair",${uri('03')},sprinkler fitter,x,broadMatch`,
  `99-0002.00,Synthetic Marine Engineers,x,${uri('04')},ship engineer,x,broadMatch`,
  `99-0002.00,Synthetic Marine Engineers,x,${uri('04')},ship engineer,x,exactMatch`,
  '99-0003.00,Synthetic Ship Officers,x,http://data.europa.eu/esco/isco/C9991,Synthetic group,x,exactISCO',
  `99-0004.00,Synthetic Stock Clerks,x,${uri('06')},warehouse worker,x,closeMatch`,
  `99-0005.00,Synthetic Orphans,x,${uri('99')},not in the registry,x,closeMatch`,
  ',,,,,,',
].join('\r\n');

const JOB_TITLES = [
  'O*NET-SOC Code,Title,Job Title,Short Title,Source(s)',
  '99-0001.00,Synthetic Pipe Trades,Sprinkler System Installer,,08',
  '99-0001.00,Synthetic Pipe Trades,Steamfitter,,08',
  '99-0001.00,Synthetic Pipe Trades,Pipefitter,,08',
  '99-0001.00,Synthetic Pipe Trades,Pipe Trades Generalist,,08',
  '99-0001.00,Synthetic Pipe Trades,Pipe Trades Helper,,08',
  '99-0001.00,Synthetic Pipe Trades,Tubista,,08',
  '99-0002.00,Synthetic Marine Engineers,Marine Engine Mechanic,,04',
  '99-0002.00,Synthetic Marine Engineers,Maquinista Naval,,04',
  '99-0002.00,Synthetic Marine Engineers,Chief Engineer (CE),CE,04',
  '99-0002.00,Synthetic Marine Engineers,Yard Technician,,04',
  '99-0003.00,Synthetic Ship Officers,Deck Watch Officer,,10',
  '99-0003.00,Synthetic Ship Officers,Ship Officer Trainee,,10',
  '99-0004.00,Synthetic Stock Clerks,Stock Handler (Stock Hand),Stock Hand,02',
  '99-0004.00,Synthetic Stock Clerks,Yard Technician,,02',
  '99-0004.00,Synthetic Stock Clerks,Plumbing Technician,,02',
  '99-0005.00,Synthetic Orphans,Orphan Title,,02',
  '99-0006.00,Synthetic Unmapped,Unmapped Title,,02',
].join('\n');
const REPORTED = [
  'O*NET-SOC Code,Title,Reported Job Title,Shown in My Next Move',
  '99-0002.00,Synthetic Marine Engineers,Marine  Engine Mechanic,Y',
  '99-0004.00,Synthetic Stock Clerks,Warehouse Associate,N',
].join('\n');

/** A unit vector with these cosines to the axes, the rest along `rest`. */
function mix(parts: Record<number, number>, rest: number): number[] {
  const v = new Array<number>(1024).fill(0);
  let sum = 0;
  for (const [a, c] of Object.entries(parts)) {
    v[Number(a)] = c;
    sum += c * c;
  }
  v[rest] = Math.sqrt(Math.max(0, 1 - sum));
  return v;
}

const VECTORS: Record<string, number[]> = {
  'pipe fitter': axis(0),
  pipefitter: axis(0),
  plumber: axis(1),
  'plumbing technician': axis(1),
  'sprinkler fitter': axis(2),
  'ship engineer': axis(3),
  'marine engineer': axis(3),
  'deck officer': axis(4),
  'warehouse worker': axis(5),
  'Sprinkler System Installer': near(2, 10, 0.97),
  Steamfitter: mix({ 0: 0.6, 1: 0.58 }, 11),
  'Pipe Trades Generalist': mix({ 0: 0.5, 1: 0.49, 2: 0.48 }, 12),
  'Pipe Trades Helper': mix({ 0: 0.5, 1: 0.5, 2: 0.4 }, 13),
  'Deck Watch Officer': near(4, 14, 0.8),
  'Ship Officer Trainee': near(4, 28, 0.7),
  // Titles held only by a Portuguese label: the plumber's "tubista", the ship engineer's "maquinista naval".
  Tubista: near(0, 27, 0.97),
  'Maquinista Naval': near(3, 26, 0.96),
  'Marine Engine Mechanic': near(3, 20, 0.96),
  'Chief Engineer': axis(21),
  'Yard Technician': axis(22),
  'Stock Handler': near(5, 23, 0.97),
  'Stock Hand': near(5, 24, 0.8),
  'Warehouse Associate': axis(25),
};

function embedFrom(table: Record<string, number[]>, seen: string[][] = [], roles: string[] = []): OnetPlanDeps['embed'] {
  return async (texts, role) => {
    seen.push(texts);
    roles.push(role);
    return texts.map((t) => {
      const v = table[t];
      if (!v) throw new Error(`no fake embedding for "${t}"`);
      return v;
    });
  };
}

/** Clef in the fake, by title: its choice, that choice's probability and none's; a failure for the helper. */
const CLEF: Record<string, [string, number, number]> = {
  Steamfitter: ['c0', 0.81, 0.05],
  'Pipe Trades Generalist': ['none', 0.65, 0.65],
  // Sure it is the one candidate, but not that it is one at all: left out.
  'Chief Engineer': ['c0', 0.75, 0.2],
  'Yard Technician': ['c0', 0.8, 0.05],
  // One of them, and Clef's most probable is the embedding's best, the deck officer.
  'Deck Watch Officer': ['c0', 0.55, 0.05],
  // One of them, but Clef's most probable (the ship engineer) is not the embedding's best: left out.
  'Ship Officer Trainee': ['c1', 0.6, 0.05],
  'Stock Hand': ['c0', 0.9, 0.04],
  'Warehouse Associate': ['none', 0.7, 0.7],
};
function clefAnswers(input: Record<string, unknown>) {
  const answer = CLEF[String(input.state).split('\n').pop()!];
  if (!answer) return new Error('clef unavailable');
  const [choice, p, none] = answer;
  return clefChoice('match', choice, { [choice]: p, none });
}

async function registry() {
  const esco = await planEscoImport({ occupations: { en: OCC_EN, pt: OCC_PT } });
  return { esco, ...layerLabelSets(esco.tokens, esco.labels) };
}

async function plan(deps: Partial<OnetPlanDeps> = {}, calls: FakeCall[] = []) {
  const r = await registry();
  const input = {
    crosswalk: readCrosswalk(CROSSWALK),
    titles: [...readOnetTitles(JOB_TITLES), ...readOnetTitles(REPORTED)],
    tokens: r.esco.tokens,
    english: r.english,
    known: r.known,
    foreign: r.foreign,
    release: '31.0',
  };
  const out = await planOnetLayer(input, { embed: embedFrom(VECTORS), choose: clefChooser(fakeInference({ 'work-adjudicate': clefAnswers }, calls)), ...deps });
  return { ...r, plan: out };
}

const tokenOfUri = (tokens: { token: string; escoUri: string | null }[], n: string) => tokens.find((t) => t.escoUri === uri(n))!.token;

describe('readCrosswalk', () => {
  it('reads the rows under the header, past the metadata block and blank rows', () => {
    const rows = readCrosswalk(CROSSWALK);
    expect(rows).toHaveLength(8);
    expect(rows[0]).toEqual({ onetCode: '99-0001.00', onetTitle: 'Synthetic Pipe Trades', target: uri('01'), match: 'broadMatch' });
    expect(rows.map((r) => r.match)).toContain('exactISCO');
  });

  it('stops on a file without the header, a missing column or an unknown match type', () => {
    expect(() => readCrosswalk('a,b\n1,2')).toThrow(OnetFormatError);
    expect(() => readCrosswalk('O*NET Id,O*NET Title,Type of Match\n99-0001.00,x,exactMatch')).toThrow(/missing ESCO or ISCO URI/);
    expect(() => readCrosswalk(CROSSWALK.replace('closeMatch', 'sortOfMatch'))).toThrow(/unknown match type "sortOfMatch" for 99-0004.00/);
  });
});

describe('readOnetTitles', () => {
  it('reads the job titles with their short titles, and the reported titles', () => {
    const titles = readOnetTitles(JOB_TITLES);
    expect(titles).toHaveLength(17);
    expect(titles.find((t) => t.title.startsWith('Chief'))).toEqual({ onetCode: '99-0002.00', title: 'Chief Engineer (CE)', short: 'CE' });
    expect(titles[0]!.short).toBeNull();
    expect(readOnetTitles(REPORTED)).toEqual([
      { onetCode: '99-0002.00', title: 'Marine  Engine Mechanic', short: null },
      { onetCode: '99-0004.00', title: 'Warehouse Associate', short: null },
    ]);
    expect(() => readOnetTitles('code,title\n1,x')).toThrow(OnetFormatError);
  });
});

describe('titleForms', () => {
  it('splits a long form from its short one by the short title, an abbreviation, or a shared word', () => {
    expect(titleForms('CPA (Certified Public Accountant)', 'CPA')).toEqual({ forms: ['Certified Public Accountant'], acronyms: ['CPA'], qualified: false });
    expect(titleForms('Endoscopy Technician (Endoscopy Tech)', 'Endoscopy Tech')).toEqual({ forms: ['Endoscopy Technician', 'Endoscopy Tech'], acronyms: [], qualified: false });
    expect(titleForms('Surgical RN (Surgery Registered Nurse)', 'Surgical RN')).toEqual({ forms: ['Surgery Registered Nurse', 'Surgical RN'], acronyms: [], qualified: false });
    expect(titleForms('LPC (Licensed Professional Counselor)', null)).toEqual({ forms: ['Licensed Professional Counselor'], acronyms: [], qualified: false });
    expect(titleForms('Strategic Debriefing Officer (SDO)', null).forms).toEqual(['Strategic Debriefing Officer']);
    expect(titleForms('Endoscopy Technician (Endoscopy Tech)', null).forms).toEqual(['Endoscopy Technician']);
  });

  it('leaves out a title with a qualifier, which neither part names alone', () => {
    expect(titleForms('Singer (Burning)', null)).toEqual({ forms: [], acronyms: [], qualified: true });
    expect(titleForms('Operational Intelligence Officer (Analyst)', null).qualified).toBe(true);
  });

  it('drops an aside in parentheses, and returns a bare acronym apart', () => {
    expect(titleForms('Electroencephalogram (EEG) Technologist', null).forms).toEqual(['Electroencephalogram Technologist']);
    expect(titleForms('Registered Radiologic Technologist (RT (R))', null).forms).toEqual(['Registered Radiologic Technologist']);
    expect(titleForms('  Pipe   Layer ', null).forms).toEqual(['Pipe Layer']);
    expect(titleForms('CNA', null)).toEqual({ forms: [], acronyms: ['CNA'], qualified: false });
    expect(titleForms('AP BD+C', null)).toEqual({ forms: [], acronyms: ['AP BD+C'], qualified: false });
    expect(titleForms('Stock Hand', 'stock hand').forms).toEqual(['Stock Hand']);
  });
});

describe('onetCandidates', () => {
  it('gives each O*NET occupation its ESCO tokens, the whole unit group for exactISCO, and the stronger of two relations', async () => {
    const { esco } = await registry();
    const c = onetCandidates(readCrosswalk(CROSSWALK), esco.tokens);
    const view = (code: string) => c.get(code)!.map((x) => [x.token.token, x.relation]);
    expect(view('99-0001.00')).toEqual([
      [tokenOfUri(esco.tokens, '01'), 'broad'],
      [tokenOfUri(esco.tokens, '02'), 'broad'],
      [tokenOfUri(esco.tokens, '03'), 'broad'],
    ]);
    expect(view('99-0002.00')).toEqual([[tokenOfUri(esco.tokens, '04'), 'exact']]);
    expect(view('99-0003.00')).toEqual([
      [tokenOfUri(esco.tokens, '04'), 'isco'],
      [tokenOfUri(esco.tokens, '05'), 'isco'],
    ]);
    expect(view('99-0005.00')).toEqual([]);
  });

  it('reads an exactISCO minor group (three digits) as every occupation under it', async () => {
    const { esco } = await registry();
    const minor = { onetCode: '99-0007.00', onetTitle: 'Synthetic Group Workers', target: 'http://data.europa.eu/esco/isco/C999', match: 'exactISCO' as const };
    const c = onetCandidates([...readCrosswalk(CROSSWALK), minor], esco.tokens);
    expect(c.get('99-0007.00')!.map((x) => x.relation)).toEqual(['isco', 'isco', 'isco', 'isco', 'isco', 'isco']);
    expect(c.get('99-0007.00')!.map((x) => x.token.iscoCode)).toEqual(['9990', '9990', '9990', '9991', '9991', '9992']);
  });
});

describe('planOnetLayer', () => {
  it('places each title on one candidate: sure and clear without a model, otherwise by Clef, a single candidate too', async () => {
    const calls: FakeCall[] = [];
    const { esco, plan: p } = await plan({}, calls);
    const at = (title: string) => p.placements.filter((x) => x.title === title).map((x) => [x.onetCode, x.method, x.token]);
    const t = (n: string) => tokenOfUri(esco.tokens, n);
    expect(at('Sprinkler System Installer')).toEqual([['99-0001.00', 'lead', t('03')]]);
    expect(at('Steamfitter')).toEqual([['99-0001.00', 'clef', t('01')]]);
    expect(at('Pipe Trades Generalist')).toEqual([['99-0001.00', 'none', null]]);
    expect(at('Pipe Trades Helper')).toEqual([['99-0001.00', 'clef_failed', null]]);
    expect(at('Marine Engine Mechanic')).toEqual([['99-0002.00', 'single', t('04')]]);
    expect(at('Chief Engineer')).toEqual([['99-0002.00', 'none', null]]);
    expect(at('Deck Watch Officer')).toEqual([['99-0003.00', 'clef', t('05')]]);
    // Clef's most probable candidate is not the embedding's best: neither is taken.
    expect(at('Ship Officer Trainee')).toEqual([['99-0003.00', 'disagreed', null]]);
    expect(at('Stock Handler')).toEqual([['99-0004.00', 'single', t('06')]]);
    expect(at('Stock Hand')).toEqual([['99-0004.00', 'clef', t('06')]]);
    // The crosswalk's one candidate, which Clef says the title is not.
    expect(at('Warehouse Associate')).toEqual([['99-0004.00', 'none', null]]);
    const steam = p.placements.find((x) => x.title === 'Steamfitter')!;
    expect(steam).toMatchObject({ candidates: 3, p: 0.81, none: 0.05 });
    expect(p.placements.find((x) => x.title === 'Chief Engineer')).toMatchObject({ p: 0.75, none: 0.2 });
    expect(steam.best! - steam.second!).toBeCloseTo(0.02, 6);
    expect(p.placements.find((x) => x.title === 'Stock Handler')).toMatchObject({ candidates: 1, second: null });
    expect(p.placements.find((x) => x.title === 'Stock Handler')!.best).toBeCloseTo(0.97, 6);

    // Clef saw the O*NET occupation and the crosswalk's candidates, best first, by key.
    const asked = calls.map((c) => c.input as { state: string; questions: { match: { criteria: Record<string, string> } } });
    expect(asked).toHaveLength(10);
    expect(asked[0]!.state).toBe('A job title as the US O*NET database lists it, under the occupation "Synthetic Pipe Trades":\nSteamfitter');
    expect(asked[0]!.questions.match.criteria).toEqual({
      c0: 'pipe fitter',
      c1: 'plumber',
      c2: 'sprinkler fitter',
      none: 'None of these: a different occupation',
    });
  });

  it("leaves out what the registry holds, titles of two tokens, acronyms, and titles with no candidate", async () => {
    const { esco, plan: p } = await plan();
    const at = (title: string) => p.placements.filter((x) => x.title === title).map((x) => [x.onetCode, x.method, x.token]);
    const t = (n: string) => tokenOfUri(esco.tokens, n);
    expect(at('Pipefitter')).toEqual([['99-0001.00', 'known', t('01')]]);
    expect(at('Plumbing Technician')).toEqual([['99-0004.00', 'elsewhere', t('02')]]);
    // Held only by a Portuguese label: placed on its holder, never on another token.
    expect(at('Maquinista Naval')).toEqual([['99-0002.00', 'single', t('04')]]);
    expect(at('Tubista')).toEqual([['99-0001.00', 'elsewhere', t('02')]]);
    expect(at('Yard Technician')).toEqual([
      ['99-0002.00', 'ambiguous', t('04')],
      ['99-0004.00', 'ambiguous', t('06')],
    ]);
    expect(at('CE')).toEqual([['99-0002.00', 'acronym', null]]);
    expect(at('Orphan Title')).toEqual([['99-0005.00', 'no_candidate', null]]);
    expect(at('Unmapped Title')).toEqual([['99-0006.00', 'no_candidate', null]]);
    expect(p.counts).toEqual({
      titles: 20,
      labels: 7,
      codes: 6,
      single: 3,
      lead: 1,
      clef: 3,
      none: 3,
      clef_failed: 1,
      disagreed: 1,
      known: 1,
      elsewhere: 2,
      ambiguous: 2,
      acronym: 1,
      qualified: 0,
      no_candidate: 2,
      unembedded: 0,
    });
  });

  it("writes each placed title once as a US alternative label, its vector the title's own", async () => {
    const { esco, plan: p } = await plan();
    const t = (n: string) => tokenOfUri(esco.tokens, n);
    expect(p.labels.map((l) => [l.label, l.token, l.source])).toEqual([
      ['Sprinkler System Installer', t('03'), 'onet:31.0:99-0001.00'],
      ['Steamfitter', t('01'), 'onet:31.0:99-0001.00'],
      ['Marine Engine Mechanic', t('04'), 'onet:31.0:99-0002.00'],
      ['Maquinista Naval', t('04'), 'onet:31.0:99-0002.00'],
      ['Deck Watch Officer', t('05'), 'onet:31.0:99-0003.00'],
      ['Stock Handler', t('06'), 'onet:31.0:99-0004.00'],
      ['Stock Hand', t('06'), 'onet:31.0:99-0004.00'],
    ]);
    const steam = p.labels.find((l) => l.label === 'Steamfitter')!;
    expect(steam).toEqual({
      labelId: await labelIdOf(t('01'), 'en', 'steamfitter'),
      embedded: true,
      token: t('01'),
      lang: 'en',
      label: 'Steamfitter',
      labelNorm: 'steamfitter',
      kind: 'alternative',
      source: 'onet:31.0:99-0001.00',
      region: 'us',
    });
    const v = p.vectors.get(steam.labelId)!;
    const w = VECTORS.Steamfitter!;
    expect(v.reduce((s, x, i) => s + x * w[i]!, 0)).toBeCloseTo(1, 9);
  });

  it("keeps the crosswalk's codes on its tokens, and an exactISCO code only where its titles went", async () => {
    const { esco, plan: p } = await plan();
    const t = (n: string) => tokenOfUri(esco.tokens, n);
    expect(p.codes.map((c) => [c.token, c.code, c.relation])).toEqual([
      [t('01'), '99-0001.00', 'broad'],
      [t('02'), '99-0001.00', 'broad'],
      [t('03'), '99-0001.00', 'broad'],
      [t('04'), '99-0002.00', 'exact'],
      [t('05'), '99-0003.00', 'isco'],
      [t('06'), '99-0004.00', 'close'],
    ]);
    expect(p.codes.every((c) => c.scheme === 'onet-soc-2019' && c.source === 'esco-onet-crosswalk-v1')).toBe(true);
  });

  it('embeds the open titles as queries, their candidates as documents and each label again as a document, each text once a role', async () => {
    const seen: string[][] = [];
    const roles: string[] = [];
    const { plan: p } = await plan({ embed: embedFrom(VECTORS, seen, roles) });
    const byRole = (role: string) => seen.filter((_, i) => roles[i] === role).flat();
    for (const role of ['query', 'document']) expect(new Set(byRole(role)).size).toBe(byRole(role).length);
    expect(byRole('query')).toContain('Steamfitter');
    expect(byRole('query')).not.toContain('warehouse worker');
    expect(byRole('document')).toEqual(expect.arrayContaining(['warehouse worker', 'plumbing technician', ...p.labels.map((l) => l.label)]));
    expect(seen.flat()).not.toContain('Pipefitter');
    expect(seen.flat()).not.toContain('Orphan Title');
  });

  it('embeds in batches of at most 100', async () => {
    const r = await registry();
    const many = Array.from({ length: 150 }, (_, i) => ({ onetCode: '99-0004.00', title: `Synthetic Stock Title ${i + 1}`, short: null }));
    const seen: string[][] = [];
    const embed: OnetPlanDeps['embed'] = async (texts) => {
      seen.push(texts);
      return texts.map((t) => VECTORS[t] ?? near(5, 30, 0.97));
    };
    const p = await planOnetLayer({ crosswalk: readCrosswalk(CROSSWALK), titles: many, tokens: r.esco.tokens, english: r.english, known: r.known, release: '31.0' }, { embed });
    // The 150 titles as queries, the one candidate's label, then the 150 labels as documents.
    expect(seen.map((b) => b.length)).toEqual([100, 50, 1, 100, 50]);
    expect(p.counts.single).toBe(150);
  });

  it('stops when the model answers the wrong number of vectors or the embedding throws', async () => {
    await expect(plan({ embed: async (texts) => texts.slice(1).map((t) => VECTORS[t]!) })).rejects.toThrow(/embed answered \d+ vectors for \d+ texts/);
    await expect(plan({ embed: () => Promise.reject(new Error('workers ai down')) })).rejects.toThrow('workers ai down');
  });

  it("counts a Clef answer without none's probability as failed, never as Clef's none", async () => {
    const { plan: p } = await plan({ choose: async () => ({ token: null, p: 0.9, probabilities: { 'pos:x': 0.9 } }) });
    expect(p.placements.filter((x) => x.method === 'clef_failed')).toHaveLength(10);
    expect(p.counts.none).toBe(0);
  });

  it('leaves out a title the model cannot embed, and ranks without a label it cannot', async () => {
    const table = { ...VECTORS };
    const embed: OnetPlanDeps['embed'] = async (texts) => texts.map((t) => (t === 'Stock Hand' || t === 'sprinkler fitter' ? null : table[t]!));
    const { plan: p } = await plan({ embed });
    expect(p.placements.find((x) => x.title === 'Stock Hand')!.method).toBe('unembedded');
    expect(p.labels.some((l) => l.label === 'Stock Hand')).toBe(false);
    // Without its one label the sprinkler fitter ranks last, so the installer is no longer a sure lead.
    expect(p.placements.find((x) => x.title === 'Sprinkler System Installer')).toMatchObject({ method: 'clef_failed', best: 0 });
    expect(p.counts.unembedded).toBe(1);
  });

  it('places nothing Clef would decide without Clef, and takes a candidate without it only when sure and clear', async () => {
    const { plan: noClef } = await plan({ choose: undefined });
    expect(noClef.placements.filter((x) => x.method === 'none').map((x) => x.title)).toEqual([
      'Steamfitter',
      'Pipe Trades Generalist',
      'Pipe Trades Helper',
      'Chief Engineer',
      'Yard Technician',
      'Deck Watch Officer',
      'Ship Officer Trainee',
      'Stock Hand',
      'Yard Technician',
      'Warehouse Associate',
    ]);
    expect(noClef.labels.map((l) => l.label)).toEqual(['Sprinkler System Installer', 'Marine Engine Mechanic', 'Maquinista Naval', 'Stock Handler']);
    const method = async (deps: Partial<OnetPlanDeps>) => (await plan({ choose: undefined, ...deps })).plan.placements.find((x) => x.title === 'Sprinkler System Installer')!.method;
    expect(await method({ sure: 0.99 })).toBe('none');
    expect(await method({ margin: 0.98 })).toBe('none');
    expect(await method({ margin: 0.96 })).toBe('lead');
  });
});

describe('the layer in the registry', () => {
  it('loads its SQL into the migrated database once, however often it runs, tagged with its source and region', async () => {
    const { esco, plan: p } = await plan();
    const { sqlite, d1 } = sqliteD1();
    sqlite.exec(registrySql(esco, 1_000));
    const files = nationalSqlFiles(p.labels, p.codes, 2_000, 1);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/^INSERT INTO registry_labels /);
    expect(files[1]).toMatch(/^INSERT INTO registry_codes /);
    for (const f of [...files, ...files]) sqlite.exec(f);
    expect(sqlite.prepare("SELECT count(*) AS n FROM registry_labels WHERE region = 'us'").get()).toEqual({ n: p.labels.length });
    expect(sqlite.prepare('SELECT count(*) AS n FROM registry_codes').get()).toEqual({ n: p.codes.length });
    expect(sqlite.prepare("SELECT source, region, kind FROM registry_labels WHERE label_norm = 'stock hand'").get()).toEqual({
      source: 'onet:31.0:99-0004.00',
      region: 'us',
      kind: 'alternative',
    });
    expect(sqlite.prepare("SELECT count(*) AS n FROM registry_labels WHERE source IS NULL AND region IS NULL").get()).toEqual({ n: esco.labels.length });
    const store = new D1RegistryStore(d1);
    expect((await store.tokensByLabel('stock hand', 'pos')).map((t) => t.token)).toEqual([tokenOfUri(esco.tokens, '06')]);
    // A label on a token the registry does not have fails, as D1 enforces the foreign key.
    expect(() => sqliteD1().sqlite.exec(files[0]!)).toThrow(/FOREIGN KEY/);
  });

  it('refuses a code relation the schema does not know', () => {
    const { sqlite } = sqliteD1();
    sqlite.exec("INSERT INTO registry_tokens (token, kind, source, label_en, status, created_at, updated_at) VALUES ('pos:x', 'pos', 'emergent', 'x', 'active', 1, 1)");
    expect(() =>
      sqlite.exec("INSERT INTO registry_codes (token, scheme, code, relation, source, created_at) VALUES ('pos:x', 'onet-soc-2019', '99-0001.00', 'roughly', 'x', 1)"),
    ).toThrow(/CHECK/);
  });

  it('writes one NDJSON line per label, with the region and the layer beside the token', async () => {
    const { esco, plan: p } = await plan();
    const label = p.labels[0]!;
    const token = esco.tokens.find((t) => t.token === label.token)!;
    const line = JSON.parse(nationalVectorLine(label, token, [0.1234567, -0.5])) as { id: string; values: number[]; metadata: Record<string, string> };
    expect(line).toEqual({
      id: label.labelId,
      values: [0.123457, -0.5],
      metadata: { token: label.token, kind: 'pos', lang: 'en', label: 'Sprinkler System Installer', source: 'esco', region: 'us', layer: 'onet', isco: '9990' },
    });
  });
});

describe('tokensByLabel and observed aliases', () => {
  it('prefers a curated label to an alias a snap observed, and falls back to aliases when only they hold it', async () => {
    const { esco } = await registry();
    const { sqlite, d1 } = sqliteD1();
    sqlite.exec(registrySql(esco, 1_000));
    const store = new D1RegistryStore(d1);
    const [plumber, sprinkler, deck, warehouse] = ['02', '03', '05', '06'].map((n) => tokenOfUri(esco.tokens, n));
    const label = async (token: string, text: string, kind: 'observed' | 'alternative', lang = 'en') => ({
      labelId: await labelIdOf(token, lang, text),
      token,
      lang,
      label: text,
      labelNorm: text,
      kind,
      embedded: false,
    });
    // "pipe layer" was observed on the plumber; a curated label puts it on the sprinkler fitter.
    await store.addLabels([await label(plumber!, 'pipe layer', 'observed'), await label(sprinkler!, 'pipe layer', 'alternative')], 1);
    expect((await store.tokensByLabel('pipe layer', 'pos')).map((t) => t.token)).toEqual([sprinkler]);
    // Only aliases: both stay, and the snap goes on to the embedding.
    await store.addLabels([await label(deck!, 'deck hand', 'observed'), await label(warehouse!, 'deck hand', 'observed')], 1);
    expect((await store.tokensByLabel('deck hand', 'pos')).map((t) => t.token).sort()).toEqual([deck, warehouse].sort());
    // A token that holds the label both ways counts as curated, and an alias elsewhere is left out.
    await store.addLabels([await label(plumber!, 'plumber', 'observed', 'pt'), await label(deck!, 'plumber', 'observed')], 1);
    expect((await store.tokensByLabel('plumber', 'pos')).map((t) => t.token)).toEqual([plumber]);
  });
});

describe('clefChooser', () => {
  const shown = [
    { token: 'pos:a', labelEn: 'a', matched: 'a', matchedLang: 'en', score: 0.6 },
    { token: 'pos:b', labelEn: 'b', matched: 'bee', matchedLang: 'en', score: 0.59 },
  ];
  const ask = { title: 'T', onetCode: '99-0001.00', occupation: 'O' };

  it('takes the candidate Clef chooses at its floor, and none below it or for none', async () => {
    expect(await clefChooser(fakeInference({ 'work-adjudicate': clefChoice('match', 'c1', { c0: 0.2, c1: 0.7, none: 0.1 }) }))(ask, shown)).toEqual({
      token: 'pos:b',
      p: 0.7,
      probabilities: { 'pos:a': 0.2, 'pos:b': 0.7, none: 0.1 },
    });
    expect(await clefChooser(fakeInference({ 'work-adjudicate': clefChoice('match', 'c1', { c0: 0.3, c1: 0.4, none: 0.3 }) }))(ask, shown)).toMatchObject({ token: null, p: 0.4 });
    expect(await clefChooser(fakeInference({ 'work-adjudicate': clefChoice('match', 'none', { c0: 0.1, c1: 0.1, none: 0.8 }) }))(ask, shown)).toMatchObject({ token: null, p: 0.8 });
    // A floor of its own: the import may ask for more than the band's.
    expect(await clefChooser(fakeInference({ 'work-adjudicate': clefChoice('match', 'c1', { c0: 0.2, c1: 0.7, none: 0.1 }) }), { floor: 0.8 })(ask, shown)).toMatchObject({ token: null, p: 0.7 });
  });

  it('asks the questions it was calibrated on: a matched label without its language, as the registry band adds it', async () => {
    const calls: FakeCall[] = [];
    await clefChooser(fakeInference({ 'work-adjudicate': clefChoice('match', 'c1', { c0: 0.2, c1: 0.7, none: 0.1 }) }, calls))(ask, shown);
    const asked = calls[0]!.input as { state: string; questions: { match: { criteria: Record<string, string> } } };
    expect(asked.state).toBe('A job title as the US O*NET database lists it, under the occupation "O":\nT');
    expect(asked.questions.match.criteria).toEqual({ c0: 'a', c1: 'b (matched "bee")', none: 'None of these: a different occupation' });
  });

  it("says a failed call, an empty answer or one without none's probability failed, and chooses nothing", async () => {
    expect(await clefChooser(fakeInference({ 'work-adjudicate': new Error('down') }))(ask, shown)).toEqual({ token: null, p: null, failed: true });
    expect(await clefChooser(fakeInference({ 'work-adjudicate': { answers: {} } }))(ask, shown)).toEqual({ token: null, p: null, failed: true });
    expect(await clefChooser(fakeInference({ 'work-adjudicate': clefChoice('match', 'c0', { c0: 0.9 }) }))(ask, shown)).toEqual({ token: null, p: null, failed: true });
  });
});
