// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One hirer query, live (opt-in: WORK_EVAL=1): the nine synthetic CVs of
 * `test/fixtures/work/` published as listings (their gold fields as the
 * phone would send them, snapped against the synthetic registry seed), then
 * the canonical sink request ("My kitchen sink is leaking...", us-tx)
 * through `hirerQuery` with the real models: the intent on `work-intent`,
 * Clef's scope and needs, the certificate snap, the namespace fan-out, the
 * Bloom gate and the exact certificate confirm. The other hirer sentences
 * run after it, for the record. The indexes are in memory (the real
 * `jobs-listings-v1` does not exist yet), with Vectorize's 50-result cap
 * enforced. Writes `test/work-eval/recall-<date>.md`.
 *
 *   cd cofferdam-api && WORK_EVAL=1 direnv exec .. yarn vitest run test/workRecall.eval.test.ts
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInference } from '../src/services/inference/index.js';
import type { BlockLang } from '../src/services/work/blocks.js';
import { hirerQuery, type HireDeps } from '../src/services/work/hire.js';
import { D1ListingStore, publishListing, type ListingDraft, type PublishDeps } from '../src/services/work/listings.js';
import { callCostMicroUsd } from '../src/services/work/meter.js';
import { D1RegistryStore, embedTexts, labelIdOf, labelNorm, type RegistryLabel, type TokenKind } from '../src/services/work/registry.js';
import { createRestAi } from './chat-eval/restAi.js';
import { sqliteD1 } from './fixtures/work/d1.js';
import { memoryIndex } from './fixtures/work/fakes.js';
import { FIXTURE_CVS, HIRER_PROMPTS, type FixtureCv } from './fixtures/work/index.js';
import seed from './fixtures/work/registry-seed.json';

const LIVE = process.env.WORK_EVAL === '1';

/** Which fixture CVs a hirer sentence should find, by the trades and regions in the fixtures. */
const EXPECTED: Record<string, string[]> = {
  'sink-en': ['en-plumber'],
  'ev-charger-en': ['en-electrician'],
  'rigger-en': ['es-rigger'],
  'translation-en': ['es-translator'],
  'gardener-en': ['pt-gardener'],
  'sink-pt': [],
  'ev-charger-pt': ['pt-electrician'],
  'rigger-pt': ['es-rigger'],
  'translation-pt': ['es-translator'],
  'gardener-pt': ['pt-gardener'],
  'reais-pt': [],
  'sink-es': ['es-plumber'],
  'ev-charger-es': [],
  'rigger-es': ['es-rigger'],
  'translation-es': ['es-translator'],
  'gardener-es': ['pt-gardener'],
  'pesos-es': ['es-plumber'],
};

const LANG: Record<string, BlockLang> = { 'en-US': 'en', 'pt-BR': 'pt', 'es-MX': 'es' };

/** A CV's gold fields as the listing draft the phone would publish. */
function draftOf(cv: FixtureCv): ListingDraft {
  const all = (field: string) => cv.blocks.flatMap((b) => (b.expected[field] == null ? [] : Array.isArray(b.expected[field]) ? (b.expected[field] as string[]) : [b.expected[field] as string]));
  const titles = cv.blocks.filter((b) => b.kind === 'summary' || b.kind === 'experience').flatMap((b) => (b.expected.title ? [b.expected.title as string] : []));
  const codes: Record<string, string> = { english: 'en', ingles: 'en', inglés: 'en', inglês: 'en', spanish: 'es', espanol: 'es', español: 'es', espanhol: 'es', portugues: 'pt', português: 'pt', portugués: 'pt' };
  const languages = [...new Set(all('fluent').map((l) => codes[l.toLowerCase()]).filter((c): c is string => !!c))];
  return {
    pseudonym: cv.id,
    profileId: 'main',
    region: cv.listing.region,
    scope: cv.listing.scope,
    tier: cv.listing.tier as 0 | 1 | 2,
    lang: LANG[cv.locale]!,
    titles: [...new Set(titles)].slice(0, 5),
    skills: [...new Set(cv.blocks.filter((b) => ['summary', 'experience', 'skills'].includes(b.kind)).flatMap((b) => (b.expected.skills as string[] | undefined) ?? []))].slice(0, 30),
    certificates: [...new Set(all('certificates'))].slice(0, 20),
    languages,
  };
}

