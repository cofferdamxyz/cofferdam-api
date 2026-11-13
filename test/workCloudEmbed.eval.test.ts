// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Workers AI's EmbeddingGemma 2 (`@cf/google/embeddinggemma-2`) standing in
 * for the phone's LiteRT-LM file against the unchanged v2 index (opt-in:
 * CLOUD_EMBED_EVAL=1, from the Mac). The question it answers before Cofferdam
 * Cloud embeds on the plane under the v2 pin (workspace decision 0084): how
 * many strings or pairs change their nearest token, their side of τ_auto
 * (0.96) or τ_low (0.81), or their side of the tier-2 floor (0.65), when the
 * cloud's vector replaces the phone's, and how many of those were right
 * before and after. Both roles: a query (a claim string, a hirer's sentence)
 * and a document (a minted label, a listing's text).
 *
 * Three sets, all against the v2 index's own label vectors (the replica's
 * cache, `<VECTORS_DIR>/bench-cache/v2-768.f32`, the 229,654 vectors the plane
 * holds), never re-embedded:
 *  1. The τ set: `test/registry.tau.test.ts`'s sample (ESCO's alternative and
 *     hidden labels, 1,000 occupations and 1,000 skills, seed 67), each
 *     snapped as a query against every other label of its kind, its own words
 *     on its token left out, the 20 nearest labels, best per token, τ_auto
 *     through a label of its language or English. The document role: the
 *     string's own label put back with its document vector, the phone's or the
 *     cloud's, and queried by the phone's query vector (a Cloud user's mint
 *     found by a Local user), and by the cloud's (a Cloud user's mint found by
 *     a Cloud user).
 *  2. The tier-2 set (`test/fixtures/work/tier2-floor.json`): every sentence
 *     (a query) against every listing (a document), in the four mixes.
 *  3. The locale strings (`test/fixtures/work/locale-cases.json`): each
 *     string's nearest token and sides of τ on the whole index, as a query,
 *     and its own document vector against its phone query (a mint's).
 *
 * Only public registry labels and the synthetic fixtures are sent to Workers
 * AI, over the REST API from the Mac (no gateway: no user text). The phone's
 * vectors come from the LiteRT-LM file on the Mac (`macEmbed`), as the v2
 * labels did. Vectors of both are cached in CLOUD_EMBED_CACHE (default
 * `<VECTORS_DIR>/cloud-embed-cache`), so a run again costs nothing.
 *
 *   cd cofferdam-api && CLOUD_EMBED_EVAL=1 ESCO_DIR=~/Development/esco/import \
 *     VECTORS_DIR=~/Development/esco/import/registry-embeddinggemma-2-litert \
 *     WORK_LITERT_FILE=~/models/embeddinggemma-2-litert/embeddinggemma-2-text-270m.litertlm \
 *     direnv exec .. yarn vitest run test/workCloudEmbed.eval.test.ts
 *
 * Writes `test/work-eval/cloud-embed-<date>.md`, numbers and fixture strings only.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { planEscoImport, type EscoLang } from '../src/services/work/esco.js';
import { EMBED_PROMPTS_BY_MODEL, EMBEDDINGGEMMA_2_LITERT, labelLangs, labelNorm, tauFor, type EmbedRole } from '../src/services/work/registry.js';
import { createRestAi } from './chat-eval/restAi.js';
import { embedText, macEmbed } from './fixtures/work/registryTools.js';

const RUN = process.env.CLOUD_EMBED_EVAL === '1';
const CLOUD = '@cf/google/embeddinggemma-2';
const LOCAL = EMBEDDINGGEMMA_2_LITERT;
const DIMS = 768;
const TOP_LABELS = 20;
const SHOWN = 5;
const FLOOR = 0.65;
const PROMPTS = EMBED_PROMPTS_BY_MODEL[LOCAL]!;

const home = (p: string) => p.replace(/^~(?=\/)/, homedir());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `test/registry.tau.test.ts`'s shuffle, so the τ set is its sample. */
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

function unit(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v as ArrayLike<number>);
  let n = 0;
  for (const x of out) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i]! /= n;
  return out;
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

