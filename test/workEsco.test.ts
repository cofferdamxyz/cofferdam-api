// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The ESCO import, on synthetic rows in the export's layout: the URIs end in
 * `test-…` and the ISCO codes (9990, 9991) belong to no ISCO-08 unit group.
 * Real codes enter the registry only from the founder's ESCO download.
 */

import { describe, expect, it } from 'vitest';

import { EscoFormatError, iscoOf, parseCsv, planEscoImport, readEscoFile, registrySql, registrySqlFiles, vectorLine } from '../src/services/work/esco.js';
import { D1RegistryStore } from '../src/services/work/registry.js';
import { sqliteD1 } from './fixtures/work/d1.js';

const OCC_HEADER = 'conceptType,conceptUri,iscoGroup,preferredLabel,altLabels,hiddenLabels,status,modifiedDate,regulatedProfessionNote,scopeNote,definition,inScheme,description,code';
const OCC_EN = [
  OCC_HEADER,
  'Occupation,http://data.europa.eu/esco/occupation/test-0001,9990,ship engineer,"marine engineer\nengine officer",ship enginer,released,,,,,,"A synthetic row, quoted",9990.1',
  'Occupation,http://data.europa.eu/esco/occupation/test-0002,9991,pipe layer,,,released,,,,,,,9991.2',
  'Occupation,http://data.europa.eu/esco/occupation/test-0003,,pipe layer,,,released,,,,,,,9991.3',
  'Occupation,http://data.europa.eu/esco/occupation/test-0004,9991,retired role,,,obsolete,,,,,,,9991.4',
].join('\r\n');
const OCC_PT = [
  OCC_HEADER,
  'Occupation,http://data.europa.eu/esco/occupation/test-0001,9990,oficial de máquinas,"maquinista naval\nmarine engineer",,released,,,,,,,9990.1',
  'Occupation,http://data.europa.eu/esco/occupation/test-0002,9991,assentador de tubos,,,released,,,,,,,9991.2',
].join('\n');
const SKILL_HEADER = 'conceptType,conceptUri,skillType,reuseLevel,preferredLabel,altLabels,hiddenLabels,status,modifiedDate,scopeNote,definition,inScheme,description';
const SKILL_EN = [SKILL_HEADER, 'KnowledgeSkillCompetence,http://data.europa.eu/esco/skill/test-0101,skill/competence,sector-specific,repair leaks,"fix leaks\nplumber\'s leak fix",,released,,,,,'].join('\n');
const SKILL_ES = [SKILL_HEADER, 'KnowledgeSkillCompetence,http://data.europa.eu/esco/skill/test-0101,skill/competence,sector-specific,reparar fugas,"arreglar fugas\nreparación de fugas",,released,,,,,'].join('\n');

describe('parseCsv', () => {
  it('reads quoted cells, doubled quotes, line breaks inside quotes, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n"one\ntwo",\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['one\ntwo', ''],
    ]);
    expect(parseCsv('')).toEqual([]);
  });
});

describe('readEscoFile', () => {
  it('reads released concepts by column name, one label per line', () => {
    const concepts = readEscoFile(OCC_EN, 'occupation');
    expect(concepts.map((c) => c.uri.slice(-9))).toEqual(['test-0001', 'test-0002', 'test-0003']);
    expect(concepts[0]).toEqual({
      uri: 'http://data.europa.eu/esco/occupation/test-0001',
      preferred: 'ship engineer',
      alternatives: ['marine engineer', 'engine officer'],
      hidden: ['ship enginer'],
      isco: '9990',
    });
    expect(concepts[2]!.isco).toBe('9991');
  });

  it('reads a concept the export lists twice once, its labels merged, and plans one token for it', async () => {
    const repeated = [OCC_EN, 'Occupation,http://data.europa.eu/esco/occupation/test-0001,9990,ship engineer,"marine engineer\nship\'s engineer",,released,,,,,,,9990.1'].join('\r\n');
    const concepts = readEscoFile(repeated, 'occupation');
    expect(concepts.map((c) => c.uri.slice(-9))).toEqual(['test-0001', 'test-0002', 'test-0003']);
    expect(concepts[0]).toMatchObject({ alternatives: ['marine engineer', 'engine officer', "ship's engineer"], hidden: ['ship enginer'] });
    const plan = await planEscoImport({ occupations: { en: repeated } });
    expect(plan.tokens.filter((t) => t.escoUri?.endsWith('test-0001')).map((t) => t.token)).toEqual(['pos:ship-engineer']);
    expect(plan.counts).toMatchObject({ occupations: 3, renamed: 1 });
  });

  it('takes the ISCO group from the column, a URI ending in it, or the ESCO code', () => {
    expect(iscoOf('9990', undefined)).toBe('9990');
    expect(iscoOf('http://data.europa.eu/esco/isco/C9990', undefined)).toBe('9990');
    expect(iscoOf('', '9991.3')).toBe('9991');
    expect(iscoOf(undefined, 'x')).toBeNull();
  });

  it('accepts the older header names and stops on a file without the columns it needs', () => {
    const older = 'Concept URI,Concept type,ISCO code,Concept PT,Definition\nhttp://data.europa.eu/esco/occupation/test-0009,Occupation,9990,test role,x';
    expect(readEscoFile(older, 'occupation')).toEqual([
      { uri: 'http://data.europa.eu/esco/occupation/test-0009', preferred: 'test role', alternatives: [], hidden: [], isco: '9990' },
    ]);
    expect(() => readEscoFile('uri,label\nx,y', 'occupation')).toThrow(EscoFormatError);
    expect(() => readEscoFile('uri,label\nx,y', 'occupation')).toThrow(/missing preferredLabel, iscoGroup or code; the header has: uri, label/);
  });
});