describe.skipIf(!LIVE)('one hirer query (live, Workers AI)', () => {
  it('publishes the fixture listings and runs the sink request end to end', async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !token) throw new Error('WORK_EVAL needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    const inference = createInference({}, { ai: createRestAi({ accountId, token }) })!;

    // The synthetic registry seed, embedded once.
    const db = sqliteD1();
    const registryStore = new D1RegistryStore(db.d1);
    const registryIndex = memoryIndex();
    const seedTokens = seed.tokens as { token: string; kind: TokenKind; labels: Partial<Record<string, string[]>> }[];
    for (const t of seedTokens) {
      const labels: RegistryLabel[] = [];
      const texts: string[] = [];
      for (const [lang, list] of Object.entries(t.labels)) {
        for (const label of list ?? []) {
          labels.push({ labelId: await labelIdOf(t.token, lang, labelNorm(label)), token: t.token, lang, label, labelNorm: labelNorm(label), kind: 'preferred', embedded: true });
          texts.push(label);
        }
      }
      const e = await embedTexts(inference, texts);
      if (!e.ok) throw new Error('seed embedding failed');
      await registryStore.insertToken({ token: t.token, kind: t.kind, source: 'seed', labelEn: t.labels.en?.[0] ?? t.token, escoUri: null, iscoCode: null, status: 'active', mergedInto: null }, labels, 0);
      await registryIndex.upsert(labels.map((l, i) => ({ id: l.labelId, values: e.vectors[i]!, metadata: { token: t.token, kind: t.kind, lang: l.lang, label: l.label, source: 'seed' } })));
    }
    const registry = { inference, store: registryStore, index: registryIndex };
    const jobsIndex = memoryIndex();
    const listings = new D1ListingStore(db.d1);
    const publish: PublishDeps = { inference, registry, listings, index: jobsIndex };
    const hire: HireDeps = { registry, recall: { inference, index: jobsIndex, listings } };

    const byListing = new Map<string, string>();
    const published: string[] = [];
    let publishCost = 0;
    for (const cv of FIXTURE_CVS) {
      const out = await publishListing(publish, draftOf(cv));
      if (!out.ok) throw new Error(`${cv.id}: ${out.error}`);
      byListing.set(out.listingId, cv.id);
      publishCost += out.calls.reduce((s, c) => s + callCostMicroUsd(c), 0);
      published.push(`| ${cv.id} | ${out.namespace} | ${out.tokens.join(', ')} |`);
      console.log(`published ${cv.id} → ${out.namespace}: ${out.tokens.join(' ')}`);
    }

    const rows: string[] = [];
    let sinkSection: string[] = [];
    let hits = 0;
    const prompts = HIRER_PROMPTS.filter((p) => !p.expected.refuse);
    const ordered = [prompts.find((p) => p.id === 'sink-en')!, ...prompts.filter((p) => p.id !== 'sink-en')];
    for (const p of ordered) {
      const t0 = Date.now();
      const out = await hirerQuery(hire, { sentence: p.text, lang: LANG[p.locale]!, regions: [p.region] });
      const ms = Date.now() - t0;
      const found = out.ok && out.recall.ok ? out.recall.finalists.map((f) => byListing.get(f.listingId) ?? f.listingId) : [];
      const expected = EXPECTED[p.id] ?? [];
      const ok = found.length === expected.length && expected.every((e) => found.includes(e));
      if (ok) hits++;
      const plan = out.ok ? out.plan : null;
      const cost = (out.ok ? out.calls : out.calls).reduce((s, c) => s + callCostMicroUsd(c), 0);
      rows.push(
        `| ${p.id} | ${p.region} | ${plan ? `${plan.intent.scope}, ${plan.intent.mode}` : `refused: ${out.ok ? '' : out.error}`} | ${plan ? plan.needs.map((n) => `${n.token} ${n.p.toFixed(2)}`).join('; ') || '—' : '—'} | ${plan?.intent.allOf.join(', ') || '—'} | ${found.join(', ') || '—'} | ${expected.join(', ') || '—'} | ${ok ? 'yes' : '**no**'} | ${(ms / 1000).toFixed(1)} s | $${(cost / 1e6).toFixed(5)} |`,
      );
      if (p.id === 'sink-en' && out.ok && out.recall.ok) {
        sinkSection = [
          `"${p.text}" from \`${p.region}\`:`,
          '',
          `- Intent (\`${out.plan.fields.task ? 'work-intent' : '?'}\`): task "${out.plan.fields.task}", when "${out.plan.fields.when}", budget $${out.plan.fields.budgetUsd}; missing: ${out.plan.missing.join(', ') || 'nothing'}.`,
          `- Clef: scope ${out.plan.scope} (${out.plan.scopeP.toFixed(2)}); needs ${out.plan.needs.map((n) => `${n.token} (${n.p.toFixed(2)})`).join(', ')}.`,
          `- Intent for recall: ${out.plan.intent.mode}, allOf [${out.plan.intent.allOf.join(', ')}], anyOf [${out.plan.intent.anyOf.join(', ')}].`,
          `- Recall: namespaces ${out.recall.namespaces.join(', ')}; ${out.recall.recalled} recalled, ${out.recall.gated} through the gate, finalists: ${out.recall.finalists.map((f) => `${byListing.get(f.listingId)} (cosine ${f.score.toFixed(3)}, tier ${f.gateTier}, matched ${f.matched.join(' ')})`).join('; ') || 'none'}.`,
          `- ${(ms / 1000).toFixed(1)} s from the Mac and $${(cost / 1e6).toFixed(5)} of Workers AI.`,
        ];
      }
      console.log(`${ok ? 'ok  ' : 'MISS'} ${p.id}: ${found.join(', ') || '—'}`);
    }

    const date = new Date().toISOString().slice(0, 10);
    const md = [
      `# One hirer query, ${date}`,
      '',
      `The nine synthetic CVs of \`test/fixtures/work/\` published as listings (their gold fields as the phone would send them) into an in-memory \`jobs-listings-v1\` (Vectorize's 50-result cap enforced; the real index does not exist yet), their claims snapped against the synthetic registry seed, with \`bge-m3\`, \`clef-flash\`, \`llama-3.3-70b\` (intent and pivot) over the Workers AI REST API from the Mac. Publishing all nine cost $${(publishCost / 1e6).toFixed(4)}.`,
      '',
      '## The sink request',
      '',
      ...sinkSection,
      '',
      '## Every hirer sentence',
      '',
      `${hits} of ${ordered.length} found exactly the CVs the fixtures make right (or none where none fits).`,
      '',
      '| Prompt | Region | Scope, mode | Needs (Clef p) | Required | Found | Expected | Right | Time | Cost |',
      '|---|---|---|---|---|---|---|---|---|---|',
      ...rows,
      '',
      '## Listings',
      '',
      '| CV | Namespace | Tokens |',
      '|---|---|---|',
      ...published,
      '',
    ].join('\n');
    writeFileSync(join(__dirname, 'work-eval', `recall-${date}.md`), md);
    expect(sinkSection.length).toBeGreaterThan(0);
  }, 1_800_000);
});
