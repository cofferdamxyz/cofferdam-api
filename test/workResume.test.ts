// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The real-resume benchmark's pure parts, offline, on made-up resumes written
 * in LiveCareer's markup: no real resume enters the repository
 * (`test/work-eval/resumeBench.ts`, `test/workResume.eval.test.ts`).
 */

import { describe, expect, it } from 'vitest';

import type { Finalist } from '../src/services/work/recall.js';
import {
  applyReview,
  applyValue,
  arbiterRequest,
  consideredOf,
  DECISION_RULES,
  disputeQuestions,
  dropAbsent,
  hasContact,
  jobMonths,
  labelDate,
  mergeReadings,
  monthIndex,
  pickSample,
  readArbiter,
  readingGaps,
  readPlan,
  readResumeCsv,
  replayRule,
  resumeTruth,
  sameSchool,
  scoreReading,
  type Considered,
  type ConsideredSearch,
  type Reading,
  type ResumeRecord,
} from './work-eval/resumeBench.js';

/** A made-up resume in the dataset's markup: two jobs (the first current), one school, a certifications section. */
const HTML = [
  '<div class="fontsize fontface"><div class="section" id="SECTION_NAME1"><span class="name">SITE SUPERVISOR</span></div>',
  '<div class="section" id="SECTION_EXPR1"><div class="paragraph firstparagraph" id="PARAGRAPH_1_1">',
  '<span class="companyname" id="1COMP1">Company Name</span><span class="jobtitle" id="1JTIT1"> Site Supervisor </span>',
  '<span class="datesWrapper"><span class="jobdates" format="%m/%Y" id="1JSTD1">03/2016</span> to <span class="jobdates" format="%m/%Y" id="1EDDT1">Current</span></span>',
  '<span class="jobline" id="1JDES1"><ul><li>Ran a crew of six.</li></ul></span></div>',
  '<div class="paragraph" id="PARAGRAPH_1_2"><span class="companyname" id="1COMP2">Company Name</span>',
  '<span class="jobtitle" id="1JTIT2">Carpenter &amp; Framer</span>',
  '<span class="jobdates" format="%B %Y" id="1JSTD2">June 2011</span> to <span class="jobdates" format="%b %Y" id="1EDDT2">Feb 2016</span></div></div>',
  '<div class="section" id="SECTION_EDUC1"><div class="paragraph" id="PARAGRAPH_2_1"><span class="degree" id="1DGRE1">Associate of Applied Science</span>',
  '<span class="programline" id="1STUY1">Construction Management</span><span class="jobdates" id="1GRYR1">2010</span>',
  '<span class="companyname companyname_educ" id="1SCHO1">Example Community College</span></div></div>',
  '<div class="section" id="SECTION_SKLL611042353" style="padding-top:0px;"><div class="heading"><div class="sectiontitle">Skills</div></div>',
  '<div class="paragraph"><div class="field singlecolumn">Framing, blueprint reading; crew scheduling</div></div></div>',
  '<div class="section" id="SECTION_CERT1"><div class="paragraph"><ul><li>OSHA 30-Hour Construction</li><li>Forklift operator</li></ul></div></div></div>',
].join('');

const reading = (r: Partial<Reading>): Reading => ({ jobs: [], schools: [], certificates: [], ...r });

