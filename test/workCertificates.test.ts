// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  accounts,
  admits,
  buildCatalogue,
  expiredClaim,
  certificates,
  describeCertificate,
  heldTokens,
  matchCertificate,
  planCertificateImport,
  readFacets,
  requiredTokens,
  saysNotHeld,
  type CertificateCatalogue,
  type CertificateEntry,
} from '../src/services/work/certificates.js';
import { bloomOf } from '../src/services/work/bloom.js';
import { registrySql, vectorLine } from '../src/services/work/esco.js';
import { D1ListingStore, listingIdOf } from '../src/services/work/listings.js';
import { recall } from '../src/services/work/recall.js';
import { D1RegistryStore, labelNorm, SLUG_MAX, snap, type RegistryDeps } from '../src/services/work/registry.js';
import { sqliteD1 } from './fixtures/work/d1.js';
import { axis, embedAnswer, fakeInference, memoryIndex, near, type FakeCall, type FakeResponses } from './fixtures/work/fakes.js';

const catalogue = certificates();
const entry = (token: string): CertificateEntry => {
  const e = catalogue.byToken.get(token);
  if (!e) throw new Error(`no ${token} in the seed`);
  return e;
};
const read = (token: string, raw: string) => readFacets(entry(token), labelNorm(raw)).facets;
const match = (raw: string, region?: string) =>
  matchCertificate(catalogue, labelNorm(raw), region ? { requirement: { region } } : {}).map((m) => ({ token: m.entry.token, via: m.via, ...m.facets }));

describe('the curated certificate seed', () => {
  it('reads without a problem, every certificate a seed token in en, pt and es', () => {
    expect(catalogue.problems).toEqual([]);
    expect(catalogue.entries.length).toBeGreaterThanOrEqual(20);
    for (const e of catalogue.entries) {
      expect(e.token, e.token).toMatch(/^cert:[a-z0-9-]+(:[a-z]{2}(-[a-z0-9]{1,3})?)?$/);
      expect(e.token.split(':')[1]!.length).toBeLessThanOrEqual(SLUG_MAX);
      expect(new Set(e.labels.map((l) => l.lang)), e.token).toEqual(new Set(['en', 'pt', 'es']));
      expect(e.labels[0]).toMatchObject({ lang: 'en', label: e.labelEn });
    }
  });

  it('suffixes a local licence with its jurisdiction and names the state in every label', () => {
    expect(entry('cert:electrician-license:us-tx').jurisdiction).toBe('us-tx');
    expect(entry('cert:nr-35:br').jurisdiction).toBe('br');
    expect(entry('cert:bosiet').jurisdiction).toBeNull();
    for (const e of catalogue.entries.filter((x) => x.jurisdiction?.includes('-'))) {
      const state = labelNorm(catalogue.jurisdictions.get(e.jurisdiction!)!);
      expect(e.shared, e.token).toContain(state);
      expect(e.requirementRegions, e.token).toEqual([e.jurisdiction]);
    }
  });

  it('keeps levels and modules as metadata of one token, never as tokens of their own', () => {
    const tokens = catalogue.entries.map((e) => e.token);
    expect(tokens).toContain('cert:osha-outreach:us');
    expect(tokens.filter((t) => t.startsWith('cert:osha'))).toEqual(['cert:osha-outreach:us']);
    expect(entry('cert:osha-outreach:us').levels.map((l) => l.key)).toEqual(['10-hour', '30-hour']);
    expect(entry('cert:nccco-rigger').levels.map((l) => l.key)).toEqual(['level-1', 'level-2']);
    expect(entry('cert:bosiet').modules.map((m) => m.key)).toEqual(['ebs', 'ca-ebs']);
    expect(entry('cert:electrician-license:us-tx').levels.map((l) => l.key)).toEqual(['residential-wireman', 'journeyman', 'master']);
  });

  it('names what goes wrong in a seed, and leaves that entry out', () => {
    const bad = buildCatalogue({
      version: 'x',
      jurisdictions: { 'us-tx': 'Texas' },
      fillers: ['with'],
      notHeld: ['apprentice'],
      certificates: [
        { token: 'cert:ok', issuer: 'X', en: 'OK card', names: ['OK'], labels: {} },
        { token: 'cert:no-name', issuer: 'X', en: 'Something', names: ['other'], labels: {} },
        { token: 'cert:local:us-ok', issuer: 'X', en: 'Oklahoma thing', names: ['Oklahoma'], labels: {} },
        { token: 'cert:leveled', issuer: 'X', en: 'Leveled Master card', names: ['Leveled'], levels: [{ key: 'master', en: 'Master', aliases: ['Master'] }] },
        { token: 'pos:not-a-cert', issuer: 'X', en: 'x', names: ['x'] },
        { token: 'cert:twin', issuer: 'X', en: 'OK card', names: ['OK'], labels: {} },
      ],
    });
    expect(bad.entries.map((e) => e.token)).toEqual(['cert:ok', 'cert:twin']);
    expect(bad.problems.join('\n')).toMatch(/cert:no-name label "Something" holds none of its names/);
    expect(bad.problems.join('\n')).toMatch(/cert:local:us-ok has a jurisdiction the seed does not name/);
    expect(bad.problems.join('\n')).toMatch(/cert:leveled label "Leveled Master card" holds its own facet alias "master"/);
    expect(bad.problems.join('\n')).toMatch(/pos:not-a-cert is not cert:/);
    expect(bad.problems.join('\n')).toMatch(/"OK card" names both cert:ok and cert:twin/);
  });

  it('never fails open on a malformed list: a bad exclude list leaves its entry out, a bad not-held list is named', () => {
    const tx = { token: 'cert:lic:us-tx', issuer: 'X', en: 'Texas licence', names: ['Texas'], labels: {} };
    for (const excludes of [['industrial', ''], 'industrial', [3]]) {
      const c = buildCatalogue({ version: 'x', jurisdictions: { 'us-tx': 'Texas' }, fillers: [], notHeld: ['apprentice'], certificates: [{ ...tx, excludes }] });
      expect(c.entries, JSON.stringify(excludes)).toEqual([]);
      expect(c.problems.join('\n')).toMatch(/cert:lic:us-tx.excludes is not a list of non-empty strings/);
    }
    const held = buildCatalogue({ version: 'x', jurisdictions: { 'us-tx': 'Texas' }, fillers: ['with', ''], notHeld: ['apprentice', ''], certificates: [tx] });
    expect(held.problems).toEqual(['fillers is not a list of non-empty strings', 'notHeld is not a list of non-empty strings']);
    // The valid words still hold.
    expect(saysNotHeld(held, labelNorm('Texas apprentice licence'))).toBe(true);
    expect(buildCatalogue({ version: 'x', jurisdictions: {}, fillers: [], certificates: [] }).problems).toEqual(['the seed has no notHeld words']);
    const regions = buildCatalogue({ version: 'x', jurisdictions: { 'us-tx': 'Texas' }, fillers: [], notHeld: ['apprentice'], certificates: [{ ...tx, requirements: { regions: ['us-tx', ''], labels: { en: ['a licence'] } } }] });
    expect(regions.entries).toEqual([]);
    expect(regions.problems.join('\n')).toMatch(/requirements.regions is not a list of non-empty strings/);
  });
});

