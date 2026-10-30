// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The router's hiring check, measured on its own (opt-in: CHAT_ROUTER_EVAL=1),
 * the founder's "layer 0" of 2026-10-30. Every prompt of
 * `test/chat-eval/prompts.json` and `test/chat-eval/hire-prompts.json` goes to
 * the router twice over the Workers AI REST API, as production asks today and
 * with the hiring check (`HIRE_QUESTION`, or CHAT_HIRE_QUESTION's wording); no
 * answer model runs. Reported:
 * - the check's score on every prompt;
 * - its precision and recall for `post_job` at each floor;
 * - every prompt whose decision the added question changed, apart from
 *   `post_job` itself.
 *
 * Writes `test/chat-eval/router-hire-<date>[-<label>].md` and the answers as
 * JSON beside it.
 *
 *   cd cofferdam-api && CHAT_ROUTER_EVAL=1 direnv exec .. yarn vitest run test/chatRouter.eval.test.ts
 *
 * Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. CHAT_HIRE_FLOOR sets
 * the floor the decisions use (0.5 by default), CHAT_ROUTER_MODEL tries
 * another router model, CHAT_EVAL_ONLY=<regex> runs the matching ids, and
 * CHAT_EVAL_LABEL names the report.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseFloor } from '../src/routes/chat.js';
import { CHAT_ACTIONS, decideRoute, HIRE_QUESTION, ROUTER_THRESHOLDS, routerQuestions, type RouteDecision } from '../src/services/chat/router.js';
import { parseChatRequest, routerState } from '../src/services/chat/run.js';
import { createInference } from '../src/services/inference/index.js';
import hirePrompts from './chat-eval/hire-prompts.json';
import prompts from './chat-eval/prompts.json';
import { createRestAi } from './chat-eval/restAi.js';
import { validatePrompts, type EvalPrompt } from './chat-eval/score.js';

const LIVE = process.env.CHAT_ROUTER_EVAL === '1';
const ACCOUNT = '0x' + '00'.repeat(20);
const FLOORS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
const HIRING = CHAT_ACTIONS.find((a) => a.hiring)!.id;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (d: RouteDecision) => `${d.route}${d.action ? ` ${d.action}` : ''}`;

interface Row {
  prompt: EvalPrompt;
  set: 'chat' | 'hire';
  hire: number | null;
  today: RouteDecision;
  withCheck: RouteDecision;
  /** The decision with the hiring question asked but its floor off: what the added question does to the other answers. */
  asked: RouteDecision;
  /** Clef's answers to both calls, so another rule can be replayed on a run without asking again. */
  answers?: { plain: unknown; checked: unknown };
  error?: string;
}

