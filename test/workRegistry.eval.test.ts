// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The canonicalization evaluation (opt-in: WORK_EVAL=1): retrieve-then-choose
 * (`services/work/registry.ts`) with the real models, bge-m3, clef-flash and
 * the JSON-mode pivot, over the synthetic occupation, skill and certificate
 * seed in `test/fixtures/work/registry-seed.json` (no ESCO data: its codes
 * come only from the founder's download; its certificates are test data,
 * since the plane holds none until a Vault document mints one, workspace
 * decision 0070). Each expected string snaps against a fresh copy of it, in
 * memory (node:sqlite for D1, a cosine index for Vectorize), so one snap's
 * alias or mint never helps the next. An occupation or a skill is a
 * worker's, with the market of their listing (`market`, as `listings.ts`
 * passes it). A certificate snaps as a skill does, without a market and
 * never minted, a worker's claim and a hirer's words alike; one where no
 * token fits is right only when nothing snaps. Records the decision, the
 * token, Clef's probability and the cosines that tune τ, and every band
 * answer of Clef's, which the report reads again at other floors, and writes
 * `test/work-eval/registry-<date>.md`.
 *
 * With ESCO_DIR (the founder's ESCO download, `occupations_{en,pt,es}.csv`) a
 * second run snaps the strings of `test/fixtures/work/locale-cases.json`
 * against ESCO's occupations as loaded (`test/work-eval/escoRegistry.ts`, the
 * label vectors cached in ESCO_VECTORS, default ESCO_DIR): Brazil's and
 * Mexico's words for a trade, which ESCO's European Portuguese and Spanish
 * lack, and English false friends. It writes
 * `test/work-eval/registry-locale-<date>.md`. These two embed on Workers AI,
 * as production does until the v3 generation (bge-m3 today).
 *
 * With V3_DIR, ESCO_SQL and US_SQL a third run snaps the same strings on the
 * v3 generation: the registry replica (`test/work-eval/replica.ts`: ESCO and
 * the US layer, EmbeddingGemma 2's v3 vectors at 768, no certificate token)
 * and each string embedded as the phone embeds it (llama-embedding, the same
 * GGUF), in three arms: the hosted requests as they were before the locale,
 * the language alone, and with the listing's market. It writes
 * `test/work-eval/registry-locale-v3-<date>.md`.
 *
 *   cd cofferdam-api && WORK_EVAL=1 direnv exec .. yarn vitest run test/workRegistry.eval.test.ts -t synthetic
 *   cd cofferdam-api && WORK_EVAL=1 ESCO_DIR=~/Development/esco/import ESCO_VECTORS=~/Development/us-layer-data/cofferdam-import direnv exec .. yarn vitest run test/workRegistry.eval.test.ts -t ESCO
 *   cd cofferdam-api && WORK_EVAL=1 V3_DIR=~/Development/esco/import/registry-embeddinggemma-2 ESCO_SQL=~/Development/esco/import/cofferdam-import \
 *     US_SQL=~/Development/us-layer-data/cofferdam-import direnv exec .. yarn vitest run test/workRegistry.eval.test.ts -t v3
 *
 * With the same three, a fourth run measures the English pivot in the band
 * (workspace decision 0018, amendment proposed 2026-10-30) on the v2 engine:
 * that replica with EmbeddingGemma 2's GGUF vectors (the v2 generation's
 * LiteRT-LM vectors match them at a median cosine of 0.990), in two arms,
 * production's requests with the listing's market, and the same with the
 * pivot in the band. It writes
 * `test/work-eval/registry-pivot-band-v2-engine-<date>.md`.
 *
 *   cd cofferdam-api && WORK_EVAL=1 V3_DIR=~/Development/esco/import/registry-embeddinggemma-2 ESCO_SQL=~/Development/esco/import/cofferdam-import \
 *     US_SQL=~/Development/us-layer-data/cofferdam-import direnv exec .. yarn vitest run test/workRegistry.eval.test.ts -t "pivot in the band"
 *
 * WORK_TAU_AUTO and WORK_TAU_LOW try other bands, WORK_EMBED_MODEL another
 * embedding model, and WORK_PIVOT_BAND=1 puts the English pivot in the band in
 * the first two runs; each one adds itself to the reports' file names, and so
 * does WORK_EVAL_SUFFIX.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInference, type Inference } from '../src/services/inference/index.js';
import type { BlockLang } from '../src/services/work/blocks.js';
import { callCostMicroUsd } from '../src/services/work/meter.js';
import {
  D1RegistryStore,
  EMBEDDINGGEMMA_2_GGUF,
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
import { embedAll, loadReplica, ReplicaIndex } from './work-eval/replica.js';

const LIVE = process.env.WORK_EVAL === '1';
const ESCO_DIR = process.env.ESCO_DIR ? homePath(process.env.ESCO_DIR) : '';
const FLOORS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
/** The English pivot in the band in the first two runs (`RegistryDeps.pivotBand`, as `WORK_PIVOT_BAND` sets it on the plane). */
const PIVOT_BAND = process.env.WORK_PIVOT_BAND === '1';

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
  /** A worker's occupation or skill: the region of their listing. */
  market?: string;
}