describe('reading a certificate string', () => {
  it('reads a level and modules off the string, longest alias first', () => {
    expect(read('cert:nccco-rigger', 'NCCCO Aparejador Nivel II')).toEqual({ level: 'level-2', modules: [] });
    expect(read('cert:bosiet', 'BOSIET with CA-EBS')).toEqual({ level: null, modules: ['ca-ebs'] });
    expect(read('cert:bosiet', 'BOSIET with EBS')).toEqual({ level: null, modules: ['ebs'] });
    expect(read('cert:osha-outreach:us', 'OSHA 10-Hour Construction')).toEqual({ level: '10-hour', modules: ['construction'] });
    expect(read('cert:osha-outreach:us', 'OSHA 30 horas')).toEqual({ level: '30-hour', modules: [] });
    expect(read('cert:nr-10:br', 'NR-10 Básico')).toEqual({ level: 'basic', modules: [] });
    expect(read('cert:nr-10:br', 'NR-10 SEP')).toEqual({ level: 'sep', modules: [] });
    expect(read('cert:electrician-license:us-tx', 'Texas Journeyman Electrician License')).toEqual({ level: 'journeyman', modules: [] });
    expect(read('cert:nccco-crane-operator', 'NCCCO Operador de Grúa Telescópica')).toEqual({ level: null, modules: ['telescopic'] });
  });

  it('keeps the lower of two levels for a claim, and the higher for a requirement', () => {
    expect(read('cert:nr-10:br', 'NR-10 Básico e SEP')).toEqual({ level: 'basic', modules: [] });
    expect(readFacets(entry('cert:nr-10:br'), labelNorm('NR-10 Básico e SEP'), { requirement: { region: 'br-sp' } }).facets).toEqual({ level: 'sep', modules: [] });
    expect(readFacets(entry('cert:electrician-license:us-tx'), labelNorm('licensed journeyman wireman'), { requirement: { region: 'us-tx' } }).facets).toEqual({ level: 'journeyman', modules: [] });
  });

  it('accounts for a string only when every word left is the credential’s own', () => {
    const tx = entry('cert:electrician-license:us-tx');
    const fits = (token: string, raw: string, region?: string) => accounts(catalogue, entry(token), labelNorm(raw), region ? { requirement: { region } } : {});
    expect(fits('cert:electrician-license:us-tx', 'Texas Master Electrician')).toBe(true);
    expect(fits('cert:electrician-license:us-tx', 'Texas Electrician License, Class B')).toBe(false);
    expect(fits('cert:epa-608:us', 'EPA 608 Type I and II', 'us-tx')).toBe(false);
    expect(fits('cert:bosiet', 'Basic Offshore Safety Induction & Emergency Training (OPITO), CA-EBS')).toBe(true);
    expect(fits('cert:nccco-rigger', 'Rigger Nível II certificado pela NCCCO')).toBe(true);
    // A level alone says nothing of the credential.
    expect(accounts(catalogue, tx, labelNorm('Master'), { requirement: { region: 'us-tx' } })).toBe(false);
  });

  it('refuses what is not held, and what another credential’s words name', () => {
    for (const s of ['Texas Apprentice Electrician License', 'NR-35 (vencido)', 'BOSIET em andamento', 'Licencia en trámite']) expect(saysNotHeld(catalogue, labelNorm(s)), s).toBe(true);
    expect(saysNotHeld(catalogue, labelNorm('NR-35 Trabalho em Altura'))).toBe(false);
    expect(admits(entry('cert:electrician-license:us-tx'), labelNorm('Texas Journeyman Industrial Electrician License'))).toBe(false);
    expect(admits(entry('cert:ata-certified-translator'), labelNorm('ATA member'))).toBe(false);
  });

  it('admits a claim only when it names the credential, and a state licence only with its state', () => {
    const tx = entry('cert:electrician-license:us-tx');
    expect(admits(tx, labelNorm('Texas Master Electrician'))).toBe(true);
    expect(admits(tx, labelNorm('Journeyman Electrician License'))).toBe(false);
    expect(admits(entry('cert:nccco-rigger'), labelNorm('certified rigger'))).toBe(false);
    // A hirer's words may leave the jurisdiction to the job's region, and only there.
    expect(admits(tx, labelNorm('Journeyman Electrician License'), { requirement: { region: 'us-tx' } })).toBe(true);
    expect(admits(tx, labelNorm('Journeyman Electrician License'), { requirement: { region: 'us-la' } })).toBe(false);
    expect(admits(entry('cert:nccco-rigger'), labelNorm('rigger level II'), { requirement: { region: 'us-tx' } })).toBe(false);
    // A national credential is named by its code for a hirer too: the region waives only a state's name.
    expect(admits(entry('cert:nr-10:br'), labelNorm('NR-12'), { requirement: { region: 'br-sp' } })).toBe(false);
    expect(admits(entry('cert:osha-outreach:us'), labelNorm('HAZWOPER 40'), { requirement: { region: 'us-tx' } })).toBe(false);
    expect(admits(entry('cert:nr-35:br'), labelNorm('NR-35'), { requirement: { region: 'br-sp' } })).toBe(true);
  });
});

