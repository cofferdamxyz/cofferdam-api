// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Matching on prompts that land in more than one ISCO group (opt-in:
 * MATCH_EVAL=1), from the Mac: workspace decision 0069, the founder's ruling
 * of 2026-10-28. The synthetic pool of `test/fixtures/work/match/ambiguous.json`
 * is published on a replica of the registry (`test/work-eval/replica.ts`: the
 * ESCO import, the US layer, the certificate seed, the v3 vectors in memory)
 * with the phone's EmbeddingGemma 2 vectors from llama-embedding, and every
 * prompt is planned once and searched twice over the pool: with the decision
 * pass (Clef, not flash, classifying each finalist against the job; the
 * needed skills breaking a tie) and with the gate alone, as before decision
 * 0069. Each search is scored on the worker the prompt names as the best and
 * on the workers it would accept. The hosted models run over the Workers AI
 * REST API (the plan's Clef and intent calls, the snaps' band and pivot, the
 * decision pass); everything here is synthetic.
 *
 *   cd cofferdam-api && MATCH_EVAL=1 direnv exec .. yarn vitest run test/workMatch.eval.test.ts
 *
 * ESCO_SQL, US_SQL and V3_DIR as the job-ad benchmark (defaults under
 * ~/Development); MATCH_PARALLEL publishes at once (2). Writes
 * `test/work-eval/match-<date>.md`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInference, type Inference } from '../src/services/inference/index.js';
import { planHire, type HireDeps, type HirePlan } from '../src/services/work/hire.js';
import { claimKey, D1ListingStore, listingText, publishListing, type ClaimVectors, type ListingDraft, type PublishDeps } from '../src/services/work/listings.js';
import { callCostMicroUsd } from '../src/services/work/meter.js';
import { recall, type Finalist, type RecallDeps } from '../src/services/work/recall.js';
import { EMBEDDINGGEMMA_2_GGUF, type RegistryDeps } from '../src/services/work/registry.js';
import { createRestAi } from './chat-eval/restAi.js';
import { memoryIndex } from './fixtures/work/fakes.js';
import { embedAll, loadReplica, ReplicaIndex } from './work-eval/replica.js';

const RUN = process.env.MATCH_EVAL === '1';
const home = (p: string) => p.replace(/^~(?=\/|$)/, homedir());

interface Worker {
  id: string;
  titles: string[];
  skills: string[];
}
interface Prompt {
  id: string;
  sentence: string;
  best: string;
  acceptable: string[];
}

async function parallel<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) await fn(items[next++]!); }));
}

