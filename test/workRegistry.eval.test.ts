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
 * index for Vectorize), so one snap's alias or mint never helps the next. An
 * occupation or a skill is a worker's, with the market of their listing
 * (`market`, as `listings.ts` passes it). A certificate string is a worker's
 * claim, or, with a region, a hirer's requirement (no mint, the jurisdiction
 * left to the job's region); it is right only with the expected token, level
 * and modules. Records the decision, the token, Clef's probability and the
 * cosines that tune τ, and every band answer of Clef's, which the report
 * reads again at other floors, and writes `test/work-eval/registry-<date>.md`.
 *
 * With ESCO_DIR (the founder's ESCO download, `occupations_{en,pt,es}.csv`) a
 * second run snaps the strings of `test/fixtures/work/locale-cases.json`
 * against ESCO's occupations as loaded (`test/work-eval/escoRegistry.ts`, the
 * label vectors cached in ESCO_VECTORS, default ESCO_DIR): Brazil's and
 * Mexico's words for a trade, which ESCO's European Portuguese and Spanish
 * lack, and English false friends. It writes
 * `test/work-eval/registry-locale-<date>.md`.
 *
 *   cd cofferdam-api && WORK_EVAL=1 direnv exec .. yarn vitest run test/workRegistry.eval.test.ts -t synthetic
 *   cd cofferdam-api && WORK_EVAL=1 ESCO_DIR=~/Development/esco/import ESCO_VECTORS=~/Development/us-layer-data/cofferdam-import direnv exec .. yarn vitest run test/workRegistry.eval.test.ts -t ESCO
 *
 * WORK_TAU_AUTO and WORK_TAU_LOW try other bands, and WORK_EMBED_MODEL another
 * embedding model; either one adds itself to the reports' file names, and so
 * does WORK_EVAL_SUFFIX.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInference, type Inference } from '../src/services/inference/index.js';
import type { BlockLang } from '../src/services/work/blocks.js';
import { planCertificateImport } from '../src/services/work/certificates.js';
import { callCostMicroUsd } from '../src/services/work/meter.js';
import {
  D1RegistryStore,
  embedTexts,
  labelIdOf,
  labelNorm,
  parseTau,
  snap,
  tauFor,
  type RegistryDeps,
  type RegistryLabel,
  type RegistryToken,
  type SnapInput,
  type SnapResult,
  type TokenKind,
} from '../src/services/work/registry.js';
import { createRestAi } from './chat-eval/restAi.js';
import { sqliteD1 } from './fixtures/work/d1.js';
import { cosine, memoryIndex } from './fixtures/work/fakes.js';
import localeCases from './fixtures/work/locale-cases.json';
import seed from './fixtures/work/registry-seed.json';
import { escoOccupationRegistry, homePath } from './work-eval/escoRegistry.js';

const LIVE = process.env.WORK_EVAL === '1';
const ESCO_DIR = process.env.ESCO_DIR ? homePath(process.env.ESCO_DIR) : '';
const FLOORS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

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
  /** A worker's occupation or skill: the region of their listing. */
  market?: string;
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
  band: BandAnswer | null;
  ms: number;
  costMicroUsd: number;
}

/** One Clef call in the band: the token it picked, at what probability, and the probability of none. */
interface BandAnswer {
  pick: string | null;
  p: number;
  none: number;
}

interface Recorded {
  op: string;
  input: unknown;
  output?: unknown;
  /** The call threw (a timeout, a refused request): the snap failed closed, which says nothing of the models. */
  error?: string;
}

/** The inference seam with every call's input and answer, or its error, kept, so the report can read Clef's answers and the pivot's names. */
function recording(inner: Inference): { inference: Inference; take(): Recorded[] } {
  let calls: Recorded[] = [];
  return {
    inference: {
      model: (op) => inner.model(op),
      async run(op, input, call) {
        try {
          const output = await inner.run(op, input, call);
          calls.push({ op, input, output });
          return output;
        } catch (err) {
          calls.push({ op, input, error: err instanceof Error ? err.message : String(err) });
          throw err;
        }
      },
    },
    take() {
      const out = calls;
      calls = [];
      return out;
    },
  };
}

/** Attempts per snap: one whose hosted call threw (a REST timeout from the Mac) runs again on a fresh registry, so a failure the eval caused is not read as the registry's. */
const ATTEMPTS = 3;