describe('what a claim may carry, and what a shared name cannot say alone', () => {
  const ASOF = Date.parse('2026-10-24T12:00:00Z');

  it('refuses a negated status, before any word is read as a filler', () => {
    for (const raw of ['TWIC no vigente', 'Licencia de Electricista Maestro de Texas, no vigente', 'OSHA 30 no válido', 'TWIC no activa', 'Texas Plumber License (inactive)', 'NR-35 não vigente']) {
      expect(saysNotHeld(catalogue, labelNorm(raw)), raw).toBe(true);
    }
    // "No" is never a filler: it means not in English and Spanish.
    expect(match('No current OSHA card')).toEqual([]);
    expect(accounts(catalogue, entry('cert:osha-outreach:us'), labelNorm('No current OSHA card'))).toBe(false);
  });

  it('reads a claim’s details, course hours and a validity date ahead off the string, and says a date this month or before is not held', () => {
    expect(match('STCW 2010 Basic Safety Training')).toEqual([{ token: 'cert:stcw-basic-safety', via: 'label', level: null, modules: [] }]);
    expect(match('OSHA 30-Hour Construction Safety and Health')).toEqual([{ token: 'cert:osha-outreach:us', via: 'label', level: '30-hour', modules: ['construction'] }]);
    expect(match('NR-35 Trabalho em Altura (8h)')).toEqual([{ token: 'cert:nr-35:br', via: 'label', level: null, modules: [] }]);
    expect(match('NR-10 Básico 40h')).toEqual([{ token: 'cert:nr-10:br', via: 'label', level: 'basic', modules: [] }]);
    expect(match('CBSP - Marinha do Brasil')).toEqual([{ token: 'cert:cbsp:br', via: 'label', level: null, modules: [] }]);
    expect(match('BOSIET with CA-EBS (OPITO approved)')).toEqual([{ token: 'cert:bosiet', via: 'label', level: null, modules: ['ca-ebs'] }]);
    expect(match('ASME IX 6G SMAW')).toEqual([{ token: 'cert:asme-ix-welder', via: 'label', level: null, modules: ['6g'] }]);
    expect(match('TWIC valid until 2028')).toEqual([{ token: 'cert:twic:us', via: 'label', level: null, modules: [] }]);
    expect(match('NCCCO Rigger Level II, exp. 2027')).toEqual([{ token: 'cert:nccco-rigger', via: 'label', level: 'level-2', modules: [] }]);
    // A validity date before the day it is read says the credential is no longer held.
    expect(expiredClaim(labelNorm('TWIC valid until 2019'), ASOF)).toBe(true);
    expect(expiredClaim(labelNorm('NCCCO Rigger Level II, exp. 09/2026'), ASOF)).toBe(true);
    // Without a day, this month and a year without a month this year cannot be told from the past.
    expect(expiredClaim(labelNorm('NCCCO Rigger Level II, exp. 10/2026'), ASOF)).toBe(true);
    expect(expiredClaim(labelNorm('TWIC exp 2026'), ASOF)).toBe(true);
    expect(expiredClaim(labelNorm('NCCCO Rigger Level II, exp. 11/2026'), ASOF)).toBe(false);
    expect(expiredClaim(labelNorm('BOSIET válido até 2027'), ASOF)).toBe(false);
    expect(expiredClaim(labelNorm('STCW 2010 Basic Safety Training'), ASOF)).toBe(false);
  });

  it('reads no other date and no other course’s hours: a range, a year beside "valid", or OSHA’s 40 hours is a word the seed cannot read', () => {
    for (const raw of ['TWIC 2019-2024', 'BOSIET (2020 - 2024)', 'CBSP 2018/2023', 'NR-35 válido de 2021 a 2023', 'TWIC valid 2024', 'Licencia de Electricista Maestro de Texas, vigente 2023', 'NR-35 Trabalho em Altura (2023)']) {
      expect(match(raw), raw).toEqual([]);
      for (const e of catalogue.entries) expect(accounts(catalogue, e, labelNorm(raw)), `${raw} as ${e.token}`).toBe(false);
    }
    // OSHA's levels are hours: another count is another course (HAZWOPER's 40, 24 and 8), never the Outreach card.
    for (const raw of ['OSHA 40-Hour', 'OSHA 24-Hour', 'OSHA 40 hours', 'OSHA 40h', 'OSHA 8-Hour']) {
      expect(match(raw), raw).toEqual([]);
      expect(accounts(catalogue, entry('cert:osha-outreach:us'), labelNorm(raw)), raw).toBe(false);
    }
    // An edition in the seed's details or a year in a label's own name is no date.
    expect(match('STCW 2010 Basic Safety Training')).toEqual([{ token: 'cert:stcw-basic-safety', via: 'label', level: null, modules: [] }]);
    expect(match('NOM-009-STPS-2011')).toEqual([{ token: 'cert:nom-009:mx', via: 'label', level: null, modules: [] }]);
  });

  it('tells a credential apart only by the distinctive words the seed lists, never by an occupation’s word', () => {
    const fitting = (raw: string, region?: string) =>
      catalogue.entries.filter((e) => admits(e, labelNorm(raw), region ? { requirement: { region } } : {}) && accounts(catalogue, e, labelNorm(raw), region ? { requirement: { region } } : {})).map((e) => e.token);
    for (const raw of ['Traductor certificado, CDMX', 'Mexico City translator', 'CDMX Expert', 'NCCCO Operator', 'STCW Safety', 'STCW 95']) expect(fitting(raw), raw).toEqual([]);
    expect(fitting('traductor', 'mx-cmx')).toEqual([]);
    expect(fitting('Perito traductor, CDMX')).toEqual(['cert:perito-traductor:mx-cmx']);
    expect(fitting('NCCCO crane operator')).toEqual(['cert:nccco-crane-operator']);
    expect(entry('cert:nccco-rigger').distinctive).toEqual(new Set(['rigger', 'aparejador']));
    // The seed's distinctive words are checked: one a sibling uses, or one in no label, leaves the entry out.
    const twins = buildCatalogue({
      version: 'x',
      jurisdictions: { 'us-tx': 'Texas' },
      fillers: [],
      notHeld: ['expired'],
      certificates: [
        { token: 'cert:a:us-tx', issuer: 'X', en: 'Texas welder licence', shared: ['Texas'], distinctive: ['welder'] },
        { token: 'cert:b:us-tx', issuer: 'X', en: 'Texas welder inspector licence', shared: ['Texas'], distinctive: ['inspector', 'welder'] },
        { token: 'cert:c:us-tx', issuer: 'X', en: 'Texas fitter licence', shared: ['Texas'], distinctive: ['pipefitter'] },
      ],
    });
    expect(twins.entries).toEqual([]);
    expect(twins.problems.join('\n')).toMatch(/cert:a:us-tx distinctive word "welder" does not tell it apart from cert:b:us-tx/);
    expect(twins.problems.join('\n')).toMatch(/cert:c:us-tx distinctive word "pipefitter" is in none of its labels/);
  });

  it('never lets a requirement carry what a claim may: a hirer’s hours, process or date asks for more than the plane reads', () => {
    const req = (raw: string, region: string) => matchCertificate(catalogue, labelNorm(raw), { requirement: { region } }).map((m) => m.entry.token);
    expect(req('NR-33 40h', 'br-sp')).toEqual([]);
    expect(req('ASME IX 6G SMAW', 'us-tx')).toEqual([]);
    expect(accounts(catalogue, entry('cert:nr-33:br'), labelNorm('NR-33 40h'), { requirement: { region: 'br-sp' } })).toBe(false);
  });

  it('needs a distinctive word beside a shared name: a state, NCCCO or an issuer of many licences names a family, not a credential', () => {
    const fitting = (raw: string, region?: string) =>
      catalogue.entries.filter((e) => admits(e, labelNorm(raw), region ? { requirement: { region } } : {}) && accounts(catalogue, e, labelNorm(raw), region ? { requirement: { region } } : {})).map((e) => e.token);
    for (const raw of ['Texas license', 'TX', 'Licensed in Texas', 'Licencia de Texas', 'Texas Master', 'NCCCO certified', 'CCO', 'TDLR License', 'TCEQ license', 'Louisiana license']) {
      expect(fitting(raw), raw).toEqual([]);
    }
    for (const raw of ['licensed', 'license']) expect(fitting(raw, 'us-tx'), raw).toEqual([]);
    expect(fitting('Texas Master Electrician')).toEqual(['cert:electrician-license:us-tx']);
    expect(fitting('TCEQ backflow tester license')).toEqual(['cert:backflow-tester:us-tx']);
    expect(fitting('NCCCO certified rigger')).toEqual(['cert:nccco-rigger']);
    expect(fitting('electrician with a master license', 'us-tx')).toEqual(['cert:electrician-license:us-tx']);
    // Every label of the seed says which credential it is.
    for (const e of catalogue.entries) for (const l of e.labels) expect(accounts(catalogue, e, l.norm), l.label).toBe(true);
  });
});

