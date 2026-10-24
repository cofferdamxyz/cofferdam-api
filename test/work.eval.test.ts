// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Work extraction evaluation (opt-in: WORK_EVAL=1), the comparison the
 * workspace TODO asks for before a Clairic pin (`docs/product/engine.md`,
 * Clairic): every synthetic CV block and hirer sentence in
 * `test/fixtures/work/` runs once on each model through the inference seam,
 * without the fallback, with Workers AI reached over its REST API
 * (`test/chat-eval/restAi.ts`), and is scored against the gold fields
 * (`test/work-eval/score.ts`). Writes `test/work-eval/report-<date>.md` and
 * the raw results beside it. It measures; it does not fail on accuracy.
 *
 *   cd cofferdam-api && WORK_EVAL=1 direnv exec .. yarn vitest run test/work.eval.test.ts
 *
 * Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI run) in the
 * environment. WORK_EVAL_MODELS (comma-separated ids) picks the models,
 * WORK_EVAL_ONLY=<regex> the fixture ids, WORK_EVAL_GAP_MS the pause between
 * calls (300 by default). Only synthetic, de-identified fixtures are sent.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInference, type InferenceEnv } from '../src/services/inference/index.js';
import { checkBlock } from '../src/services/work/blocks.js';
import { attemptBlock, classifyDocument, isCvKind } from '../src/services/work/executor.js';
import { attemptIntent } from '../src/services/work/intent.js';
import { callCostMicroUsd } from '../src/services/work/meter.js';
import { createRestAi } from './chat-eval/restAi.js';
import { FIXTURE_CVS, HIRER_PROMPTS, fixtureBlocks } from './fixtures/work/index.js';
import { reportMarkdown, scoreBlock, scoreIntent, type BlockRun, type ClassifyRun, type IntentRun } from './work-eval/score.js';

const LIVE = process.env.WORK_EVAL === '1';
const DEFAULT_MODELS = ['@cf/cloudflare/clairic', '@cf/meta/llama-3.3-70b-instruct-fp8-fast'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!LIVE)('Work extraction evaluation (live, Workers AI)', () => {
  it('runs every fixture block and hirer sentence on each model and writes the report', async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !token) throw new Error('WORK_EVAL needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment');
    const models = (process.env.WORK_EVAL_MODELS ?? DEFAULT_MODELS.join(','))
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    const only = process.env.WORK_EVAL_ONLY ? new RegExp(process.env.WORK_EVAL_ONLY) : null;
    const gap = Number(process.env.WORK_EVAL_GAP_MS ?? 300);
    const ai = createRestAi({ accountId, token });
    const started = Date.now();

    const blocks = fixtureBlocks().filter(({ block }) => isCvKind(block.kind) && (!only || only.test(block.id)));
    const intents = HIRER_PROMPTS.filter((p) => !p.expected.refuse && (!only || only.test(p.id)));
    const blockRuns: BlockRun[] = [];
    const intentRuns: IntentRun[] = [];

    for (const model of models) {
      const env: InferenceEnv = { WORK_EXTRACT_MODEL: model, WORK_INTENT_MODEL: model };
      const inference = createInference(env, { ai })!;
      for (const { cv, block } of blocks) {
        const checked = checkBlock(block);
        if (!checked.ok) throw new Error(`${block.id} refused: ${checked.reason}`);
        const a = await attemptBlock(inference, 'work-extract', block.kind as never, checked.block);
        const scores = scoreBlock(block.kind, block.expected, a.extraction?.fragment ?? null, a.extraction?.fields ?? null);
        blockRuns.push({
          model,
          id: block.id,
          cv: cv.id,
          locale: cv.locale,
          kind: block.kind,
          ok: a.extraction != null,
          failure: a.failure,
          ms: a.call.ms,
          usage: a.call.usage,
          costMicroUsd: callCostMicroUsd(a.call),
          violations: a.extraction?.violations ?? [],
          ...scores,
        });
        console.log(`${a.extraction ? 'ok  ' : 'FAIL'} ${model.split('/').pop()} ${block.id} ${a.call.ms} ms${a.failure ? ` (${a.failure})` : ''}`);
        await sleep(gap);
      }
      for (const p of intents) {
        const a = await attemptIntent(inference, 'work-intent', p.text);
        intentRuns.push({
          model,
          id: p.id,
          locale: p.locale,
          ok: a.intent != null,
          failure: a.failure,
          ms: a.call.ms,
          usage: a.call.usage,
          costMicroUsd: callCostMicroUsd(a.call),
          violations: a.violations,
          scalars: scoreIntent(p.expected as unknown as Record<string, unknown>, a.intent, a.fields),
        });
        console.log(`${a.intent ? 'ok  ' : 'FAIL'} ${model.split('/').pop()} ${p.id} ${a.call.ms} ms`);
        await sleep(gap);
      }
    }

    const classifier = createInference({}, { ai })!;
    const classifyRuns: ClassifyRun[] = [];
    for (const cv of FIXTURE_CVS.filter((c) => !only || c.blocks.some((b) => only.test(b.id)))) {
      const first = cv.blocks.slice(0, 2).map((b) => {
        const r = checkBlock(b);
        if (!r.ok) throw new Error(`${b.id} refused`);
        return r.block;
      });
      const t0 = Date.now();
      const out = await classifyDocument(classifier, first);
      classifyRuns.push({ cv: cv.id, locale: cv.locale, type: out.ok ? out.type : null, confidence: out.ok ? out.confidence : 0, ms: Date.now() - t0 });
      await sleep(gap);
    }

    const date = new Date().toISOString().slice(0, 10);
    const meta = {
      date,
      models,
      classifyModel: await classifier.model('work-classify'),
      cvs: new Set(blocks.map((b) => b.cv.id)).size,
      blocks: blocks.length,
      intents: intents.length,
      durationMs: Date.now() - started,
    };
    const dir = join(__dirname, 'work-eval');
    writeFileSync(join(dir, `report-${date}.md`), reportMarkdown(meta, blockRuns, intentRuns, classifyRuns));
    writeFileSync(join(dir, `report-${date}.json`), JSON.stringify({ meta, blockRuns, intentRuns, classifyRuns }, null, 2) + '\n');
    expect(blockRuns).toHaveLength(blocks.length * models.length);
  }, 1_800_000);
});