describe('planEscoImport', () => {
  it('names tokens by the English label, joins the other languages by URI, and keeps every code from the export', async () => {
    const plan = await planEscoImport({ occupations: { en: OCC_EN, pt: OCC_PT }, skills: { en: SKILL_EN, es: SKILL_ES } });
    expect(plan.tokens.map((t) => [t.token, t.source, t.iscoCode, t.status])).toEqual([
      ['pos:ship-engineer', 'esco', '9990', 'active'],
      ['pos:pipe-layer', 'esco', '9991', 'active'],
      ['pos:pipe-layer-st0003', 'esco', '9991', 'active'],
      ['skill:repair-leaks', 'esco', null, 'active'],
    ]);
    expect(plan.counts).toMatchObject({ occupations: 3, skills: 1, withoutIsco: 0, renamed: 1 });
    const ship = plan.labels.filter((l) => l.token === 'pos:ship-engineer').map((l) => `${l.lang}:${l.kind}:${l.label}`);
    expect(ship).toEqual([
      'en:preferred:ship engineer',
      'en:alternative:marine engineer',
      'en:alternative:engine officer',
      'en:hidden:ship enginer',
      'pt:preferred:oficial de máquinas',
      'pt:alternative:maquinista naval',
      'pt:alternative:marine engineer',
    ]);
    expect(plan.labels.filter((l) => l.token === 'skill:repair-leaks').map((l) => l.lang)).toEqual(['en', 'en', 'en', 'es', 'es', 'es']);
    const without = await planEscoImport({ occupations: { en: OCC_EN } }, { hidden: false });
    expect(without.labels.some((l) => l.kind === 'hidden')).toBe(false);
    await expect(planEscoImport({ occupations: { pt: OCC_PT } })).rejects.toThrow(/English occupation file is required/);
  });

  it('writes SQL that loads into the migrated database once, however often it runs', async () => {
    const plan = await planEscoImport({ occupations: { en: OCC_EN, pt: OCC_PT }, skills: { en: SKILL_EN } });
    const sql = registrySql(plan, 1_000);
    const { sqlite, d1 } = sqliteD1();
    sqlite.exec(sql);
    sqlite.exec(sql);
    expect(sqlite.prepare('SELECT count(*) AS n FROM registry_tokens').get()).toEqual({ n: plan.tokens.length });
    expect(sqlite.prepare('SELECT count(*) AS n FROM registry_labels').get()).toEqual({ n: plan.labels.length });
    const store = new D1RegistryStore(d1);
    expect((await store.tokensByLabel('maquinista naval', 'pos')).map((t) => t.token)).toEqual(['pos:ship-engineer']);
    expect(sqlite.prepare("SELECT label FROM registry_labels WHERE label_norm = 'plumber s leak fix'").get()).toEqual({ label: "plumber's leak fix" });
  });

  it('cuts the SQL into files between statements, the tokens first, that load one by one to the same rows', async () => {
    const plan = await planEscoImport({ occupations: { en: OCC_EN, pt: OCC_PT }, skills: { en: SKILL_EN, es: SKILL_ES } });
    const files = registrySqlFiles(plan, 1_000, 1);
    expect(files.length).toBeGreaterThan(1);
    expect(files.every((f) => f.startsWith('INSERT INTO ') && f.split('ON CONFLICT DO NOTHING;').length === 2)).toBe(true);
    expect(files[0]).toMatch(/^INSERT INTO registry_tokens /);
    expect(files.join('')).toBe(registrySql(plan, 1_000));
    // D1 enforces the labels' foreign key, as this database does: out of order, a label file fails.
    expect(() => sqliteD1().sqlite.exec(files[files.length - 1]!)).toThrow(/FOREIGN KEY/);
    const { sqlite } = sqliteD1();
    for (const f of files) sqlite.exec(f);
    expect(sqlite.prepare('SELECT count(*) AS n FROM registry_labels').get()).toEqual({ n: plan.labels.length });
  });

  it('writes one NDJSON line per label vector, with the code beside the token', async () => {
    const plan = await planEscoImport({ occupations: { en: OCC_EN } });
    const label = plan.labels[0]!;
    const line = JSON.parse(vectorLine(label, plan.tokens[0]!, Array.from({ length: 4 }, (_, i) => i / 3)));
    expect(line).toEqual({
      id: label.labelId,
      values: [0, 0.333333, 0.666667, 1],
      metadata: { token: 'pos:ship-engineer', kind: 'pos', lang: 'en', label: 'ship engineer', source: 'esco', isco: '9990' },
    });
  });
});
