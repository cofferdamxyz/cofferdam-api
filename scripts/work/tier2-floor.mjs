// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Curated tier-2 floor (`recall.ts` `TIER2_FLOOR`) on an embedding
 * model's own scale: what a listing scores against a hirer's sentence when
 * it is the occupation asked for, an adjacent one, another occupation of
 * the same industry, or unrelated, embedded as recall embeds them (the
 * sentence a query, the listing's text a document, EmbeddingGemma 2's
 * prompts), at 768 and 512 dimensions. Two worlds: the synthetic set of
 * `test/fixtures/work/tier2-floor.json` (listings and sentences with their
 * relations) and the nine fixture CVs of `cv-blocks.json` as the listings the
 * recall eval publishes, against `hirer-prompts.json`. A floor is the only
 * gate a token miss meets in Curated mode, so the sweep asks, at each floor,
 * what share of each relation it admits.
 *
 *   node scripts/work/tier2-floor.mjs [--hf <repo:quant> | --model <path>] [--out test/work-eval]
 *
 * Needs brew's llama-embedding (llama.cpp). Writes nothing to Cloudflare.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const QUERY = 'task: search result | query: ';
const DOCUMENT = 'title: none | text: ';
const DIMS = 768;
const WIDTHS = [768, 512];
const FLOORS = [0.5, 0.55, 0.6, 0.62, 0.64, 0.65, 0.66, 0.67, 0.68, 0.69, 0.7, 0.72, 0.74, 0.76, 0.78, 0.8, 0.81, 0.82, 0.83, 0.84, 0.85, 0.86, 0.87, 0.88, 0.9];

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const hf = opt('--hf', 'ggml-org/embeddinggemma-2-GGUF:Q8_0');
const model = opt('--model', null) ?? resolveHf(hf);
const out = opt('--out', 'test/work-eval');
const generation = `gguf:${hf}`;

/** llama.cpp's Hugging Face cache names a file `<owner>_<repo>_<file>`; the quant names the file. */
function resolveHf(spec) {
  const [repo, quant] = spec.split(':');
  const dir = join(homedir(), 'Library', 'Caches', 'llama.cpp');
  const stem = repo.replace('/', '_') + '_';
  const hit = readdirSync(dir).find((f) => f.startsWith(stem) && f.endsWith(`-${quant}.gguf`));
  if (hit) return join(dir, hit);
  // Hugging Face's own cache, where `huggingface-cli download` puts it.
  const hub = join(homedir(), '.cache', 'huggingface', 'hub', `models--${repo.replace('/', '--')}`, 'snapshots');
  for (const snap of readdirSync(hub)) {
    const f = readdirSync(join(hub, snap)).find((f) => f.endsWith(`-${quant}.gguf`));
    if (f) return join(hub, snap, f);
  }
  throw new Error(`no ${spec} in llama.cpp's or Hugging Face's cache`);
}

const oneLine = (t) => t.normalize('NFC').replace(/\s+/g, ' ').trim();