describe.skipIf(!LIVE)('the router’s hiring check (live, Workers AI)', () => {
  it('asks the router with and without the hiring check and writes the report', async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !token) throw new Error('CHAT_ROUTER_EVAL needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment');
    const sets = [
      { set: 'chat' as const, list: prompts as EvalPrompt[] },
      { set: 'hire' as const, list: hirePrompts as EvalPrompt[] },
    ];
    for (const s of sets) expect(validatePrompts(s.list)).toEqual([]);
    const floor = parseFloor(process.env.CHAT_HIRE_FLOOR) ?? 0.5;
    const wording = process.env.CHAT_HIRE_QUESTION?.trim() || HIRE_QUESTION;
    const only = process.env.CHAT_EVAL_ONLY ? new RegExp(process.env.CHAT_EVAL_ONLY) : null;
    const inference = createInference({ CHAT_ROUTER_MODEL: process.env.CHAT_ROUTER_MODEL }, { ai: createRestAi({ accountId, token }) })!;
    const model = await inference.model('chat-router');
    const clef = model.split('/').pop() ?? model;

    const ask = async (state: string, hire: boolean) => {
      for (let attempt = 1; ; attempt++) {
        try {
          const out = (await inference.run('chat-router', { model: clef, state, questions: routerQuestions(CHAT_ACTIONS, { hire: hire ? wording : false }) })) as { answers?: unknown };
          return out?.answers;
        } catch (err) {
          if (attempt >= 3) throw err;
          await sleep(1_000 * attempt);
        }
      }
    };

    const rows: Row[] = [];
    for (const { set, list } of sets) {
      for (const prompt of list) {
        if (only && !only.test(prompt.id)) continue;
        const { messages } = parseChatRequest({ account: ACCOUNT, messages: [...(prompt.history ?? []), { role: 'user', text: prompt.text }] });
        const state = routerState(messages);
        try {
          const [plain, checked] = await Promise.all([ask(state, false), ask(state, true)]);
          const hire = Number((checked as Record<string, { noul?: number }> | undefined)?.hire?.noul);
          rows.push({
            prompt,
            set,
            hire: Number.isFinite(hire) ? hire : null,
            today: decideRoute(plain),
            withCheck: decideRoute(checked, ROUTER_THRESHOLDS, CHAT_ACTIONS, { hireFloor: floor }),
            asked: decideRoute(checked),
            answers: { plain, checked },
          });
        } catch (err) {
          const failed = decideRoute(undefined);
          rows.push({ prompt, set, hire: null, today: failed, withCheck: failed, asked: failed, error: err instanceof Error ? err.message : String(err) });
        }
        const r = rows.at(-1)!;
        const expected = r.prompt.expect.action === HIRING;
        const got = r.withCheck.action === HIRING;
        console.log(`${expected === got ? 'ok  ' : 'MISS'} ${prompt.id}: hire ${r.hire?.toFixed(2) ?? '—'} → ${short(r.withCheck)}${r.error ? ` (${r.error})` : ''}`);
        await sleep(150);
      }
    }

    const scored = rows.filter((r) => !r.error && r.hire != null);
    const positives = scored.filter((r) => r.prompt.expect.action === HIRING);
    const negatives = scored.filter((r) => r.prompt.expect.action !== HIRING);
    const sweep = FLOORS.map((f) => {
      const tp = positives.filter((r) => r.hire! >= f).length;
      const fp = negatives.filter((r) => r.hire! >= f);
      return { f, tp, fn: positives.length - tp, fp };
    });
    // Apart from the hiring check's own route, does asking it move any other decision?
    const moved = scored.filter((r) => short(r.asked) !== short(r.today));
    const expectedOk = (d: RouteDecision, p: EvalPrompt) => d.route === p.expect.route && (d.action ?? null) === (p.expect.action ?? null);
    const agree = (set: Row['set'], pick: (r: Row) => RouteDecision) => scored.filter((r) => r.set === set && expectedOk(pick(r), r.prompt)).length;
    const total = (set: Row['set']) => scored.filter((r) => r.set === set).length;
    const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
    const clip = (s: string) => (s.length > 90 ? `${s.slice(0, 87)}…` : s);

    const date = new Date().toISOString().slice(0, 10);
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const name = `router-hire-${date}${process.env.CHAT_EVAL_LABEL ? `-${slug(process.env.CHAT_EVAL_LABEL)}` : ''}`;
    const md = [
      `# The router's hiring check, ${date}`,
      '',
      `${rows.length} prompts (${total('chat')} of \`test/chat-eval/prompts.json\`, ${total('hire')} of \`test/chat-eval/hire-prompts.json\`), each asked of \`${model}\` twice over the Workers AI REST API from the Mac: with production's questions, and with the hiring check added. No answer model ran. The check's wording: "${wording}" Decisions use the floor ${floor}.${rows.length - scored.length ? ` ${rows.length - scored.length} prompts failed and are left out.` : ''}`,
      '',
      `## The check at each floor`,
      '',
      `${positives.length} prompts ask for a worker (\`post_job\` expected), ${negatives.length} do not.`,
      '',
      '| Floor | Hiring requests caught | Missed | Other messages sent to post_job |',
      '|---|---|---|---|',
      ...sweep.map((s) => `| ${s.f} | ${s.tp} of ${positives.length} | ${s.fn} | ${s.fp.length}${s.fp.length ? ` (${s.fp.map((r) => r.prompt.id).join(', ')})` : ''} |`),
      '',
      `## What the added question changes`,
      '',
      `Decisions that match the prompt's expectation: the chat set ${agree('chat', (r) => r.today)} of ${total('chat')} without the check and ${agree('chat', (r) => r.withCheck)} with it; the hiring set ${agree('hire', (r) => r.today)} of ${total('hire')} without it and ${agree('hire', (r) => r.withCheck)} with it.`,
      '',
      moved.length
        ? `${moved.length} prompts decided otherwise once the question was asked, before its own floor:\n\n| Prompt | Without | With the question asked |\n|---|---|---|\n${moved.map((r) => `| ${r.prompt.id} | ${short(r.today)} | ${short(r.asked)} |`).join('\n')}`
        : 'No other decision moved when the question was asked.',
      '',
      `## Every prompt`,
      '',
      '| Prompt | Text | Expected | Hire | Today | With the check |',
      '|---|---|---|---|---|---|',
      ...rows.map(
        (r) =>
          `| ${r.prompt.id} | ${cell(clip(r.prompt.text))} | ${r.prompt.expect.route}${r.prompt.expect.action ? ` ${r.prompt.expect.action}` : ''} | ${r.hire == null ? '—' : r.hire.toFixed(2)} | ${r.error ? 'failed' : short(r.today)} | ${r.error ? 'failed' : short(r.withCheck)} |`,
      ),
      '',
    ].join('\n');
    const dir = join(__dirname, 'chat-eval');
    writeFileSync(join(dir, `${name}.md`), md);
    writeFileSync(
      join(dir, `${name}.json`),
      JSON.stringify({ date, model, wording, floor, rows: rows.map((r) => ({ id: r.prompt.id, set: r.set, hire: r.hire, today: r.today, withCheck: r.withCheck, asked: r.asked, answers: r.answers ?? null, error: r.error ?? null })) }, null, 2) + '\n',
    );
    console.log(sweep.map((s) => `floor ${s.f}: caught ${s.tp}/${positives.length}, false ${s.fp.length}`).join('\n'));
    expect(rows.length).toBeGreaterThan(0);
  }, 1_800_000);
});
