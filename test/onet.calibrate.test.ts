// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Clef's floor for the US layer's import (workspace decision 0066), from the
 * Mac (opt-in: ONET_CALIBRATE=1), on titles whose answer is known: O*NET
 * titles that are already an ESCO label of one of their occupation's
 * crosswalk candidates. Each is asked twice, the way the import asks:
 * - with its own candidates, that label hidden from the candidate holding it
 *   (a title that is the holder's English name, which Clef is shown, is not
 *   asked), so the right answer is that candidate;
 * - with the candidates of another O*NET occupation that holds none of the
 *   title's candidates, so the right answer is none.
 *
 * The report gives, per probability band, how often Clef chose right, chose
 * the wrong token or said none, so the import's floor can be set where a wrong
 * label, which the exact-label shortcut would take without a model, is rare.
 *
 *   cd cofferdam-api && ONET_CALIBRATE=1 ONET_DIR=~/Development/us-layer-data ESCO_DIR=~/Development/esco/import direnv exec .. yarn vitest run test/onet.calibrate.test.ts
 *
 * ONET_CALIBRATE_N is the number of titles (default 400). ONET_CALIBRATE_OUT
 * saves the answers (outside the repository), and ONET_CALIBRATE_ANSWERS reads
 * saved ones instead of asking Clef again, to report another reading. The
 * report goes to `test/work-eval/onet-clef-<date>.md`, numbers only. Needs
 * CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI run).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInference } from '../src/services/inference/index.js';
import { planEscoImport, type EscoLang } from '../src/services/work/esco.js';
import {
  clefChooser,
  layerLabelSets,
  ONET_FLOOR,
  ONET_NONE_MAX,
  onetCandidates,
  readCrosswalk,
  readOnetTitles,
  titleForms,
  type OnetCandidate,
} from '../src/services/work/onet.js';
import { embedTexts, labelNorm, type Candidate } from '../src/services/work/registry.js';
import { createRestAi } from './chat-eval/restAi.js';

const RUN = process.env.ONET_CALIBRATE === '1';
const RELEASE = '31.0';
const PARALLEL = 4;
const SHOWN = 5;