describe('the exact match, without a model', () => {
  it('matches a label once the level, modules and fillers are read off', () => {
    expect(match('NCCCO Aparejador Nivel II')).toEqual([{ token: 'cert:nccco-rigger', via: 'label', level: 'level-2', modules: [] }]);
    expect(match('BOSIET with CA-EBS')).toEqual([{ token: 'cert:bosiet', via: 'label', level: null, modules: ['ca-ebs'] }]);
    expect(match('OSHA 10-Hour Construction')).toEqual([{ token: 'cert:osha-outreach:us', via: 'label', level: '10-hour', modules: ['construction'] }]);
    expect(match('Texas Journeyman Plumber License')).toEqual([{ token: 'cert:plumber-license:us-tx', via: 'label', level: 'journeyman', modules: [] }]);
    expect(match('Curso NR-35')).toEqual([{ token: 'cert:nr-35:br', via: 'label', level: null, modules: [] }]);
    expect(match('EPA 608 Universal')).toEqual([{ token: 'cert:epa-608:us', via: 'label', level: null, modules: ['universal'] }]);
    // The issuer's name is a detail a claim may carry.
    expect(match('Basic Offshore Safety Induction and Emergency Training (OPITO), CA-EBS')).toEqual([{ token: 'cert:bosiet', via: 'label', level: null, modules: ['ca-ebs'] }]);
  });

  it('matches nothing a word too far: another word, no state, or a claim in a hirer’s words', () => {
    expect(match('Backflow Prevention Assembly Tester')).toEqual([]);
    expect(match('Perito Traductor certificado')).toEqual([]);
    expect(match('licensed electrician')).toEqual([]);
    expect(match('certified rigger')).toEqual([]);
  });

  it('reads a hirer’s phrase as the credential of the job’s region only', () => {
    expect(match('licensed electrician', 'us-tx')).toEqual([{ token: 'cert:electrician-license:us-tx', via: 'requirement', level: null, modules: [] }]);
    expect(match('a licensed master electrician', 'us-tx')).toEqual([{ token: 'cert:electrician-license:us-tx', via: 'requirement', level: 'master', modules: [] }]);
    expect(match('licensed plumber', 'us-la')).toEqual([{ token: 'cert:plumber-license:us-la', via: 'requirement', level: null, modules: [] }]);
    expect(match('electricista con licencia', 'mx-nle')).toEqual([]);
    expect(match('eletricista com licença', 'br-sp')).toEqual([]);
    expect(match('aparejador certificado', 'us-tx')).toEqual([{ token: 'cert:nccco-rigger', via: 'requirement', level: null, modules: [] }]);
    expect(match('rigger certificado', 'br-rj')).toEqual([]);
  });
});