/** One llama-embedding run: unit vectors, in order. */
function embed(texts) {
  const dir = mkdtempSync(join(tmpdir(), 'tier2-floor-'));
  try {
    const file = join(dir, 'prompts.txt');
    writeFileSync(file, texts.map(oneLine).join('\n') + '\n');
    const run = spawnSync('llama-embedding', ['-m', model, '--pooling', 'mean', '--embd-normalize', '2', '--embd-output-format', 'json', '-f', file, '-b', '8192', '-ub', '8192', '-c', '8192'], { encoding: 'utf8', maxBuffer: 1 << 30 });
    if (run.status !== 0) throw new Error(`llama-embedding exited ${run.status}: ${(run.stderr ?? '').split('\n').slice(-5).join(' ')}`);
    const data = JSON.parse(run.stdout).data;
    if (data.length !== texts.length) throw new Error(`${data.length} embeddings for ${texts.length} texts`);
    return data.map((d) => {
      const v = d.embedding;
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      if (v.length !== DIMS || Math.abs(n - 1) > 1e-3) throw new Error(`an embedding of ${v.length} dimensions and length ${n}`);
      return v;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cut = (v, k) => {
  const w = v.slice(0, k);
  const n = Math.sqrt(w.reduce((s, x) => s + x * x, 0));
  return w.map((x) => x / n);
};
const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '—');
const f3 = (x) => (x == null ? '—' : x.toFixed(3));

// ---- World 1: the synthetic set. ----
const synth = JSON.parse(readFileSync('test/fixtures/work/tier2-floor.json', 'utf8'));

// ---- World 2: the fixture CVs as the recall eval drafts them, against the hirer prompts. ----
const cvs = JSON.parse(readFileSync('test/fixtures/work/cv-blocks.json', 'utf8')).cvs;
const prompts = JSON.parse(readFileSync('test/fixtures/work/hirer-prompts.json', 'utf8')).prompts.filter((p) => !p.expected.refuse);
const EXPECTED = {
  'sink-en': ['en-plumber'], 'ev-charger-en': ['en-electrician'], 'rigger-en': ['es-rigger'], 'translation-en': ['es-translator'], 'gardener-en': ['pt-gardener'],
  'sink-pt': [], 'ev-charger-pt': ['pt-electrician'], 'rigger-pt': ['es-rigger'], 'translation-pt': ['es-translator'], 'gardener-pt': ['pt-gardener'], 'reais-pt': [],
  'sink-es': ['es-plumber'], 'ev-charger-es': [], 'rigger-es': ['es-rigger'], 'translation-es': ['es-translator'], 'gardener-es': ['pt-gardener'], 'pesos-es': ['es-plumber'],
};
/** The worker the sentence asks for, whatever the region: the recall eval's EXPECTED is region-bound, this is not. */
const TRADE = { sink: ['en-plumber', 'es-plumber'], 'ev-charger': ['en-electrician', 'pt-electrician'], rigger: ['es-rigger'], translation: ['es-translator'], gardener: ['pt-gardener'], reais: ['en-plumber', 'es-plumber'], pesos: ['en-plumber', 'es-plumber'] };
const dedupe = (xs) => [...new Set(xs)];
function draftText(cv) {
  const all = (field) => cv.blocks.flatMap((b) => (b.expected[field] == null ? [] : Array.isArray(b.expected[field]) ? b.expected[field] : [b.expected[field]]));
  const titles = dedupe(cv.blocks.filter((b) => b.kind === 'summary' || b.kind === 'experience').flatMap((b) => (b.expected.title ? [b.expected.title] : []))).slice(0, 5);
  const skills = dedupe(cv.blocks.filter((b) => ['summary', 'experience', 'skills'].includes(b.kind)).flatMap((b) => b.expected.skills ?? [])).slice(0, 30);
  const certificates = dedupe(all('certificates')).slice(0, 20);
  return [titles.join('; '), skills.join('; '), certificates.join('; ')].filter(Boolean).join('. ');
}
const fixtureListings = cvs.map((cv) => ({ id: cv.id, text: draftText(cv), region: cv.listing.region, scope: cv.listing.scope }));

// ---- Embed everything in one run. ----
const withEnglish = (l) => (l.english?.length ? `${l.text} (${[...new Set(l.english)].join('; ')})` : l.text);
const texts = [
  ...synth.sentences.map((s) => QUERY + s.text),
  ...synth.listings.map((l) => DOCUMENT + l.text),
  ...synth.listings.map((l) => DOCUMENT + withEnglish(l)),
  ...prompts.map((p) => QUERY + p.text),
  ...fixtureListings.map((l) => DOCUMENT + l.text),
];
console.log(`${texts.length} texts through ${model}`);
const t0 = Date.now();
const vectors = embed(texts);
console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s`);
let at = 0;
const take = (n) => vectors.slice(at, (at += n));
const synthQ = take(synth.sentences.length);
const synthD = take(synth.listings.length);
const synthDPlane = take(synth.listings.length);
const fixQ = take(prompts.length);
const fixD = take(fixtureListings.length);

const lines = [];
const say = (l = '') => lines.push(l);
const date = new Date().toISOString().slice(0, 10);
say(`# The Curated tier-2 floor for ${generation} at 2 widths, ${date}`);
say();
say(`What a listing scores against a hirer's sentence when it misses the token gate, by its relation to the sentence, embedded as recall embeds them: the sentence a query (\`${QUERY.trim()}\`), the listing's text a document (\`${DOCUMENT.trim()}\`; its titles, skills and certificates as the phone sends them, without the registry's English names), ${generation} through llama.cpp's llama-embedding on the Mac, mean-pooled and normalised, and at 512 the first 512 values normalised again. In Curated mode a token miss becomes a tier-2 finalist at \`TIER2_FLOOR\` (0.5 today, set on bge-m3's scale) or above, with no other gate, so the floor alone decides which of these a hirer is counted.`);
say();
say(`Two worlds. The synthetic set of \`test/fixtures/work/tier2-floor.json\`: ${synth.listings.length} listings and ${synth.sentences.length} sentences in English, Portuguese and Spanish, each sentence naming the listings that are right (the occupation it asks for, in any language), near (an adjacent occupation a hirer would still want counted as tier 2) and of the same industry (another occupation: never a finalist); every other listing is far. And the recall eval's world: the nine fixture CVs of \`cv-blocks.json\` as \`test/workRecall.eval.test.ts\` drafts them, against the ${prompts.length} hirer sentences of \`hirer-prompts.json\` that are not refused, right meaning the trade the sentence asks for in any region, and the recall eval's region-bound expectation beside it.`);

const langOf = (locale) => locale.slice(0, 2);
/** One synthetic world: its stats, its sweep and, for the phone's variant, its per-sentence table. */
function synthetic(width, docs, variant) {
  const Q = synthQ.map((v) => cut(v, width));
  const D = docs.map((v) => cut(v, width));
  const pairs = { right: [], near: [], industry: [], far: [] };
  const cross = [];
  const rows = [];
  let firstRight = 0;
  for (const [si, s] of synth.sentences.entries()) {
    const rel = {};
    for (const k of ['right', 'near', 'industry']) for (const id of s[k]) rel[id] = k;
    const scored = synth.listings.map((l, li) => ({ id: l.id, lang: l.lang, score: cos(Q[si], D[li]), rel: rel[l.id] ?? 'far' })).sort((a, b) => b.score - a.score);
    for (const x of scored) {
      pairs[x.rel].push(x.score);
      if (x.rel === 'right' && x.lang !== langOf(s.locale)) cross.push(x.score);
    }
    if (scored[0].rel === 'right') firstRight++;
    const best = (k) => scored.find((x) => x.rel === k);
    const worst = (k) => [...scored].reverse().find((x) => x.rel === k);
    const b = { right: best('right'), near: best('near'), industry: best('industry'), far: best('far') };
    const lowRight = worst('right');
    rows.push(`| ${s.id} | ${scored[0].id} ${f3(scored[0].score)} (${scored[0].rel}) | ${b.right ? `${f3(b.right.score)} / ${f3(lowRight.score)}` : '—'} | ${b.near ? `${b.near.id} ${f3(b.near.score)}` : '—'} | ${b.industry ? `${b.industry.id} ${f3(b.industry.score)}` : '—'} | ${b.far ? `${b.far.id} ${f3(b.far.score)}` : '—'} |`);
  }
  const stats = (xs) => {
    if (!xs.length) return '—';
    const s = [...xs].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return `${f3(s.reduce((a, b) => a + b, 0) / s.length)} (${f3(q(0.05))} to ${f3(q(0.95))}, min ${f3(s[0])}, max ${f3(s[s.length - 1])})`;
  };
  say();
  say(`## Synthetic set at ${width}, ${variant}`);
  say();
  say(`The right listing ranks first for ${firstRight} of ${synth.sentences.length} sentences. Cosine by relation, mean (5th to 95th percentile, min, max); a right listing in another language than the sentence's is counted again as cross-language:`);
  say();
  say('| Relation | Pairs | Cosine |');
  say('|---|---|---|');
  for (const k of ['right', 'near', 'industry', 'far']) say(`| ${k} | ${pairs[k].length} | ${stats(pairs[k])} |`);
  say(`| right, cross-language | ${cross.length} | ${stats(cross)} |`);
  say();
  say('The floor sweep: the share of each relation at or above the floor, which is what Curated mode would count as tier 2 of the listings that missed the token gate.');
  say();
  say('| Floor | Right kept | Right kept, cross-language | Near kept | Industry admitted | Far admitted |');
  say('|---|---|---|---|---|---|');
  for (const f of FLOORS) {
    const at = (xs) => xs.filter((x) => x >= f).length;
    say(`| ${f} | ${pct(at(pairs.right), pairs.right.length)} | ${pct(at(cross), cross.length)} | ${pct(at(pairs.near), pairs.near.length)} | ${pct(at(pairs.industry), pairs.industry.length)} | ${pct(at(pairs.far), pairs.far.length)} |`);
  }
  if (variant.startsWith('the phone')) {
    say();
    say('Per sentence: the listing ranked first, the best and the lowest right listing, and the best near, same-industry and far listing.');
    say();
    say('| Sentence | First | Right best / lowest | Near best | Industry best | Far best |');
    say('|---|---|---|---|---|---|');
    for (const r of rows) say(r);
  }
}

for (const width of WIDTHS) {
  synthetic(width, synthD, "the phone's text");
  synthetic(width, synthDPlane, "the plane's text (the registry's English names appended to a Portuguese or Spanish listing)");

  // The fixture world.
  const FQ = fixQ.map((v) => cut(v, width));
  const FD = fixD.map((v) => cut(v, width));
  say();
  say(`## The recall eval's world at ${width}`);
  say();
  say('Each hirer sentence against all nine fixture listings, whatever their region: the listing ranked first, the trade asked for (its best and lowest), and the best other listing. The recall eval expects the region-bound listing in the last column; a dash means none is in the sentence\'s region.');
  say();
  say('| Sentence | First | Trade best / lowest | Best other | Expected (region-bound) |');
  say('|---|---|---|---|---|');
  for (const [pi, p] of prompts.entries()) {
    const trade = TRADE[p.id.replace(/-(en|pt|es)$/, '')] ?? [];
    const scored = fixtureListings.map((l, li) => ({ id: l.id, score: cos(FQ[pi], FD[li]), trade: trade.includes(l.id) })).sort((a, b) => b.score - a.score);
    const t = scored.filter((x) => x.trade);
    const other = scored.find((x) => !x.trade);
    say(`| ${p.id} | ${scored[0].id} ${f3(scored[0].score)}${scored[0].trade ? '' : ' (other)'} | ${t.length ? `${f3(t[0].score)} / ${f3(t[t.length - 1].score)}` : '—'} | ${other ? `${other.id} ${f3(other.score)}` : '—'} | ${(EXPECTED[p.id] ?? []).join(', ') || '—'} |`);
  }
}

const file = join(out, `tier2-floor-${hf.replace('/', '-').replace(':', '-')}-${WIDTHS.join('-')}-${date}.md`);
writeFileSync(file, lines.join('\n') + '\n');
console.log(`wrote ${file}`);
