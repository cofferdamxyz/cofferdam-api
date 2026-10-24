// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The canonicalization evaluation (opt-in: WORK_EVAL=1): retrieve-then-choose
 * (`services/work/registry.ts`) with the real models, bge-m3, clef-flash and
 * the JSON-mode pivot, over the synthetic seed in
 * `test/fixtures/work/registry-seed.json` (no ESCO data: its codes come only
 * from the founder's download). Each expected string snaps against a fresh
 * copy of the seed, in memory (node:sqlite for D1, a cosine index for
 * Vectorize), so one snap's alias or mint never helps the next. Records the
 * decision, the token, Clef's probability and the cosines that tune τ, and
 * writes `test/work-eval/registry-<date>.md`.
 *
 *   cd cofferdam-api && WORK_EVAL=1 direnv exec .. yarn vitest run test/workRegistry.eval.test.ts
 *
 * WORK_TAU_AUTO and WORK_TAU_LOW try other bands.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInference } from '../src/services/inference/index.js';
import type { BlockLang } from '../src/services/work/blocks.js';
import { callCostMicroUsd } from '../src/services/work/meter.js';
import { D1RegistryStore, embedTexts, labelIdOf, labelNorm, parseTau, snap, type RegistryLabel, type TokenKind } from '../src/services/work/registry.js';
import { createRestAi } from './chat-eval/restAi.js';
import { sqliteD1 } from './fixtures/work/d1.js';
import { cosine, memoryIndex } from './fixtures/work/fakes.js';
import seed from './fixtures/work/registry-seed.json';

const LIVE = process.env.WORK_EVAL === '1';

interface SeedToken {
  token: string;
  kind: TokenKind;
  labels: Partial<Record<string, string[]>>;
}

interface Row {
  kind: TokenKind;
  lang: string;
  raw: string;
  expected: string | null;
  decision: string;
  token: string | null;
  correct: boolean;
  /** The best cosine of any seed label, and the best of the expected token's labels. */
  top: number;
  expectedCos: number | null;
  probability: number | null;
  ms: number;
  costMicroUsd: number;
}

