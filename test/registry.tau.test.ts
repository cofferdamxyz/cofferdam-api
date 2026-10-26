// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * τ for an embedding model (workspace decision 0067, rule 7), from the Mac
 * (opt-in: TAU_CALIBRATE=1), set against bge-m3's, whose values the registry
 * runs on. Every model has its own cosine scale, so the new model's τ_auto is
 * the lowest that takes candidates as precisely as bge-m3's 0.95 does, and its
 * τ_low the highest that leaves out no more right answers than bge-m3's 0.6.
 *
 * The test strings are ESCO's own: a sample of the alternative and hidden
 * labels of occupations and skills, in English, Portuguese and Spanish, each
 * snapped as a query against every other label of its kind (its own label,
 * and that label in other languages, left out) the way the registry's
 * retrieval does: the 20 nearest labels, best per token, τ_auto read through
 * a label of the string's language or English. A string's right answer is the
 * token whose label it is.
 *
 *   cd cofferdam-api && TAU_CALIBRATE=1 ESCO_DIR=~/Development/esco/import direnv exec .. yarn vitest run test/registry.tau.test.ts
 *
 * TAU_MODEL is the model to calibrate (default EmbeddingGemma), TAU_N the
 * strings per kind (default 1,000), TAU_CACHE the folder for the label
 * vectors (default `<ESCO_DIR>/tau-cache`, documents per model and prompt).
 * The report goes to `test/work-eval/tau-<model>-<date>.md`, numbers only.
 * Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI run).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInference } from '../src/services/inference/index.js';
import { planEscoImport, type EscoLang } from '../src/services/work/esco.js';
import { DEFAULT_TAU, EMBED_PROMPTS_BY_MODEL, embedTexts, labelLangs, type EmbedRole, type RegistryLabel } from '../src/services/work/registry.js';
import { createRestAi } from './chat-eval/restAi.js';

const RUN = process.env.TAU_CALIBRATE === '1';
const BASE = '@cf/baai/bge-m3';
const TOP_LABELS = 20;
const SHOWN = 5;
const PARALLEL = 8;

const home = (p: string) => p.replace(/^~(?=\/)/, homedir());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function shuffled<T>(items: readonly T[], seed = 67): T[] {
  const a = [...items];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function unitInto(out: Float32Array, at: number, v: readonly number[]) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) out[at + i] = v[i]! / n;
}

interface Result {
  kind: 'pos' | 'skill';
  /** The best token's score, and its score through a label of the string's languages. */
  score: number;
  scoped: number | null;
  right: boolean;
  /** The right token among the best five. */
  shown: boolean;
}