describe.skipIf(!RUN)('Matching on prompts across ISCO groups (live: Workers AI)', () => {
  it('plans each prompt, searches with and without the decision pass, and writes the report', async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !token) throw new Error('MATCH_EVAL needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    const escoSql = home(process.env.ESCO_SQL ?? '~/Development/esco/import/cofferdam-import');
    const usSql = home(process.env.US_SQL ?? '~/Development/us-layer-data/cofferdam-import');
    const v3Dir = home(process.env.V3_DIR ?? '~/Development/esco/import/registry-embeddinggemma-2');
    const parallelN = Number(process.env.MATCH_PARALLEL ?? 2);
    const started = Date.now();
    const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'work', 'match', 'ambiguous.json'), 'utf8')) as { workers: Worker[]; prompts: Prompt[] };

    const replica = await loadReplica(escoSql, usSql);
    const index = ReplicaIndex.load(v3Dir);
    const raw = createInference({ WORK_EMBED_MODEL: EMBEDDINGGEMMA_2_GGUF }, { ai: createRestAi({ accountId, token }) })!;
    /** Every decision Clef makes, with the state it read: written beside the report's data, outside the repository's report. */
    const decisions: { state: string; answer: unknown }[] = [];
    const seam: Inference = {
      model: (op) => raw.model(op),
      async run(op, input, call) {
        const result = await raw.run(op, input, call);
        if (op === 'work-decide' && typeof input.state === 'string') decisions.push({ state: input.state, answer: (result as { answers?: unknown } | null)?.answers ?? null });
        return result;
      },
    };
    const registry: RegistryDeps = { inference: seam, store: replica.store, index };
    const listings = new D1ListingStore(replica.db.d1);
    {
      const d1 = replica.db.d1 as unknown as { batch: (stmts: unknown[]) => Promise<unknown> };
      const rawBatch = d1.batch.bind(d1);
      let chain: Promise<unknown> = Promise.resolve();
      d1.batch = (stmts) => {
        const run = chain.then(() => rawBatch(stmts));
        chain = run.catch(() => undefined);
        return run;
      };
    }
    const jobsIndex = memoryIndex();
    const withPass: RecallDeps = { inference: seam, index: jobsIndex, listings, store: replica.store };
    const gateOnly: RecallDeps = { inference: seam, index: jobsIndex, listings };
    const publish: PublishDeps = { inference: seam, registry, listings, index: jobsIndex };

    // The phone's vectors: every claim as a query and a document, each listing as a document, each sentence as a query.
    // Every worker publishes two Work Profiles, on site in Texas and remote in the US, so a prompt Clef reads as remote work finds them too.
    const draftOf = (w: Worker, scope: 'onsite' | 'remote' = 'onsite'): ListingDraft => ({ pseudonym: `w-${w.id}`, profileId: scope === 'onsite' ? 'p1' : 'p2', region: scope === 'onsite' ? 'us-tx' : 'us', scope, tier: 1, lang: 'en', titles: w.titles, skills: w.skills, certificates: [], languages: ['en'] });
    const claims = fixture.workers.flatMap((w) => [...w.titles, ...w.skills]);
    const docs = embedAll([...fixture.workers.map((w) => listingText(draftOf(w), [])), ...claims], 'document');
    const queries = embedAll([...claims, ...fixture.prompts.map((p) => p.sentence)], 'query');
    const norm = (t: string) => t.replace(/\s+/g, ' ').trim();

    // The pool.
    let publishCost = 0;
    const workerOf = new Map<string, string>();
    const tokensOf = new Map<string, string[]>();
    await parallel(fixture.workers.flatMap((w) => [draftOf(w, 'onsite'), draftOf(w, 'remote')]), parallelN, async (d) => {
      const id = d.pseudonym.slice(2);
      const cv = new Map<string, ClaimVectors>();
      for (const [kind, texts] of [['pos', d.titles], ['skill', d.skills]] as const) {
        for (const t of texts) {
          const q = queries.get(norm(t));
          const doc = docs.get(norm(t));
          if (q && doc) cv.set(claimKey(kind, t), { query: q, document: doc });
        }
      }
      const out = await publishListing(publish, d, { listing: docs.get(norm(listingText(d, []))), claims: cv });
      publishCost += out.calls.reduce((s, c) => s + callCostMicroUsd(c), 0);
      if (!out.ok) throw new Error(`${id} did not publish: ${out.error}`);
      workerOf.set(out.listingId, id);
      tokensOf.set(id, out.tokens);
    });
    process.stdout.write(`published ${workerOf.size} listings of ${fixture.workers.length} workers, ${((Date.now() - started) / 1000).toFixed(0)} s\n`);

    // Each prompt: one plan, two searches.
    const hire: HireDeps = { registry, recall: withPass };
    const named = async (ts: string[]) => [...(await replica.store.tokens(ts)).values()].map((t) => t.labelEn);
    interface Row {
      p: Prompt;
      plan: HirePlan | null;
      needs: string[];
      groups: number;
      pass: { ids: string[]; top: Finalist[]; failed: number };
      gate: { ids: string[] };
    }
    const rows: Row[] = [];
    let planCost = 0;
    let searchCost = 0;
    for (const p of fixture.prompts) {
      const vector = queries.get(norm(p.sentence));
      const planned = await planHire(hire, { sentence: p.sentence, lang: 'en', regions: ['us-tx'], ...(vector ? { vector } : {}) });
      planCost += planned.calls.reduce((s, c) => s + callCostMicroUsd(c), 0);
      if (!planned.ok) {
        rows.push({ p, plan: null, needs: [], groups: 0, pass: { ids: [], top: [], failed: 0 }, gate: { ids: [] } });
        continue;
      }
      const plan = planned.plan;
      const a = await recall(withPass, plan.intent);
      const b = await recall(gateOnly, plan.intent);
      searchCost += [...a.calls, ...b.calls].reduce((s, c) => s + callCostMicroUsd(c), 0);
      const ids = (fs: Finalist[]) => fs.map((f) => workerOf.get(f.listingId) ?? '?');
      // The ISCO groups among the workers this prompt would accept: more than one is what the prompt is for.
      const groups = new Set(p.acceptable.flatMap((id) => (tokensOf.get(id) ?? []).filter((t) => t.startsWith('isco:'))));
      rows.push({
        p,
        plan,
        needs: await named(plan.needs.filter((n) => n.token.startsWith('pos:')).map((n) => n.token)),
        groups: groups.size,
        pass: { ids: a.ok ? ids(a.finalists) : [], top: a.ok ? a.finalists.slice(0, 2) : [], failed: a.ok ? [...a.finalists, ...(a.dropped ?? [])].filter((f) => f.fit?.choice === null).length : 0 },
        gate: { ids: b.ok ? ids(b.finalists) : [] },
      });
      process.stdout.write(`${p.id}: with the pass ${a.ok ? ids(a.finalists).slice(0, 3).join(', ') : 'failed'}; gate alone ${b.ok ? ids(b.finalists).slice(0, 3).join(', ') : 'failed'} | mode ${plan.intent.mode}, allOf [${plan.intent.allOf.join(', ')}], anyOf ${plan.intent.anyOf.length}, recalled ${a.ok ? a.recalled : '?'}, gated ${a.ok ? a.gated : '?'}\n`);
    }

    // The report.
    const rank = (ids: string[], id: string) => {
      const i = ids.indexOf(id);
      return i < 0 ? '–' : String(i + 1);
    };
    const count = (f: (r: Row) => boolean) => rows.filter(f).length;
    const date = new Date().toISOString().slice(0, 10);
    const out: string[] = [];
    out.push(`# Matching on prompts across ISCO groups, ${date}`, '');
    out.push(
      `Generated by \`test/workMatch.eval.test.ts\` (MATCH_EVAL=1; workspace decision 0069) on the synthetic pool of \`test/fixtures/work/match/ambiguous.json\`: ${fixture.workers.length} workers published on a replica of the registry with the phone's EmbeddingGemma 2 vectors, each on site in Texas and remote in the US, and ${fixture.prompts.length} hirer prompts, each planned once and searched twice: with the decision pass (Clef, not flash, classifying each finalist; the needed skills breaking a tie) and with the gate alone. ${Math.round((Date.now() - started) / 1000)} s; hosted cost $${((publishCost + planCost + searchCost) / 1e6).toFixed(4)} (publishing $${(publishCost / 1e6).toFixed(4)}, plans $${(planCost / 1e6).toFixed(4)}, searches $${(searchCost / 1e6).toFixed(4)}).`,
      '',
      '## Summary',
      '',
      '| | With the decision pass | Gate alone |',
      '|---|---|---|',
      `| The best worker first | ${count((r) => r.pass.ids[0] === r.p.best)}/${rows.length} | ${count((r) => r.gate.ids[0] === r.p.best)}/${rows.length} |`,
      `| The best worker in the top 3 | ${count((r) => r.pass.ids.slice(0, 3).includes(r.p.best))}/${rows.length} | ${count((r) => r.gate.ids.slice(0, 3).includes(r.p.best))}/${rows.length} |`,
      `| An acceptable worker first | ${count((r) => r.p.acceptable.includes(r.pass.ids[0] ?? ''))}/${rows.length} | ${count((r) => r.p.acceptable.includes(r.gate.ids[0] ?? ''))}/${rows.length} |`,
      `| No finalist | ${count((r) => !r.pass.ids.length)}/${rows.length} | ${count((r) => !r.gate.ids.length)}/${rows.length} |`,
      '',
      '## Prompts',
      '',
      '| Prompt | Plan\'s occupations | ISCO groups accepted | With the pass: top 3 | Best\'s rank | Top two: P(fit), needed skills held | Gate alone: top 3 | Best\'s rank |',
      '|---|---|---|---|---|---|---|---|',
    );
    for (const r of rows) {
      const top2 = r.pass.top.map((f) => `${(f.fit?.pFit ?? 0).toFixed(2)}, ${f.fit?.skillsHeld ?? 0}`).join(' / ');
      out.push(
        `| ${r.p.id} | ${r.plan ? r.needs.join('; ') || 'none' : 'no plan'} | ${r.groups} | ${r.pass.ids.slice(0, 3).join(', ') || '–'} | ${rank(r.pass.ids, r.p.best)} | ${top2 || '–'} | ${r.gate.ids.slice(0, 3).join(', ') || '–'} | ${rank(r.gate.ids, r.p.best)} |`,
      );
    }
    out.push('', `Decision calls that failed (the gate's tier stood): ${rows.reduce((s, r) => s + r.pass.failed, 0)}.`, '');
    const path = (() => {
      for (let i = 1; ; i++) {
        const p = join(__dirname, 'work-eval', `match-${date}${i === 1 ? '' : `-${i}`}.md`);
        if (!existsSync(p)) return p;
      }
    })();
    writeFileSync(path, out.join('\n'));
    if (process.env.MATCH_DECISIONS) writeFileSync(home(process.env.MATCH_DECISIONS), JSON.stringify(decisions, null, 1) + '\n');
    process.stdout.write(`report: ${path}\n`);
    expect(rows).toHaveLength(fixture.prompts.length);
  }, 3_600_000);
});