interface Row {
  kind: TokenKind;
  lang: string;
  raw: string;
  as: string;
  expected: string | null;
  decision: string;
  token: string | null;
  correct: boolean;
  /** The best cosine of any seed label, and the best of the expected token's labels. */
  top: number;
  expectedCos: number | null;
  probability: number | null;
  band: BandAnswer | null;
  pivot: string;
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

/**
 * The inference seam with every call's input and answer, or its error, kept, so the report can read Clef's answers and
 * the pivot's names. A call the snap cancelled (the English pivot at a τ_auto take) is no error, and a call that ends
 * after its snap's calls were taken is dropped, so it is never read as the next snap's.
 */
function recording(inner: Inference): { inference: Inference; take(): Recorded[] } {
  let calls: Recorded[] = [];
  let round = 0;
  return {
    inference: {
      model: (op) => inner.model(op),
      async run(op, input, call) {
        const at = round;
        try {
          const output = await inner.run(op, input, call);
          if (at === round) calls.push({ op, input, output });
          return output;
        } catch (err) {
          if (at === round && !call?.signal?.aborted) calls.push({ op, input, error: err instanceof Error ? err.message : String(err) });
          throw err;
        }
      },
    },
    take() {
      const out = calls;
      calls = [];
      round++;
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
  // The nearest candidates are c0, c1, …; the English pivot's token, when the band showed it after them, the next key.
  const entry = (i: number) => (i < out.candidates.length ? out.candidates[i]!.token : i === out.candidates.length && out.pivot?.added ? out.pivot.token : null);
  const pick = choice === 'none' ? 'none' : choice && /^c\d$/.test(choice) ? entry(Number(choice.slice(1))) : null;
  return { pick, p: p(choice), none: p('none') };
}

/** The English pivot as a snap read it: the name, then the token it names, and whether the band showed that token to Clef after the nearest candidates. */
function pivotText(out: SnapResult, recorded: readonly Recorded[]): string {
  const name = out.pivot?.english ?? pivotName(recorded);
  if (!name) return '—';
  if (!out.pivot) return name;
  return `${name} → ${out.pivot.token ?? 'no token'}${out.pivot.added ? ' (in the band)' : ''}`;
}

/**
 * What the English pivot did in the band, over the strings that asked it there (a worker's Portuguese or Spanish
 * string with the pivot in the band): how often its name named a token, shown after the nearest five or already among
 * them, and what became of that token: Clef's choice, Clef's none (a refusal), or step 3 on an answer under the floor.
 */
function pivotBandLine(rows: readonly { c: { lang: string }; out: SnapResult; band: BandAnswer | null }[]): string {
  const inBand = rows.filter((r) => r.c.lang !== 'en' && r.band && r.out.pivot?.token);
  const added = inBand.filter((r) => r.out.pivot!.added).length;
  const chose = inBand.filter((r) => r.out.decision === 'chosen' && r.out.token === r.out.pivot!.token).length;
  const refused = inBand.filter((r) => r.out.decision === 'unmatched' && r.band!.pick === 'none').length;
  const undecided = inBand.filter((r) => r.out.decision === 'pivot').length;
  return `In the band, the English name named a token for ${inBand.length} strings: shown after the nearest five ${added} times, already among them ${inBand.length - added} times. Clef chose that token ${chose} times, chose another ${inBand.length - chose - refused - undecided} times and refused it with its none ${refused} times; ${undecided} times Clef answered under its floor and step 3 took it.`;
}

/** The hosted calls a snap made, per snap, and each op's median time (from the Mac, over the REST API); a pivot a τ_auto take left unread counts as a call. */
function callStats(outs: readonly SnapResult[]): string {
  const ops = ['work-embed', 'work-pivot', 'work-adjudicate'] as const;
  const unread = outs.filter((o) => o.decision === 'auto' && o.calls.some((c) => c.op === 'work-pivot')).length;
  const parts = ops.map((op) => {
    const calls = outs.flatMap((o) => o.calls.filter((c) => c.op === op));
    return `${op} ${(calls.length / Math.max(1, outs.length)).toFixed(2)} a snap${calls.length ? ` (median ${median(calls.filter((c) => c.ok).map((c) => c.ms))} ms answered)` : ''}`;
  });
  return `${parts.join(', ')}; ${unread} pivot calls a τ_auto take left unread (cancelled while running, or metered as answered)`;
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
  return `${embed}${band}${PIVOT_BAND ? '-pivot-band' : ''}${process.env.WORK_EVAL_SUFFIX ?? ''}`;
}

describe.skipIf(!LIVE)('canonicalization evaluation (live, Workers AI)', () => {
  it('snaps every expected string against a fresh synthetic seed and writes the report', async () => {
    const recorder = recording(liveInference());
    const inference = recorder.inference;
    const tau = tauFor(await inference.model('work-embed'), parseTau(process.env.WORK_TAU_AUTO, process.env.WORK_TAU_LOW));

    // The synthetic seed, as rows and labels.
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
    const outs: SnapResult[] = [];
    const failed: string[] = [];
    let retried = 0;
    for (const x of seed.expected as Expected[]) {
      // As a listing snaps them (`claimSnapInput`): a worker's occupation or skill with its market, a certificate without.
      const input: SnapInput = { kind: x.kind, raw: x.raw, lang: x.lang, ...(x.market && x.kind !== 'cert' ? { market: x.market } : {}) };
      const { out, recorded, errors, attempts, ms } = await snapRecorded(recorder, freshRegistry, { inference, tau, pivotBand: PIVOT_BAND }, input);
      outs.push(out);
      if (attempts > 1) retried++;
      if (errors.length) failed.push(`${x.raw}: ${errors.join('; ')}`);
      const band = bandAnswer(recorded, out);
      let rawVec = await embedTexts(inference, [x.raw], { role: 'query' });
      for (let attempt = 1; !rawVec.ok && attempt < ATTEMPTS; attempt++) rawVec = await embedTexts(inference, [x.raw], { role: 'query' });
      recorder.take();
      const cosines = rawVec.ok ? labels.map((l, i) => ({ l, c: kindOf.get(l.token) === x.kind ? cosine(rawVec.vectors[0]!, vectors[i]!) : -1 })) : [];
      const top = Math.max(-1, ...cosines.map((c) => c.c));
      const expectedCos = x.token ? Math.max(-1, ...cosines.filter((c) => c.l.token === x.token).map((c) => c.c)) : null;
      const correct = x.token ? out.token === x.token : x.kind === 'cert' ? out.decision === 'unmatched' : out.decision === 'minted' || out.decision === 'unmatched';
      rows.push({
        kind: x.kind,
        lang: x.lang,
        raw: x.raw,
        as: input.market ? `worker, ${input.market}` : x.kind === 'cert' ? 'worker or hirer' : 'worker',
        expected: x.token,
        decision: out.decision,
        token: out.token,
        correct,
        top: Math.round(top * 1000) / 1000,
        expectedCos: expectedCos == null ? null : Math.round(expectedCos * 1000) / 1000,
        probability: out.probability,
        band,
        pivot: pivotText(out, recorded),
        ms,
        costMicroUsd: out.calls.reduce((s, c) => s + callCostMicroUsd(c), 0),
      });
      console.log(`${correct ? 'ok  ' : 'MISS'} ${x.kind} ${x.raw}${input.market ? ` (${input.market})` : ''} → ${out.decision} ${out.token ?? ''}`);
    }

    const date = new Date().toISOString().slice(0, 10);
    const line = (label: string, r: Row[]) =>
      `| ${label} | ${pct(r.filter((x) => x.correct).length, r.length)} (${r.filter((x) => x.correct).length} of ${r.length}) | ${r.filter((x) => x.expected && x.token && !x.correct).length} | ${r.filter((x) => !x.expected && x.token && !x.correct).length} | ${r.filter((x) => x.expected && !x.token).length} |`;
    const byKind = (['pos', 'skill', 'cert'] as const).map((k) => line(k, rows.filter((x) => x.kind === k)));
    const decisions = [...new Set(rows.map((r) => r.decision))].map((d) => `${d} ${rows.filter((r) => r.decision === d).length}`).join(', ');
    const positives = rows.filter((r) => r.expectedCos != null).map((r) => r.expectedCos!);
    const negatives = rows.filter((r) => r.expected == null).map((r) => r.top);
    const banded = rows.filter((r): r is Row & { band: BandAnswer } => r.band != null).map((r) => ({ band: r.band, right: (t: string) => t === r.expected }));
    const nCert = tokens.filter((t) => t.kind === 'cert').length;
    const md = [
      `# Canonicalization evaluation, ${date}`,
      '',
      `Retrieve-then-choose over the synthetic seed (\`test/fixtures/work/registry-seed.json\`, no ESCO data; its ${nCert} certificates are test data, since the plane holds none until a Vault document mints one, workspace decision 0070), ${tokens.length} tokens and ${labels.length} labels in en, pt and es, each of ${rows.length} strings against a fresh copy, with \`${await inference.model('work-embed')}\`, \`${await inference.model('work-adjudicate')}\` and \`${await inference.model('work-pivot')}\` over the Workers AI REST API from the Mac. τ_auto ${tau.auto}, τ_low ${tau.low}. An occupation or a skill is a worker's, with their listing's market. A certificate snaps as a skill does, without a market and never minted, a worker's claim and a hirer's words alike; one where no token fits is right only when nothing snaps. The English pivot in the band (workspace decision 0018, amendment proposed 2026-10-30): ${PIVOT_BAND ? 'on, so a worker\'s Portuguese or Spanish occupation or skill asks the pivot beside the embedding, and Clef is shown the token its English name names' : 'off, as on the plane today'}.`,
      '',
      '| Kind | Right | Wrong token | A token where none fits | No token where one fits |',
      '|---|---|---|---|---|',
      ...byKind,
      '',
      `Decisions: ${decisions}. Cost per snap ${(rows.reduce((s, r) => s + r.costMicroUsd, 0) / rows.length / 1e6).toFixed(6)} USD, median ${median(rows.map((r) => r.ms))} ms. ${retried} snaps ran again after a hosted call threw; ${failed.length ? `${failed.length} still failed: ${failed.join('; ')}` : 'none still failed'}.`,
      '',
      `Calls: ${callStats(outs)}.`,
      '',
      `Cosine of the expected token's best label: min ${Math.min(...positives).toFixed(3)}, median ${median(positives).toFixed(3)}. Best cosine of strings with no fitting token: max ${Math.max(...negatives).toFixed(3)}.`,
      '',
      `Clef answered ${banded.length} strings in the band. Each answer read again at other floors (the shipped floor is 0.5): a pick counts at or above the floor, none too, and anything else is undecided.`,
      '',
      '| Floor | Picked the expected token | Picked another | None | Below the floor |',
      '|---|---|---|---|---|',
      ...floorSweep(banded),
      '',
      '| Kind | As | Language | String | Expected | Decision | Token | Top cos | Expected cos | Clef p | Clef band answer | Pivot |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|',
      ...rows.map(
        (r) =>
          `| ${r.kind} | ${r.as} | ${r.lang} | ${r.raw} | ${r.expected ?? '—'} | ${r.correct ? '' : '**'}${r.decision}${r.correct ? '' : '**'} | ${r.token ?? '—'} | ${r.top} | ${r.expectedCos ?? '—'} | ${r.probability == null ? '—' : r.probability.toFixed(2)} | ${bandText(r.band)} | ${r.pivot} |`,
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
      pivot: string;
      state: string | null;
      ms: number;
      costMicroUsd: number;
    }[] = [];
    const failed: string[] = [];
    let retried = 0;
    const fresh = async () => {
      registry.reset();
      return registry;
    };
    for (const c of localeCases.cases as LocaleCase[]) {
      const { out, recorded, errors, attempts, ms } = await snapRecorded(recorder, fresh, { inference, tau, pivotBand: PIVOT_BAND }, { kind: c.kind, raw: c.raw, lang: c.lang, market: c.market });
      if (attempts > 1) retried++;
      if (errors.length) failed.push(`${c.raw}: ${errors.join('; ')}`);
      const existing = out.token && out.decision !== 'minted' ? out.token : null;
      const verdict = existing ? (c.right.includes(existing) ? 'right' : c.wrong?.includes(existing) ? 'false friend' : 'other') : c.none ? 'right' : 'other';
      const clef = recorded.find((r) => r.op === 'work-adjudicate' && r.output !== undefined)?.input as { state?: string; questions?: { match?: { criteria?: Record<string, string> } } } | undefined;
      const told = clef?.state ? [clef.state, '', ...Object.entries(clef.questions?.match?.criteria ?? {}).map(([k, v]) => `${k}: ${v}`)].join('\n') : null;
      rows.push({ c, out, verdict, band: bandAnswer(recorded, out), pivot: pivotText(out, recorded), state: told, ms, costMicroUsd: out.calls.reduce((s, x) => s + callCostMicroUsd(x), 0) });
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
      `${rows.length} synthetic strings (\`test/fixtures/work/locale-cases.json\`), each with the market of the worker who wrote it, snapped against ESCO v1.2.1's occupations as loaded (${registry.tokens} tokens, ${registry.labels} labels in en, pt and es; \`test/work-eval/escoRegistry.ts\`), each against the registry as loaded, with \`${await inference.model('work-embed')}\`, \`${await inference.model('work-adjudicate')}\` and \`${await inference.model('work-pivot')}\` over the Workers AI REST API from the Mac. τ_auto ${tau.auto}, τ_low ${tau.low}. Right: one of the expected tokens, or, where no token fits, none or a new one; a false friend is the token ESCO's Spanish or Portuguese gives the word, or the one a generic English name holds as a label (workspace OD-28). The English pivot in the band (workspace decision 0018, amendment proposed 2026-10-30): ${PIVOT_BAND ? 'on, so a worker\'s Portuguese or Spanish string asks the pivot beside the embedding, and Clef is shown the token its English name names' : 'off, as on the plane today'}.`,
      '',
      '| Group | Right | A false friend or a generic name\'s token | Another token |',
      '|---|---|---|---|',
      ...groups.map((g) => {
        const r = rows.filter((x) => x.c.group === g);
        return `| ${g} | ${r.filter((x) => x.verdict === 'right').length} of ${r.length} | ${r.filter((x) => x.verdict === 'false friend').length} | ${r.filter((x) => x.verdict === 'other').length} |`;
      }),
      '',
      `All: ${rows.filter((r) => r.verdict === 'right').length} of ${rows.length} right.`,
      '',
      `Cost per snap ${(rows.reduce((s, r) => s + r.costMicroUsd, 0) / rows.length / 1e6).toFixed(6)} USD, median ${median(rows.map((r) => r.ms))} ms. ${retried} snaps ran again after a hosted call threw; ${failed.length ? `${failed.length} still failed: ${failed.join('; ')}` : 'none still failed'}.`,
      '',
      `Calls: ${callStats(rows.map((r) => r.out))}.`,
      '',
      ...(PIVOT_BAND ? [pivotBandLine(rows), ''] : []),
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

// ── The v3 generation: the phone's EmbeddingGemma 2 and the registry replica ───────

const V3_DIR = process.env.V3_DIR ? homePath(process.env.V3_DIR) : '';
const ESCO_SQL = process.env.ESCO_SQL ? homePath(process.env.ESCO_SQL) : '';
const US_SQL = process.env.US_SQL ? homePath(process.env.US_SQL) : '';

/**
 * The v3 run's arms, one registry and one embedding: the hosted requests as
 * they were before the registry read a string's locale (`beforeLocale`), the
 * language alone (no market), and production's (the language, the variant
 * and the market).
 */
const ARMS = ['before', 'language', 'market'] as const;
type Arm = (typeof ARMS)[number];

/** What the locale added to the pivot's system prompt (cofferdam-api 16ab6a8). */
const PIVOT_LOCALE_CLAUSE = ', with the language it is written in and, when known, where the worker who wrote it is';

/**
 * Production's requests as they were before the locale (cofferdam-api
 * 16ab6a8): Clef's state named the language by its code ("A occupation as a
 * worker or a hirer wrote it, in pt:", its article as it was), a candidate's
 * matched label carried no language, and the pivot read the bare string
 * under a prompt that named neither. The string is the state's last line, as
 * the registry normalized it.
 */
function beforeLocale(op: string, input: Record<string, unknown>, kind: TokenKind, lang: string): Record<string, unknown> {
  if (op === 'work-adjudicate' && typeof input.state === 'string') {
    const raw = input.state.split('\n').pop() ?? '';
    const questions = input.questions as Record<string, { criteria?: Record<string, string> }>;
    const match = questions.match;
    const criteria = match?.criteria && Object.fromEntries(Object.entries(match.criteria).map(([k, v]) => [k, v.replace(/ \(matched "(.*)", [^"()]+\)$/, ' (matched "$1")')]));
    const noun = { pos: 'occupation', skill: 'skill', cert: 'certificate or licence' }[kind];
    return { ...input, state: `A ${noun} as a worker or a hirer wrote it, in ${lang}:\n${raw}`, questions: match ? { ...questions, match: { ...match, ...(criteria ? { criteria } : {}) } } : questions };
  }
  if (op === 'work-pivot' && Array.isArray(input.messages)) {
    const messages = (input.messages as { role: string; content: string }[]).map((m) =>
      m.role === 'system' ? { ...m, content: m.content.replace(PIVOT_LOCALE_CLAUSE, '') } : m.role === 'user' ? { ...m, content: m.content.split('\n').pop() ?? '' } : m,
    );
    return { ...input, messages };
  }
  return input;
}

describe.skipIf(!LIVE || !V3_DIR || !ESCO_SQL || !US_SQL)('regional words and false friends on the v3 replica (live Clef and pivot, the phone’s EmbeddingGemma 2)', () => {
  it('snaps each market-tagged string before the locale, with its language only and with its market, and writes the report', async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !apiToken) throw new Error('WORK_EVAL needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    const seam = createInference({ WORK_EMBED_MODEL: EMBEDDINGGEMMA_2_GGUF }, { ai: createRestAi({ accountId, token: apiToken }) })!;
    let arm: Arm = 'market';
    let current: { kind: TokenKind; lang: string } = { kind: 'pos', lang: 'en' };
    const recorder = recording({
      model: (op) => seam.model(op),
      run: (op, input, call) => seam.run(op, arm === 'before' ? beforeLocale(op, input, current.kind, current.lang) : input, call),
    });
    const inference = recorder.inference;
    const tau = tauFor(EMBEDDINGGEMMA_2_GGUF, parseTau(process.env.WORK_TAU_AUTO, process.env.WORK_TAU_LOW));

    // The registry as the v3 generation holds it: ESCO, the US layer, their v3 vectors (no certificate token).
    const t0 = Date.now();
    const replica = await loadReplica(ESCO_SQL, US_SQL);
    const index = ReplicaIndex.load(V3_DIR);
    const loadedAt = Date.now();
    process.stdout.write(`replica: ${replica.tokens} tokens, ${replica.labels} labels, ${index.size} vectors, ${((loadedAt - t0) / 1000).toFixed(0)} s\n`);
    /** Back to the registry as loaded: what a snap added (aliases, mints and their vectors, decisions) goes. */
    const fresh = async () => {
      const added = replica.db.sqlite.prepare('SELECT label_id FROM registry_labels WHERE created_at >= ?').all(loadedAt) as { label_id: string }[];
      if (added.length) await index.deleteByIds(added.map((r) => r.label_id));
      for (const table of ['registry_decisions', 'registry_labels', 'registry_tokens']) replica.db.sqlite.prepare(`DELETE FROM ${table} WHERE created_at >= ?`).run(loadedAt);
      return { store: replica.store, index };
    };

    // The phone's vectors for each string, as llama-embedding makes them with the same GGUF.
    const cases = localeCases.cases as LocaleCase[];
    const key = (t: string) => t.replace(/\s+/g, ' ').trim();
    const queries = embedAll(cases.map((c) => c.raw), 'query');
    const documents = embedAll(cases.map((c) => c.raw), 'document');

    type V3Row = { c: LocaleCase; arm: Arm; out: SnapResult; verdict: 'right' | 'false friend' | 'other'; band: BandAnswer | null; pivot: string | null; state: string | null; costMicroUsd: number };
    const rows: V3Row[] = [];
    const failed: string[] = [];
    let retried = 0;
    for (const a of ARMS) {
      arm = a;
      for (const c of cases) {
        current = { kind: c.kind, lang: c.lang };
        const input: SnapInput = {
          kind: c.kind,
          raw: c.raw,
          lang: c.lang,
          ...(a === 'market' ? { market: c.market } : {}),
          vectors: { query: queries.get(key(c.raw))!, document: documents.get(key(c.raw))! },
        };
        const { out, recorded, errors, attempts } = await snapRecorded(recorder, fresh, { inference, tau }, input);
        if (attempts > 1) retried++;
        if (errors.length) failed.push(`${a} ${c.raw}: ${errors.join('; ')}`);
        const existing = out.token && out.decision !== 'minted' ? out.token : null;
        const verdict = existing ? (c.right.includes(existing) ? 'right' : c.wrong?.includes(existing) ? 'false friend' : 'other') : c.none ? 'right' : 'other';
        // What Clef was sent, after the arm's rewrite: the recorder sees the request before it.
        const clef = recorded.find((r) => r.op === 'work-adjudicate' && r.output !== undefined)?.input as Record<string, unknown> | undefined;
        const sent = clef && (a === 'before' ? beforeLocale('work-adjudicate', clef, c.kind, c.lang) : clef);
        const criteria = (sent?.questions as { match?: { criteria?: Record<string, string> } } | undefined)?.match?.criteria ?? {};
        const told = typeof sent?.state === 'string' ? [sent.state, '', ...Object.entries(criteria).map(([k, v]) => `${k}: ${v}`)].join('\n') : null;
        rows.push({ c, arm: a, out, verdict, band: bandAnswer(recorded, out), pivot: pivotName(recorded), state: told, costMicroUsd: out.calls.reduce((s, x) => s + callCostMicroUsd(x), 0) });
        console.log(`${verdict === 'right' ? 'ok  ' : 'MISS'} ${a} ${c.lang}/${c.market} ${c.raw} → ${out.decision} ${out.token ?? ''}`);
      }
    }

    const date = new Date().toISOString().slice(0, 10);
    const groups = [...new Set(cases.map((c) => c.group))];
    const of = (a: Arm) => rows.filter((r) => r.arm === a);
    const cell = (r: V3Row | undefined) => {
      if (!r) return '—';
      const what = `${r.verdict === 'right' ? '' : '**'}${r.out.decision} ${r.out.token ?? '—'}${r.verdict === 'right' ? '' : '**'}`;
      return [what, r.band ? `Clef ${bandText(r.band)}` : null, r.pivot ? `pivot "${r.pivot}"` : null].filter(Boolean).join('; ');
    };
    const shown = (out: SnapResult) =>
      out.candidates
        .slice(0, 5)
        .map((x) => `${x.token} "${x.matched}" ${x.matchedLang ?? '?'}${x.matchedRegion ? `-${x.matchedRegion}` : ''} ${x.score.toFixed(3)}`)
        .join('; ') || '—';
    const md = [
      `# Regional words and false friends on the v3 replica, ${date}`,
      '',
      `${cases.length} synthetic strings (\`test/fixtures/work/locale-cases.json\`), each with the market of the worker who wrote it, snapped against the v3 generation's registry (\`test/work-eval/replica.ts\`: the ESCO import's and the US layer's SQL, ${replica.tokens} tokens and ${replica.labels} labels, no certificate token; ${index.size} vectors of EmbeddingGemma 2 at 768, a national label's region kept), each string embedded as the phone embeds it (\`${EMBEDDINGGEMMA_2_GGUF}\` through llama-embedding, a query and a document), with \`${await inference.model('work-adjudicate')}\` and \`${await inference.model('work-pivot')}\` over the Workers AI REST API from the Mac. τ_auto ${tau.auto}, τ_low ${tau.low}. Three arms on the same registry and vectors: **before**, the hosted requests as they were before the locale (cofferdam-api 16ab6a8: Clef told the language's code, no language beside a matched label, the pivot given the bare string); **language**, production's requests with no market; **market**, production's with the listing's market. Right: one of the expected tokens, or, where no token fits, none or a new one; a false friend is the token ESCO's Spanish or Portuguese gives the word.`,
      '',
      '| Group | Before | Language | Market (production) |',
      '|---|---|---|---|',
      ...groups.map((g) => {
        const line = (a: Arm) => {
          const r = of(a).filter((x) => x.c.group === g);
          return `${r.filter((x) => x.verdict === 'right').length} of ${r.length} right, ${r.filter((x) => x.verdict === 'false friend').length} false friend, ${r.filter((x) => x.verdict === 'other').length} other`;
        };
        return `| ${g} | ${line('before')} | ${line('language')} | ${line('market')} |`;
      }),
      `| all | ${of('before').filter((r) => r.verdict === 'right').length} of ${cases.length} | ${of('language').filter((r) => r.verdict === 'right').length} of ${cases.length} | ${of('market').filter((r) => r.verdict === 'right').length} of ${cases.length} |`,
      '',
      `Cost per snap ${(rows.reduce((s, r) => s + r.costMicroUsd, 0) / rows.length / 1e6).toFixed(6)} USD (the embeddings are the Mac's). ${retried} snaps ran again after a hosted call threw; ${failed.length ? `${failed.length} still failed: ${failed.join('; ')}` : 'none still failed'}.`,
      '',
      'Clef\'s band answers, read again at other floors (the shipped floor is 0.5), per arm:',
      '',
      ...ARMS.flatMap((a) => {
        const banded = of(a)
          .filter((r): r is V3Row & { band: BandAnswer } => r.band != null)
          .map((r) => ({ band: r.band, right: (t: string) => r.c.right.includes(t) }));
        return [`**${a}**, ${banded.length} answers:`, '', '| Floor | Picked an expected token | Picked another | None | Below the floor |', '|---|---|---|---|---|', ...floorSweep(banded), ''];
      }),
      '| Group | String | Language, market | Expected | Before | Language | Market (production) |',
      '|---|---|---|---|---|---|---|',
      ...cases.map((c) => {
        const at = (a: Arm) => rows.find((r) => r.arm === a && r.c === c);
        return `| ${c.group} | ${c.raw} | ${c.lang}, ${c.market} | ${[...c.right, ...(c.none ? ['none'] : [])].join(', ')} | ${cell(at('before'))} | ${cell(at('language'))} | ${cell(at('market'))} |`;
      }),
      '',
      'The nearest candidates (token, matched label, its language and a national label\'s region, cosine), the same in every arm:',
      '',
      '| String | Candidates |',
      '|---|---|',
      ...of('market').map((r) => `| ${r.c.raw} (${r.c.lang}) | ${shown(r.out)} |`),
      '',
      'What Clef was told in production\'s arm (the state and the `match` criteria), for the first string of each group that reached it:',
      '',
      ...groups.flatMap((g) => {
        const told = of('market').find((r) => r.c.group === g && r.state)?.state;
        return told ? ['```', told, '```', ''] : [];
      }),
    ].join('\n');
    writeFileSync(join(__dirname, 'work-eval', `registry-locale-v3-${date}${process.env.WORK_EVAL_SUFFIX ?? ''}.md`), md);
    expect(rows).toHaveLength(cases.length * ARMS.length);
  }, 3_600_000);
});

// ── The English pivot in the band on the v2 engine: the replica and the phone's EmbeddingGemma 2 ──────────────────

/** The pivot run's arms: production's requests with the listing's market, and the same with the English pivot in the band. */
const PIVOT_ARMS = ['market', 'pivot'] as const;
type PivotArm = (typeof PIVOT_ARMS)[number];

describe.skipIf(!LIVE || !V3_DIR || !ESCO_SQL || !US_SQL)('the English pivot in the band on the v2 engine (live Clef and pivot, the replica and the phone’s EmbeddingGemma 2)', () => {
  it('snaps each market-tagged string as production does, then with the pivot in the band, and writes the report', async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !apiToken) throw new Error('WORK_EVAL needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    const recorder = recording(createInference({ WORK_EMBED_MODEL: EMBEDDINGGEMMA_2_GGUF }, { ai: createRestAi({ accountId, token: apiToken }) })!);
    const inference = recorder.inference;
    const tau = tauFor(EMBEDDINGGEMMA_2_GGUF, parseTau(process.env.WORK_TAU_AUTO, process.env.WORK_TAU_LOW));

    // The registry as the v2 engine holds it (ESCO and the US layer, EmbeddingGemma 2's GGUF vectors, no certificate token), as the run above loads it.
    const replica = await loadReplica(ESCO_SQL, US_SQL);
    const index = ReplicaIndex.load(V3_DIR);
    const loadedAt = Date.now();
    const fresh = async () => {
      const added = replica.db.sqlite.prepare('SELECT label_id FROM registry_labels WHERE created_at >= ?').all(loadedAt) as { label_id: string }[];
      if (added.length) await index.deleteByIds(added.map((r) => r.label_id));
      for (const table of ['registry_decisions', 'registry_labels', 'registry_tokens']) replica.db.sqlite.prepare(`DELETE FROM ${table} WHERE created_at >= ?`).run(loadedAt);
      return { store: replica.store, index };
    };
    const cases = localeCases.cases as LocaleCase[];
    const key = (t: string) => t.replace(/\s+/g, ' ').trim();
    const queries = embedAll(cases.map((c) => c.raw), 'query');
    const documents = embedAll(cases.map((c) => c.raw), 'document');

    type PivotRow = { c: LocaleCase; arm: PivotArm; out: SnapResult; verdict: 'right' | 'false friend' | 'other'; band: BandAnswer | null; pivot: string; state: string | null; ms: number; costMicroUsd: number };
    const rows: PivotRow[] = [];
    const failed: string[] = [];
    let retried = 0;
    for (const arm of PIVOT_ARMS) {
      for (const c of cases) {
        const input: SnapInput = { kind: c.kind, raw: c.raw, lang: c.lang, market: c.market, vectors: { query: queries.get(key(c.raw))!, document: documents.get(key(c.raw))! } };
        const { out, recorded, errors, attempts, ms } = await snapRecorded(recorder, fresh, { inference, tau, pivotBand: arm === 'pivot' }, input);
        if (attempts > 1) retried++;
        if (errors.length) failed.push(`${arm} ${c.raw}: ${errors.join('; ')}`);
        const existing = out.token && out.decision !== 'minted' ? out.token : null;
        const verdict = existing ? (c.right.includes(existing) ? 'right' : c.wrong?.includes(existing) ? 'false friend' : 'other') : c.none ? 'right' : 'other';
        const clef = recorded.find((r) => r.op === 'work-adjudicate' && r.output !== undefined)?.input as { state?: string; questions?: { match?: { criteria?: Record<string, string> } } } | undefined;
        const told = clef?.state ? [clef.state, '', ...Object.entries(clef.questions?.match?.criteria ?? {}).map(([k, v]) => `${k}: ${v}`)].join('\n') : null;
        rows.push({ c, arm, out, verdict, band: bandAnswer(recorded, out), pivot: pivotText(out, recorded), state: told, ms, costMicroUsd: out.calls.reduce((s, x) => s + callCostMicroUsd(x), 0) });
        console.log(`${verdict === 'right' ? 'ok  ' : 'MISS'} ${arm} ${c.lang}/${c.market} ${c.raw} → ${out.decision} ${out.token ?? ''}`);
      }
    }

    const date = new Date().toISOString().slice(0, 10);
    const groups = [...new Set(cases.map((c) => c.group))];
    const of = (a: PivotArm) => rows.filter((r) => r.arm === a);
    const right = (r: readonly PivotRow[]) => r.filter((x) => x.verdict === 'right').length;
    const cell = (r: PivotRow | undefined) => {
      if (!r) return '—';
      const what = `${r.verdict === 'right' ? '' : '**'}${r.out.decision} ${r.out.token ?? '—'}${r.verdict === 'right' ? '' : '**'}`;
      return [what, r.band ? `Clef ${bandText(r.band)}` : null, r.pivot !== '—' ? `pivot "${r.pivot}"` : null].filter(Boolean).join('; ');
    };
    const shown = (out: SnapResult) =>
      out.candidates
        .slice(0, 5)
        .map((x) => `${x.token} "${x.matched}" ${x.matchedLang ?? '?'}${x.matchedRegion ? `-${x.matchedRegion}` : ''} ${x.score.toFixed(3)}`)
        .join('; ') || '—';
    const perArm = (a: PivotArm) => {
      const r = of(a);
      return `**${a === 'market' ? 'Market (production)' : 'With the pivot in the band'}:** cost per snap ${(r.reduce((s, x) => s + x.costMicroUsd, 0) / r.length / 1e6).toFixed(6)} USD, median ${median(r.map((x) => x.ms))} ms a snap (the phone's vectors were embedded before, and the replica searches its vectors in process, so this is no production latency); calls: ${callStats(r.map((x) => x.out))}.`;
    };
    const md = [
      `# The English pivot in the band on the v2 engine, ${date}`,
      '',
      `${cases.length} synthetic strings (\`test/fixtures/work/locale-cases.json\`), each with the market of the worker who wrote it, snapped on the v2 engine: the registry replica (\`test/work-eval/replica.ts\`: the ESCO import's and the US layer's SQL, ${replica.tokens} tokens and ${replica.labels} labels, no certificate token; ${index.size} vectors of EmbeddingGemma 2 at 768, a national label's region kept), each string embedded with the same GGUF (\`${EMBEDDINGGEMMA_2_GGUF}\` through llama-embedding, a query and a document; the v2 generation's LiteRT-LM vectors match these at a median cosine of 0.990), with \`${await inference.model('work-adjudicate')}\` and \`${await inference.model('work-pivot')}\` over the Workers AI REST API from the Mac. τ_auto ${tau.auto}, τ_low ${tau.low}. Two arms on the same registry and vectors: **market**, production's requests with the listing's market, the pivot asked only below the band or after Clef's none, as today; **pivot**, the same with the English pivot in the band (workspace decision 0018, amendment proposed 2026-10-30): a worker's Portuguese or Spanish string asks the pivot beside the snap's search, and Clef is shown the token its English name names. Right: one of the expected tokens, or, where no token fits, none or a new one; a false friend is the token ESCO's Spanish or Portuguese gives the word, or the one a generic English name holds as a label (workspace OD-28).`,
      '',
      '| Group | Market (production) | With the pivot in the band |',
      '|---|---|---|',
      ...groups.map((g) => {
        const line = (a: PivotArm) => {
          const r = of(a).filter((x) => x.c.group === g);
          return `${right(r)} of ${r.length} right, ${r.filter((x) => x.verdict === 'false friend').length} false friend or generic name, ${r.filter((x) => x.verdict === 'other').length} other`;
        };
        return `| ${g} | ${line('market')} | ${line('pivot')} |`;
      }),
      `| all | ${right(of('market'))} of ${cases.length} | ${right(of('pivot'))} of ${cases.length} |`,
      '',
      perArm('market'),
      '',
      perArm('pivot'),
      '',
      pivotBandLine(of('pivot')),
      '',
      `${retried} snaps ran again after a hosted call threw; ${failed.length ? `${failed.length} still failed: ${failed.join('; ')}` : 'none still failed'}.`,
      '',
      'Clef\'s band answers, read again at other floors (the shipped floor is 0.5), per arm:',
      '',
      ...PIVOT_ARMS.flatMap((a) => {
        const banded = of(a)
          .filter((r): r is PivotRow & { band: BandAnswer } => r.band != null)
          .map((r) => ({ band: r.band, right: (t: string) => r.c.right.includes(t) }));
        return [`**${a}**, ${banded.length} answers:`, '', '| Floor | Picked an expected token | Picked another | None | Below the floor |', '|---|---|---|---|---|', ...floorSweep(banded), ''];
      }),
      '| Group | String | Language, market | Expected | Market (production) | With the pivot in the band |',
      '|---|---|---|---|---|---|',
      ...cases.map((c) => {
        const at = (a: PivotArm) => rows.find((r) => r.arm === a && r.c === c);
        return `| ${c.group} | ${c.raw} | ${c.lang}, ${c.market} | ${[...c.right, ...(c.none ? ['none'] : [])].join(', ') || '—'} | ${cell(at('market'))} | ${cell(at('pivot'))} |`;
      }),
      '',
      'The nearest candidates (token, matched label, its language and a national label\'s region, cosine), the same in both arms:',
      '',
      '| String | Candidates |',
      '|---|---|',
      ...of('market').map((r) => `| ${r.c.raw} (${r.c.lang}) | ${shown(r.out)} |`),
      '',
      'What Clef was told with the pivot in the band (the state and the `match` criteria), for each string whose band showed the English name\'s token after the nearest five:',
      '',
      ...of('pivot')
        .filter((r) => r.out.pivot?.added && r.state)
        .flatMap((r) => ['```', r.state!, '```', '']),
    ].join('\n');
    writeFileSync(join(__dirname, 'work-eval', `registry-pivot-band-v2-engine-${date}${process.env.WORK_EVAL_SUFFIX ?? ''}.md`), md);
    expect(rows).toHaveLength(cases.length * PIVOT_ARMS.length);
  }, 3_600_000);
});
