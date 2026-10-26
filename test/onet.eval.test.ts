// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The US layer measured before and after (workspace decision 0066 (6)), from
 * the Mac (opt-in: ONET_EVAL=1), after `test/onet.import.test.ts` has written
 * its files. The test set is O*NET's own titles, held out: one title in ten,
 * by a fixed hash of its norm, leaves the layer, and a sample of those titles
 * is snapped twice the way the registry's first steps snap an English string
 * (`registry.ts`, `labelLangs`):
 * - before, against ESCO's occupation labels;
 * - after, against those and the rest of the layer.
 *
 * A snap is an exact English label held by one token, else the 20 nearest
 * labels by cosine, in every language and of every kind, best per token,
 * taken at τ_auto only when one of the token's English labels among them
 * reaches it (since 2026-10-26; the reports of 2026-10-25 read every
 * language for both). It is right when its token is one of the ESCO
 * occupations the crosswalk gives the title's O*NET occupation. The report
 * splits the snaps by where the registry would take them: an exact label, τ_auto
 * (taken), the band (Clef chooses among the best five) or below it.
 *
 *   cd cofferdam-api && ONET_EVAL=1 ONET_DIR=~/Development/us-layer-data ESCO_DIR=~/Development/esco/import direnv exec .. yarn vitest run test/onet.eval.test.ts
 *
 * ONET_OUT is the import's folder (default `<ONET_DIR>/cofferdam-import`);
 * ESCO's label vectors are cached there (`esco-occupation-vectors.*`), so a
 * second run embeds only the sample. ONET_EVAL_N is the sample (default
 * 2,000). The report goes to `test/work-eval/onet-layer-<date><ONET_EVAL_SUFFIX>.md`,
 * numbers only. Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI run).
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInference } from '../src/services/inference/index.js';
import { planEscoImport, type EscoLang } from '../src/services/work/esco.js';
import { onetCandidates, readCrosswalk, readOnetTitles, titleForms } from '../src/services/work/onet.js';
import { EMBED_PROMPTS_BY_MODEL, embedTexts, labelNorm, tauFor, type EmbedRole, type Tau } from '../src/services/work/registry.js';
import { createRestAi } from './chat-eval/restAi.js';

const RUN = process.env.ONET_EVAL === '1';
const RELEASE = '31.0';
const PARALLEL = 4;
/** The nearest labels a snap reads (`candidatesFor`), and the candidates Clef sees. */
const TOP_LABELS = 20;
const CLEF_SHOWN = 5;

const home = (p: string) => p.replace(/^~(?=\/)/, homedir());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** FNV-1a: the held-out tenth is every norm whose hash ends in 0 (mod 10). */
function heldOut(norm: string): boolean {
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 10 === 0;
}

function shuffled<T>(items: readonly T[], seed = 66): T[] {
  const a = [...items];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Unit vectors in one Float32Array, row by row, with the token and the language of each row. */
interface Pool {
  dims: number;
  rows: Float32Array;
  tokens: string[];
  langs: string[];
}

function pool(dims: number, parts: { vectors: Float32Array; tokens: string[]; langs: string[] }[]): Pool {
  const n = parts.reduce((s, p) => s + p.tokens.length, 0);
  const rows = new Float32Array(n * dims);
  const tokens: string[] = [];
  const langs: string[] = [];
  let at = 0;
  for (const p of parts) {
    rows.set(p.vectors, at * dims);
    tokens.push(...p.tokens);
    langs.push(...p.langs);
    at += p.tokens.length;
  }
  return { dims, rows, tokens, langs };
}

/** The nearest `TOP_LABELS` rows, best per token, best first, with each token's best English row among them (`candidatesFor`'s `scoped`). */
function nearest(p: Pool, q: Float32Array): { token: string; score: number; english: number | null }[] {
  const top: { i: number; s: number }[] = [];
  const { dims, rows } = p;
  const n = p.tokens.length;
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * dims;
    for (let d = 0; d < dims; d++) s += rows[o + d]! * q[d]!;
    if (top.length < TOP_LABELS) {
      top.push({ i, s });
      if (top.length === TOP_LABELS) top.sort((a, b) => a.s - b.s);
    } else if (s > top[0]!.s) {
      top[0] = { i, s };
      for (let k = 0; k + 1 < TOP_LABELS && top[k]!.s > top[k + 1]!.s; k++) [top[k], top[k + 1]] = [top[k + 1]!, top[k]!];
    }
  }
  const best = new Map<string, number>();
  const english = new Map<string, number>();
  for (const { i, s } of top) {
    const t = p.tokens[i]!;
    if (!best.has(t) || s > best.get(t)!) best.set(t, s);
    if (p.langs[i] === 'en' && (!english.has(t) || s > english.get(t)!)) english.set(t, s);
  }
  return [...best].map(([token, score]) => ({ token, score, english: english.get(token) ?? null })).sort((a, b) => b.score - a.score);
}