describe.skipIf(!LIVE)('canonicalization evaluation (live, Workers AI)', () => {
  it('snaps every expected string against a fresh seed and writes the report', async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !token) throw new Error('WORK_EVAL needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    const tau = parseTau(process.env.WORK_TAU_AUTO, process.env.WORK_TAU_LOW);
    const inference = createInference({}, { ai: createRestAi({ accountId, token }) })!;
    const tokens = seed.tokens as SeedToken[];

    // The seed's labels, embedded once.
    const labels: { token: SeedToken; lang: string; label: string }[] = tokens.flatMap((t) =>
      Object.entries(t.labels).flatMap(([lang, list]) => (list ?? []).map((label) => ({ token: t, lang, label }))),
    );
    const vectors: number[][] = [];
    for (let i = 0; i < labels.length; i += 50) {
      const e = await embedTexts(inference, labels.slice(i, i + 50).map((l) => l.label));
      if (!e.ok) throw new Error('seed embedding failed');
      vectors.push(...e.vectors);
    }

    async function freshRegistry() {
      const { d1 } = sqliteD1();
      const store = new D1RegistryStore(d1);
      const index = memoryIndex();
      for (const t of tokens) {
        const own: RegistryLabel[] = [];
        for (const [i, l] of labels.entries()) {
          if (l.token !== t) continue;
          const norm = labelNorm(l.label);
          own.push({ labelId: await labelIdOf(t.token, l.lang, norm), token: t.token, lang: l.lang, label: l.label, labelNorm: norm, kind: 'preferred', embedded: true });
          await index.upsert([{ id: own.at(-1)!.labelId, values: vectors[i]!, metadata: { token: t.token, kind: t.kind, lang: l.lang, label: l.label, source: 'seed' } }]);
        }
        await store.insertToken({ token: t.token, kind: t.kind, source: 'seed', labelEn: t.labels.en?.[0] ?? t.token, escoUri: null, iscoCode: null, status: 'active', mergedInto: null }, own, 0);
      }
      return { store, index };
    }

    const rows: Row[] = [];
    for (const x of seed.expected as { kind: TokenKind; lang: BlockLang; raw: string; token: string | null }[]) {
      const { store, index } = await freshRegistry();
      const t0 = Date.now();
      const out = await snap({ inference, store, index, tau }, { kind: x.kind, raw: x.raw, lang: x.lang });
      const ms = Date.now() - t0;
      const rawVec = await embedTexts(inference, [x.raw]);
      const cosines = rawVec.ok ? labels.map((l, i) => ({ l, c: l.token.kind === x.kind ? cosine(rawVec.vectors[0]!, vectors[i]!) : -1 })) : [];
      const top = Math.max(-1, ...cosines.map((c) => c.c));
      const expectedCos = x.token ? Math.max(-1, ...cosines.filter((c) => c.l.token.token === x.token).map((c) => c.c)) : null;
      const correct = x.token ? out.token === x.token : x.kind === 'cert' ? out.decision === 'unmatched' : out.decision === 'minted' || out.decision === 'unmatched';
      rows.push({
        kind: x.kind,
        lang: x.lang,
        raw: x.raw,
        expected: x.token,
        decision: out.decision,
        token: out.token,
        correct,
        top: Math.round(top * 1000) / 1000,
        expectedCos: expectedCos == null ? null : Math.round(expectedCos * 1000) / 1000,
        probability: out.probability,
        ms,
        costMicroUsd: out.calls.reduce((s, c) => s + callCostMicroUsd(c), 0),
      });
      console.log(`${correct ? 'ok  ' : 'MISS'} ${x.kind} ${x.raw} → ${out.decision} ${out.token ?? ''}`);
    }

    const date = new Date().toISOString().slice(0, 10);
    const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 1000) / 10}%` : '—');
    const byKind = (['pos', 'skill', 'cert'] as const).map((k) => {
      const r = rows.filter((x) => x.kind === k);
      return `| ${k} | ${pct(r.filter((x) => x.correct).length, r.length)} (${r.filter((x) => x.correct).length} of ${r.length}) | ${r.filter((x) => x.expected && x.token && x.token !== x.expected).length} | ${r.filter((x) => x.expected && !x.token).length} |`;
    });
    const decisions = [...new Set(rows.map((r) => r.decision))].map((d) => `${d} ${rows.filter((r) => r.decision === d).length}`).join(', ');
    const positives = rows.filter((r) => r.expectedCos != null).map((r) => r.expectedCos!);
    const negatives = rows.filter((r) => r.expected == null).map((r) => r.top);
    const md = [
      `# Canonicalization evaluation, ${date}`,
      '',
      `Retrieve-then-choose over the synthetic seed (\`test/fixtures/work/registry-seed.json\`: ${tokens.length} tokens, ${labels.length} labels in en, pt and es; no ESCO data), each of ${rows.length} strings against a fresh copy, with \`${await inference.model('work-embed')}\`, \`${await inference.model('work-adjudicate')}\` and \`${await inference.model('work-pivot')}\` over the Workers AI REST API from the Mac. τ_auto ${tau.auto}, τ_low ${tau.low}.`,
      '',
      '| Kind | Right | Wrong token | No token where one fits |',
      '|---|---|---|---|',
      ...byKind,
      '',
      `Decisions: ${decisions}. Cost per snap ${(rows.reduce((s, r) => s + r.costMicroUsd, 0) / rows.length / 1e6).toFixed(6)} USD, median ${[...rows.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(rows.length / 2)]} ms.`,
      '',
      `Cosine of the expected token's best label: min ${Math.min(...positives).toFixed(3)}, median ${positives.sort((a, b) => a - b)[Math.floor(positives.length / 2)]!.toFixed(3)}. Best cosine of strings with no fitting token: max ${Math.max(...negatives).toFixed(3)}.`,
      '',
      '| Kind | Language | String | Expected | Decision | Token | Top cos | Expected cos | Clef p |',
      '|---|---|---|---|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.kind} | ${r.lang} | ${r.raw} | ${r.expected ?? '—'} | ${r.correct ? '' : '**'}${r.decision}${r.correct ? '' : '**'} | ${r.token ?? '—'} | ${r.top} | ${r.expectedCos ?? '—'} | ${r.probability == null ? '—' : r.probability.toFixed(2)} |`),
      '',
    ].join('\n');
    writeFileSync(join(__dirname, 'work-eval', `registry-${date}.md`), md);
    expect(rows).toHaveLength(seed.expected.length);
  }, 1_800_000);
});