async function snapRecorded(
  recorder: ReturnType<typeof recording>,
  fresh: () => Promise<Pick<RegistryDeps, 'store' | 'index'>>,
  deps: Omit<RegistryDeps, 'store' | 'index'>,
  input: SnapInput,
): Promise<{ out: SnapResult; recorded: Recorded[]; errors: string[]; attempts: number; ms: number }> {
  for (let attempt = 1; ; attempt++) {
    const registry = await fresh();
    recorder.take();
    const t0 = Date.now();
    const out = await snap({ ...deps, ...registry }, input);
    const ms = Date.now() - t0;
    const recorded = recorder.take();
    const errors = recorded.filter((r) => r.error).map((r) => `${r.op}: ${r.error}`);
    if (!errors.length || attempt >= ATTEMPTS) return { out, recorded, errors, attempts: attempt, ms };
    // A dropped connection from the Mac can last seconds: wait before the next attempt.
    await new Promise((r) => setTimeout(r, 5_000 * attempt));
  }
}

/** Clef's band answer for a snap, its candidate keys read as the snap's candidates. */
function bandAnswer(recorded: readonly Recorded[], out: SnapResult): BandAnswer | null {
  const call = recorded.find((r) => r.op === 'work-adjudicate' && r.output !== undefined);
  if (!call) return null;
  const match = (call.output as { answers?: { match?: { choice?: unknown; probabilities?: Record<string, unknown> } } } | null)?.answers?.match;
  const probabilities = match?.probabilities ?? {};
  const p = (key: unknown) => (typeof key === 'string' && typeof probabilities[key] === 'number' ? probabilities[key] : 0);
  const choice = typeof match?.choice === 'string' ? match.choice : null;
  const pick = choice === 'none' ? 'none' : choice && /^c\d$/.test(choice) ? (out.candidates[Number(choice.slice(1))]?.token ?? null) : null;
  return { pick, p: p(choice), none: p('none') };
}

/** The pivot's English name for a snap, as the model wrote it. */
function pivotName(recorded: readonly Recorded[]): string | null {
  const call = recorded.find((r) => r.op === 'work-pivot' && r.output !== undefined);
  if (!call) return null;
  const o = call.output as { response?: unknown; choices?: { message?: { content?: unknown } }[] } | null;
  const answer = o?.response && typeof o.response === 'object' ? o.response : (() => {
    try {
      return JSON.parse(String(o?.choices?.[0]?.message?.content ?? 'null')) as unknown;
    } catch {
      return null;
    }
  })();
  const english = (answer as { english?: unknown } | null)?.english;
  return typeof english === 'string' ? english : null;
}

/** Every band answer read again at each floor: a pick of the right token, a pick of another, none, and below the floor. */
function floorSweep(answers: { band: BandAnswer; right: (token: string) => boolean }[]): string[] {
  return FLOORS.map((f) => {
    const at = answers.filter((a) => a.band.pick && a.band.pick !== 'none' && a.band.p >= f);
    const right = at.filter((a) => a.right(a.band.pick!)).length;
    const none = answers.filter((a) => a.band.pick === 'none' && a.band.p >= f).length;
    const below = answers.length - at.length - none;
    return `| ${f} | ${right} | ${at.length - right} | ${none} | ${below} |`;
  });
}