describe('facet tokens', () => {
  it('lets a claim hold its level and every level below, and a requirement ask for one', () => {
    const rigger = entry('cert:nccco-rigger');
    expect(heldTokens(rigger, { level: 'level-2', modules: [] })).toEqual(['cert:nccco-rigger', 'cert:nccco-rigger/level-1', 'cert:nccco-rigger/level-2']);
    expect(requiredTokens(rigger, { level: 'level-2', modules: [] })).toEqual(['cert:nccco-rigger', 'cert:nccco-rigger/level-2']);
    const levelOne = new Set(heldTokens(rigger, { level: 'level-1', modules: [] }));
    expect(requiredTokens(rigger, { level: 'level-2', modules: [] }).every((t) => levelOne.has(t))).toBe(false);
    expect(requiredTokens(rigger, { level: null, modules: [] }).every((t) => levelOne.has(t))).toBe(true);
  });

  it('pairs a module with its level, so two cards never add up to one neither holder has', () => {
    const osha = entry('cert:osha-outreach:us');
    const held = new Set([...heldTokens(osha, { level: '30-hour', modules: ['construction'] }), ...heldTokens(osha, { level: '10-hour', modules: ['general-industry'] })]);
    const meets = (level: string, module: string) => requiredTokens(osha, { level, modules: [module] }).every((t) => held.has(t));
    expect(meets('10-hour', 'construction')).toBe(true);
    expect(meets('30-hour', 'construction')).toBe(true);
    expect(meets('10-hour', 'general-industry')).toBe(true);
    expect(meets('30-hour', 'general-industry')).toBe(false);
  });

  it('adds what a module implies to a claim, never to a requirement', () => {
    const epa = entry('cert:epa-608:us');
    expect(heldTokens(epa, { level: null, modules: ['universal'] })).toEqual([
      'cert:epa-608:us',
      'cert:epa-608:us/type-i',
      'cert:epa-608:us/type-ii',
      'cert:epa-608:us/type-iii',
      'cert:epa-608:us/universal',
    ]);
    expect(requiredTokens(epa, { level: null, modules: ['universal'] })).toEqual(['cert:epa-608:us', 'cert:epa-608:us/universal']);
    const crane = entry('cert:nccco-crane-operator');
    expect(heldTokens(crane, { level: null, modules: ['tll'] })).toContain('cert:nccco-crane-operator/telescopic');
  });

  it('describes a candidate for Clef by name, issuer, jurisdiction, levels and modules', () => {
    expect(describeCertificate(catalogue, entry('cert:electrician-license:us-tx'))).toBe(
      'Texas electrician license, issued by TDLR, valid in Texas; levels Residential Wireman, Journeyman, Master',
    );
    expect(describeCertificate(catalogue, entry('cert:bosiet'))).toBe('BOSIET, issued by OPITO; modules EBS, CA-EBS');
  });
});

describe('the certificate import', () => {
  it('plans seed tokens and embedded labels, which load into the registry’s own tables', async () => {
    const plan = await planCertificateImport();
    expect(plan.counts.certificates).toBe(catalogue.entries.length);
    expect(plan.tokens.every((t) => t.kind === 'cert' && t.source === 'seed' && t.escoUri == null && t.iscoCode == null && t.status === 'active')).toBe(true);
    expect(plan.labels.every((l) => l.embedded)).toBe(true);
    expect(plan.labels.filter((l) => l.token === 'cert:bosiet' && l.kind === 'preferred').map((l) => l.lang).sort()).toEqual(['en', 'es', 'pt']);
    // The SQL is what `wrangler d1 execute` loads: it runs on the real migrations, twice without a duplicate.
    const { sqlite } = sqliteD1();
    const sql = registrySql(plan, 1);
    sqlite.exec(sql);
    sqlite.exec(sql);
    expect(sqlite.prepare("SELECT count(*) AS n FROM registry_tokens WHERE kind = 'cert' AND source = 'seed'").get()).toEqual({ n: plan.tokens.length });
    expect(sqlite.prepare('SELECT count(*) AS n FROM registry_labels').get()).toEqual({ n: plan.labels.length });
    const line = JSON.parse(vectorLine(plan.labels[0]!, plan.tokens[0]!, [0.1, 0.2]));
    expect(line).toEqual({ id: plan.labels[0]!.labelId, values: [0.1, 0.2], metadata: { token: plan.tokens[0]!.token, kind: 'cert', lang: 'en', label: plan.labels[0]!.label, source: 'seed' } });
  });
});

// ── The registry's certificate path ────────────────────────────────────────

/** Each certificate's labels share one axis, so a test string's cosine to a credential is its own choice. */
const axes = (c: CertificateCatalogue) => new Map(c.entries.map((e, i) => [e.token, 100 + i]));
const AXIS = axes(catalogue);
const toward = (token: string, cos: number, axis = AXIS) => near(axis.get(token)!, 9, cos);

/**
 * Two credentials with one specific name and one vocabulary, written for these tests: the seed's
 * own siblings never both fit one string, so this is how the band shows Clef two candidates.
 */
const TWINS = buildCatalogue({
  version: 'test',
  jurisdictions: {},
  fillers: ['card'],
  notHeld: ['expired'],
  certificates: [
    { token: 'cert:alpha', issuer: 'A', en: 'Alpha card', names: ['Alpha'], labels: { en: ['Gamma Beta Alpha card'] } },
    { token: 'cert:alpha-beta', issuer: 'A', en: 'Alpha Beta card', names: ['Alpha'], labels: { en: ['Gamma Alpha card'] } },
  ],
});
const TWIN_AXIS = axes(TWINS);

async function certRegistry(responses: FakeResponses = {}, calls: FakeCall[] = [], certificates: CertificateCatalogue = catalogue) {
  const AXIS = axes(certificates);
  const db = sqliteD1();
  const store = new D1RegistryStore(db.d1);
  const index = memoryIndex();
  const plan = await planCertificateImport(certificates);
  for (const t of plan.tokens) {
    const labels = plan.labels.filter((l) => l.token === t.token);
    await store.insertToken(t, labels, 0);
    await index.upsert(labels.map((l) => ({ id: l.labelId, values: axis(AXIS.get(t.token)!), metadata: { token: t.token, kind: 'cert', lang: l.lang, label: l.label, source: 'seed' } })));
  }
  let n = 0;
  const deps: RegistryDeps = { inference: fakeInference(responses, calls), store, index, certificates, now: () => Date.parse('2026-10-24T12:00:00Z'), newId: () => `d${++n}` };
  const observed = () => db.sqlite.prepare("SELECT token, label FROM registry_labels WHERE kind = 'observed' ORDER BY label").all();
  const decisions = () => db.sqlite.prepare('SELECT decision, token, probability, raw FROM registry_decisions ORDER BY id').all();
  return { deps, store, index, db, observed, decisions };
}

