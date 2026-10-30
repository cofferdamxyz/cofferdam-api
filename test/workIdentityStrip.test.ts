// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The identity strip (`test/work-eval/identityStrip.ts`; workspace decision 0021, the founder's ruling of 2026-10-30),
 * offline on made-up text: no resume enters the repository.
 */

import { describe, expect, it } from 'vitest';

import { birthDateOf, monthOf, stripIdentity, type HolderIdentity } from './work-eval/identityStrip.js';
import { injectIdentity, nameRead, phoneRead, stripCounts, syntheticPerson } from './work-eval/stripBench.js';

/** A passport as the app keeps it: the MRZ's names without accents, title-cased. */
const jose: HolderIdentity = { firstName: 'Jose Luis', lastName: 'Garcia Perez', fullName: 'Jose Luis Garcia Perez', dateOfBirth: '1985-03-14' };
const strip = (text: string, holder: HolderIdentity | null = jose) => stripIdentity(text, holder).text;

describe('emails', () => {
  it('go whether or not the account is bound, one placeholder per address', () => {
    const text = 'Contact: Jose.Garcia@example.com, or jg@example.org.\nAgain: jose.garcia@example.com';
    const out = stripIdentity(text, null);
    expect(out.text).toBe('Contact: [EMAIL_1], or [EMAIL_2].\nAgain: [EMAIL_1]');
    expect(out.removed.map((r) => r.kind)).toEqual(['email', 'email', 'email']);
  });

  it('leave the name and the birth date of an account that is not bound', () => {
    expect(strip('José García\nBorn 03/14/1985\njose@example.com', null)).toBe('José García\nBorn 03/14/1985\n[EMAIL_1]');
  });
});

describe('the passport name', () => {
  it('goes in the spellings a CV gives it, accents, capitals and order included', () => {
    expect(strip('José García')).toBe('[PERSON_1]');
    expect(strip('JOSÉ LUIS GARCÍA PÉREZ\nElectrician')).toBe('[PERSON_1]\nElectrician');
    expect(strip('García, José')).toBe('[PERSON_1]');
    expect(strip('José L. García')).toBe('[PERSON_1]');
    expect(strip('Signed, J. García Pérez.')).toBe('Signed, [PERSON_1].');
    expect(strip('Hoff, I.', { firstName: 'Icaro', lastName: 'Pereira Hoff', dateOfBirth: null })).toBe('[PERSON_1]');
  });

  it('goes when a header breaks it over two lines, but not across a blank line', () => {
    expect(strip('JOSÉ\nGARCÍA\nElectrician')).toBe('[PERSON_1]\nElectrician');
    expect(strip('José\n\nGarcía')).toBe('José\n\nGarcía');
  });

  it("reads the MRZ's spelling of letters it writes out", () => {
    const juergen: HolderIdentity = { firstName: 'Juergen', lastName: 'Mueller', dateOfBirth: null };
    expect(strip('Jürgen Müller, welder', juergen)).toBe('[PERSON_1], welder');
  });

  it('keeps a word of the name that stands alone', () => {
    const cook: HolderIdentity = { firstName: 'James', lastName: 'Cook', dateOfBirth: null };
    expect(strip('James Cook\nLine Cook, 2019 to 2021', cook)).toBe('[PERSON_1]\nLine Cook, 2019 to 2021');
    expect(strip('Worked as a Silva crew lead', { firstName: 'Ana', lastName: 'Silva', dateOfBirth: null })).toBe('Worked as a Silva crew lead');
  });

  it("takes the name's particles inside it, never alone", () => {
    const maria: HolderIdentity = { firstName: 'Maria', lastName: 'De Los Santos', dateOfBirth: null };
    expect(strip('María de los Santos\nUniversidad de los Andes', maria)).toBe('[PERSON_1]\nUniversidad de los Andes');
  });

  it('ends at an email built from it', () => {
    expect(strip('José García jose.garcia@example.com')).toBe('[PERSON_1] [EMAIL_1]');
  });
});