describe('the dataset', () => {
  it('reads the CSV, quotes, commas and line breaks included', () => {
    const csv = 'ID,Resume_str,Resume_html,Category\n1,"Line one, with a comma\nline two ""quoted""",<b>x</b>,CHEF\n2,plain,<i>y</i>,ENGINEERING\n';
    const rows = readResumeCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: '1', category: 'CHEF', text: 'Line one, with a comma\nline two "quoted"', html: '<b>x</b>' });
  });

  it('finds an email or a phone number', () => {
    expect(hasContact('reach me at someone@example.com')).toBe(true);
    expect(hasContact('call (555) 123-4567')).toBe(true);
    expect(hasContact('Ran a crew of six for 18 months in 2019.')).toBe(false);
  });

  it('reads the labels: jobs in order, dates in each format, current, school, skills, certificates, anchor', () => {
    const t = resumeTruth(HTML);
    expect(t.jobs).toEqual([
      { title: 'Site Supervisor', start: '2016-03', end: null, current: true },
      { title: 'Carpenter & Framer', start: '2011-06', end: '2016-02', current: false },
    ]);
    expect(t.schools).toEqual([{ school: 'Example Community College', degree: 'Associate of Applied Science Construction Management', end: '2010' }]);
    expect(t.certificates).toEqual(['OSHA', 'forklift']);
    expect(t.anchor).toBe('2016-03');
    // Neither the section's own tag nor the next section's leaks in as a skill.
    expect(t.skills).toEqual(['Framing', 'blueprint reading', 'crew scheduling']);
  });

  it('reads label dates through the parse’s own reader', () => {
    expect(labelDate('03/2015')).toEqual({ present: false, date: '2015-03' });
    expect(labelDate('March 2015')).toEqual({ present: false, date: '2015-03' });
    expect(labelDate('Mar 2015')).toEqual({ present: false, date: '2015-03' });
    expect(labelDate('2015')).toEqual({ present: false, date: '2015' });
    expect(labelDate('Current')).toEqual({ present: true });
    expect(labelDate('')).toBeNull();
  });

  it('samples the same resumes for the same seed, within each category', () => {
    const recs: ResumeRecord[] = Array.from({ length: 30 }, (_, i) => ({ id: String(1000 + i), category: i % 2 ? 'CHEF' : 'ENGINEERING', text: '', html: '' }));
    const plan = readPlan('CHEF:4,ENGINEERING:3');
    const a = pickSample(recs, plan, 7, () => true);
    expect(a.map((r) => r.id)).toEqual(pickSample(recs, plan, 7, () => true).map((r) => r.id));
    expect(a.filter((r) => r.category === 'CHEF')).toHaveLength(4);
    expect(a.filter((r) => r.category === 'ENGINEERING')).toHaveLength(3);
    expect(pickSample(recs, plan, 7, (r) => r.id !== a[0]!.id).map((r) => r.id)).not.toContain(a[0]!.id);
    expect(() => readPlan('CHEF')).toThrow();
  });
});

describe('months', () => {
  it('counts a job in months, a current one to the anchor, a bare year as June', () => {
    expect(monthIndex('2016-03') - monthIndex('2016-01')).toBe(2);
    expect(jobMonths({ start: '2011-06', end: '2016-02', current: false }, null)).toBe(56);
    expect(jobMonths({ start: '2016-03', end: null, current: true }, '2018-03')).toBe(24);
    expect(jobMonths({ start: '2016', end: '2017', current: false }, null)).toBe(12);
    expect(jobMonths({ start: null, end: '2017', current: false }, null)).toBeNull();
    expect(jobMonths({ start: '2018-01', end: '2017-01', current: false }, null)).toBeNull();
  });
});

