// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Clef classification patterns, calibrated (opt-in: WORK_EVAL=1): each
 * Clef classifier the Work pipeline runs, with the real `clef-flash`, on the
 * synthetic fixtures, recording Clef's probabilities and sweeping each floor
 * so a floor moves on evidence:
 *
 *  - the document type: the nine CVs (their first two blocks) and the seven
 *    other Vault documents of `test/fixtures/work/documents.json`;
 *  - the request checks: all 23 hirer sentences, refusals and scope;
 *  - the needs: the 17 that are not refusals, from their gold task span,
 *    against the synthetic registry seed.
 *
 * The τ-band adjudication is measured by `test/workRegistry.eval.test.ts`.
 * Writes `test/work-eval/clef-<date>.md`.
 *
 *   cd cofferdam-api && WORK_EVAL=1 direnv exec .. yarn vitest run test/workClef.eval.test.ts
 *
 * WORK_CLEF_LOCAL='{"label":"d1-2B Q4_K_M (llama.cpp)","url":"http://127.0.0.1:8090"}'
 * puts a local decision model in Clef's place (`test/work-eval/localClef.ts`;
 * workspace decision 0068, proposed amendment); the embeddings stay on Workers
 * AI, and the report is `clef-<date>-<label>.md`.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInference } from '../src/services/inference/index.js';
import { checkBlock, type DeidentifiedBlock } from '../src/services/work/blocks.js';
import { clefInput, DOCUMENT_TYPE_KEYS, needQuestions, readNoul, requestQuestions, requestState, type NeedCandidate } from '../src/services/work/clef.js';
import { classifyDocument } from '../src/services/work/executor.js';
import { candidatesFor, embedTexts } from '../src/services/work/registry.js';
import { createRestAi } from './chat-eval/restAi.js';
import documents from './fixtures/work/documents.json';
import { FIXTURE_CVS, HIRER_PROMPTS } from './fixtures/work/index.js';
import { localClefPending, localClefSlug, parseLocalClef, withLocalClef } from './work-eval/localClef.js';
import { seededRegistry } from './work-eval/seed.js';

const LIVE = process.env.WORK_EVAL === '1';
const FLOORS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

/** The occupation each hirer sentence must need. */
const OCCUPATION: Record<string, string> = {
  sink: 'pos:plumber',
  'ev-charger': 'pos:electrician',
  rigger: 'pos:rigger',
  translation: 'pos:translator',
  gardener: 'pos:gardener',
  reais: 'pos:plumber',
  pesos: 'pos:plumber',
};

const checked = (b: { kind: string; lang: string; text: string }): DeidentifiedBlock => {
  const r = checkBlock(b);
  if (!r.ok) throw new Error(`fixture refused: ${r.reason}`);
  return r.block;
};

