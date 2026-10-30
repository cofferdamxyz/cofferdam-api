// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The whole-CV parse benchmark inside the app on a phone (opt-in; workspace
 * decision 0068): the readers only the app reaches, Gemma 4 E2B through
 * LiteRT-LM on the iPhone's Metal and the Pixel's TPU, measured with the truth
 * and scorer of `test/workParse.eval.test.ts`.
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
 *    imageMaxTokens?, schema?, input?, litert?}`; when absent, `DEFAULT_READERS`
 *    below, the iPhone's or with WORK_PARSE_PHONE_DEVICE=android the Pixel's;
 *    the app refuses any reader but LiteRT-LM's since 2026-10-30). A reader with `input: "text"` reads the CV's OCR lines through
 *    the parse's text path, which the plan then carries (`text`); one with
 *    `litert: {file, backend, mtp}` and `schema: "regex"` reads them through
 *    LiteRT-LM with the schema as a regex, as the Mac's in-process reader does,
 *    its `.litertlm` file copied beside the plan.
 *
 * 2. Score: the phone's `results.json`, fetched with `devicectl device copy from`:
 *
 *      WORK_PARSE_PHONE=<results.json> WORK_PARSE_PHONE_LABEL=iphone16 yarn vitest run test/workParsePhone.eval.test.ts
 *
 *    WORK_PARSE_PHONE_NOTE adds a paragraph under the method (what the run's
 *    results cannot say, such as a runtime built from unreleased sources).
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

/**
 * The phones' readers since llama.rn left the app (decision 0068, 2026-10-30): Gemma 4 E2B through LiteRT-LM reading the
 * CV's text with the schema as a regex, as each phone read twenty real resumes at the founder's bar. The iPhone: Metal at
 * 32-bit activations with multi-token prediction. The Pixel (`WORK_PARSE_PHONE_DEVICE=android`): the Tensor G5's TPU file
 * with its fixed 4,096-token context, then the CPU with MTP for what the TPU cuts or leaves out of shape. Each `.litertlm`
 * file comes over the cable beside the plan, or from the app's downloaded document reader, which holds the same files.
 */
const DEFAULT_READERS: Record<'ios' | 'android', PhoneReader[]> = {
  ios: [
    {
      label: 'Gemma 4 E2B, LiteRT-LM, Metal, 32-bit, MTP',
      model: 'gemma-4-e2b',
      imageMaxTokens: null,
      schema: 'regex',
      input: 'text',
      litert: { file: 'gemma-4-E2B-it.litertlm', backend: 'gpu', mtp: true, activation: 'f32' },
    },
  ],
  android: [
    {
      label: 'Gemma 4 E2B, LiteRT-LM, TPU, then CPU, 32-bit, MTP',
      model: 'gemma-4-e2b',
      imageMaxTokens: null,
      schema: 'regex',
      input: 'text',
      litert: {
        file: 'gemma-4-E2B-it_Google_Tensor_G5.litertlm',
        backend: 'npu',
        mtp: true,
        activation: 'f32',
        contextLimit: 4096,
        fallback: { file: 'gemma-4-E2B-it.litertlm', backend: 'cpu', mtp: true, activation: 'f32' },
      },
    },
  ],
};

interface FixtureCv {
  id: string;
  locale: string;
  layout: string;
  image: string;
  /** The CV's OCR lines, read by text readers through the parse's text path. */
  ocr: string[];
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
    const device = process.env.WORK_PARSE_PHONE_DEVICE === 'android' ? 'android' : 'ios';
    const readers = process.env.WORK_PARSE_PHONE_READERS ? parsePhoneReaders(process.env.WORK_PARSE_PHONE_READERS) : DEFAULT_READERS[device];
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
    writeFileSync(path, phoneReport(results, scored, all, { date, title, note: process.env.WORK_PARSE_PHONE_NOTE }));
    for (const r of scored) {
      console.log(`${r.score ? 'ok  ' : 'FAIL'} ${r.reader} ${r.cv} #${r.run} ${r.msToJson} ms ${Math.round((r.score?.accuracy ?? 0) * 100)}%${r.failure ? ` (${r.failure})` : ''}`);
    }
    console.log(`report: ${path}`);
    expect(scored.length).toBe(results.runs.length);
  });
});
