// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The chat evaluation of decision 0037 (opt-in: CHAT_EVAL=1). Every prompt in
 * `test/chat-eval/prompts.json` runs through the real turn, `runChat` over the
 * inference seam, with Workers AI reached over its REST API
 * (`test/chat-eval/restAi.ts`), and is scored for route, action, fields,
 * language, latency and cost. Writes `test/chat-eval/report-<date>.md` and the
 * raw results beside it, and prints a summary. It measures; it does not fail
 * on accuracy.
 *
 *   cd cofferdam-api && CHAT_EVAL=1 direnv exec .. yarn vitest run test/chat.eval.test.ts
 *
 * Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI read and
 * run) in the environment. CHAT_ROUTER_MODEL, CHAT_ACTION_MODEL,
 * CHAT_ANSWER_MODEL and CHAT_LONG_MODEL try other models, CHAT_EARLY_ANSWER=off
 * starts answers after the router, CHAT_EVAL_ONLY=<regex> runs the matching
 * ids, CHAT_EVAL_GAP_MS spaces the turns (500 by default).
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseFloor } from '../src/routes/chat.js';
import { parseChatRequest, runChat, type ChatEvent, type ChatTier } from '../src/services/chat/run.js';
import { createInference, type InferenceEnv, type InferenceOp } from '../src/services/inference/index.js';
import prompts from './chat-eval/prompts.json';
import { createRestAi, type RecordedCall } from './chat-eval/restAi.js';
import { reportMarkdown, scoreTurn, summarize, summaryText, validatePrompts, type EvalPrompt, type TurnResult } from './chat-eval/score.js';

const LIVE = process.env.CHAT_EVAL === '1';
/** The action model's "today", so month expectations hold on any day. */
const TODAY = Date.parse('2026-10-20T12:00:00Z');
const ACCOUNT = '0x' + '00'.repeat(20);
const OPS: InferenceOp[] = ['chat-router', 'chat-action', 'chat-answer', 'chat-long'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function events(stream: ReadableStream<Uint8Array>): Promise<ChatEvent[]> {
  const text = await new Response(stream).text();
  return text
    .split('\n\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)) as ChatEvent);
}

describe.skipIf(!LIVE)('chat evaluation (live, Workers AI)', () => {
  it('runs every prompt through the real turn and writes the report', async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !token) throw new Error('CHAT_EVAL needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment');
    expect(validatePrompts(prompts)).toEqual([]);

    const env: InferenceEnv = {
      CHAT_ROUTER_MODEL: process.env.CHAT_ROUTER_MODEL,
      CHAT_ACTION_MODEL: process.env.CHAT_ACTION_MODEL,
      CHAT_ANSWER_MODEL: process.env.CHAT_ANSWER_MODEL,
      CHAT_LONG_MODEL: process.env.CHAT_LONG_MODEL,
      CHAT_REASONING_MODEL: process.env.CHAT_REASONING_MODEL,
    };
    const early = process.env.CHAT_EARLY_ANSWER !== 'off';
    // CHAT_EVAL_TIER=thinking runs every prompt in the Thinking tier (decision 0047); CHAT_THINKING_HIGH_FLOOR as on the plane.
    const tier: ChatTier = process.env.CHAT_EVAL_TIER === 'thinking' ? 'thinking' : 'ordinary';
    const highFloor = parseFloor(process.env.CHAT_THINKING_HIGH_FLOOR);
    const gap = Number(process.env.CHAT_EVAL_GAP_MS ?? 500);
    const only = process.env.CHAT_EVAL_ONLY ? new RegExp(process.env.CHAT_EVAL_ONLY) : null;
    const selected = (prompts as EvalPrompt[]).filter((p) => !only || only.test(p.id));

    const results: TurnResult[] = [];
    const models: Record<string, string> = {};
    const started = Date.now();
    for (const prompt of selected) {
      // One adapter per turn, so a cancelled early answer that settles late lands on its own turn.
      const calls: RecordedCall[] = [];
      const inference = createInference(env, { ai: createRestAi({ accountId, token, onCall: (c) => calls.push(c) }) })!;
      for (const op of OPS) models[op] = await inference.model(op);
      const { messages } = parseChatRequest({ account: ACCOUNT, messages: [...(prompt.history ?? []), { role: 'user', text: prompt.text }] });
      const log: Record<string, unknown>[] = [];
      const t0 = Date.now();
      const evs = await events(runChat({ inference, messages, early, tier, highFloor, now: () => TODAY, log: (l) => log.push(l) }));
      const totalMs = Date.now() - t0;
      await sleep(Math.max(gap, 200));
      const result = scoreTurn(prompt, { events: evs as never, log, calls, totalMs, routerModel: models['chat-router']! });
      results.push(result);
      console.log(`${result.softOk ? 'ok  ' : 'MISS'} ${prompt.id}: ${result.route ?? 'none'}${result.action ? ` ${result.action}` : ''}${result.error ? ` (${result.error})` : ''}`);
    }

    const summary = summarize(results);
    console.log(summaryText(summary));
    const date = new Date().toISOString().slice(0, 10);
    const dir = join(__dirname, 'chat-eval');
    const meta = { date, models, early, durationMs: Date.now() - started };
    writeFileSync(join(dir, `report-${date}.md`), reportMarkdown(results, meta));
    writeFileSync(join(dir, `report-${date}.json`), JSON.stringify({ meta, summary, results }, null, 2) + '\n');
    expect(results).toHaveLength(selected.length);
  }, 1_800_000);
});