interface Row {
  token: string;
  kind: string;
  lang: string;
  label: string;
}

/** The v2 index as the replica caches it: the plane's label vectors. */
function loadIndex(dir: string) {
  const buf = readFileSync(join(dir, 'bench-cache', `v2-${DIMS}.f32`));
  const values = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const rows = (JSON.parse(readFileSync(join(dir, 'bench-cache', `v2-${DIMS}.meta.json`), 'utf8')) as (Row & { source: string })[]).map(
    (r) => ({ token: r.token, kind: r.kind, lang: r.lang, label: r.label, source: r.source }),
  );
  if (values.length !== rows.length * DIMS) throw new Error('the v2 cache does not match its metadata');
  const byKind = new Map<string, number[]>();
  rows.forEach((r, i) => {
    if (r.kind === 'cert' && r.source === 'seed') return;
    (byKind.get(r.kind) ?? byKind.set(r.kind, []).get(r.kind)!).push(i);
  });
  return { values, rows, byKind: new Map([...byKind].map(([k, l]) => [k, Int32Array.from(l)])) };
}
type Index = ReturnType<typeof loadIndex>;

/** The 20 nearest labels of a kind, best first, rows in `skip` left out. */
function nearest(index: Index, kind: string, q: Float32Array, skip?: Set<number>): { i: number; s: number }[] {
  const top: { i: number; s: number }[] = [];
  const V = index.values;
  for (const i of index.byKind.get(kind) ?? []) {
    if (skip?.has(i)) continue;
    const o = i * DIMS;
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    for (let d = 0; d < DIMS; d += 4) {
      s0 += V[o + d]! * q[d]!;
      s1 += V[o + d + 1]! * q[d + 1]!;
      s2 += V[o + d + 2]! * q[d + 2]!;
      s3 += V[o + d + 3]! * q[d + 3]!;
    }
    const s = s0 + s1 + s2 + s3;
    if (top.length < TOP_LABELS) {
      top.push({ i, s });
      if (top.length === TOP_LABELS) top.sort((a, b) => a.s - b.s);
    } else if (s > top[0]!.s) {
      top[0] = { i, s };
      for (let k = 0; k + 1 < TOP_LABELS && top[k]!.s > top[k + 1]!.s; k++) [top[k], top[k + 1]] = [top[k + 1]!, top[k]!];
    }
  }
  return top.sort((a, b) => b.s - a.s);
}

/** What the registry reads from the nearest labels: the best token, its score, its score through the string's languages. */
interface Snap {
  token: string | null;
  score: number;
  scoped: number | null;
  shown: string[];
}

function snapOf(index: Index, top: { i: number; s: number }[], lang: string, extra: { token: string; lang: string; s: number }[] = []): Snap {
  const langs = labelLangs(lang);
  const best = new Map<string, number>();
  const scoped = new Map<string, number>();
  const add = (token: string, l: string, s: number) => {
    if (s > (best.get(token) ?? -Infinity)) best.set(token, s);
    if (langs.includes(l) && s > (scoped.get(token) ?? -Infinity)) scoped.set(token, s);
  };
  for (const { i, s } of top) add(index.rows[i]!.token, index.rows[i]!.lang, s);
  for (const e of extra) add(e.token, e.lang, e.s);
  const ranked = [...best].sort((a, b) => b[1] - a[1]);
  const first = ranked[0];
  return { token: first?.[0] ?? null, score: first?.[1] ?? -1, scoped: first ? (scoped.get(first[0]) ?? null) : null, shown: ranked.slice(0, SHOWN).map(([t]) => t) };
}

