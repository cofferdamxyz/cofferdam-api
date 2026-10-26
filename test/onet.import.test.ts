// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The US layer's import (workspace decision 0066), run from the Mac (opt-in:
 * ONET_IMPORT=1). Reads the ESCO–O*NET crosswalk, O*NET 31.0's title files and
 * the ESCO occupation files the registry was loaded from, places every title
 * (`services/work/onet.ts`), embeds the new labels with the pinned work-embed
 * model and asks Clef the close calls over the Workers AI REST API, and writes:
 *
 *   <ONET_OUT>/national-001.sql, …          → wrangler d1 execute cofferdam-work --remote --yes --file=… (each, in order, after migration 0003)
 *   <ONET_OUT>/national-vectors-001.ndjson  → wrangler vectorize upsert token-registry-v1 --file=… (each, after the SQL)
 *   <ONET_OUT>/placements.csv               → every title, where it went and why: the list of changes
 *   <ONET_OUT>/review.md                    → the counts, and a sample per method to read before the load
 *
 *   cd cofferdam-api && ONET_IMPORT=1 ONET_DIR=~/Development/us-layer-data ESCO_DIR=~/Development/esco/import direnv exec .. yarn vitest run test/onet.import.test.ts
 *
 * Inputs:
 * - ONET_DIR holds `esco-onet/ONET_Occupations_0_updated.csv` (the
 *   crosswalk, esco.ec.europa.eu) and `onet-31.0/job_titles.csv` and
 *   `sample_of_reported_titles.csv` (onetcenter.org, O*NET 31.0 Database,
 *   CSV).
 * - ESCO_DIR holds the `occupations_<lang>.csv` the registry was loaded from
 *   (en, pt, es).
 * - ONET_LIVE_TOKENS, optional and strongly advised, is the live registry's
 *   occupations as `wrangler d1 execute cofferdam-work --remote --json
 *   --command "SELECT token, esco_uri AS uri, status FROM registry_tokens
 *   WHERE kind = 'pos'"` prints them. The run stops if a token it writes to
 *   is not live and active with the same ESCO URI, since D1 refuses a label
 *   on a missing token.
 * - ONET_CLEF=0 places only what needs no model and leaves the rest
 *   unplaced; ONET_NONE_MAX is Clef's most probable none for a placement
 *   (default `ONET_NONE_MAX`), ONET_FLOOR the probability at which Clef's
 *   own choice names the token (default `ONET_FLOOR`), ONET_MARGIN the lead a
 *   sure best needs (default 0.04), ONET_PARALLEL the calls in flight (default
 *   4).
 *
 * Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI run).
 * Nothing is written to Cloudflare by this run.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInference } from '../src/services/inference/index.js';
import { adjudicationQuestions, nationalTitleState } from '../src/services/work/clef.js';
import { planEscoImport, type EscoLang } from '../src/services/work/esco.js';
import { nationalSqlFiles, nationalVectorLine } from '../src/services/work/national.js';
import {
  clefChooser,
  layerLabelSets,
  ONET_FLOOR,
  ONET_MARGIN,
  ONET_NONE_MAX,
  planOnetLayer,
  readCrosswalk,
  readOnetTitles,
  type OnetChoice,
  type TitlePlacement,
} from '../src/services/work/onet.js';
import { embedTexts, tauFor } from '../src/services/work/registry.js';
import { createRestAi } from './chat-eval/restAi.js';

const RUN = process.env.ONET_IMPORT === '1';
const RELEASE = '31.0';
/** Vectors per NDJSON file, as in the ESCO import. */
const PER_FILE = 5_000;
const PARALLEL = Number(process.env.ONET_PARALLEL ?? 4);
/** Titles per method in the review sample. */
const SAMPLE = 30;