const home = (p: string) => p.replace(/^~(?=\/)/, homedir());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const dot = (a: readonly number[], b: readonly number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
const unit = (v: readonly number[]) => {
  const n = Math.sqrt(dot(v, v)) || 1;
  return v.map((x) => x / n);
};

interface Ask {
  title: string;
  onetCode: string;
  occupation: string;
  candidates: OnetCandidate[];
  /** The candidate that holds the title, or null when none of them does. */
  gold: string | null;
  hide: string;
}

interface Answer {
  ask: Ask;
  shown: string[];
  token: string | null;
  p: number | null;
  probabilities: Record<string, number>;
  failed: boolean;
}

describe.skipIf(!RUN)("US layer, Clef's floor (opt-in, from the Mac)", () => {
  it('asks Clef about titles ESCO already holds, with their own candidates and with another occupation’s', async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const onetDir = home(process.env.ONET_DIR ?? '');
    const escoDir = home(process.env.ESCO_DIR ?? '');
    if (!accountId || !apiToken || !onetDir || !escoDir) throw new Error('ONET_CALIBRATE needs ONET_DIR, ESCO_DIR, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    const n = Number(process.env.ONET_CALIBRATE_N ?? 400);

    const occupations: Partial<Record<EscoLang, string>> = {};
    for (const lang of ['en', 'pt', 'es'] as const) {
      const path = join(escoDir, `occupations_${lang}.csv`);
      if (existsSync(path)) occupations[lang] = readFileSync(path, 'utf8');
    }
    const esco = await planEscoImport({ occupations });
    const { english, known } = layerLabelSets(esco.tokens, esco.labels);
    const crosswalk = readCrosswalk(readFileSync(join(onetDir, 'esco-onet', 'ONET_Occupations_0_updated.csv'), 'utf8'));
    const occupation = new Map<string, string>();
    for (const r of crosswalk) if (!occupation.has(r.onetCode)) occupation.set(r.onetCode, r.onetTitle);
    const candidates = onetCandidates(crosswalk, esco.tokens);
    const titles = [
      ...readOnetTitles(readFileSync(join(onetDir, `onet-${RELEASE}`, 'job_titles.csv'), 'utf8')),
      ...readOnetTitles(readFileSync(join(onetDir, `onet-${RELEASE}`, 'sample_of_reported_titles.csv'), 'utf8')),
    ];

    // Titles one of their own candidates holds, each norm once.
    const seen = new Set<string>();
    const positives: Ask[] = [];
    for (const t of titles) {
      for (const form of titleForms(t.title, t.short).forms) {
        const norm = labelNorm(form);
        const cands = candidates.get(t.onetCode) ?? [];
        const holders = known.get(norm);
        const gold = cands.find((c) => holders?.has(c.token.token));
        // The holder's English name is shown to Clef, so a title that is that name tells nothing.
        if (!gold || holders!.size > 1 || seen.has(norm) || labelNorm(gold.token.labelEn) === norm) continue;
        seen.add(norm);
        positives.push({ title: form, onetCode: t.onetCode, occupation: occupation.get(t.onetCode) ?? '', candidates: cands, gold: gold.token.token, hide: norm });
      }
    }
    const codes = [...candidates.keys()].filter((c) => candidates.get(c)!.length);
    const asks: Ask[] = [];
    shuffled(positives)
      .slice(0, n)
      .forEach((pos, i) => {
        asks.push(pos);
        // Another occupation's candidates, none of them the title's own.
        const own = new Set(pos.candidates.map((c) => c.token.token));
        const other = shuffled(codes, 1000 + i).find((c) => c !== pos.onetCode && candidates.get(c)!.every((x) => !own.has(x.token.token)))!;
        asks.push({ ...pos, onetCode: other, occupation: occupation.get(other) ?? '', candidates: candidates.get(other)!, gold: null });
      });

    const inference = createInference({ WORK_EMBED_MODEL: process.env.WORK_EMBED_MODEL }, { ai: createRestAi({ accountId, token: apiToken }) })!;
    const savedPath = process.env.ONET_CALIBRATE_ANSWERS ? home(process.env.ONET_CALIBRATE_ANSWERS) : null;
    type Saved = { title: string; code: string; occupation: string; gold: string | null; shown: string[]; token: string | null; p: number | null; probabilities?: Record<string, number>; failed: boolean };
    const answers: Answer[] = savedPath
      ? (JSON.parse(readFileSync(savedPath, 'utf8')) as Saved[]).map((a) => ({
          ask: { title: a.title, onetCode: a.code, occupation: a.occupation, candidates: [], gold: a.gold, hide: '' },
          shown: a.shown,
          token: a.token,
          p: a.p,
          probabilities: a.probabilities ?? {},
          failed: a.failed,
        }))
      : await askClef();

    async function askClef(): Promise<Answer[]> {
      const vectors = new Map<string, number[]>();
      const texts = [...new Set(asks.flatMap((a) => [a.title, ...a.candidates.flatMap((c) => english.get(c.token.token) ?? [])]))];
      for (let i = 0; i < texts.length; i += 100) {
        const batch = texts.slice(i, i + 100);
        for (let attempt = 0; ; attempt++) {
          const e = await embedTexts(inference, batch);
          if (e.ok) {
            batch.forEach((t, j) => vectors.set(t, unit(e.vectors[j]!)));
            break;
          }
          if (attempt >= 4) throw new Error(`embedding failed five times at ${i}`);
          await sleep(1_000 * 2 ** attempt);
        }
      }

      // Clef at floor 0, so every answer is kept and read at each floor below.
      const choose = clefChooser(inference, { floor: 0 });
      const answers: Answer[] = new Array<Answer>(asks.length);
      let next = 0;
      const worker = async () => {
        while (next < asks.length) {
          const i = next++;
          const a = asks[i]!;
          const v = vectors.get(a.title)!;
          const shown: Candidate[] = a.candidates
            .map((c) => {
              let score = -1;
              let matched = c.token.labelEn;
              for (const l of english.get(c.token.token) ?? []) {
                if (labelNorm(l) === a.hide) continue;
                const s = dot(v, vectors.get(l)!);
                if (s > score) [score, matched] = [s, l];
              }
              return { token: c.token.token, labelEn: c.token.labelEn, matched, matchedLang: 'en', score };
            })
            .sort((x, y) => y.score - x.score)
            .slice(0, SHOWN);
          let pick = await choose({ title: a.title, onetCode: a.onetCode, occupation: a.occupation }, shown);
          for (let attempt = 0; pick.failed && attempt < 3; attempt++) {
            await sleep(1_000 * 2 ** attempt);
            pick = await choose({ title: a.title, onetCode: a.onetCode, occupation: a.occupation }, shown);
          }
          answers[i] = { ask: a, shown: shown.map((s) => s.token), token: pick.token, p: pick.p, probabilities: pick.probabilities ?? {}, failed: Boolean(pick.failed) };
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      return answers;
    }

    const pct = (x: number, of: number) => (of ? `${((100 * x) / of).toFixed(1)}%` : '—');
    const pos = answers.filter((a) => a.ask.gold);
    const neg = answers.filter((a) => !a.ask.gold);
    const floors = [0.5, 0.6, 0.7, 0.8, 0.9];
    const lines = floors.map((f) => {
      const placed = (a: Answer) => a.token != null && (a.p ?? 0) >= f;
      const right = pos.filter((a) => placed(a) && a.token === a.ask.gold).length;
      const wrong = pos.filter((a) => placed(a) && a.token !== a.ask.gold).length;
      const falsePlaced = neg.filter(placed).length;
      const placedAll = right + wrong + falsePlaced;
      return `| ${f} | ${pct(right, pos.length)} | ${pct(wrong, pos.length)} | ${pct(pos.length - right - wrong, pos.length)} | ${pct(falsePlaced, neg.length)} | ${pct(right, placedAll)} |`;
    });
    const goldShown = pos.filter((a) => a.shown.includes(a.ask.gold!)).length;
    // The other reading: Clef only says whether the title is any of the candidates (its probability of none), and
    // the token is Clef's most probable candidate, or the embedding's best.
    const pNone = (a: Answer) => a.probabilities.none ?? 1;
    const clefBest = (a: Answer) => a.shown.reduce<string | null>((best, t) => (best == null || (a.probabilities[t] ?? 0) > (a.probabilities[best] ?? 0) ? t : best), null);
    const noneLines = (pickToken: (a: Answer) => string | null) =>
      [0.05, 0.1, 0.15, 0.2, 0.3].map((max) => {
        const placed = (a: Answer) => pNone(a) <= max && pickToken(a) != null;
        const right = pos.filter((a) => placed(a) && pickToken(a) === a.ask.gold).length;
        const wrong = pos.filter((a) => placed(a) && pickToken(a) !== a.ask.gold).length;
        const falsePlaced = neg.filter(placed).length;
        return `| ${max} | ${pct(right, pos.length)} | ${pct(wrong, pos.length)} | ${pct(pos.length - right - wrong, pos.length)} | ${pct(falsePlaced, neg.length)} | ${pct(right, right + wrong + falsePlaced)} |`;
      });
    const date = new Date().toISOString().slice(0, 10);
    const report = [
      `# Clef's floor for the US layer, ${date}`,
      '',
      `${pos.length} O*NET ${RELEASE} titles that are an ESCO label of one of their occupation's ESCO–O*NET crosswalk candidates, that label hidden, each asked with its own candidates (the holder is right) and with another O*NET occupation's (none is right), as the import asks: the best ${SHOWN} by cosine, the O*NET occupation beside the title, \`${await inference.model('work-adjudicate')}\` over the Workers AI REST API from the Mac. The holder was among the ${SHOWN} shown for ${pct(goldShown, pos.length)}; ${answers.filter((a) => a.failed).length} calls failed after retries.`,
      '',
      "A wrong token or a false placement becomes a label the exact-label shortcut takes without a model; a title left out is only snapped as it is today.",
      '',
      "Clef's choice at a floor:",
      '',
      '| Floor | Own candidates: right | Wrong token | Left out | Another occupation’s: placed | Placed and right |',
      '|---|---|---|---|---|---|',
      ...lines,
      '',
      "Clef's probability of none at most the bound, the token Clef's most probable candidate:",
      '',
      '| None at most | Own candidates: right | Wrong token | Left out | Another occupation’s: placed | Placed and right |',
      '|---|---|---|---|---|---|',
      ...noneLines(clefBest),
      '',
      "The same bound, the token the embedding's best candidate:",
      '',
      '| None at most | Own candidates: right | Wrong token | Left out | Another occupation’s: placed | Placed and right |',
      '|---|---|---|---|---|---|',
      ...noneLines((a) => a.shown[0] ?? null),
      '',
      `The first reading of 2026-10-25: the same bound, the token Clef's choice from ${ONET_FLOOR}, else the embedding's best:`,
      '',
      '| None at most | Own candidates: right | Wrong token | Left out | Another occupation’s: placed | Placed and right |',
      '|---|---|---|---|---|---|',
      ...noneLines((a) => (a.token && (a.p ?? 0) >= ONET_FLOOR ? a.token : (a.shown[0] ?? null))),
      '',
      `The import's reading (\`onet.ts\`, 2026-10-26): Clef's choice from ${ONET_FLOOR} (\`ONET_FLOOR\`), else the embedding's best only when it is also Clef's most probable candidate; it ships at none at most ${ONET_NONE_MAX} (\`ONET_NONE_MAX\`):`,
      '',
      '| None at most | Own candidates: right | Wrong token | Left out | Another occupation’s: placed | Placed and right |',
      '|---|---|---|---|---|---|',
      ...noneLines((a) => (a.token && (a.p ?? 0) >= ONET_FLOOR ? a.token : a.shown[0] != null && clefBest(a) === a.shown[0] ? a.shown[0] : null)),
      '',
      "\"Right\" is the candidate ESCO itself gives the title as a label; a wrong token is another candidate of the same O*NET occupation, often the title's broader or narrower sibling (\"journalist\" for \"business journalist\"), and sometimes the better one, since ESCO's own placement is the yardstick.",
      '',
      'Includes information from the O*NET 31.0 Database by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA), used under the CC BY 4.0 license (`cofferdam-api` `NOTICE`).',
      '',
    ].join('\n');
    writeFileSync(join(__dirname, 'work-eval', `onet-clef-${date}.md`), report);
    console.log(report);
    // The answers, for reading the misses (outside the repository).
    if (process.env.ONET_CALIBRATE_OUT)
      writeFileSync(
        home(process.env.ONET_CALIBRATE_OUT),
        JSON.stringify(
          answers.map((a) => ({ title: a.ask.title, code: a.ask.onetCode, occupation: a.ask.occupation, gold: a.ask.gold, shown: a.shown, token: a.token, p: a.p, probabilities: a.probabilities, failed: a.failed })),
          null,
          1,
        ),
      );
    expect(answers.length).toBe(asks.length);
  }, 60 * 60 * 1000);
});