const unit = (v: readonly number[]) => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
};

type Route = 'label' | 'auto' | 'band' | 'below';
interface Snap {
  route: Route;
  token: string | null;
  shown: string[];
  score: number | null;
}

function snapIn(p: Pool, exact: Map<string, Set<string>>, norm: string, q: Float32Array, tau: Tau): Snap {
  const holders = exact.get(norm);
  if (holders?.size === 1) return { route: 'label', token: [...holders][0]!, shown: [], score: 1 };
  const c = nearest(p, q);
  const top = c[0];
  if (!top) return { route: 'below', token: null, shown: [], score: null };
  // Another language's label at τ_auto goes to Clef, as the registry sends it.
  const route: Route = top.english != null && top.english >= tau.auto ? 'auto' : top.score >= tau.low ? 'band' : 'below';
  return { route, token: top.token, shown: c.slice(0, CLEF_SHOWN).map((x) => x.token), score: top.score };
}

describe.skipIf(!RUN)('US layer, before and after (opt-in, from the Mac)', () => {
  it('snaps held-out O*NET titles against ESCO alone and with the layer', async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const onetDir = home(process.env.ONET_DIR ?? '');
    const escoDir = home(process.env.ESCO_DIR ?? '');
    if (!accountId || !apiToken || !onetDir || !escoDir) throw new Error('ONET_EVAL needs ONET_DIR, ESCO_DIR, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    const out = home(process.env.ONET_OUT ?? join(onetDir, 'cofferdam-import'));
    const sampleSize = Number(process.env.ONET_EVAL_N ?? 2_000);

    const occupations: Partial<Record<EscoLang, string>> = {};
    for (const lang of ['en', 'pt', 'es'] as const) {
      const path = join(escoDir, `occupations_${lang}.csv`);
      if (existsSync(path)) occupations[lang] = readFileSync(path, 'utf8');
    }
    const esco = await planEscoImport({ occupations });
    const escoLabels = esco.labels.filter((l) => l.token.startsWith('pos:'));
    const crosswalk = readCrosswalk(readFileSync(join(onetDir, 'esco-onet', 'ONET_Occupations_0_updated.csv'), 'utf8'));
    const candidates = onetCandidates(crosswalk, esco.tokens);
    const titles = [
      ...readOnetTitles(readFileSync(join(onetDir, `onet-${RELEASE}`, 'job_titles.csv'), 'utf8')),
      ...readOnetTitles(readFileSync(join(onetDir, `onet-${RELEASE}`, 'sample_of_reported_titles.csv'), 'utf8')),
    ];

    // The held-out titles: each norm once, its gold every candidate of every O*NET occupation that lists it.
    const held = new Map<string, { title: string; gold: Set<string> }>();
    for (const t of titles) {
      for (const form of titleForms(t.title, t.short).forms) {
        const norm = labelNorm(form);
        const cands = candidates.get(t.onetCode) ?? [];
        if (!norm || !heldOut(norm) || !cands.length) continue;
        const h = held.get(norm) ?? { title: form, gold: new Set<string>() };
        for (const c of cands) h.gold.add(c.token.token);
        held.set(norm, h);
      }
    }
    const sample = shuffled([...held.keys()]).slice(0, sampleSize);

    // The layer's labels and vectors, the held-out tenth left out.
    const layer: { norm: string; token: string; lang: string; values: number[] }[] = [];
    for (const f of readdirSync(out).filter((f) => /^national-vectors-\d{3}\.ndjson$/.test(f)).sort()) {
      for (const line of readFileSync(join(out, f), 'utf8').split('\n')) {
        if (!line) continue;
        const v = JSON.parse(line) as { values: number[]; metadata: { token: string; label: string; lang?: string } };
        const norm = labelNorm(v.metadata.label);
        if (!heldOut(norm)) layer.push({ norm, token: v.metadata.token, lang: v.metadata.lang ?? 'en', values: v.values });
      }
    }
    if (!layer.length) throw new Error(`no national-vectors-*.ndjson in ${out}: run test/onet.import.test.ts first`);
    const dims = layer[0]!.values.length;

    const inference = createInference({ WORK_EMBED_MODEL: process.env.WORK_EMBED_MODEL }, { ai: createRestAi({ accountId, token: apiToken }) })!;
    const embedModel = await inference.model('work-embed');
    const tau = tauFor(embedModel);
    const embedMany = async (texts: string[], role: EmbedRole): Promise<Float32Array> => {
      const outv = new Float32Array(texts.length * dims);
      const batches: number[] = [];
      for (let i = 0; i < texts.length; i += 100) batches.push(i);
      let next = 0;
      const worker = async () => {
        while (next < batches.length) {
          const from = batches[next++]!;
          const batch = texts.slice(from, from + 100);
          for (let attempt = 0; ; attempt++) {
            const e = await embedTexts(inference, batch, { role });
            if (e.ok) {
              e.vectors.forEach((v, j) => outv.set(unit(v), (from + j) * dims));
              break;
            }
            if (attempt >= 4) throw new Error(`${embedModel} failed five times at text ${from}`);
            await sleep(1_000 * 2 ** attempt);
          }
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      return outv;
    };

    // ESCO's occupation labels, embedded once and cached beside the import.
    const escoTexts = [...new Set(escoLabels.map((l) => l.label))];
    const cacheText = join(out, 'esco-occupation-vectors.json');
    const cacheBin = join(out, 'esco-occupation-vectors.f32');
    let escoVectors: Float32Array;
    // A model with role prompts caches its documents under its name and the prompt, so a cache made without them is not read.
    const cacheModel = EMBED_PROMPTS_BY_MODEL[embedModel] ? `${embedModel}|${EMBED_PROMPTS_BY_MODEL[embedModel]!.document}` : embedModel;
    if (existsSync(cacheText) && existsSync(cacheBin) && (JSON.parse(readFileSync(cacheText, 'utf8')) as { model: string; texts: string[] }).model === cacheModel) {
      const cached = JSON.parse(readFileSync(cacheText, 'utf8')) as { texts: string[] };
      const buf = readFileSync(cacheBin);
      const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      const at = new Map(cached.texts.map((t, i) => [t, i]));
      escoVectors = new Float32Array(escoTexts.length * dims);
      escoTexts.forEach((t, i) => {
        const j = at.get(t);
        if (j === undefined) throw new Error(`the cache lacks "${t}": delete ${cacheText}`);
        escoVectors.set(all.subarray(j * dims, (j + 1) * dims), i * dims);
      });
    } else {
      escoVectors = await embedMany(escoTexts, 'document');
      writeFileSync(cacheBin, Buffer.from(escoVectors.buffer));
      writeFileSync(cacheText, JSON.stringify({ model: cacheModel, texts: escoTexts }));
    }
    const textRow = new Map(escoTexts.map((t, i) => [t, i]));
    const escoRows = new Float32Array(escoLabels.length * dims);
    escoLabels.forEach((l, i) => escoRows.set(escoVectors.subarray(textRow.get(l.label)! * dims, (textRow.get(l.label)! + 1) * dims), i * dims));
    const layerRows = new Float32Array(layer.length * dims);
    layer.forEach((l, i) => layerRows.set(unit(l.values), i * dims));

    const escoLangs = escoLabels.map((l) => l.lang);
    const before = pool(dims, [{ vectors: escoRows, tokens: escoLabels.map((l) => l.token), langs: escoLangs }]);
    const after = pool(dims, [
      before.tokens.length ? { vectors: escoRows, tokens: before.tokens, langs: escoLangs } : { vectors: new Float32Array(), tokens: [], langs: [] },
      { vectors: layerRows, tokens: layer.map((l) => l.token), langs: layer.map((l) => l.lang) },
    ]);
    // An English string's exact label is an English one (`labelLangs('en')`).
    const exactBefore = new Map<string, Set<string>>();
    for (const l of escoLabels) if (l.lang === 'en') (exactBefore.get(l.labelNorm) ?? exactBefore.set(l.labelNorm, new Set()).get(l.labelNorm)!).add(l.token);
    const exactAfter = new Map([...exactBefore].map(([k, v]) => [k, new Set(v)]));
    for (const l of layer) if (l.lang === 'en') (exactAfter.get(l.norm) ?? exactAfter.set(l.norm, new Set()).get(l.norm)!).add(l.token);

    const queries = await embedMany(sample.map((n) => held.get(n)!.title), 'query');
    const rows: { norm: string; inEsco: boolean; before: Snap; after: Snap; gold: Set<string> }[] = [];
    sample.forEach((norm, i) => {
      const q = queries.subarray(i * dims, (i + 1) * dims);
      rows.push({ norm, inEsco: exactBefore.has(norm), before: snapIn(before, exactBefore, norm, q, tau), after: snapIn(after, exactAfter, norm, q, tau), gold: held.get(norm)!.gold });
    });

    const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');
    const table = (subset: typeof rows, name: string) => {
      const line = (side: 'before' | 'after') => {
        const s = subset.map((r) => ({ snap: r[side], gold: r.gold }));
        const by = (route: Route) => s.filter((x) => x.snap.route === route);
        const right = (x: (typeof s)[number]) => x.snap.token != null && x.gold.has(x.snap.token);
        const shownRight = (x: (typeof s)[number]) => x.snap.shown.some((t) => x.gold.has(t));
        const [label, auto, band, below] = (['label', 'auto', 'band', 'below'] as const).map(by);
        return `| ${name} | ${side} | ${pct(s.filter(right).length, s.length)} | ${pct(label!.length, s.length)} (${pct(label!.filter(right).length, label!.length)} right) | ${pct(auto!.length, s.length)} (${pct(auto!.filter(right).length, auto!.length)} right) | ${pct(band!.length, s.length)} (${pct(band!.filter(right).length, band!.length)} right at 1, ${pct(band!.filter(shownRight).length, band!.length)} among ${CLEF_SHOWN}) | ${pct(below!.length, s.length)} |`;
      };
      return [line('before'), line('after')];
    };
    const notInEsco = rows.filter((r) => !r.inEsco);
    const changed = rows.filter((r) => r.before.token !== r.after.token);
    const fixed = changed.filter((r) => r.after.token && r.gold.has(r.after.token) && !(r.before.token && r.gold.has(r.before.token))).length;
    const broken = changed.filter((r) => r.before.token && r.gold.has(r.before.token) && !(r.after.token && r.gold.has(r.after.token))).length;
    const date = new Date().toISOString().slice(0, 10);
    const report = [
      `# The US layer before and after, ${date}`,
      '',
      `O*NET ${RELEASE} titles held out of the layer (one norm in ten by a fixed hash: ${held.size}), ${rows.length} of them sampled, each snapped against ESCO v1.2.1's occupation labels in English, Portuguese and Spanish (${escoLabels.length}) and then against those and the layer's other labels (${layer.length}), with ${embedModel} over the Workers AI REST API from the Mac. A snap is an exact English label held by one token, else the 20 nearest labels in every language, best per token, taken at τ_auto only through an English one (the registry's rule since 2026-10-26); it is right when its token is one of the ESCO occupations the ESCO–O*NET crosswalk gives an O*NET occupation that lists the title. τ_auto ${tau.auto}, τ_low ${tau.low}; Clef, the pivot and the mint are not run, so "among ${CLEF_SHOWN}" is the most Clef could get right in the band.`,
      '',
      '| Titles | Registry | Right | Exact label | τ_auto | Band | Below the band |',
      '|---|---|---|---|---|---|---|',
      ...table(rows, `all (${rows.length})`),
      ...table(notInEsco, `not an English ESCO label (${notInEsco.length})`),
      '',
      `The layer changed ${changed.length} of ${rows.length} snaps: ${fixed} from wrong to right, ${broken} from right to wrong.`,
      '',
      'Includes information from the O*NET 31.0 Database by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA), used under the CC BY 4.0 license; the titles were split and placed by Cofferdam Inc. (`cofferdam-api` `NOTICE`).',
      '',
    ].join('\n');
    writeFileSync(join(__dirname, 'work-eval', `onet-layer-${date}${process.env.ONET_EVAL_SUFFIX ?? ''}.md`), report);
    // Every snap, for reading the misses (outside the repository: O*NET's titles).
    if (process.env.ONET_EVAL_ROWS)
      writeFileSync(
        home(process.env.ONET_EVAL_ROWS),
        JSON.stringify(rows.map((r) => ({ title: held.get(r.norm)!.title, gold: [...r.gold], before: r.before, after: r.after }))),
      );
    console.log(report);
    expect(rows.length).toBeGreaterThan(0);
  }, 3 * 60 * 60 * 1000);
});