describe('the passport birth date', () => {
  it('goes in every format the strip reads, in English, Spanish and Portuguese', () => {
    for (const written of ['03/14/1985', '14/03/1985', '14.03.85', '1985-03-14', '14 March 1985', 'March 14, 1985', 'Mar. 14th, 1985', '14 de março de 1985', '14 de marzo de 1985', '14-Mar-1985']) {
      expect(strip(`Date of birth: ${written}.`), written).toBe('Date of birth: [BIRTH_DATE].');
    }
  });

  it('leaves every other date', () => {
    const text = 'Born 03/15/1985. Hired 2010-03-14, March 2010, 14/03/1986; 03/2014 - 05/2018.';
    expect(strip(text)).toBe(text);
  });

  it('reads a passport year the app put in the future a century back', () => {
    expect(birthDateOf('2045-01-02', 2026)).toEqual({ y: 1945, m: 1, d: 2 });
    expect(strip('Born 02/01/1945', { firstName: null, lastName: null, dateOfBirth: '2045-01-02' })).toBe('Born [BIRTH_DATE]');
  });

  it('reads month names in the three launch languages', () => {
    expect([monthOf('março'), monthOf('Setiembre'), monthOf('dic'), monthOf('Mai'), monthOf('build')]).toEqual([3, 9, 12, 5, null]);
  });
});

describe('the result', () => {
  it('lists what was removed in the order of the text, as the CV wrote it', () => {
    const out = stripIdentity('JOSÉ GARCÍA · jose@example.com · Born 14 de marzo de 1985', jose);
    expect(out.removed.map((r) => [r.kind, r.text, r.placeholder])).toEqual([
      ['name', 'JOSÉ GARCÍA', '[PERSON_1]'],
      ['email', 'jose@example.com', '[EMAIL_1]'],
      ['birthDate', '14 de marzo de 1985', '[BIRTH_DATE]'],
    ]);
    expect(out.text).toBe('[PERSON_1] · [EMAIL_1] · Born [BIRTH_DATE]');
  });
});

describe("the strip's benchmark (stripBench)", () => {
  const body = 'Summary\nLine Cook with a mason crew, grants and rose gardens.\nExperience\nCook, 06/2019 to 05/2021\nBaker Street Bistro';
  const seeds = Array.from({ length: 200 }, (_, i) => i + 1);

  it('makes the same person for a seed, with the passport as the app keeps it', () => {
    expect(syntheticPerson(7)).toEqual(syntheticPerson(7));
    for (const seed of seeds) {
      const p = syntheticPerson(seed);
      expect(`${p.passport.firstName} ${p.passport.lastName}`).toMatch(/^([A-Z][a-z]+ ?)+$/);
      expect(p.passport.dateOfBirth).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("places the person's strings where its spans say", () => {
    for (const seed of seeds) {
      const p = syntheticPerson(seed);
      const inj = injectIdentity(body, p);
      const at = (k: string) => inj.spans.filter((s) => s.kind === k).map((s) => inj.text.slice(s.start, s.end));
      expect(at('name')).toEqual(p.names);
      expect(at('email')).toEqual([p.email]);
      expect(at('phone')).toEqual([p.phone]);
      expect(at('birthDate')).toEqual(p.birthDate ? [p.birthDate] : []);
    }
  });

  it('a bound strip leaves none of the name, birth date or email in any spelling the benchmark writes, and takes nothing else', () => {
    for (const seed of seeds) {
      const p = syntheticPerson(seed);
      const inj = injectIdentity(body, p);
      const c = stripCounts(inj, stripIdentity(inj.text, p.passport).removed, p);
      expect({ seed, ...c.left, extra: c.extraSpans }).toEqual({ seed, name: false, birthDate: false, email: false, phone: true, extra: 0 });
      expect(stripIdentity(body, p.passport).removed).toEqual([]);
    }
  });

  it('an unbound strip takes only the email', () => {
    const p = syntheticPerson(3);
    const inj = injectIdentity(body, p);
    const c = stripCounts(inj, stripIdentity(inj.text, null).removed, p);
    expect(c.left).toEqual({ name: true, birthDate: !!p.birthDate, email: false, phone: true });
  });

  it("compares a reader's name and phone with the person's", () => {
    const p = syntheticPerson(11);
    expect(nameRead(p.fullName, p)).toBe('right');
    expect(nameRead('[PERSON_1]', p)).toBe('placeholder');
    expect(nameRead(null, p)).toBe('none');
    expect(nameRead('Somebody Else', p)).toBe('other');
    expect(phoneRead(p.phone.replace(/\D/g, ''), p)).toBe(true);
    expect(phoneRead('555-0000', p)).toBe(false);
  });
});