describe.skipIf(!RUN)('τ for an embedding model, set against bge-m3 (opt-in, from the Mac)', () => {
  it('snaps held-out ESCO labels with both models and writes the thresholds', async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const escoDir = home(process.env.ESCO_DIR ?? '');
    if (!accountId || !apiToken || !escoDir) throw new Error('TAU_CALIBRATE needs ESCO_DIR, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    const target = process.env.TAU_MODEL ?? '@cf/google/embeddinggemma-300m';
    const perKind = Number(process.env.TAU_N ?? 1_000);
    const cacheDir = home(process.env.TAU_CACHE ?? join(escoDir, 'tau-cache'));
    mkdirSync(cacheDir, { recursive: true });

    const read = (pillar: string) => {
      const files: Partial<Record<EscoLang, string>> = {};
      for (const lang of ['en', 'pt', 'es'] as const) {
        const path = join(escoDir, `${pillar}_${lang}.csv`);
        if (existsSync(path)) files[lang] = readFileSync(path, 'utf8');
      }
      return files;
    };
    const plan = await planEscoImport({ occupations: read('occupations'), skills: read('skills') });
    const ai = createRestAi({ accountId, token: apiToken });

    const results = new Map<string, Result[]>();
    const refusedBy = new Map<string, number>();
    for (const model of [BASE, target]) {
      const inference = createInference({ WORK_EMBED_MODEL: model }, { ai })!;
      const prompt = EMBED_PROMPTS_BY_MODEL[model];
      /** A text the model refuses (a batch halved until it is alone) keeps a zero vector, and its index is in `refused`. */
      const refused = new Set<string>();
      const embed = async (texts: string[], role: EmbedRole, dims: number): Promise<Float32Array> => {
        const out = new Float32Array(texts.length * dims);
        const starts: number[] = [];
        for (let i = 0; i < texts.length; i += 100) starts.push(i);
        let next = 0;
        let done = 0;
        const run = async (from: number, batch: string[]): Promise<void> => {
          for (let attempt = 0; attempt < 4; attempt++) {
            const e = await embedTexts(inference, batch, { role });
            if (e.ok) {
              e.vectors.forEach((v, j) => unitInto(out, (from + j) * dims, v));
              return;
            }
            await sleep(1_000 * 2 ** attempt);
          }
          if (batch.length === 1) {
            refused.add(batch[0]!);
            process.stdout.write(`${model} will not embed "${batch[0]}"\n`);
            return;
          }
          const half = Math.ceil(batch.length / 2);
          await run(from, batch.slice(0, half));
          await run(from + half, batch.slice(half));
        };
        const worker = async () => {
          while (next < starts.length) {
            const from = starts[next++]!;
            const batch = texts.slice(from, from + 100);
            await run(from, batch);
            done += batch.length;
            if (done % 20_000 < 100) process.stdout.write(`${model} ${role} ${done} of ${texts.length}\n`);
          }
        };
        await Promise.all(Array.from({ length: PARALLEL }, worker));
        return out;
      };
      // A model's first calls can outlast the op's 10 s while it starts (EmbeddingGemma, 2026-10-25 and 2026-10-26).
      let dimsProbe = await embedTexts(inference, ['plumber'], { role: 'document' });
      for (let attempt = 0; !dimsProbe.ok && attempt < 6; attempt++) {
        await sleep(2_000 * 2 ** attempt);
        dimsProbe = await embedTexts(inference, ['plumber'], { role: 'document' });
      }
      if (!dimsProbe.ok) throw new Error(`${model} did not answer`);
      const dims = dimsProbe.vectors[0]!.length;
      const out: Result[] = [];

      for (const kind of ['pos', 'skill'] as const) {
        const labels = plan.labels.filter((l) => l.token.startsWith(`${kind}:`));
        const texts = [...new Set(labels.map((l) => l.label))];
        // The documents, cached per model, prompt and kind.
        const tag = `${model.split('/').pop()}${prompt ? '-prompted' : ''}-${kind}`;
        const cacheText = join(cacheDir, `${tag}.json`);
        const cacheBin = join(cacheDir, `${tag}.f32`);
        let docs: Float32Array;
        if (existsSync(cacheText) && existsSync(cacheBin) && (JSON.parse(readFileSync(cacheText, 'utf8')) as string[]).length === texts.length) {
          const buf = readFileSync(cacheBin);
          docs = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        } else {
          docs = await embed(texts, 'document', dims);
          writeFileSync(cacheBin, Buffer.from(docs.buffer));
          writeFileSync(cacheText, JSON.stringify(texts));
        }
        const row = new Map(texts.map((t, i) => [t, i]));

        // The strings: alternative and hidden labels, the same sample for both models.
        const sample = shuffled(labels.filter((l) => l.kind === 'alternative' || l.kind === 'hidden')).slice(0, perKind);
        const queries = await embed(
          sample.map((l) => l.label),
          'query',
          dims,
        );
        const byLabel: RegistryLabel[] = labels;
        const offsets = Int32Array.from(byLabel, (l) => row.get(l.label)! * dims);
        const sameWords = new Map<string, number[]>();
        byLabel.forEach((l, i) => {
          const k = `${l.token}\u0000${l.labelNorm}`;
          (sameWords.get(k) ?? sameWords.set(k, []).get(k)!).push(i);
        });
        const skip = new Uint8Array(byLabel.length);
        for (let qi = 0; qi < sample.length; qi++) {
          const q = sample[qi]!;
          // A string the model would not embed is not asked.
          if (refused.has(q.label)) continue;
          const langs = labelLangs(q.lang);
          const qv = queries.subarray(qi * dims, (qi + 1) * dims);
          // The string's own label, and the same words on its token in another language, are left out.
          const own = sameWords.get(`${q.token}\u0000${q.labelNorm}`) ?? [];
          for (const i of own) skip[i] = 1;
          const top: { i: number; s: number }[] = [];
          for (let i = 0; i < byLabel.length; i++) {
            if (skip[i]) continue;
            const o = offsets[i]!;
            let s = 0;
            for (let d = 0; d < dims; d++) s += docs[o + d]! * qv[d]!;
            if (top.length < TOP_LABELS) {
              top.push({ i, s });
              if (top.length === TOP_LABELS) top.sort((a, b) => a.s - b.s);
            } else if (s > top[0]!.s) {
              top[0] = { i, s };
              for (let k = 0; k + 1 < TOP_LABELS && top[k]!.s > top[k + 1]!.s; k++) [top[k], top[k + 1]] = [top[k + 1]!, top[k]!];
            }
          }
          for (const i of own) skip[i] = 0;
          const best = new Map<string, number>();
          const scoped = new Map<string, number>();
          for (const { i, s } of top) {
            const l = byLabel[i]!;
            if (s > (best.get(l.token) ?? -Infinity)) best.set(l.token, s);
            if (langs.includes(l.lang) && s > (scoped.get(l.token) ?? -Infinity)) scoped.set(l.token, s);
          }
          const ranked = [...best].sort((a, b) => b[1] - a[1]);
          const first = ranked[0];
          out.push({
            kind,
            score: first?.[1] ?? -1,
            scoped: first ? (scoped.get(first[0]) ?? null) : null,
            right: first?.[0] === q.token,
            shown: ranked.slice(0, SHOWN).some(([t]) => t === q.token),
          });
        }
        process.stdout.write(`${model} ${kind}: ${sample.length} strings, ${out.filter((r) => r.kind === kind && r.right).length} right at 1\n`);
      }
      results.set(model, out);
      refusedBy.set(model, refused.size);
    }

    // The thresholds: precision of what τ_auto takes, and the right answers τ_low leaves out.
    const takes = (rs: Result[], t: number) => rs.filter((r) => r.scoped != null && r.scoped >= t);
    const precision = (rs: Result[], t: number) => {
      const a = takes(rs, t);
      return a.length ? a.filter((r) => r.right).length / a.length : 1;
    };
    const lost = (rs: Result[], t: number) => rs.filter((r) => r.score < t && r.shown).length / rs.length;
    const base = results.get(BASE)!;
    const model = results.get(target)!;
    const wrong = (rs: Result[], t: number) => takes(rs, t).filter((r) => !r.right).length / rs.length;
    const baseTaken = takes(base, DEFAULT_TAU.auto).length / base.length;
    const baseLost = lost(base, DEFAULT_TAU.low);
    const grid = Array.from({ length: 70 }, (_, i) => Math.round((0.3 + i * 0.01) * 100) / 100);
    // As many strings taken without Clef as bge-m3 takes at its τ_auto, so the band carries as much as today, at the precision the model has there.
    const auto = grid.find((t) => takes(model, t).length / model.length <= baseTaken) ?? 1;
    const low = [...grid].reverse().find((t) => t < auto && lost(model, t) <= baseLost) ?? grid[0]!;
    const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
    const line = (name: string, rs: Result[], t: number, l: number) =>
      `| ${name} | ${rs.length} | ${pct(rs.filter((r) => r.right).length / rs.length)} | ${t} | ${pct(takes(rs, t).length / rs.length)} | ${pct(precision(rs, t))} | ${pct(wrong(rs, t))} | ${l} | ${pct(rs.filter((r) => r.score >= l).length / rs.length)} | ${pct(lost(rs, l))} |`;
    const date = new Date().toISOString().slice(0, 10);
    const report = [
      `# τ for ${target}, set against ${BASE}, ${date}`,
      '',
      `ESCO v1.2.1's alternative and hidden labels, ${perKind} strings each of occupations and of skills in English, Portuguese and Spanish, the same for both models, each snapped as a query against every other label of its kind (${plan.labels.filter((l) => l.token.startsWith('pos:')).length} occupation and ${plan.labels.filter((l) => l.token.startsWith('skill:')).length} skill labels; the string's own words on its token left out), over the Workers AI REST API from the Mac. Retrieval as the registry's: the 20 nearest labels, best per token, τ_auto through a label in the string's language or English. Right means the token whose label the string is. Texts a model would not embed (bge-m3 ${refusedBy.get(BASE) ?? 0}, ${target} ${refusedBy.get(target) ?? 0}) are left out of its labels and its strings.`,
      '',
      `${target}'s τ_auto is the lowest that takes no more strings without Clef than bge-m3's ${DEFAULT_TAU.auto} does (${pct(baseTaken)}), so the band carries what it carries today and the gain is in precision: an auto-take is final, and under OD-27 its alias counts at once, so precision is not traded for fewer Clef calls. Its τ_low is the highest, below that, that leaves out no more strings whose token was among the best ${SHOWN} than bge-m3's at ${DEFAULT_TAU.low} (${pct(baseLost)}). Wrong takes are a share of all strings: what τ_auto snaps wrongly without a model.`,
      '',
      '| Model | Strings | Right at 1 | τ_auto | Taken | Taken and right | Wrong takes | τ_low | In the band or above | Right among 5 below τ_low |',
      '|---|---|---|---|---|---|---|---|---|---|',
      line(BASE, base, DEFAULT_TAU.auto, DEFAULT_TAU.low),
      line(target, model, auto, low),
      '',
      'By kind, at the same values:',
      '',
      '| Model | Kind | Strings | Right at 1 | Taken | Taken and right | Wrong takes | Right among 5 below τ_low |',
      '|---|---|---|---|---|---|---|---|',
      ...(['pos', 'skill'] as const).flatMap((kind) =>
        [
          [BASE, base, DEFAULT_TAU.auto, DEFAULT_TAU.low],
          [target, model, auto, low],
        ].map(([name, rs, t, l]) => {
          const k = (rs as Result[]).filter((r) => r.kind === kind);
          return `| ${name as string} | ${kind} | ${k.length} | ${pct(k.filter((r) => r.right).length / k.length)} | ${pct(takes(k, t as number).length / k.length)} | ${pct(precision(k, t as number))} | ${pct(wrong(k, t as number))} | ${pct(lost(k, l as number))} |`;
        }),
      ),
      '',
      `${target} across thresholds:`,
      '',
      '| Threshold | Taken | Taken and right | Wrong takes | Right among 5 below |',
      '|---|---|---|---|---|',
      ...grid
        .filter((t) => Math.round(t * 100) % 5 === 0 || (t >= 0.7 && t <= 0.9))
        .map((t) => `| ${t} | ${pct(takes(model, t).length / model.length)} | ${pct(precision(model, t))} | ${pct(wrong(model, t))} | ${pct(lost(model, t))} |`),
      '',
    ].join('\n');
    writeFileSync(join(__dirname, 'work-eval', `tau-${target.split('/').pop()}-${date}.md`), report);
    process.stdout.write(`${report}\n`);
    expect(model.length).toBeGreaterThan(0);
  }, 3 * 60 * 60 * 1000);
});