/** Vectors by (model, role, text), kept on disk between runs. */
class VectorCache {
  private readonly maps = new Map<string, Map<string, number[]>>();
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  private file(model: string, role: EmbedRole) {
    return join(this.dir, `${model.replace(/[^a-z0-9.-]+/gi, '_').slice(-60)}-${role}.json`);
  }
  get(model: string, role: EmbedRole): Map<string, number[]> {
    const key = `${model}\u0000${role}`;
    let m = this.maps.get(key);
    if (!m) {
      const f = this.file(model, role);
      m = existsSync(f) ? new Map(Object.entries(JSON.parse(readFileSync(f, 'utf8')) as Record<string, number[]>)) : new Map();
      this.maps.set(key, m);
    }
    return m;
  }
  save(model: string, role: EmbedRole) {
    writeFileSync(this.file(model, role), JSON.stringify(Object.fromEntries(this.get(model, role))));
  }
}

describe.skipIf(!RUN)('Workers AI EmbeddingGemma 2 in place of the phone’s LiteRT-LM vectors on the v2 index (opt-in, from the Mac)', () => {
  it('counts the nearest tokens, τ sides and floor sides that change, and writes the report', async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const escoDir = home(process.env.ESCO_DIR ?? '');
    const vectorsDir = home(process.env.VECTORS_DIR ?? '');
    const litertFile = home(process.env.WORK_LITERT_FILE ?? '');
    if (!accountId || !apiToken || !escoDir || !vectorsDir || !litertFile) throw new Error('CLOUD_EMBED_EVAL needs ESCO_DIR, VECTORS_DIR, WORK_LITERT_FILE, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    const cache = new VectorCache(home(process.env.CLOUD_EMBED_CACHE ?? join(vectorsDir, 'cloud-embed-cache')));
    const ai = createRestAi({ accountId, token: apiToken });
    const tau = tauFor(LOCAL);
    let cloudCalls = 0;
    let cloudTokens = 0;

    /** Unit vectors of `texts` in `role` by one model, read from the cache or embedded and added to it. */
    const vectors = async (model: string, role: EmbedRole, texts: readonly string[]): Promise<Map<string, Float32Array>> => {
      const m = cache.get(model, role);
      const missing = [...new Set(texts.filter((t) => !m.has(t)))];
      if (missing.length && model === LOCAL) {
        for (let i = 0; i < missing.length; i += 2_000) {
          const batch = missing.slice(i, i + 2_000);
          macEmbed(LOCAL, batch, role, litertFile).forEach((v, j) => m.set(batch[j]!, Array.from(unit(v))));
          process.stdout.write(`litert ${role}: ${Math.min(i + 2_000, missing.length)} of ${missing.length}\n`);
        }
      } else if (missing.length) {
        // The prompt and the text as the phone sends them (NFC, one line), batches of 20, four at a time, retried.
        const batches: string[][] = [];
        for (let i = 0; i < missing.length; i += 20) batches.push(missing.slice(i, i + 20));
        let next = 0;
        const worker = async () => {
          while (next < batches.length) {
            const batch = batches[next++]!;
            for (let attempt = 0; ; attempt++) {
              try {
                const res = (await ai.run(CLOUD as never, { input: batch.map((t) => PROMPTS[role] + embedText(t)), dimensions: DIMS } as never)) as {
                  data?: { index: number; embedding: number[] }[];
                  usage?: { prompt_tokens?: number };
                };
                const data = res.data ?? [];
                if (data.length !== batch.length || data.some((d) => !Array.isArray(d.embedding) || d.embedding.length !== DIMS)) throw new Error('bad shape');
                for (const d of data) m.set(batch[d.index]!, Array.from(unit(d.embedding)));
                cloudCalls++;
                cloudTokens += res.usage?.prompt_tokens ?? 0;
                break;
              } catch (err) {
                if (attempt >= 6) throw err;
                await sleep(1_000 * 2 ** attempt);
              }
            }
            if (next % 25 === 0) process.stdout.write(`cloud ${role}: ${Math.min(next * 20, missing.length)} of ${missing.length}\n`);
          }
        };
        await Promise.all(Array.from({ length: 4 }, worker));
      }
      if (missing.length) cache.save(model, role);
      return new Map(texts.map((t) => [t, Float32Array.from(m.get(t)!)]));
    };

    const index = loadIndex(vectorsDir);
    process.stdout.write(`v2 index: ${index.rows.length} vectors\n`);
    const lines: string[] = [];
    const say = (l = '') => lines.push(l);
    const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');
    const f3 = (x: number | null) => (x == null ? '—' : x.toFixed(3));
    const quant = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
      return `min ${s[0]!.toFixed(4)}, 1st percentile ${q(0.01).toFixed(4)}, 5th ${q(0.05).toFixed(4)}, median ${q(0.5).toFixed(4)}`;
    };
    const auto = (s: Snap) => s.scoped != null && s.scoped >= tau.auto;
    const band = (s: Snap) => s.score >= tau.low;

    // ── 1. The τ set ──────────────────────────────────────────────────────────
    const read = (pillar: string) => {
      const files: Partial<Record<EscoLang, string>> = {};
      for (const lang of ['en', 'pt', 'es'] as const) {
        const path = join(escoDir, `${pillar}_${lang}.csv`);
        if (existsSync(path)) files[lang] = readFileSync(path, 'utf8');
      }
      return files;
    };
    const plan = await planEscoImport({ occupations: read('occupations'), skills: read('skills') });
    const sample = (['pos', 'skill'] as const).flatMap((kind) =>
      shuffled(plan.labels.filter((l) => l.token.startsWith(`${kind}:`)).filter((l) => l.kind === 'alternative' || l.kind === 'hidden')).slice(0, 1_000).map((l) => ({ ...l, pillar: kind })),
    );
    const texts = sample.map((s) => s.label);
    const [lq, cq, ld, cd] = [await vectors(LOCAL, 'query', texts), await vectors(CLOUD, 'query', texts), await vectors(LOCAL, 'document', texts), await vectors(CLOUD, 'document', texts)];
    const sameWords = new Map<string, number[]>();
    index.rows.forEach((r, i) => {
      const k = `${r.token}\u0000${labelNorm(r.label)}`;
      (sameWords.get(k) ?? sameWords.set(k, []).get(k)!).push(i);
    });
    type TauRow = { s: (typeof sample)[number]; L: Snap; C: Snap; docLL: Snap; docLC: Snap; docCC: Snap; self: number };
    const tauRows: TauRow[] = [];
    const t0 = Date.now();
    for (const s of sample) {
      const skip = new Set(sameWords.get(`${s.token}\u0000${s.labelNorm}`) ?? []);
      const qL = lq.get(s.label)!;
      const qC = cq.get(s.label)!;
      const topL = nearest(index, s.pillar, qL, skip);
      const topC = nearest(index, s.pillar, qC, skip);
      // The document role: the string's own label back in the index, with the phone's or the cloud's document vector.
      const own = (q: Float32Array, d: Float32Array) => [{ token: s.token, lang: s.lang, s: dot(q, d) }];
      tauRows.push({
        s,
        L: snapOf(index, topL, s.lang),
        C: snapOf(index, topC, s.lang),
        docLL: snapOf(index, topL, s.lang, own(qL, ld.get(s.label)!)),
        docLC: snapOf(index, topL, s.lang, own(qL, cd.get(s.label)!)),
        docCC: snapOf(index, topC, s.lang, own(qC, cd.get(s.label)!)),
        self: dot(cd.get(s.label)!, ld.get(s.label)!),
      });
      if (tauRows.length % 250 === 0) process.stdout.write(`τ set: ${tauRows.length} of ${sample.length}, ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
    }
    const right = (x: Snap, token: string) => x.token === token;
    /** Changes between two snaps of the same strings: nearest token, τ_auto side, τ_low side, with right before and after. */
    const changes = <R>(rows: R[], a: (r: R) => Snap, b: (r: R) => Snap, token: (r: R) => string) => {
      const tok = rows.filter((r) => a(r).token !== b(r).token);
      const au = rows.filter((r) => auto(a(r)) !== auto(b(r)));
      const lo = rows.filter((r) => band(a(r)) !== band(b(r)));
      return {
        tokens: tok.length,
        tokensRight: [tok.filter((r) => right(a(r), token(r))).length, tok.filter((r) => right(b(r), token(r))).length],
        autoDown: au.filter((r) => auto(a(r))).length,
        autoUp: au.filter((r) => auto(b(r))).length,
        autoDownRight: au.filter((r) => auto(a(r)) && right(a(r), token(r))).length,
        autoUpRight: au.filter((r) => auto(b(r)) && right(b(r), token(r))).length,
        lowDown: lo.filter((r) => band(a(r))).length,
        lowUp: lo.filter((r) => band(b(r))).length,
        lowRight: lo.filter((r) => a(r).shown.includes(token(r)) || b(r).shown.includes(token(r))).length,
      };
    };
    const summary = <R>(rows: R[], x: (r: R) => Snap, token: (r: R) => string) => {
      const taken = rows.filter((r) => auto(x(r)));
      return {
        right1: rows.filter((r) => right(x(r), token(r))).length,
        right5: rows.filter((r) => x(r).shown.includes(token(r))).length,
        taken: taken.length,
        takenRight: taken.filter((r) => right(x(r), token(r))).length,
        below: rows.filter((r) => !band(x(r)) && x(r).shown.includes(token(r))).length,
      };
    };
    const date = new Date().toISOString().slice(0, 10);
    say(`# Workers AI's EmbeddingGemma 2 in place of the phone's LiteRT-LM vectors, on the v2 index, ${date}`);
    say();
    say(
      `\`${CLOUD}\` over the Workers AI REST API from the Mac (768 dimensions, the role's prompt before each text, NFC and one line as the phone sends it), standing in for \`${LOCAL}\` (LiteRT-LM's Python API on the Mac's CPU, as the v2 labels were made), against the v2 index's own label vectors (${index.rows.length} vectors, the replica's cache of \`token-registry-v2\`; none re-embedded). τ_auto ${tau.auto}, τ_low ${tau.low}, the tier-2 floor ${FLOOR}. "Local" is the phone's vector, "Cloud" the Workers AI one; a change is counted between the two on the same string or pair. Only public ESCO labels and the synthetic fixtures went to Workers AI (${cloudCalls} calls, ${cloudTokens} input tokens this run; the rest from the cache, \`test/workCloudEmbed.eval.test.ts\`).`,
    );
    say();
    say('## The same text, both models');
    say();
    say(`Cosine between the cloud's and the phone's vector of the same string, over the τ set's ${sample.length} strings: as documents ${quant(tauRows.map((r) => r.self))}; as queries ${quant(tauRows.map((r) => dot(cq.get(r.s.label)!, lq.get(r.s.label)!)))}.`);
    say();
    say('## 1. The τ set (`test/registry.tau.test.ts`\'s sample), as queries');
    say();
    say(`${sample.length} of ESCO's alternative and hidden labels (1,000 occupations, 1,000 skills, English, Portuguese and Spanish, seed 67), each snapped against every other label of its kind in the v2 index, its own words on its token left out; right means its own token.`);
    say();
    say('| Vectors | Right at 1 | Right among 5 | Taken at τ_auto | Taken and right | Right among 5 below τ_low |');
    say('|---|---|---|---|---|---|');
    for (const [name, x] of [
      ['Local (the phone)', (r: TauRow) => r.L],
      ['Cloud (Workers AI)', (r: TauRow) => r.C],
    ] as const) {
      const m = summary(tauRows, x, (r) => r.s.token);
      say(`| ${name} | ${m.right1} (${pct(m.right1, sample.length)}) | ${m.right5} (${pct(m.right5, sample.length)}) | ${m.taken} (${pct(m.taken, sample.length)}) | ${m.takenRight} (${pct(m.takenRight, m.taken)}) | ${m.below} |`);
    }
    const flipsTable = (rows: { name: string; c: ReturnType<typeof changes> ; n: number }[]) => {
      say('| Change against Local | Strings | Nearest token changes (right before → after) | τ_auto: falls below / rises above (right among them) | τ_low: falls below / rises above |');
      say('|---|---|---|---|---|');
      for (const { name, c, n } of rows)
        say(`| ${name} | ${n} | ${c.tokens} (${pct(c.tokens, n)}; ${c.tokensRight[0]} → ${c.tokensRight[1]}) | ${c.autoDown} / ${c.autoUp} (${c.autoDownRight} / ${c.autoUpRight}) | ${c.lowDown} / ${c.lowUp} |`);
    };
    const qc = changes(tauRows, (r) => r.L, (r) => r.C, (r) => r.s.token);
    const qcBy = (kind: string) => changes(tauRows.filter((r) => r.s.pillar === kind), (r) => r.L, (r) => r.C, (r) => r.s.token);
    say();
    flipsTable([
      { name: 'Cloud query, all', c: qc, n: tauRows.length },
      { name: 'Cloud query, occupations', c: qcBy('pos'), n: 1_000 },
      { name: 'Cloud query, skills', c: qcBy('skill'), n: 1_000 },
    ]);
    say();
    say('## 1b. The τ set, as documents (a mint)');
    say();
    say("Each string's own label put back into the index with a document vector, then the string asked again: the phone's query against the phone's document (today), the phone's query against the cloud's document (a Cloud user's mint found by a Local user), and the cloud's query against the cloud's document (a Cloud user's mint found by a Cloud user). Right means the string's own token.");
    say();
    say('| Vectors | Right at 1 | Taken at τ_auto | Taken and right |');
    say('|---|---|---|---|');
    for (const [name, x] of [
      ['Local query, Local document', (r: TauRow) => r.docLL],
      ['Local query, Cloud document', (r: TauRow) => r.docLC],
      ['Cloud query, Cloud document', (r: TauRow) => r.docCC],
    ] as const) {
      const m = summary(tauRows, x, (r) => r.s.token);
      say(`| ${name} | ${m.right1} (${pct(m.right1, sample.length)}) | ${m.taken} (${pct(m.taken, sample.length)}) | ${m.takenRight} (${pct(m.takenRight, m.taken)}) |`);
    }
    say();
    const dc = changes(tauRows, (r) => r.docLL, (r) => r.docLC, (r) => r.s.token);
    const dcc = changes(tauRows, (r) => r.docLL, (r) => r.docCC, (r) => r.s.token);
    flipsTable([
      { name: 'Local query, Cloud document', c: dc, n: tauRows.length },
      { name: 'Cloud query, Cloud document', c: dcc, n: tauRows.length },
    ]);

    // ── 2. The tier-2 set ─────────────────────────────────────────────────────
    const synth = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'work', 'tier2-floor.json'), 'utf8')) as {
      sentences: { id: string; text: string; locale: string; right: string[]; near: string[]; industry: string[] }[];
      listings: { id: string; lang: string; text: string }[];
    };
    const sq = { L: await vectors(LOCAL, 'query', synth.sentences.map((s) => s.text)), C: await vectors(CLOUD, 'query', synth.sentences.map((s) => s.text)) };
    const ld2 = { L: await vectors(LOCAL, 'document', synth.listings.map((l) => l.text)), C: await vectors(CLOUD, 'document', synth.listings.map((l) => l.text)) };
    type Mix = 'LL' | 'CL' | 'LC' | 'CC';
    const MIXES: { mix: Mix; name: string }[] = [
      { mix: 'LL', name: 'Local sentence, Local listing (today)' },
      { mix: 'CL', name: 'Cloud sentence, Local listing' },
      { mix: 'LC', name: 'Local sentence, Cloud listing' },
      { mix: 'CC', name: 'Cloud sentence, Cloud listing' },
    ];
    const pairs = synth.sentences.flatMap((s) => {
      const rel = new Map<string, string>();
      for (const k of ['right', 'near', 'industry'] as const) for (const id of s[k]) rel.set(id, k);
      return synth.listings.map((l) => ({
        s,
        l,
        rel: rel.get(l.id) ?? 'far',
        score: Object.fromEntries(MIXES.map(({ mix }) => [mix, dot(sq[mix[0] as 'L' | 'C'].get(s.text)!, ld2[mix[1] as 'L' | 'C'].get(l.text)!)])) as Record<Mix, number>,
      }));
    });
    const first = (mix: Mix) =>
      synth.sentences.filter((s) => {
        const best = pairs.filter((p) => p.s === s).sort((a, b) => b.score[mix] - a.score[mix])[0]!;
        return best.rel === 'right';
      }).length;
    say();
    say('## 2. The tier-2 set (`test/fixtures/work/tier2-floor.json`)');
    say();
    say(`${synth.sentences.length} sentences (queries) against ${synth.listings.length} listings (documents, their text as the phone sends it), ${pairs.length} pairs. Kept: a right or near pair at the floor (${FLOOR}) or above; admitted: a same-industry or far pair at or above it.`);
    say();
    say('| Vectors | Right listing first | Right kept | Near kept | Industry admitted | Far admitted | Pairs whose side of the floor changes (right, near, industry, far) |');
    say('|---|---|---|---|---|---|---|');
    for (const { mix, name } of MIXES) {
      const of = (rel: string) => pairs.filter((p) => p.rel === rel);
      const at = (rel: string) => of(rel).filter((p) => p.score[mix] >= FLOOR).length;
      const flips = pairs.filter((p) => p.score[mix] >= FLOOR !== p.score.LL >= FLOOR);
      const by = (rel: string) => flips.filter((p) => p.rel === rel).length;
      say(
        `| ${name} | ${first(mix)} of ${synth.sentences.length} | ${at('right')} of ${of('right').length} | ${at('near')} of ${of('near').length} | ${at('industry')} of ${of('industry').length} | ${at('far')} of ${of('far').length} | ${mix === 'LL' ? '—' : `${flips.length} (${by('right')}, ${by('near')}, ${by('industry')}, ${by('far')})`} |`,
      );
    }
    say();
    say(`The score of a pair, Cloud against Local, over the ${pairs.length} pairs: ${(['CL', 'LC', 'CC'] as const).map((m) => `${m} differs by ${f3(pairs.reduce((a, p) => a + Math.abs(p.score[m] - p.score.LL), 0) / pairs.length)} on average, ${f3(Math.max(...pairs.map((p) => Math.abs(p.score[m] - p.score.LL))))} at most`).join('; ')}.`);
    const crossing = pairs.filter((p) => (['CL', 'LC', 'CC'] as const).some((m) => p.score[m] >= FLOOR !== p.score.LL >= FLOOR));
    if (crossing.length) {
      say();
      say('The pairs that cross the floor in any mix:');
      say();
      say('| Sentence | Listing | Relation | LL | CL | LC | CC |');
      say('|---|---|---|---|---|---|---|');
      for (const p of crossing) say(`| ${p.s.id} | ${p.l.id} | ${p.rel} | ${f3(p.score.LL)} | ${f3(p.score.CL)} | ${f3(p.score.LC)} | ${f3(p.score.CC)} |`);
    }

    // ── 3. The locale strings ────────────────────────────────────────────────
    const locale = (JSON.parse(readFileSync(join(__dirname, 'fixtures', 'work', 'locale-cases.json'), 'utf8')) as { cases: { group: string; kind: string; lang: string; market: string; raw: string; right: string[]; none?: boolean }[] }).cases;
    const lt = locale.map((c) => c.raw);
    const [llq, lcq, lld, lcd] = [await vectors(LOCAL, 'query', lt), await vectors(CLOUD, 'query', lt), await vectors(LOCAL, 'document', lt), await vectors(CLOUD, 'document', lt)];
    const locRows = locale.map((c) => {
      const L = snapOf(index, nearest(index, c.kind, llq.get(c.raw)!), c.lang);
      const C = snapOf(index, nearest(index, c.kind, lcq.get(c.raw)!), c.lang);
      return { c, L, C, mintL: dot(llq.get(c.raw)!, lld.get(c.raw)!), mintC: dot(llq.get(c.raw)!, lcd.get(c.raw)!) };
    });
    const isRight = (x: Snap, c: (typeof locale)[number]) => x.token != null && c.right.includes(x.token);
    const lc = {
      tokens: locRows.filter((r) => r.L.token !== r.C.token),
      auto: locRows.filter((r) => auto(r.L) !== auto(r.C)),
      low: locRows.filter((r) => band(r.L) !== band(r.C)),
    };
    say();
    say('## 3. The locale strings (`test/fixtures/work/locale-cases.json`), retrieval only');
    say();
    say(`${locale.length} strings, each a query against its kind on the whole v2 index (no label left out; Clef and the pivot are not asked here: \`test/workRegistry.eval.test.ts\`'s locale arms run them with WORK_REPLICA_EMBED). Right at 1 means the nearest token is one the case expects.`);
    say();
    say('| Vectors | Nearest token right | Taken at τ_auto | In the band or above |');
    say('|---|---|---|---|');
    for (const [name, x] of [
      ['Local (the phone)', (r: (typeof locRows)[number]) => r.L],
      ['Cloud (Workers AI)', (r: (typeof locRows)[number]) => r.C],
    ] as const)
      say(`| ${name} | ${locRows.filter((r) => isRight(x(r), r.c)).length} of ${locale.length} | ${locRows.filter((r) => auto(x(r))).length} | ${locRows.filter((r) => band(x(r))).length} |`);
    say();
    say(`Changes against Local: the nearest token for ${lc.tokens.length} (right ${lc.tokens.filter((r) => isRight(r.L, r.c)).length} → ${lc.tokens.filter((r) => isRight(r.C, r.c)).length}), the side of τ_auto for ${lc.auto.length}, the side of τ_low for ${lc.low.length}.`);
    const locChanged = [...new Set([...lc.tokens, ...lc.auto, ...lc.low])];
    if (locChanged.length) {
      say();
      say('| String | Local: token, score (through its languages) | Cloud: token, score (through its languages) |');
      say('|---|---|---|');
      for (const r of locChanged) say(`| ${r.c.raw} (${r.c.lang}) | ${r.L.token} ${f3(r.L.score)} (${f3(r.L.scoped)}) | ${r.C.token} ${f3(r.C.score)} (${f3(r.C.scoped)}) |`);
    }
    say();
    say(
      `As documents: a mint of the string scores against the phone's later query of the same string ${quant(locRows.map((r) => r.mintL))} with the phone's document, ${quant(locRows.map((r) => r.mintC))} with the cloud's; at or above τ_auto ${locRows.filter((r) => r.mintL >= tau.auto).length} and ${locRows.filter((r) => r.mintC >= tau.auto).length} of ${locale.length}.`,
    );

    // ── For the decision ─────────────────────────────────────────────────────
    say();
    say('## Against the GGUF-to-LiteRT difference');
    say();
    say(
      `\`test/work-eval/embedder-litert-2026-10-30.md\` measured LiteRT-LM's query vectors against the GGUF's v3 documents, 600 labels as claim strings: the best label the same for 527 of 600 (88%), 89 of 600 (14.8%) falling below τ_auto and 1 rising above, none crossing τ_low or the tier-2 floor. Here, Cloud queries against the v2 (Local) documents: the nearest token changes for ${qc.tokens} of ${tauRows.length} (${pct(qc.tokens, tauRows.length)}), ${qc.autoDown} (${pct(qc.autoDown, tauRows.length)}) fall below τ_auto and ${qc.autoUp} (${pct(qc.autoUp, tauRows.length)}) rise above, ${qc.lowDown + qc.lowUp} cross τ_low; ${pairs.filter((p) => p.score.CL >= FLOOR !== p.score.LL >= FLOOR).length} tier-2 pairs of ${pairs.length} cross the floor (Cloud sentence), ${pairs.filter((p) => p.score.LC >= FLOOR !== p.score.LL >= FLOOR).length} (Cloud listing).`,
    );
    writeFileSync(join(__dirname, 'work-eval', `cloud-embed-${date}${process.env.WORK_EVAL_SUFFIX ?? ''}.md`), lines.join('\n') + '\n');
    expect(tauRows).toHaveLength(sample.length);
  }, 7_200_000);
});
