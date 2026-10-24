// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The canonicalization evaluation (opt-in: WORK_EVAL=1): retrieve-then-choose
 * (`services/work/registry.ts`) with the real models, bge-m3, clef-flash and
 * the JSON-mode pivot, over the synthetic occupation and skill seed in
 * `test/fixtures/work/registry-seed.json` (no ESCO data: its codes come only
 * from the founder's download) and the curated certificate seed
 * (`src/services/work/certificates.json`). Each expected string snaps
 * against a fresh copy of both, in memory (node:sqlite for D1, a cosine
 * index for Vectorize), so one snap's alias or mint never helps the next. A
 * certificate string is a worker's claim, or, with a region, a hirer's
 * requirement (no mint, the jurisdiction left to the job's region); it is
 * right only with the expected token, level and modules. Records the
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
import { planCertificateImport } from '../src/services/work/certificates.js';
import { callCostMicroUsd } from '../src/services/work/meter.js';
import { D1RegistryStore, embedTexts, labelIdOf, labelNorm, parseTau, snap, type RegistryLabel, type RegistryToken, type TokenKind } from '../src/services/work/registry.js';
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

interface Expected {
  kind: TokenKind;
  lang: BlockLang;
  raw: string;
  token: string | null;
  level?: string;
  modules?: string[];
  /** A hirer's requirement in this region; a worker's claim without one. */
  region?: string;
}

interface Row {
  kind: TokenKind;
  lang: string;
  raw: string;
  as: string;
  expected: string | null;
  expectedFacets: string;
  decision: string;
  token: string | null;
  facets: string;
  correct: boolean;
  /** The best cosine of any seed label, and the best of the expected token's labels. */
  top: number;
  expectedCos: number | null;
  probability: number | null;
  ms: number;
  costMicroUsd: number;
}

const facetText = (level: string | null | undefined, modules: readonly string[] | undefined) => [level, ...(modules ?? [])].filter(Boolean).join(', ') || '—';

describe.skipIf(!LIVE)('canonicalization evaluation (live, Workers AI)', () => {
  it('snaps every expected string against a fresh seed and writes the report', async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !token) throw new Error('WORK_EVAL needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    const tau = parseTau(process.env.WORK_TAU_AUTO, process.env.WORK_TAU_LOW);
    const inference = createInference({}, { ai: createRestAi({ accountId, token }) })!;

    // The occupation and skill seed, and the certificate seed, as rows and labels.
    const tokens: RegistryToken[] = [];
    const labels: RegistryLabel[] = [];
    for (const t of seed.tokens as SeedToken[]) {
      tokens.push({ token: t.token, kind: t.kind, source: 'seed', labelEn: t.labels.en?.[0] ?? t.token, escoUri: null, iscoCode: null, status: 'active', mergedInto: null });
      for (const [lang, list] of Object.entries(t.labels)) {
        for (const label of list ?? []) {
          const norm = labelNorm(label);
          labels.push({ labelId: await labelIdOf(t.token, lang, norm), token: t.token, lang, label, labelNorm: norm, kind: 'preferred', embedded: true });
        }
      }
    }
    const certificates = await planCertificateImport();
    tokens.push(...certificates.tokens);
    labels.push(...certificates.labels);
    const kindOf = new Map(tokens.map((t) => [t.token, t.kind]));

    // Every label, embedded once.
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
      for (const t of tokens) await store.insertToken(t, labels.filter((l) => l.token === t.token), 0);
      await index.upsert(labels.map((l, i) => ({ id: l.labelId, values: vectors[i]!, metadata: { token: l.token, kind: kindOf.get(l.token)!, lang: l.lang, label: l.label, source: 'seed' } })));
      return { store, index };
    }

    const rows: Row[] = [];
    for (const x of seed.expected as Expected[]) {
      const { store, index } = await freshRegistry();
      const t0 = Date.now();
      const out = await snap(
        { inference, store, index, tau },
        { kind: x.kind, raw: x.raw, lang: x.lang, ...(x.region ? { mint: false, region: x.region } : {}) },
      );
      const ms = Date.now() - t0;
      const rawVec = await embedTexts(inference, [x.raw]);
      const cosines = rawVec.ok ? labels.map((l, i) => ({ l, c: kindOf.get(l.token) === x.kind ? cosine(rawVec.vectors[0]!, vectors[i]!) : -1 })) : [];
      const top = Math.max(-1, ...cosines.map((c) => c.c));
      const expectedCos = x.token ? Math.max(-1, ...cosines.filter((c) => c.l.token === x.token).map((c) => c.c)) : null;
      const facetsRight =
        x.kind !== 'cert' || !x.token || ((out.facets?.level ?? null) === (x.level ?? null) && JSON.stringify(out.facets?.modules ?? []) === JSON.stringify([...(x.modules ?? [])].sort()));
      const correct = x.token
        ? out.token === x.token && facetsRight
        : x.kind === 'cert' || x.region
          ? out.decision === 'unmatched'
          : out.decision === 'minted' || out.decision === 'unmatched';
      rows.push({
        kind: x.kind,
        lang: x.lang,
        raw: x.raw,
        as: x.region ? `hirer, ${x.region}` : x.kind === 'cert' ? 'worker' : '—',
        expected: x.token,
        expectedFacets: x.token ? facetText(x.level, x.modules) : '—',
        decision: out.decision,
        token: out.token,
        facets: out.token ? facetText(out.facets?.level, out.facets?.modules) : '—',
        correct,
        top: Math.round(top * 1000) / 1000,
        expectedCos: expectedCos == null ? null : Math.round(expectedCos * 1000) / 1000,
        probability: out.probability,
        ms,
        costMicroUsd: out.calls.reduce((s, c) => s + callCostMicroUsd(c), 0),
      });
      console.log(`${correct ? 'ok  ' : 'MISS'} ${x.kind} ${x.raw}${x.region ? ` @${x.region}` : ''} → ${out.decision} ${out.token ?? ''} ${out.facets ? facetText(out.facets.level, out.facets.modules) : ''}`);
    }

    const date = new Date().toISOString().slice(0, 10);
    const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 1000) / 10}%` : '—');
    const line = (label: string, r: Row[]) =>
      `| ${label} | ${pct(r.filter((x) => x.correct).length, r.length)} (${r.filter((x) => x.correct).length} of ${r.length}) | ${r.filter((x) => x.expected && x.token && !x.correct).length} | ${r.filter((x) => !x.expected && x.token && !x.correct).length} | ${r.filter((x) => x.expected && !x.token).length} |`;
    const certs = rows.filter((x) => x.kind === 'cert');
    const byKind = [
      line('pos', rows.filter((x) => x.kind === 'pos')),
      line('skill', rows.filter((x) => x.kind === 'skill')),
      line('cert, a worker’s claim', certs.filter((x) => x.as === 'worker')),
      line('cert, a hirer’s requirement', certs.filter((x) => x.as !== 'worker')),
    ];
    const decisions = [...new Set(rows.map((r) => r.decision))].map((d) => `${d} ${rows.filter((r) => r.decision === d).length}`).join(', ');
    const positives = rows.filter((r) => r.expectedCos != null).map((r) => r.expectedCos!);
    const negatives = rows.filter((r) => r.expected == null).map((r) => r.top);
    const nCert = certificates.tokens.length;
    const md = [
      `# Canonicalization evaluation, ${date}`,
      '',
      `Retrieve-then-choose over the synthetic occupation and skill seed (\`test/fixtures/work/registry-seed.json\`, no ESCO data) and the curated certificate seed (\`src/services/work/certificates.json\`: ${nCert} certificates), ${tokens.length} tokens and ${labels.length} labels in en, pt and es, each of ${rows.length} strings against a fresh copy, with \`${await inference.model('work-embed')}\`, \`${await inference.model('work-adjudicate')}\` and \`${await inference.model('work-pivot')}\` over the Workers AI REST API from the Mac. τ_auto ${tau.auto}, τ_low ${tau.low}. A certificate is right only with its level and modules; one where none fits is right only when nothing snaps.`,
      '',
      '| Kind | Right | Wrong token or level | A token where none fits | No token where one fits |',
      '|---|---|---|---|---|',
      ...byKind,
      '',
      `Decisions: ${decisions}. Cost per snap ${(rows.reduce((s, r) => s + r.costMicroUsd, 0) / rows.length / 1e6).toFixed(6)} USD, median ${[...rows.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(rows.length / 2)]} ms.`,
      '',
      `Cosine of the expected token's best label: min ${Math.min(...positives).toFixed(3)}, median ${positives.sort((a, b) => a - b)[Math.floor(positives.length / 2)]!.toFixed(3)}. Best cosine of strings with no fitting token: max ${Math.max(...negatives).toFixed(3)}.`,
      '',
      '| Kind | As | Language | String | Expected | Expected level, modules | Decision | Token | Level, modules | Top cos | Expected cos | Clef p |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|',
      ...rows.map(
        (r) =>
          `| ${r.kind} | ${r.as} | ${r.lang} | ${r.raw} | ${r.expected ?? '—'} | ${r.expectedFacets} | ${r.correct ? '' : '**'}${r.decision}${r.correct ? '' : '**'} | ${r.token ?? '—'} | ${r.facets} | ${r.top} | ${r.expectedCos ?? '—'} | ${r.probability == null ? '—' : r.probability.toFixed(2)} |`,
      ),
      '',
    ].join('\n');
    writeFileSync(join(__dirname, 'work-eval', `registry-${date}.md`), md);
    expect(rows).toHaveLength(seed.expected.length);
  }, 1_800_000);
});