describe.skipIf(!LIVE)('Clef classification patterns (live, Workers AI)', () => {
  it('runs every Work classifier on the fixtures and writes the calibration report', async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !token) throw new Error('WORK_EVAL needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    const localClef = parseLocalClef(process.env.WORK_CLEF_LOCAL, 'WORK_CLEF_LOCAL');
    const rest = createRestAi({ accountId, token });
    const inference = createInference({}, { ai: localClef ? withLocalClef(rest, localClef) : rest })!;
    const model = await inference.model('work-classify');
    const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 1000) / 10}%` : '—');

    // 1. The document type.
    const docs = [
      ...FIXTURE_CVS.map((cv) => ({ id: cv.id, type: 'cv', blocks: cv.blocks.slice(0, 2).map(checked) })),
      ...(documents.documents as { id: string; type: string; blocks: { kind: string; lang: string; text: string }[] }[]).map((d) => ({ id: d.id, type: d.type, blocks: d.blocks.map(checked) })),
    ];
    const typed: { id: string; gold: string; pick: string | null; p: number; probabilities: Record<string, number> }[] = [];
    for (const d of docs) {
      const out = await classifyDocument(inference, d.blocks);
      if (!out.ok) throw new Error(`${d.id}: classification failed`);
      const best = DOCUMENT_TYPE_KEYS.reduce((a, k) => ((out.probabilities[k] ?? 0) > (out.probabilities[a] ?? 0) ? k : a), DOCUMENT_TYPE_KEYS[0]!);
      typed.push({ id: d.id, gold: d.type, pick: best, p: out.probabilities[best] ?? 0, probabilities: out.probabilities as Record<string, number> });
    }
    const docSweep = FLOORS.map((f) => {
      const right = typed.filter((t) => t.p >= f && t.pick === t.gold).length;
      const asked = typed.filter((t) => t.p < f).length;
      return `| ${f} | ${right} | ${asked} | ${typed.length - right - asked} |`;
    });

    // 2. The request checks and the scope.
    const requests: { id: string; refuse: string | null; harmful: number; injection: number; scope: string; scopeP: number; goldScope: string }[] = [];
    for (const p of HIRER_PROMPTS) {
      const answer = await inference.run('work-classify', clefInput(model, requestState(p.text, p.locale.slice(0, 2)), requestQuestions()));
      const a = answer as { answers?: { scope?: { probabilities?: Record<string, number> } } };
      const remote = a.answers?.scope?.probabilities?.remote ?? 0;
      requests.push({
        id: p.id,
        refuse: p.expected.refuse,
        harmful: readNoul(answer, 'harmful') ?? -1,
        injection: readNoul(answer, 'injection') ?? -1,
        scope: remote >= 0.5 ? 'remote' : 'onsite',
        scopeP: remote >= 0.5 ? remote : 1 - remote,
        goldScope: p.expected.scope,
      });
    }
    const refuseSweep = FLOORS.slice(0, 5).map((f) => {
      const caught = requests.filter((r) => r.refuse && Math.max(r.harmful, r.injection) > f).length;
      const wrong = requests.filter((r) => !r.refuse && Math.max(r.harmful, r.injection) > f).length;
      return `| ${f} | ${caught} of ${requests.filter((r) => r.refuse).length} | ${wrong} of ${requests.filter((r) => !r.refuse).length} |`;
    });
    const scopeRight = requests.filter((r) => r.scope === r.goldScope).length;

    // 3. The needs, from the gold task span against the seed.
    const { registry } = await seededRegistry(inference);
    const needs: { id: string; expected: string; probabilities: { token: string; p: number }[] }[] = [];
    for (const p of HIRER_PROMPTS.filter((x) => !x.expected.refuse)) {
      const task = p.expected.task ?? p.text;
      const e = await embedTexts(inference, [task], { role: 'query' });
      if (!e.ok) throw new Error('embedding failed');
      const near: NeedCandidate[] = [];
      for (const kind of ['pos', 'skill'] as const) for (const c of (await candidatesFor(registry, kind, e.vectors[0]!)).slice(0, kind === 'pos' ? 4 : 8)) near.push({ token: c.token, label: c.labelEn, kind });
      const answer = await inference.run('work-classify', clefInput(model, requestState(p.text, p.locale.slice(0, 2)), needQuestions(near)));
      needs.push({ id: p.id, expected: OCCUPATION[p.id.replace(/-(en|pt|es)$/, '')]!, probabilities: near.map((c, i) => ({ token: c.token, p: readNoul(answer, `need_${i}`) ?? 0 })) });
    }
    const needSweep = FLOORS.map((f) => {
      const hit = needs.filter((n) => n.probabilities.some((x) => x.token === n.expected && x.p >= f)).length;
      const foreign = needs.reduce((s, n) => s + n.probabilities.filter((x) => x.token.startsWith('pos:') && x.token !== n.expected && x.p >= f).length, 0);
      return `| ${f} | ${hit} of ${needs.length} | ${foreign} |`;
    });

    const date = new Date().toISOString().slice(0, 10);
    const md = [
      `# Clef classification patterns, ${date}`,
      '',
      `${localClef ? `${localClef.label} through llama.cpp's \`/v1/systemone\` on the Mac, in \`${model}\`'s place (the embeddings over the Workers AI REST API)` : `\`${model}\` over the Workers AI REST API from the Mac`}, on the synthetic fixtures of \`test/fixtures/work/\`. Each floor row reads every recorded answer again at that floor; the shipped floors are 0.5.`,
      '',
      '## Document type',
      '',
      `${docs.length} documents: the nine CVs by their first two blocks and seven others as \`body\` blocks.`,
      '',
      '| Floor | Right | Asked (below the floor) | Wrong |',
      '|---|---|---|---|',
      ...docSweep,
      '',
      '| Document | Gold | Clef | p |',
      '|---|---|---|---|',
      ...typed.map((t) => `| ${t.id} | ${t.gold} | ${t.pick === t.gold ? t.pick : `**${t.pick}**`} | ${t.p.toFixed(2)} |`),
      '',
      '## Request checks and scope',
      '',
      `${requests.length} hirer sentences, ${requests.filter((r) => r.refuse).length} of them to refuse. Scope right: ${pct(scopeRight, requests.length)} (${scopeRight} of ${requests.length}).`,
      '',
      '| Floor | Refusals caught | Requests refused wrongly |',
      '|---|---|---|',
      ...refuseSweep,
      '',
      '| Sentence | Should refuse | harmful | injection | Scope (p) | Gold scope |',
      '|---|---|---|---|---|---|',
      ...requests.map((r) => `| ${r.id} | ${r.refuse ?? '—'} | ${r.harmful.toFixed(2)} | ${r.injection.toFixed(2)} | ${r.scope === r.goldScope ? r.scope : `**${r.scope}**`} (${r.scopeP.toFixed(2)}) | ${r.goldScope} |`),
      '',
      '## Needs',
      '',
      `${needs.length} sentences: the occupation each must need, against the registry's four nearest occupations and eight nearest skills to its task.`,
      '',
      '| Floor | Occupation needed | Other occupations needed |',
      '|---|---|---|',
      ...needSweep,
      '',
      '| Sentence | Expected | Clef p for each candidate |',
      '|---|---|---|',
      ...needs.map((n) => `| ${n.id} | ${n.expected} | ${n.probabilities.map((x) => `${x.token === n.expected ? '**' : ''}${x.token}${x.token === n.expected ? '**' : ''} ${x.p.toFixed(2)}`).join('; ')} |`),
      '',
    ].join('\n');
    // A local model answered from a file with requests still listed has not been measured: no report.
    const listed = localClef ? localClefPending(localClef) : 0;
    if (listed) throw new Error(`${listed} requests for ${localClef!.label} are listed in ${localClef!.answers}.pending.jsonl: answer them (uv run scripts/work/laya-answers.py ${localClef!.answers}) and run again`);
    writeFileSync(join(__dirname, 'work-eval', `clef-${date}${localClef ? `-${localClefSlug(localClef)}` : ''}.md`), md);
    expect(typed).toHaveLength(docs.length);
  }, 1_800_000);
});