describe('merging two readings', () => {
  const a = reading({
    jobs: [
      { title: 'Site Supervisor', start: '2016-03', end: null, current: true },
      { title: 'Carpenter', start: '2011-06', end: '2016-02', current: false },
    ],
    schools: [{ institution: 'Example Community College', qualification: 'AAS', end: '2010' }],
    certificates: ['OSHA 30'],
  });

  it('keeps what both read alike, with no dispute', () => {
    const m = mergeReadings(a, structuredClone(a));
    expect(m.disputes).toEqual([]);
    expect(m.reading).toEqual({ ...a, skills: [] });
  });

  it('takes the union of both readers’ skills, first seen first, without a dispute', () => {
    const m = mergeReadings({ ...a, skills: ['Blueprint reading', 'OSHA safety'] }, { ...structuredClone(a), skills: ['blueprint  reading', 'Scheduling'] });
    expect(m.reading.skills).toEqual(['Blueprint reading', 'OSHA safety', 'Scheduling']);
    expect(m.disputes).toEqual([]);
  });

  it('turns a different value into a value dispute and an item one reader missed into a presence dispute', () => {
    const b = structuredClone(a);
    b.jobs[1]!.start = '2011';
    b.jobs.pop();
    b.jobs.push({ title: 'Carpenter', start: '2011', end: '2016-02', current: false });
    b.certificates = [];
    const m = mergeReadings(a, b);
    expect(m.disputes.map((d) => [d.kind, d.path, d.a, d.b])).toEqual([
      ['value', 'jobs.1.start', '2011-06', '2011'],
      ['presence', 'certificates.0', 'OSHA 30', null],
    ]);
    const q = disputeQuestions(m.disputes);
    expect(q.d1).toMatchObject({ type: 'choice', criteria: { a: '"2011-06"', b: '"2011"' } });
    expect(q.d2).toMatchObject({ type: 'noul' });
  });

  it('asks about the job only one reader read, keeping it until it is settled', () => {
    const b = reading({ ...structuredClone(a), jobs: [a.jobs[0]!] });
    const m = mergeReadings(a, b);
    expect(m.reading.jobs).toHaveLength(2);
    expect(m.disputes).toMatchObject([{ kind: 'presence', path: 'jobs.1', b: null }]);
  });

  it('finds the gaps the code can see without a model', () => {
    expect(readingGaps(reading({ jobs: [{ title: 'x', start: null, end: null, current: false }, { title: 'y', start: '2019-05', end: '2018-01', current: false }] }))).toEqual([
      'jobs.0.start',
      'jobs.0.end',
      'jobs.1.start',
      'jobs.1.end',
    ]);
  });
});

describe('settling a dispute', () => {
  it('asks the arbiter with the pages and reads its answers, a date as the parse would', () => {
    const req = arbiterRequest([{ mime: 'image/jpeg', base64: 'AAAA' }], [
      { id: 'd1', kind: 'value', path: 'jobs.0.start', a: '2016-03', b: '2016', subject: 'the start date' },
    ]);
    expect(req.reasoning_effort).toBe('high');
    const content = (req.messages as { content: unknown }[])[1]!.content as { type: string }[];
    expect(content.map((c) => c.type)).toEqual(['text', 'image_url']);
    const answers = readArbiter({ choices: [{ message: { content: '{"answers":[{"id":"d1","value":"March 2016","present":null},{"id":"d2","value":null,"present":false}]}' } }] });
    expect(answers.get('d1')).toEqual({ value: 'March 2016', present: null });
    expect(answers.get('d2')).toEqual({ value: null, present: false });
    const r = reading({ jobs: [{ title: 'x', start: '2016', end: null, current: true }] });
    applyValue(r, 'jobs.0.start', 'March 2016');
    applyValue(r, 'jobs.0.end', 'Jan 2019');
    expect(r.jobs[0]).toEqual({ title: 'x', start: '2016-03', end: '2019-01', current: false });
    applyValue(r, 'jobs.0.end', 'present');
    expect(r.jobs[0]).toMatchObject({ end: null, current: true });
  });

  it('drops an item settled as absent', () => {
    const r = reading({ jobs: [{ title: 'a', start: null, end: null, current: false }, { title: 'b', start: null, end: null, current: false }], certificates: ['x', 'y'] });
    expect(dropAbsent(r, ['jobs.0', 'certificates.1'])).toEqual(reading({ jobs: [{ title: 'b', start: null, end: null, current: false }], certificates: ['x'] }));
  });

  it('applies the full check’s corrections and missing jobs', () => {
    const r = reading({ jobs: [{ title: 'Site Supervisor', start: '2016', end: null, current: true }] });
    const result = { choices: [{ message: { content: JSON.stringify({ corrections: [{ id: 'j0.start', value: '03/2016' }, { id: 'zz', value: 'x' }], missing_jobs: [{ title: 'Carpenter', start: 'June 2011', end: 'Feb 2016' }] }) } }] };
    const out = applyReview(r, result);
    expect(out.corrections).toBe(1);
    expect(out.added).toBe(1);
    expect(out.reading.jobs).toEqual([
      { title: 'Site Supervisor', start: '2016-03', end: null, current: true },
      { title: 'Carpenter', start: '2011-06', end: '2016-02', current: false },
    ]);
    expect(r.jobs[0]!.start).toBe('2016');
  });
});