const facetText = (level: string | null | undefined, modules: readonly string[] | undefined) => [level, ...(modules ?? [])].filter(Boolean).join(', ') || '—';
const bandText = (b: BandAnswer | null) => (b ? `${b.pick ?? '—'} ${b.p.toFixed(2)}, none ${b.none.toFixed(2)}` : '—');
const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 1000) / 10}%` : '—');
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

function liveInference(): Inference {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) throw new Error('WORK_EVAL needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
  // WORK_EMBED_MODEL tries another embedding model (2026-10-25: @cf/google/embeddinggemma-300m against bge-m3).
  return createInference({ WORK_EMBED_MODEL: process.env.WORK_EMBED_MODEL }, { ai: createRestAi({ accountId, token }) })!;
}

function reportSuffix(tau: { auto: number; low: number }): string {
  const embed = process.env.WORK_EMBED_MODEL ? `-${process.env.WORK_EMBED_MODEL.split('/').pop()}` : '';
  const band = process.env.WORK_TAU_AUTO || process.env.WORK_TAU_LOW ? `-tau-${tau.auto}-${tau.low}` : '';
  return `${embed}${band}${process.env.WORK_EVAL_SUFFIX ?? ''}`;
}

describe.skipIf(!LIVE)('canonicalization evaluation (live, Workers AI)', () => {
  it('snaps every expected string against a fresh synthetic seed and writes the report', async () => {
    const recorder = recording(liveInference());
    const inference = recorder.inference;
    const tau = tauFor(await inference.model('work-embed'), parseTau(process.env.WORK_TAU_AUTO, process.env.WORK_TAU_LOW));

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
      // A model's first calls can outlast the op's 10 s while it starts (EmbeddingGemma, 2026-10-25): try four times.
      let reason = '';
      let e = await embedTexts(inference, labels.slice(i, i + 50).map((l) => l.label), { role: 'document', log: (entry) => (reason = JSON.stringify(entry)) });
      for (let attempt = 1; !e.ok && attempt < 4; attempt++) {
        e = await embedTexts(inference, labels.slice(i, i + 50).map((l) => l.label), { role: 'document', log: (entry) => (reason = JSON.stringify(entry)) });
      }
      if (!e.ok) throw new Error(`seed embedding failed at label ${i}: ${reason} after ${e.call.ms} ms`);
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
    const failed: string[] = [];
    let retried = 0;
    for (const x of seed.expected as Expected[]) {
      // As a listing snaps them (`claimSnapInput`): a worker's occupation or skill with its market, a certificate claim without.
      const input: SnapInput = {
        kind: x.kind,
        raw: x.raw,
        lang: x.lang,
        ...(x.region ? { mint: false, region: x.region } : {}),
        ...(x.market && x.kind !== 'cert' ? { market: x.market } : {}),
      };
      const { out, recorded, errors, attempts, ms } = await snapRecorded(recorder, freshRegistry, { inference, tau }, input);
      if (attempts > 1) retried++;
      if (errors.length) failed.push(`${x.raw}: ${errors.join('; ')}`);
      const band = bandAnswer(recorded, out);
      let rawVec = await embedTexts(inference, [x.raw], { role: 'query' });
      for (let attempt = 1; !rawVec.ok && attempt < ATTEMPTS; attempt++) rawVec = await embedTexts(inference, [x.raw], { role: 'query' });
      recorder.take();
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
        as: x.region ? `hirer, ${x.region}` : input.market ? `worker, ${input.market}` : 'worker',
        expected: x.token,
        expectedFacets: x.token ? facetText(x.level, x.modules) : '—',
        decision: out.decision,
        token: out.token,
        facets: out.token ? facetText(out.facets?.level, out.facets?.modules) : '—',
        correct,
        top: Math.round(top * 1000) / 1000,
        expectedCos: expectedCos == null ? null : Math.round(expectedCos * 1000) / 1000,
        probability: out.probability,
        band,
        ms,
        costMicroUsd: out.calls.reduce((s, c) => s + callCostMicroUsd(c), 0),
      });
      console.log(`${correct ? 'ok  ' : 'MISS'} ${x.kind} ${x.raw}${x.region ? ` @${x.region}` : ''}${x.market ? ` (${x.market})` : ''} → ${out.decision} ${out.token ?? ''} ${out.facets ? facetText(out.facets.level, out.facets.modules) : ''}`);
    }

    const date = new Date().toISOString().slice(0, 10);
    const line = (label: string, r: Row[]) =>
      `| ${label} | ${pct(r.filter((x) => x.correct).length, r.length)} (${r.filter((x) => x.correct).length} of ${r.length}) | ${r.filter((x) => x.expected && x.token && !x.correct).length} | ${r.filter((x) => !x.expected && x.token && !x.correct).length} | ${r.filter((x) => x.expected && !x.token).length} |`;
    const certs = rows.filter((x) => x.kind === 'cert');
    const byKind = [
      line('pos', rows.filter((x) => x.kind === 'pos')),
      line('skill', rows.filter((x) => x.kind === 'skill')),
      line('cert, a worker’s claim', certs.filter((x) => !x.as.startsWith('hirer'))),
      line('cert, a hirer’s requirement', certs.filter((x) => x.as.startsWith('hirer'))),
    ];
    const decisions = [...new Set(rows.map((r) => r.decision))].map((d) => `${d} ${rows.filter((r) => r.decision === d).length}`).join(', ');
    const positives = rows.filter((r) => r.expectedCos != null).map((r) => r.expectedCos!);
    const negatives = rows.filter((r) => r.expected == null).map((r) => r.top);
    const banded = rows.filter((r): r is Row & { band: BandAnswer } => r.band != null).map((r) => ({ band: r.band, right: (t: string) => t === r.expected }));
    const nCert = certificates.tokens.length;
    const md = [
      `# Canonicalization evaluation, ${date}`,
      '',
      `Retrieve-then-choose over the synthetic occupation and skill seed (\`test/fixtures/work/registry-seed.json\`, no ESCO data) and the curated certificate seed (\`src/services/work/certificates.json\`: ${nCert} certificates), ${tokens.length} tokens and ${labels.length} labels in en, pt and es, each of ${rows.length} strings against a fresh copy, with \`${await inference.model('work-embed')}\`, \`${await inference.model('work-adjudicate')}\` and \`${await inference.model('work-pivot')}\` over the Workers AI REST API from the Mac. τ_auto ${tau.auto}, τ_low ${tau.low}. An occupation or a skill is a worker's, with their listing's market. A certificate is right only with its level and modules; one where none fits is right only when nothing snaps.`,
      '',
      '| Kind | Right | Wrong token or level | A token where none fits | No token where one fits |',
      '|---|---|---|---|---|',
      ...byKind,
      '',
      `Decisions: ${decisions}. Cost per snap ${(rows.reduce((s, r) => s + r.costMicroUsd, 0) / rows.length / 1e6).toFixed(6)} USD, median ${median(rows.map((r) => r.ms))} ms. ${retried} snaps ran again after a hosted call threw; ${failed.length ? `${failed.length} still failed: ${failed.join('; ')}` : 'none still failed'}.`,
      '',
      `Cosine of the expected token's best label: min ${Math.min(...positives).toFixed(3)}, median ${median(positives).toFixed(3)}. Best cosine of strings with no fitting token: max ${Math.max(...negatives).toFixed(3)}.`,
      '',
      `Clef answered ${banded.length} strings in the band. Each answer read again at other floors (the shipped floor is 0.5): a pick counts at or above the floor, none too, and anything else is undecided.`,
      '',
      '| Floor | Picked the expected token | Picked another | None | Below the floor |',
      '|---|---|---|---|---|',
      ...floorSweep(banded),
      '',
      '| Kind | As | Language | String | Expected | Expected level, modules | Decision | Token | Level, modules | Top cos | Expected cos | Clef p | Clef band answer |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
      ...rows.map(
        (r) =>
          `| ${r.kind} | ${r.as} | ${r.lang} | ${r.raw} | ${r.expected ?? '—'} | ${r.expectedFacets} | ${r.correct ? '' : '**'}${r.decision}${r.correct ? '' : '**'} | ${r.token ?? '—'} | ${r.facets} | ${r.top} | ${r.expectedCos ?? '—'} | ${r.probability == null ? '—' : r.probability.toFixed(2)} | ${bandText(r.band)} |`,
      ),
      '',
    ].join('\n');
    writeFileSync(join(__dirname, 'work-eval', `registry-${date}${reportSuffix(tau)}.md`), md);
    expect(rows).toHaveLength(seed.expected.length);
  }, 1_800_000);
});