/** A Clef answer in the certificate band. */
const certClef = (choice: string, p: number) => ({
  model: 'clef-flash',
  answers: { match: { type: 'choice', choice, probabilities: { [choice]: p } } },
  usage: { input_tokens: 220 },
});

type ClefRequest = { state: string; questions: Record<string, unknown> & { match: { criteria: Record<string, string> } } };

describe('snapping a certificate', () => {
  it('snaps a label with its level read off, and holds that level and every one below, without a model', async () => {
    const calls: FakeCall[] = [];
    const { deps, observed } = await certRegistry({}, calls);
    const out = await snap(deps, { kind: 'cert', raw: 'NCCCO Aparejador Nivel II', lang: 'es' });
    expect(out).toMatchObject({ decision: 'label', token: 'cert:nccco-rigger', facets: { level: 'level-2', modules: [] } });
    expect(out.tokens).toEqual(['cert:nccco-rigger', 'cert:nccco-rigger/level-1', 'cert:nccco-rigger/level-2']);
    expect(calls).toEqual([]);
    // The worker's string is an alias now, and still reads its level.
    expect(observed()).toEqual([{ token: 'cert:nccco-rigger', label: 'NCCCO Aparejador Nivel II' }]);
    expect(await snap(deps, { kind: 'cert', raw: 'nccco aparejador nivel ii', lang: 'es' })).toMatchObject({ decision: 'label', facets: { level: 'level-2' } });
  });

  it('reads a module and a level of one card together', async () => {
    const { deps } = await certRegistry();
    const out = await snap(deps, { kind: 'cert', raw: 'OSHA 10-Hour Construction', lang: 'en' });
    expect(out).toMatchObject({ decision: 'label', token: 'cert:osha-outreach:us', facets: { level: '10-hour', modules: ['construction'] } });
    expect(out.tokens).toEqual(['cert:osha-outreach:us', 'cert:osha-outreach:us/10-hour', 'cert:osha-outreach:us/construction', 'cert:osha-outreach:us/construction/10-hour']);
  });

  it('reads a hirer’s phrase as the licence of the job’s region, asks only what it names, and never keeps the phrase', async () => {
    const calls: FakeCall[] = [];
    const { deps, observed } = await certRegistry({}, calls);
    const tx = await snap(deps, { kind: 'cert', raw: 'licensed master electrician', lang: 'en', mint: false, region: 'us-tx' });
    expect(tx).toMatchObject({ decision: 'label', token: 'cert:electrician-license:us-tx', facets: { level: 'master' } });
    expect(tx.tokens).toEqual(['cert:electrician-license:us-tx', 'cert:electrician-license:us-tx/master']);
    expect(await snap(deps, { kind: 'cert', raw: 'licensed plumber', lang: 'en', mint: false, region: 'us-la' })).toMatchObject({ token: 'cert:plumber-license:us-la' });
    expect(calls).toEqual([]);
    expect(observed()).toEqual([]);
  });

  it('gives a worker no licence the string does not name: no state, no issuer, or only a hirer’s phrase', async () => {
    const calls: FakeCall[] = [];
    const { deps, decisions } = await certRegistry(
      {
        'work-embed': embedAnswer({
          'licensed electrician': toward('cert:electrician-license:us-tx', 0.9),
          'Journeyman Electrician License': toward('cert:electrician-license:us-tx', 0.93),
          'certified rigger': toward('cert:nccco-rigger', 0.92),
        }),
        'work-adjudicate': certClef('c0', 0.95),
      },
      calls,
    );
    for (const raw of ['licensed electrician', 'Journeyman Electrician License', 'certified rigger']) {
      expect(await snap(deps, { kind: 'cert', raw, lang: 'en' }), raw).toMatchObject({ decision: 'unmatched', token: null, tokens: [] });
    }
    expect(calls.map((c) => c.op)).toEqual(['work-embed', 'work-embed', 'work-embed']);
    expect(decisions()).toMatchObject([{ decision: 'unmatched' }, { decision: 'unmatched' }, { decision: 'unmatched' }]);
  });

  it('refuses what is not held, and another credential’s words, before any model', async () => {
    const calls: FakeCall[] = [];
    const { deps } = await certRegistry({ 'work-embed': embedAnswer({ 'Texas Journeyman Industrial Electrician License': toward('cert:electrician-license:us-tx', 0.97) }) }, calls);
    expect(await snap(deps, { kind: 'cert', raw: 'Texas Apprentice Electrician License', lang: 'en' })).toMatchObject({ decision: 'unmatched', token: null });
    expect(calls).toEqual([]);
    expect(await snap(deps, { kind: 'cert', raw: 'Texas Journeyman Industrial Electrician License', lang: 'en' })).toMatchObject({ decision: 'unmatched', token: null });
    expect(calls.map((c) => c.op)).toEqual(['work-embed']);
  });

  it('asks Clef one choice among the candidates the string names, each by issuer, jurisdiction and levels', async () => {
    const calls: FakeCall[] = [];
    const { deps, observed } = await certRegistry({ 'work-embed': embedAnswer({ 'Texas Master Electrician': toward('cert:electrician-license:us-tx', 0.88) }), 'work-adjudicate': certClef('c0', 0.86) }, calls);
    const out = await snap(deps, { kind: 'cert', raw: 'Texas Master Electrician', lang: 'en' });
    expect(out).toMatchObject({ decision: 'chosen', token: 'cert:electrician-license:us-tx', probability: 0.86, facets: { level: 'master' } });
    expect(out.tokens).toEqual(['cert:electrician-license:us-tx', 'cert:electrician-license:us-tx/residential-wireman', 'cert:electrician-license:us-tx/journeyman', 'cert:electrician-license:us-tx/master']);
    const request = calls.find((c) => c.op === 'work-adjudicate')!.input as unknown as ClefRequest;
    // The other Texas licences name Texas too, but not an electrician: they never reach Clef.
    expect(Object.keys(request.questions.match.criteria)).toEqual(['c0', 'none']);
    expect(request.questions.match.criteria.c0).toMatch(/^Texas electrician license, issued by TDLR, valid in Texas; levels Residential Wireman, Journeyman, Master/);
    expect(Object.keys(request.questions)).toEqual(['match']);
    expect(JSON.stringify(request)).not.toMatch(/esco|isco|cert:/i);
    expect(observed()).toEqual([{ token: 'cert:electrician-license:us-tx', label: 'Texas Master Electrician' }]);
  });

  it('shows Clef only candidates in the band', async () => {
    const calls: FakeCall[] = [];
    const vector = toward('cert:alpha', 0.8, TWIN_AXIS);
    vector[TWIN_AXIS.get('cert:alpha-beta')!] = 0.45;
    const { deps } = await certRegistry({ 'work-embed': embedAnswer({ 'Beta Alpha': vector }), 'work-adjudicate': certClef('none', 0.9) }, calls, TWINS);
    expect(await snap(deps, { kind: 'cert', raw: 'Beta Alpha', lang: 'en' })).toMatchObject({ decision: 'unmatched', token: null });
    const request = calls.find((c) => c.op === 'work-adjudicate')!.input as unknown as ClefRequest;
    expect(Object.keys(request.questions.match.criteria)).toEqual(['c0', 'none']);
    expect(request.questions.match.criteria.c0).toMatch(/^Alpha card, issued by A/);
  });

  it('refuses a grade or module the seed cannot read, before any Clef call', async () => {
    const calls: FakeCall[] = [];
    const { deps, decisions } = await certRegistry(
      {
        'work-embed': embedAnswer({
          'Texas Electrician License, Class B': toward('cert:electrician-license:us-tx', 0.97),
          'EPA 608 Type I and II': toward('cert:epa-608:us', 0.9),
        }),
        'work-adjudicate': certClef('c0', 0.9),
      },
      calls,
    );
    // A worker's "Class B" may be a lesser licence, even at τ_auto.
    expect(await snap(deps, { kind: 'cert', raw: 'Texas Electrician License, Class B', lang: 'en' })).toMatchObject({ decision: 'unmatched', token: null });
    // A hirer's "Type I and II" must never become a requirement for Type I alone.
    expect(await snap(deps, { kind: 'cert', raw: 'EPA 608 Type I and II', lang: 'en', mint: false, region: 'us-tx' })).toMatchObject({ decision: 'unmatched', token: null, tokens: [] });
    expect(calls.map((c) => c.op)).toEqual(['work-embed', 'work-embed']);
    expect(decisions()).toMatchObject([{ decision: 'unmatched' }, { decision: 'unmatched' }]);
  });

  it('requires the higher of two levels a hirer names, without a model', async () => {
    const calls: FakeCall[] = [];
    const { deps } = await certRegistry({}, calls);
    const need = await snap(deps, { kind: 'cert', raw: 'NR-10 Básico e SEP', lang: 'pt', mint: false, region: 'br-sp' });
    expect(need).toMatchObject({ decision: 'label', token: 'cert:nr-10:br', facets: { level: 'sep' } });
    expect(need.tokens).toEqual(['cert:nr-10:br', 'cert:nr-10:br/sep']);
    const held = await snap(deps, { kind: 'cert', raw: 'NR-10 Básico e SEP', lang: 'pt' });
    expect(held.tokens).toEqual(['cert:nr-10:br', 'cert:nr-10:br/basic']);
    expect(calls).toEqual([]);
  });

  it('says a past validity date and a negated status are not held, and reads a date ahead off the claim', async () => {
    const calls: FakeCall[] = [];
    const { deps } = await certRegistry({}, calls);
    for (const raw of ['TWIC valid until 2019', 'TWIC no vigente', 'OSHA 30 no válido', 'NCCCO Rigger Level II, exp. 09/2026']) {
      expect(await snap(deps, { kind: 'cert', raw, lang: 'en' }), raw).toMatchObject({ decision: 'unmatched', token: null });
    }
    expect(calls).toEqual([]);
    expect(await snap(deps, { kind: 'cert', raw: 'NCCCO Rigger Level II, exp. 2027', lang: 'en' })).toMatchObject({ decision: 'label', token: 'cert:nccco-rigger', facets: { level: 'level-2' } });
  });

  it('gives a shared name alone no credential, a claim’s or a hirer’s', async () => {
    const calls: FakeCall[] = [];
    const vector = toward('cert:electrician-license:us-tx', 0.9);
    const { deps } = await certRegistry({ 'work-embed': embedAnswer({ 'Texas license': vector, 'NCCCO certified': toward('cert:nccco-rigger', 0.9), license: vector }), 'work-adjudicate': certClef('c0', 0.9) }, calls);
    expect(await snap(deps, { kind: 'cert', raw: 'Texas license', lang: 'en' })).toMatchObject({ decision: 'unmatched', token: null });
    expect(await snap(deps, { kind: 'cert', raw: 'NCCCO certified', lang: 'en' })).toMatchObject({ decision: 'unmatched', token: null });
    expect(await snap(deps, { kind: 'cert', raw: 'license', lang: 'en', mint: false, region: 'us-tx' })).toMatchObject({ decision: 'unmatched', token: null });
    expect(calls.map((c) => c.op)).toEqual(['work-embed', 'work-embed', 'work-embed']);
  });

  it('never lets a hirer’s region stand in for a national credential’s name', async () => {
    const calls: FakeCall[] = [];
    const { deps } = await certRegistry(
      { 'work-embed': embedAnswer({ 'NR-12': toward('cert:nr-10:br', 0.9), 'HAZWOPER 40': toward('cert:osha-outreach:us', 0.9) }), 'work-adjudicate': certClef('c0', 0.9) },
      calls,
    );
    expect(await snap(deps, { kind: 'cert', raw: 'NR-12', lang: 'pt', mint: false, region: 'br-sp' })).toMatchObject({ decision: 'unmatched', token: null });
    expect(await snap(deps, { kind: 'cert', raw: 'HAZWOPER 40', lang: 'en', mint: false, region: 'us-tx' })).toMatchObject({ decision: 'unmatched', token: null });
    expect(calls.map((c) => c.op)).toEqual(['work-embed', 'work-embed']);
  });

  it('keeps the floor for licensed work and never mints: below it, or none, is no token', async () => {
    for (const answer of [certClef('c0', 0.49), certClef('none', 0.97)]) {
      const calls: FakeCall[] = [];
      const { deps, store } = await certRegistry({ 'work-embed': embedAnswer({ 'Texas Master Electrician': toward('cert:electrician-license:us-tx', 0.88) }), 'work-adjudicate': answer }, calls);
      expect(await snap(deps, { kind: 'cert', raw: 'Texas Master Electrician', lang: 'en' })).toMatchObject({ decision: 'unmatched', token: null });
      expect(calls.map((c) => c.op)).toEqual(['work-embed', 'work-adjudicate']);
      expect((await store.tokensByLabel(labelNorm('Texas Master Electrician'), 'cert')).length).toBe(0);
    }
  });

  it('lets a hirer’s words leave the jurisdiction to the job’s region in the band, and only there', async () => {
    const calls: FakeCall[] = [];
    const vector = toward('cert:plumber-license:us-tx', 0.86);
    vector[AXIS.get('cert:plumber-license:us-la')!] = 0.84;
    const { deps, observed } = await certRegistry({ 'work-embed': embedAnswer({ 'master plumber': vector }), 'work-adjudicate': certClef('c0', 0.9) }, calls);
    const la = await snap(deps, { kind: 'cert', raw: 'master plumber', lang: 'en', mint: false, region: 'us-la' });
    expect(la).toMatchObject({ decision: 'chosen', token: 'cert:plumber-license:us-la', facets: { level: 'master' } });
    expect(la.tokens).toEqual(['cert:plumber-license:us-la', 'cert:plumber-license:us-la/master']);
    const request = calls.find((c) => c.op === 'work-adjudicate')!.input as unknown as ClefRequest;
    expect(Object.keys(request.questions.match.criteria)).toEqual(['c0', 'none']);
    expect(request.questions.match.criteria.c0).toMatch(/^Louisiana plumber license/);
    expect(observed()).toEqual([]);
    // In Mexico neither licence is the job's, and the words name neither.
    expect(await snap(deps, { kind: 'cert', raw: 'master plumber', lang: 'en', mint: false, region: 'mx-nle' })).toMatchObject({ decision: 'unmatched', token: null });
  });

  it('takes one candidate alone at τ_auto, never one of two', async () => {
    const one = await certRegistry({ 'work-embed': embedAnswer({ 'TWIC credential card': toward('cert:twic:us', 0.97) }) });
    expect(await snap(one.deps, { kind: 'cert', raw: 'TWIC credential card', lang: 'en' })).toMatchObject({ decision: 'auto', token: 'cert:twic:us' });
    const calls: FakeCall[] = [];
    const vector = toward('cert:alpha', 0.97, TWIN_AXIS);
    vector[TWIN_AXIS.get('cert:alpha-beta')!] = 0.96;
    const two = await certRegistry({ 'work-embed': embedAnswer({ 'Beta Alpha': vector }), 'work-adjudicate': certClef('none', 0.8) }, calls, TWINS);
    expect(await snap(two.deps, { kind: 'cert', raw: 'Beta Alpha', lang: 'en' })).toMatchObject({ decision: 'unmatched' });
    expect(calls.map((c) => c.op)).toEqual(['work-embed', 'work-adjudicate']);
  });
});