describe('scoring against the labels', () => {
  const truth = resumeTruth(HTML);

  it('scores a perfect reading right everywhere, with no question', () => {
    const r = reading({
      jobs: truth.jobs.map((j) => ({ ...j })),
      schools: [{ institution: 'Example Community College', qualification: 'Associate of Applied Science', end: '2010' }],
      certificates: ['OSHA 30-Hour Construction', 'Forklift operator'],
    });
    const s = scoreReading(r, truth, new Set());
    for (const f of ['job', 'title', 'start', 'end', 'months', 'school', 'certificate'] as const) {
      expect(s.outcomes[f].silent + s.outcomes[f]['asked-wrong']).toBe(0);
    }
    expect(s.outcomes.job.right).toBe(2);
    expect(s.outcomes.certificate.right).toBe(2);
    expect(s.jobs).toEqual({ truth: 2, found: 2, spurious: 0 });
    expect(s.questions).toBe(0);
  });

  it('counts a lost month as wrong, asked when its path is open and silent when not', () => {
    const r = reading({ jobs: [{ ...truth.jobs[0]!, start: '2016' }, { ...truth.jobs[1]! }, { title: 'Invented', start: '2001', end: '2002', current: false }] });
    const silent = scoreReading(r, truth, new Set());
    expect(silent.outcomes.start.silent).toBe(1);
    expect(silent.outcomes.months.silent).toBe(1);
    expect(silent.jobs.spurious).toBe(1);
    expect(silent.outcomes.school.silent).toBe(1);
    expect(silent.outcomes.certificate.silent).toBe(2);
    const asked = scoreReading(r, truth, new Set(['jobs.0.start']));
    expect(asked.outcomes.start['asked-wrong']).toBe(1);
    expect(asked.outcomes.months['asked-wrong']).toBe(1);
    expect(asked.questions).toBe(1);
  });

  it('scores no date the label lacks, and a school read right with its location appended', () => {
    const undated = { ...truth, jobs: [{ title: 'Site Supervisor', start: null, end: null, current: false }] };
    const s = scoreReading(reading({ jobs: [{ title: 'Site Supervisor', start: '2016-03', end: '2018-01', current: false }], schools: [{ institution: 'Example Community College - City, State', qualification: null, end: null }] }), undated, new Set());
    expect(s.outcomes.title.right).toBe(1);
    expect(s.outcomes.start).toEqual({ right: 0, 'asked-right': 0, 'asked-wrong': 0, silent: 0 });
    expect(s.outcomes.months).toEqual({ right: 0, 'asked-right': 0, 'asked-wrong': 0, silent: 0 });
    expect(s.outcomes.school.right).toBe(1);
    expect(sameSchool('Example College', 'Example Community College')).toBe(false);
  });

  it('counts a job the reading missed as wrong in every field', () => {
    const s = scoreReading(reading({ jobs: [{ ...truth.jobs[0]! }] }), truth, new Set());
    expect(s.jobs).toMatchObject({ truth: 2, found: 1 });
    expect(s.outcomes.job.silent).toBe(1);
    expect(s.outcomes.title.silent).toBe(1);
  });
});