interface LocaleCase {
  group: string;
  kind: TokenKind;
  lang: BlockLang;
  market: string;
  raw: string;
  right: string[];
  none?: boolean;
  wrong?: string[];
}

describe.skipIf(!LIVE || !ESCO_DIR)('regional words and false friends on ESCO (live, Workers AI, the founder’s download)', () => {
  it('snaps each market-tagged string against ESCO’s occupations as loaded and writes the report', async () => {
    const recorder = recording(liveInference());
    const inference = recorder.inference;
    const tau = tauFor(await inference.model('work-embed'), parseTau(process.env.WORK_TAU_AUTO, process.env.WORK_TAU_LOW));
    const registry = await escoOccupationRegistry(inference, ESCO_DIR, homePath(process.env.ESCO_VECTORS ?? ESCO_DIR));

    const rows: {
      c: LocaleCase;
      out: SnapResult;
      verdict: 'right' | 'false friend' | 'other';
      band: BandAnswer | null;
      pivot: string | null;
      state: string | null;
      costMicroUsd: number;
    }[] = [];
    const failed: string[] = [];
    let retried = 0;
    const fresh = async () => {
      registry.reset();
      return registry;
    };
    for (const c of localeCases.cases as LocaleCase[]) {
      const { out, recorded, errors, attempts } = await snapRecorded(recorder, fresh, { inference, tau }, { kind: c.kind, raw: c.raw, lang: c.lang, market: c.market });
      if (attempts > 1) retried++;
      if (errors.length) failed.push(`${c.raw}: ${errors.join('; ')}`);
      const existing = out.token && out.decision !== 'minted' ? out.token : null;
      const verdict = existing ? (c.right.includes(existing) ? 'right' : c.wrong?.includes(existing) ? 'false friend' : 'other') : c.none ? 'right' : 'other';
      const clef = recorded.find((r) => r.op === 'work-adjudicate' && r.output !== undefined)?.input as { state?: string; questions?: { match?: { criteria?: Record<string, string> } } } | undefined;
      const told = clef?.state ? [clef.state, '', ...Object.entries(clef.questions?.match?.criteria ?? {}).map(([k, v]) => `${k}: ${v}`)].join('\n') : null;
      rows.push({ c, out, verdict, band: bandAnswer(recorded, out), pivot: pivotName(recorded), state: told, costMicroUsd: out.calls.reduce((s, x) => s + callCostMicroUsd(x), 0) });
      console.log(`${verdict === 'right' ? 'ok  ' : 'MISS'} ${c.lang}/${c.market} ${c.raw} → ${out.decision} ${out.token ?? ''}`);
    }

    const date = new Date().toISOString().slice(0, 10);
    const groups = [...new Set(rows.map((r) => r.c.group))];
    const banded = rows
      .filter((r): r is typeof r & { band: BandAnswer } => r.band != null)
      .map((r) => ({ band: r.band, right: (t: string) => r.c.right.includes(t) }));
    const shown = (out: SnapResult) =>
      out.candidates
        .slice(0, 5)
        .map((x) => `${x.token} "${x.matched}" ${x.matchedLang ?? '?'} ${x.score.toFixed(3)}`)
        .join('; ') || '—';
    const md = [
      `# Regional words and false friends on ESCO, ${date}`,
      '',
      `${rows.length} synthetic strings (\`test/fixtures/work/locale-cases.json\`), each with the market of the worker who wrote it, snapped against ESCO v1.2.1's occupations as loaded (${registry.tokens} tokens, ${registry.labels} labels in en, pt and es; \`test/work-eval/escoRegistry.ts\`), each against the registry as loaded, with \`${await inference.model('work-embed')}\`, \`${await inference.model('work-adjudicate')}\` and \`${await inference.model('work-pivot')}\` over the Workers AI REST API from the Mac. τ_auto ${tau.auto}, τ_low ${tau.low}. Right: one of the expected tokens, or, where no token fits, none or a new one; a false friend is the token ESCO's Spanish or Portuguese gives the word.`,
      '',
      '| Group | Right | A false friend | Another token |',
      '|---|---|---|---|',
      ...groups.map((g) => {
        const r = rows.filter((x) => x.c.group === g);
        return `| ${g} | ${r.filter((x) => x.verdict === 'right').length} of ${r.length} | ${r.filter((x) => x.verdict === 'false friend').length} | ${r.filter((x) => x.verdict === 'other').length} |`;
      }),
      '',
      `Cost per snap ${(rows.reduce((s, r) => s + r.costMicroUsd, 0) / rows.length / 1e6).toFixed(6)} USD. ${retried} snaps ran again after a hosted call threw; ${failed.length ? `${failed.length} still failed: ${failed.join('; ')}` : 'none still failed'}.`,
      '',
      `Clef answered ${banded.length} strings in the band. Each answer read again at other floors (the shipped floor is 0.5):`,
      '',
      '| Floor | Picked an expected token | Picked another | None | Below the floor |',
      '|---|---|---|---|---|',
      ...floorSweep(banded),
      '',
      '| Group | String | Language, market | Expected | Decision | Token | Clef band answer | Pivot | Nearest candidates (token, matched label, language, cosine) |',
      '|---|---|---|---|---|---|---|---|---|',
      ...rows.map(
        (r) =>
          `| ${r.c.group} | ${r.c.raw} | ${r.c.lang}, ${r.c.market} | ${[...r.c.right, ...(r.c.none ? ['none'] : [])].join(', ')} | ${r.verdict === 'right' ? '' : '**'}${r.out.decision}${r.verdict === 'right' ? '' : '**'} | ${r.out.token ?? '—'} | ${bandText(r.band)} | ${r.pivot ?? '—'} | ${shown(r.out)} |`,
      ),
      '',
      'What Clef was told (the state and the `match` criteria), for the first string of each group that reached it:',
      '',
      ...groups.flatMap((g) => {
        const told = rows.find((r) => r.c.group === g && r.state)?.state;
        return told ? ['```', told, '```', ''] : [];
      }),
    ].join('\n');
    writeFileSync(join(__dirname, 'work-eval', `registry-locale-${date}${reportSuffix(tau)}.md`), md);
    expect(rows).toHaveLength(localeCases.cases.length);
  }, 3_600_000);
});
