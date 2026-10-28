// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The whole-CV parse benchmark inside the app on a phone (opt-in; workspace
 * decision 0068): the readers only the app reaches, llama.rn on the iPhone's
 * Metal, measured with the truth and scorer of `test/workParse.eval.test.ts`.
 * The app's half is cofferdam-app's Local AI test screen (`src/lib/localAi/readerBench.ts`).
 *
 * 1. Plan: the cloud parse's request (`parseRequest`: system prompt, user text,
 *    JSON schema), the readers and the runs, with the two synthetic CV pages
 *    beside it, for `xcrun devicectl device copy to` into the app's
 *    `Documents/reader-bench/`:
 *
 *      WORK_PARSE_PHONE_PLAN=<folder> yarn vitest run test/workParsePhone.eval.test.ts
 *
 *    WORK_PARSE_PHONE_RUNS sets the reads in a row per reader and CV (5), and
 *    WORK_PARSE_PHONE_READERS the readers (a JSON array of `{label, model,
 *    imageMaxTokens?, schema?}`; `DEFAULT_READERS` below when absent).
 *
 * 2. Score: the phone's `results.json`, fetched with `devicectl device copy from`:
 *
 *      WORK_PARSE_PHONE=<results.json> WORK_PARSE_PHONE_LABEL=iphone16 yarn vitest run test/workParsePhone.eval.test.ts
 *
 *    Writes `test/work-eval/parse-<date>-<label>.md` (never over an earlier
 *    one). The results, every answer included, stay where they are, outside
 *    the repository, like the Mac's runs data. Steps: the workspace
 *    `docs/runbooks/device-builds.md`, Reader benchmark on the iPhone.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parsePhoneReaders, parsePhoneResults, phonePlan, phoneReport, scorePhoneRuns, type PhoneReader } from './work-eval/phoneBench.js';
import type { ParseTruth } from './work-eval/parseScore.js';

const PLAN_DIR = process.env.WORK_PARSE_PHONE_PLAN;
const RESULTS = process.env.WORK_PARSE_PHONE;

/** The readers of decision 0068's iPhone check (2026-10-28): LFM3-VL on the full page and at 1,024 image tokens, Gemma 4 E2B with the schema in the prompt. */
const DEFAULT_READERS: PhoneReader[] = [
  { label: 'LFM3-VL-2B QAD-Q4_0, full page', model: 'lfm3-vl-2b', imageMaxTokens: null, schema: 'grammar' },
  { label: 'LFM3-VL-2B QAD-Q4_0, 1,024 image tokens', model: 'lfm3-vl-2b', imageMaxTokens: 1024, schema: 'grammar' },
  { label: 'Gemma 4 E2B Q4_0, schema in the prompt', model: 'gemma-4-e2b', imageMaxTokens: null, schema: 'prompt' },
];

interface FixtureCv {
  id: string;
  locale: string;
  layout: string;
  image: string;
  truth: ParseTruth;
}

const FIXTURES = join(__dirname, 'fixtures/work/parse');
const cvs = () => (JSON.parse(readFileSync(join(FIXTURES, 'cvs.json'), 'utf8')) as { cvs: FixtureCv[] }).cvs;

/** The first of `<stem>.md`, `<stem>-2.md`, … that does not exist. */
function freePath(dir: string, stem: string): string {
  for (let i = 1; ; i++) {
    const p = join(dir, `${stem}${i === 1 ? '' : `-${i}`}.md`);
    if (!existsSync(p)) return p;
  }
}

describe.skipIf(!PLAN_DIR)('Whole-CV parse on a phone: the plan', () => {
  it('writes the plan and the CV pages for the app', () => {
    const readers = process.env.WORK_PARSE_PHONE_READERS ? parsePhoneReaders(process.env.WORK_PARSE_PHONE_READERS) : DEFAULT_READERS;
    const runs = Number(process.env.WORK_PARSE_PHONE_RUNS ?? 5);
    const all = cvs();
    const plan = phonePlan(all, readers, runs, `cofferdam-api test/workParsePhone.eval.test.ts, ${new Date().toISOString()}`);
    mkdirSync(PLAN_DIR!, { recursive: true });
    writeFileSync(join(PLAN_DIR!, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
    for (const cv of all) copyFileSync(join(FIXTURES, cv.image), join(PLAN_DIR!, cv.image));
    console.log(`plan: ${join(PLAN_DIR!, 'plan.json')} (${readers.length} readers x ${all.length} CVs x ${runs} runs)`);
    expect(plan.cvs).toHaveLength(all.length);
  });
});

describe.skipIf(!RESULTS)('Whole-CV parse on a phone: the score', () => {
  it('scores the phone\'s answers and writes the report', () => {
    const results = parsePhoneResults(JSON.parse(readFileSync(RESULTS!, 'utf8')));
    const all = cvs();
    const scored = scorePhoneRuns(results, new Map(all.map((cv) => [cv.id, cv.truth])));
    const date = (results.startedAt || new Date().toISOString()).slice(0, 10);
    const label = (process.env.WORK_PARSE_PHONE_LABEL ?? 'phone').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
    const title = process.env.WORK_PARSE_PHONE_TITLE ?? results.device.model ?? label;
    const path = freePath(join(__dirname, 'work-eval'), `parse-${date}-${label}`);
    writeFileSync(path, phoneReport(results, scored, all, { date, title }));
    for (const r of scored) {
      console.log(`${r.score ? 'ok  ' : 'FAIL'} ${r.reader} ${r.cv} #${r.run} ${r.msToJson} ms ${Math.round((r.score?.accuracy ?? 0) * 100)}%${r.failure ? ` (${r.failure})` : ''}`);
    }
    console.log(`report: ${path}`);
    expect(scored.length).toBe(results.runs.length);
  });
});
