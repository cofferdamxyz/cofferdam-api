// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/** The Work evaluation's scorer, offline: the live run is `test/work.eval.test.ts` (WORK_EVAL=1). */

import { describe, expect, it } from 'vitest';

import { languageCode, type CvFragment } from '../src/services/work/cv.js';
import { HIRER_PROMPTS, fixtureBlocks } from './fixtures/work/index.js';
import {
  aggregate,
  jaccard,
  LIST_FIELDS,
  listF1,
  listMatch,
  reportMarkdown,
  SCALAR_FIELDS,
  scoreBlock,
  scoreIntent,
  textMatch,
  type BlockRun,
} from './work-eval/score.js';

/** A fragment that says exactly what the gold says. */
function perfect(kind: string, e: Record<string, unknown>): CvFragment {
  const claims = (v: unknown) => ((v as string[] | undefined) ?? []).map((raw) => ({ raw }));
  switch (kind) {
    case 'summary':
      return { kind, headline: { title: e.title ? { raw: e.title as string, rank: null } : null, years: (e.years as number) ?? null }, skills: claims(e.skills) };
    case 'experience':
      return {
        kind,
        experience: {
          title: { raw: e.title as string, rank: (e.rank as number | null) ?? null },
          employer: null,
          location: null,
          start: (e.start as string | null) ?? null,
          end: (e.end as string | null) ?? null,
          current: e.current as boolean,
          skills: claims(e.skills),
        },
      };
    case 'education':
      return { kind, education: { qualification: e.qualification as string, institution: null, end: (e.end as string | null) ?? null } };
    case 'skills':
      return { kind, skills: claims(e.skills) };
    case 'certificates':
      return { kind, certificates: claims(e.certificates) };
    default:
      return {
        kind: 'languages',
        languages: [
          ...((e.fluent as string[]) ?? []).map((raw) => ({ raw, code: languageCode(raw), level: 'fluent' as const })),
          ...((e.basic as string[]) ?? []).map((raw) => ({ raw, code: languageCode(raw), level: 'basic' as const })),
        ],
      };
  }
}

const run = (id: string, kind: string, scores: ReturnType<typeof scoreBlock>, extra: Partial<BlockRun> = {}): BlockRun => ({
  model: 'm',
  id,
  cv: id.split('/')[0]!,
  locale: 'en-US',
  kind,
  ok: true,
  failure: null,
  ms: 1000,
  usage: { tokensIn: 100, tokensOut: 10, neurons: null },
  costMicroUsd: 50,
  violations: [],
  ...scores,
  ...extra,
});

describe('the Work evaluation scorer', () => {
  it('matches text by its words and lists one to one', () => {
    expect(textMatch('Aparejador (Rigger)', 'Aparejador')).toBe(true);
    expect(textMatch('Third Assistant Engineer', 'third assistant engineer')).toBe(true);
    expect(textMatch('Electrician', 'Plumber')).toBe(false);
    expect(jaccard('Soldagem TIG', 'soldagem tig')).toBe(1);
    expect(listMatch(['Leak detection', 'drain cleaning', 'welding'], ['Leak detection', 'Drain cleaning', 'PEX repiping'])).toEqual({ tp: 2, predCount: 3, goldCount: 3 });
    expect(listMatch([], [])).toEqual({ tp: 0, predCount: 0, goldCount: 0 });
  });

  it('gives a perfect answer every field and every item, for every fixture block', () => {
    const runs = fixtureBlocks()
      .filter(({ block }) => block.kind in SCALAR_FIELDS || block.kind in LIST_FIELDS)
      .map(({ block }) => run(block.id, block.kind, scoreBlock(block.kind, block.expected, perfect(block.kind, block.expected), null)));
    const a = aggregate(runs);
    expect(a.scalarCorrect).toBe(a.scalarTotal);
    expect(listF1(a)).toEqual({ precision: 1, recall: 1, f1: 1 });
    expect(a.falsePositives + a.misses).toBe(0);
    expect(a.scalarTotal).toBeGreaterThan(80);
  });

  it('counts a miss, a false positive, and p_null against the gold', () => {
    const e = { title: 'Engine Cadet', rank: null, start: '2016-08', end: '2019-05', current: false, skills: ['bunkering operations'] };
    const wrong: CvFragment = {
      kind: 'experience',
      experience: { title: null, employer: null, location: null, start: '2016-08', end: '2019-05', current: false, skills: [{ raw: 'bunkering operations' }] },
    };
    wrong.experience.title = { raw: 'Engine Cadet', rank: 2 };
    const scores = scoreBlock('experience', e, wrong, { rank: { value: 2, pNull: 0.2 }, title: { value: 'Engine Cadet', pNull: 0.1 } });
    const a = aggregate([run('x/experience-1', 'experience', scores)]);
    expect(a.byField.rank).toEqual({ correct: 0, total: 1 });
    expect(a.falsePositives).toBe(1);
    expect(a.brier).toBe(Math.round(((0.8 ** 2 + 0.1 ** 2) / 2) * 1000) / 1000);
    const none = aggregate([run('x/experience-1', 'experience', scoreBlock('experience', e, null, null), { ok: false, failure: 'not_json' })]);
    expect(none.misses).toBe(4);
    expect(none.failures).toEqual({ not_json: 1 });
  });

  it('scores intents on their gold, the budget included', () => {
    const p = HIRER_PROMPTS.find((x) => x.id === 'sink-en')!;
    const intent = { task: 'kitchen sink is leaking under the cabinet', when: 'today after 2pm', budgetUsd: 120, credential: null, language: null, languageCode: null, recurrence: null };
    expect(scoreIntent(p.expected as unknown as Record<string, unknown>, intent, null).every((s) => s.correct)).toBe(true);
    expect(scoreIntent(p.expected as unknown as Record<string, unknown>, { ...intent, budgetUsd: null }, null).find((s) => s.field === 'budgetUsd')?.correct).toBe(false);
  });

  it('writes a report with every section and no empty numbers', () => {
    const block = fixtureBlocks()[1]!.block;
    const md = reportMarkdown(
      { date: '2026-10-24', models: ['m'], classifyModel: '@cf/cloudflare/clef-flash', cvs: 1, blocks: 1, intents: 0, durationMs: 1_000 },
      [run(block.id, block.kind, scoreBlock(block.kind, block.expected, perfect(block.kind, block.expected), null))],
      [],
      [{ cv: 'x', locale: 'en-US', type: 'cv', confidence: 0.97, ms: 900 }],
    );
    for (const heading of ['## CV blocks', '### Single fields', '### By locale', '## Hirer sentences (S5)', '## Document type', '## Misses']) expect(md).toContain(heading);
    expect(md).not.toMatch(/NaN|undefined/);
  });
});