describe('the exact certificate confirm with levels (E10)', () => {
  it('never lets a Level I rigger through a Level II requirement, and lets both through "certified rigger"', async () => {
    const { deps } = await certRegistry();
    const db = sqliteD1();
    const listings = new D1ListingStore(db.d1);
    const index = memoryIndex();
    for (const [pseudonym, raw] of [
      ['level-one', 'NCCCO Rigger Level I'],
      ['level-two', 'NCCCO Aparejador Nivel II'],
    ] as const) {
      const claim = await snap(deps, { kind: 'cert', raw, lang: 'en' });
      const tokens = [...claim.tokens, 'pos:rigger'].sort();
      const listingId = await listingIdOf(pseudonym, 'main');
      await index.upsert([{ id: listingId, values: axis(1), namespace: 'us-tx:onsite', metadata: { v: 1, region: 'us-tx', scope: 'onsite', tier: 1, bloom: bloomOf(tokens), model: 'm' } }]);
      await listings.put({ listingId, pseudonym, profileId: 'main', region: 'us-tx', scope: 'onsite', namespace: 'us-tx:onsite', tier: 1, tokens, embedModel: 'm', publishedAt: 0, updatedAt: 0 });
    }
    const recallDeps = { inference: fakeInference({ 'work-embed': embedAnswer({ 'move a genset; rigger': axis(1) }) }), index, listings };
    const found = async (requirement: string) => {
      const need = await snap(deps, { kind: 'cert', raw: requirement, lang: 'en', mint: false, region: 'us-tx' });
      const out = await recall(recallDeps, { scope: 'onsite', regions: ['us-tx'], queryText: 'move a genset; rigger', allOf: need.tokens, anyOf: ['pos:rigger'], mode: 'curated' });
      if (!out.ok) throw new Error(out.error);
      const names = new Map([[await listingIdOf('level-one', 'main'), 'level-one'], [await listingIdOf('level-two', 'main'), 'level-two']]);
      return out.finalists.map((f) => names.get(f.listingId)).sort();
    };
    expect(await found('NCCCO Rigger Level II')).toEqual(['level-two']);
    expect(await found('certified rigger')).toEqual(['level-one', 'level-two']);
  });
});