describe('the decision pass, replayed', () => {
  const c = (over: Partial<Considered>): Considered => ({ right: false, gateTier: 1, occupationHit: false, meetsAllOf: true, score: 0.7, choice: 'related', pFit: 0.2, pRelated: 0.6, pOther: 0.2, skillShare: 0, ...over });
  const search: ConsideredSearch = {
    mode: 'instant',
    considered: [
      c({ right: true, gateTier: 2, choice: 'fit', pFit: 0.6, pRelated: 0.3, pOther: 0.1 }),
      c({ occupationHit: true, score: 0.8, choice: 'other', pFit: 0.1, pRelated: 0.1, pOther: 0.8 }),
      c({ score: 0.75, pFit: 0.3 }),
    ],
  };
  const built = Object.values(DECISION_RULES)[1]!;

  it('replays recall as built: a fit promotes a miss, other work drops even a token hit', () => {
    expect(replayRule([search], built)).toEqual({ found: 1, first: 1, top5: 1, kept: 2, asked: 3 });
    expect(replayRule([search], DECISION_RULES['The gate alone, by cosine']!)).toEqual({ found: 0, first: 0, top5: 0, kept: 2, asked: 0 });
    expect(replayRule([search], DECISION_RULES['Other drops only a finalist with no occupation hit']!)).toEqual({ found: 1, first: 1, top5: 1, kept: 3, asked: 3 });
    // EmbeddingGemma 2's floor: the right miss at 0.7 is still asked; one at 0.6 would not be.
    const floor = Object.values(DECISION_RULES)[2]!;
    expect(replayRule([search], floor)).toEqual({ found: 1, first: 1, top5: 1, kept: 2, asked: 3 });
    expect(replayRule([{ ...search, considered: [{ ...search.considered[0]!, score: 0.6 }, ...search.considered.slice(1)] }], floor)).toEqual({ found: 0, first: 0, top5: 0, kept: 1, asked: 2 });
  });

  it('never promotes a finalist that lacks a hard requirement, and never drops one whose call failed', () => {
    const lacking: ConsideredSearch = { mode: 'instant', considered: [c({ right: true, gateTier: 2, choice: 'fit', pFit: 0.9, meetsAllOf: false })] };
    expect(replayRule([lacking], built).found).toBe(0);
    expect(replayRule([{ ...lacking, mode: 'curated' }], built).found).toBe(1);
    expect(replayRule([{ mode: 'instant', considered: [c({ right: true, choice: null, pOther: 0 })] }], built).found).toBe(1);
  });

  it('reads recall’s finalists: the gate’s tier before a promotion, an occupation hit, the hard requirements, the share of needed skills', () => {
    const f = (over: Partial<Finalist>): Finalist => ({ listingId: 'a', score: 0.7, gateTier: 1, personhood: 1, matched: [], namespace: 'us-tx:onsite', ...over });
    const out = consideredOf(
      [
        f({ listingId: 'a', matched: ['isco:7126'], fit: { choice: 'fit', pFit: 0.9, pRelated: 0.05, pOther: 0.05, skillsHeld: 1, promoted: false } }),
        f({ listingId: 'b', fit: { choice: 'fit', pFit: 0.8, pRelated: 0.1, pOther: 0.1, skillsHeld: 0, promoted: true } }),
      ],
      { allOf: ['lang:en'], anyOf: ['pos:plumber', 'isco:7126', 'skill:leak-repair', 'skill:pipe-welding'] },
      (id) => (id === 'a' ? ['isco:7126', 'lang:en', 'pos:pipefitter'] : []),
      'b',
    );
    expect(out.map((x) => [x.right, x.gateTier, x.occupationHit, x.meetsAllOf, x.skillShare])).toEqual([
      [false, 1, true, true, 0.5],
      [true, 2, false, false, 0],
    ]);
    // An occupation kept under Clef's floor is no occupation hit, as recall ranks it at the cut.
    const kept = consideredOf([f({ listingId: 'a', matched: ['pos:plumber'] })], { allOf: [], anyOf: ['pos:plumber', 'skill:leak-repair'], keptOccupation: 'pos:plumber' }, () => [], undefined);
    expect(kept[0]!.occupationHit).toBe(false);
  });
});