const home = (p: string) => p.replace(/^~(?=\/)/, homedir());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fixed shuffle, so a re-run samples the same titles. */
function sample<T>(items: readonly T[], n: number, seed = 66): T[] {
  const a = [...items];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const round = (v: number | null) => (v == null ? '' : v.toFixed(3));

describe.skipIf(!RUN)('US layer import (opt-in, from the Mac)', () => {
  it('places every O*NET title, embeds the new labels and writes the files wrangler loads', async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const onetDir = home(process.env.ONET_DIR ?? '');
    const escoDir = home(process.env.ESCO_DIR ?? '');
    if (!accountId || !apiToken || !onetDir || !escoDir) throw new Error('ONET_IMPORT needs ONET_DIR, ESCO_DIR, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    const out = home(process.env.ONET_OUT ?? join(onetDir, 'cofferdam-import'));
    mkdirSync(out, { recursive: true });

    // The registry as the ESCO import planned it.
    const occupations: Partial<Record<EscoLang, string>> = {};
    for (const lang of ['en', 'pt', 'es'] as const) {
      const path = join(escoDir, `occupations_${lang}.csv`);
      if (existsSync(path)) occupations[lang] = readFileSync(path, 'utf8');
    }
    const esco = await planEscoImport({ occupations });
    const { english, known, foreign } = layerLabelSets(esco.tokens, esco.labels);

    const crosswalk = readCrosswalk(readFileSync(join(onetDir, 'esco-onet', 'ONET_Occupations_0_updated.csv'), 'utf8'));
    const titles = [
      ...readOnetTitles(readFileSync(join(onetDir, `onet-${RELEASE}`, 'job_titles.csv'), 'utf8')),
      ...readOnetTitles(readFileSync(join(onetDir, `onet-${RELEASE}`, 'sample_of_reported_titles.csv'), 'utf8')),
    ];
    process.stdout.write(`inputs: ${esco.tokens.filter((t) => t.kind === 'pos').length} ESCO occupations, ${crosswalk.length} crosswalk rows, ${titles.length} O*NET titles\n`);

    const inference = createInference({ WORK_EMBED_MODEL: process.env.WORK_EMBED_MODEL }, { ai: createRestAi({ accountId, token: apiToken }) })!;
    const embedModel = await inference.model('work-embed');
    const floor = process.env.ONET_FLOOR ? Number(process.env.ONET_FLOOR) : ONET_FLOOR;
    const noneMax = process.env.ONET_NONE_MAX ? Number(process.env.ONET_NONE_MAX) : ONET_NONE_MAX;
    const clef = process.env.ONET_CLEF === '0' ? undefined : clefChooser(inference, { floor });
    // Clef's answers are kept in the output folder, so a run that stops, or one after a fix, asks only what is new.
    // The file is named by the model and the question, so another of either asks again.
    const fingerprint = createHash('sha256')
      .update([await inference.model('work-adjudicate'), nationalTitleState('t', 'o', 'c'), JSON.stringify(adjudicationQuestions('pos', []))].join('\u0000'))
      .digest('hex')
      .slice(0, 12);
    // ONET_CLEF_CACHE names the file instead, for answers known to come from the same model and question.
    const cachePath = process.env.ONET_CLEF_CACHE ? home(process.env.ONET_CLEF_CACHE) : join(out, `clef-answers-${fingerprint}-${floor}.json`);
    const cache = new Map<string, OnetChoice>(existsSync(cachePath) ? (Object.entries(JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, OnetChoice>)) : []);
    const saveCache = () => writeFileSync(cachePath, JSON.stringify(Object.fromEntries(cache)));
    let unsaved = 0;
    const choose: typeof clef = clef
      ? async (ask, shown) => {
          const key = [ask.onetCode, ask.title, ...shown.map((c) => `${c.token}=${c.matched}`)].join('\u0000');
          const hit = cache.get(key);
          if (hit && !hit.failed && hit.probabilities?.none != null) return hit;
          // A failed call goes again a few times before it counts as failed.
          for (let attempt = 0; ; attempt++) {
            const pick = await clef(ask, shown);
            if (!pick.failed && pick.probabilities?.none != null) {
              cache.set(key, pick);
              if (++unsaved >= 500) {
                saveCache();
                unsaved = 0;
              }
            }
            if (!pick.failed || attempt >= 3) return pick;
            await sleep(1_000 * 2 ** attempt);
          }
        }
      : undefined;
    const started = Date.now();
    const unembeddable: string[] = [];
    const plan = await planOnetLayer(
      { crosswalk, titles, tokens: esco.tokens, english, known, foreign, release: RELEASE },
      {
        embed: async function embed(texts, role): Promise<(number[] | null)[]> {
          let reason = '';
          for (let attempt = 0; attempt < 5; attempt++) {
            const e = await embedTexts(inference, texts, { role, log: (event) => (reason = String(event.reason ?? '')) });
            if (e.ok) return e.vectors;
            await sleep(1_000 * 2 ** attempt);
          }
          // A batch that fails five times is halved until the text the model refuses is found; that text gets no vector.
          if (texts.length === 1) {
            unembeddable.push(`${texts[0]} (${reason})`);
            return [null];
          }
          const half = Math.ceil(texts.length / 2);
          return [...(await embed(texts.slice(0, half), role)), ...(await embed(texts.slice(half), role))];
        },
        choose,
        noneMax,
        // A sure best is one at the pinned model's τ_auto.
        sure: tauFor(embedModel).auto,
        margin: process.env.ONET_MARGIN ? Number(process.env.ONET_MARGIN) : ONET_MARGIN,
        parallel: PARALLEL,
        progress: (event, done, total) => {
          if (done === total || done % 5_000 < (event.startsWith('embedded') ? 100 : 1)) process.stdout.write(`${event} ${done} of ${total}\n`);
        },
      },
    );
    if (choose) saveCache();
    if (unembeddable.length) process.stdout.write(`${unembeddable.length} texts ${embedModel} would not embed: ${unembeddable.slice(0, 20).join('; ')}\n`);
    process.stdout.write(`plan: ${JSON.stringify(plan.counts)} in ${Math.round((Date.now() - started) / 1000)} s\n`);

    // Every token the layer writes to must be live, with the same ESCO URI.
    const tokens = new Map(esco.tokens.map((t) => [t.token, t]));
    const written = new Set([...plan.labels.map((l) => l.token), ...plan.codes.map((c) => c.token)]);
    if (process.env.ONET_LIVE_TOKENS) {
      const live = new Map<string, { uri: string | null; status?: string }>();
      for (const block of JSON.parse(readFileSync(home(process.env.ONET_LIVE_TOKENS), 'utf8')) as { results: { token: string; uri: string | null; status?: string }[] }[])
        for (const r of block.results) live.set(r.token, r);
      // An export without the status column (an older query) checks the URI only.
      const missing = [...written].filter((t) => live.get(t)?.uri !== tokens.get(t)!.escoUri || (live.get(t)!.status ?? 'active') !== 'active');
      if (missing.length) throw new Error(`${missing.length} tokens are not live with the same ESCO URI, e.g. ${missing.slice(0, 5).join(', ')}`);
      process.stdout.write(`all ${written.size} tokens the layer writes to are live\n`);
    } else process.stdout.write('ONET_LIVE_TOKENS not given: the tokens were not checked against the live registry\n');

    // A previous run's numbered files would load beside this run's.
    for (const f of readdirSync(out)) if (/^(national-\d{3}\.sql|national-vectors-\d{3}\.ndjson)$/.test(f)) rmSync(join(out, f));
    const sqlFiles = nationalSqlFiles(plan.labels, plan.codes, Date.now());
    sqlFiles.forEach((text, i) => writeFileSync(join(out, `national-${String(i + 1).padStart(3, '0')}.sql`), text));
    const lines = plan.labels.map((l) => nationalVectorLine(l, tokens.get(l.token)!, plan.vectors.get(l.labelId)!));
    const vectorFiles: string[] = [];
    for (let i = 0; i < lines.length; i += PER_FILE) {
      const name = `national-vectors-${String(i / PER_FILE + 1).padStart(3, '0')}.ndjson`;
      writeFileSync(join(out, name), lines.slice(i, i + PER_FILE).join('\n') + '\n');
      vectorFiles.push(name);
    }

    // The list of changes, and the review.
    const occupation = new Map<string, string>();
    for (const r of crosswalk) if (!occupation.has(r.onetCode)) occupation.set(r.onetCode, r.onetTitle);
    const label = (t: string | null) => (t ? (tokens.get(t)?.labelEn ?? t) : '');
    writeFileSync(
      join(out, 'placements.csv'),
      [
        'onet_code,onet_occupation,title,method,token,esco_label,candidates,best,second,clef_p,clef_none',
        ...plan.placements.map((p) =>
          [p.onetCode, occupation.get(p.onetCode) ?? '', p.title, p.method, p.token ?? '', label(p.token), p.candidates, round(p.best), round(p.second), round(p.p), round(p.none)]
            .map(csvCell)
            .join(','),
        ),
      ].join('\n') + '\n',
    );
    const leads = plan.placements.filter((p) => p.best != null && p.second != null).map((p) => p.best! - p.second!);
    const buckets = [0.01, 0.02, 0.04, 0.08, 0.16, Infinity];
    const histogram = buckets.map((b, i) => {
      const lo = i ? buckets[i - 1]! : 0;
      return `| ${i ? lo.toFixed(2) : '0'} to ${b === Infinity ? 'more' : b.toFixed(2)} | ${leads.filter((d) => d >= lo && d < b).length} |`;
    });
    const row = (p: TitlePlacement) =>
      `| ${p.onetCode} ${occupation.get(p.onetCode) ?? ''} | ${p.title} | ${label(p.token)} | ${p.best == null ? '' : `${round(p.best)} / ${round(p.second)}`} | ${round(p.p)} / ${round(p.none)} |`;
    const methods: TitlePlacement['method'][] = ['single', 'lead', 'clef', 'none', 'disagreed', 'clef_failed', 'elsewhere', 'ambiguous', 'acronym', 'qualified', 'no_candidate', 'unembedded'];
    writeFileSync(
      join(out, 'review.md'),
      [
        `# US layer review: O*NET ${RELEASE} titles on ESCO tokens`,
        '',
        `Embedding model ${embedModel}; Clef ${choose ? `on: none at most ${noneMax}, its own choice from ${floor}` : 'off'}; margin ${process.env.ONET_MARGIN ?? ONET_MARGIN}. ${plan.labels.length} labels and ${plan.codes.length} codes on ${written.size} tokens.`,
        '',
        "What to expect of the Clef placements (`test/work-eval/onet-clef-2026-10-26.md`, on 400 titles ESCO already holds, read as shipped): of titles asked with their own occupation's candidates, 47% were placed, 84% of those on the candidate ESCO gives the title and the rest on another candidate of the same O*NET occupation, often a broader or narrower sibling; of titles asked with another occupation's candidates, 0.8% were placed. `disagreed` titles are those where Clef's most probable candidate was not the embedding's best and Clef was not sure enough to choose. Read the clef sample with that in mind: a sibling is a near miss, another occupation is a wrong label.",
        '',
        '| Method | Titles |',
        '| --- | --- |',
        ...Object.entries(plan.counts).map(([k, v]) => `| ${k} | ${v} |`),
        '',
        '## Lead of the best candidate over the second, in contests',
        '',
        '| Lead | Titles |',
        '| --- | --- |',
        ...histogram,
        '',
        ...methods.flatMap((m) => {
          const rows = sample(
            plan.placements.filter((p) => p.method === m),
            SAMPLE,
          );
          return rows.length
            ? [`## ${m} (${plan.counts[m]}; ${rows.length} shown)`, '', '| O*NET occupation | Title | ESCO token | Best / second cosine | Clef p / none |', '| --- | --- | --- | --- | --- |', ...rows.map(row), '']
            : [];
        }),
        '## Attribution',
        '',
        'This layer includes information from the O*NET 31.0 Database by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA). Used under the CC BY 4.0 license. Cofferdam Inc. has modified all or some of this information: titles were split into long and short forms and placed on ESCO occupations through the ESCO–O*NET crosswalk (placements.csv lists every change). USDOL/ETA has not approved, endorsed, or tested these modifications. O*NET® is a trademark of USDOL/ETA.',
        '',
      ].join('\n'),
    );

    process.stdout.write(
      [
        `wrote ${sqlFiles.length} SQL files (${plan.labels.length} labels, ${plan.codes.length} codes), ${vectorFiles.length} vector files, placements.csv and review.md to ${out}`,
        'read review.md first; then, after migration 0003, load one file at a time, the SQL first (runbook: docs/runbooks/cloudflare-deploys.md, Cofferdam Work resources):',
        `  for f in ${out}/national-[0-9][0-9][0-9].sql; do wrangler d1 execute cofferdam-work --remote --yes --file="$f" || break; done`,
        `  for f in ${out}/national-vectors-[0-9][0-9][0-9].ndjson; do wrangler vectorize upsert token-registry-v1 --file="$f" || break; done`,
      ].join('\n') + '\n',
    );
    expect(lines).toHaveLength(plan.labels.length);
  }, 3 * 60 * 60 * 1000);
});
