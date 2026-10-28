// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The whole-CV parse evaluation (opt-in: WORK_PARSE_EVAL=1), the founder's
 * alternative of 2026-10-27 to on-device OCR plus rule-based
 * de-identification: the whole CV goes to Workers AI in one call, and
 * nothing is kept. Two paths on the two synthetic CVs in
 * `test/fixtures/work/parse/` (a one-column pt electrician; an es safety
 * technician with a sidebar, the layout that broke the block path on the
 * Pixel):
 *
 *   image: the page PNG to each vision model with JSON-schema output;
 *   text:  the OCR lines (the sidebar CV's merged across both columns, as a
 *          line-sorted read gives them) to a text model in JSON mode.
 *
 * Each run is scored against the known truth (`test/work-eval/parseScore.ts`):
 * identity, headline, experience (title, employer, dates), education,
 * skills, certificates and languages, with latency and cost per CV. Writes
 * `test/work-eval/parse-<date>.md`, and the runs' data (every predicted
 * value) as JSON in the OS temp folder, outside the repository. It
 * measures; it does not fail on accuracy. A failed run scores zero; a model
 * that reports no usage shows its cost as unknown, since an image's tokens
 * cannot be estimated from the request.
 *
 *   cd cofferdam-api && WORK_PARSE_EVAL=1 direnv exec .. yarn vitest run test/workParse.eval.test.ts
 *
 * Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI run).
 * WORK_PARSE_IMAGE_MODELS and WORK_PARSE_TEXT_MODELS (comma-separated ids)
 * pick the models, WORK_PARSE_RUNS the runs per model, path and CV (3),
 * WORK_PARSE_GAP_MS the pause between calls (500), WORK_PARSE_CALL_TIMEOUT_MS
 * the most a call may take (300,000; a slower call is a failed run). A second
 * run the same day writes `parse-<date>-2.md`, never over the first. WORK_PARSE_EVAL=dry
 * checks the harness and the report offline, on a fake model. The REST API keeps no
 * input or output (Workers AI's data policy); no AI Gateway is in the path.
 *
 * On-device readers run in the same report through OpenAI-compatible servers
 * on the Mac (`test/work-eval/localAi.ts`; workspace decision 0068, proposed
 * amendment): WORK_PARSE_LOCAL is a JSON array of `{label, url, model,
 * paths?, thinking?}`, the image path and thinking off by default. With the cloud lists set empty, no
 * Cloudflare credentials are needed and nothing leaves the Mac:
 *
 *   WORK_PARSE_EVAL=1 WORK_PARSE_IMAGE_MODELS= WORK_PARSE_TEXT_MODELS= \
 *   WORK_PARSE_LOCAL='[{"label":"MiniCPM-V 4.7 1B (llama.cpp)","url":"http://127.0.0.1:8080","model":"minicpm-v-4.7"},
 *     {"label":"Gemma 4 E2B (LiteRT-LM)","url":"http://127.0.0.1:9379","model":"gemma-4-E2B-it.litertlm,gpu"}]' \
 *   yarn vitest run test/workParse.eval.test.ts
 *
 * The servers' commands are in the workspace `docs/runbooks/android-build.md`
 * (Local readers on the Mac).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MODEL_PRICES, type AiBinding } from '../src/services/inference/index.js';
import { usageOf } from '../src/services/work/fields.js';
import { ParseShapeError, parseRequest, readParse, type ParseInput } from '../src/services/work/parse.js';
import { createRestAi, RestAiError } from './chat-eval/restAi.js';
import { createLocalAi, LocalAiError, parseLocalReaders } from './work-eval/localAi.js';
import { scoreParse, sectionScore, type ParseScore, type ParseTruth } from './work-eval/parseScore.js';

const LIVE = process.env.WORK_PARSE_EVAL === '1';
/** WORK_PARSE_EVAL=dry runs the harness on a fake model that answers the pt CV's truth for every call, and writes to the OS temp folder. */
const DRY = process.env.WORK_PARSE_EVAL === 'dry';

/** Workers AI models with image input and JSON-schema output, read 2026-10-27; Gemma 4 (vision on its model page) since 2026-10-28. */
const IMAGE_MODELS = [
  '@cf/zai-org/glm-5.3-flash',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
  '@cf/qwen/qwen3.8-27b',
  '@cf/moonshotai/kimi-k2.6',
  '@cf/google/gemma-4-26b-a4b-it',
];
const TEXT_MODELS = ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/zai-org/glm-5.3-flash'];

/** Prices (USD per million tokens) for the candidates `MODEL_PRICES` does not hold yet, read 2026-10-27. */
const CANDIDATE_PRICES: Record<string, { input: number; output: number }> = {
  '@cf/meta/llama-4-scout-17b-16e-instruct': { input: 0.27, output: 0.85 },
  '@cf/qwen/qwen3.8-27b': { input: 0.45, output: 3.2 },
  '@cf/moonshotai/kimi-k2.6': { input: 0.95, output: 4 },
};

/** Workers AI bills $0.011 per 1,000 neurons: 11 micro-dollars a neuron. */
const MICRO_USD_PER_NEURON = 11;

interface FixtureCv {
  id: string;
  locale: string;
  layout: string;
  image: string;
  ocr: string[];
  truth: ParseTruth;
}

interface Run {
  model: string;
  /** An on-device reader on the Mac: no cost, and its name is the reader's label. */
  local: boolean;
  path: 'image' | 'text';
  cv: string;
  run: number;
  ok: boolean;
  failure: string | null;
  ms: number;
  tokensIn: number;
  tokensOut: number;
  neurons: number | null;
  /** Null when the model reported no usage: an image's tokens cannot be estimated from the request. */
  costMicroUsd: number | null;
  /** Null when the call failed or answered out of shape; such a run counts as zero accuracy. */
  score: ParseScore | null;
  dropped: { path: string; reason: string }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const usd = (micro: number) => `$${(micro / 1e6).toFixed(5)}`;
/** A cloud model by its last path segment; an on-device reader by its label, which may hold a slash. A bar is escaped for the table. */
const short = (m: string) => (m.startsWith('local:') ? m.slice('local:'.length) : m.split('/').pop()!).replace(/\|/g, '\\|');

/** The first of `<stem>.<ext>`, `<stem>-2.<ext>`, … that does not exist, so a second run that day keeps the first's file. */
function freePath(dir: string, stem: string, ext: string): string {
  for (let i = 1; ; i++) {
    const p = join(dir, `${stem}${i === 1 ? '' : `-${i}`}.${ext}`);
    if (!existsSync(p)) return p;
  }
}
const list = (s: ParseScore, l: string) => {
  const x = s.lists.find((y) => y.list === l)!;
  return `${x.tp}/${x.goldCount} (+${x.predCount - x.tp})`;
};

/** The call's cost from what it reported, or null when it reported neither neurons nor tokens, or the model has no price. */
function cost(model: string, result: unknown): number | null {
  const u = usageOf(result);
  if (u.neurons != null && u.neurons > 0) return Math.round(u.neurons * MICRO_USD_PER_NEURON);
  const p = MODEL_PRICES[model] ?? CANDIDATE_PRICES[model];
  if (!p || (!u.tokensIn && !u.tokensOut)) return null;
  return Math.round(u.tokensIn * p.input + u.tokensOut * p.output);
}

const accuracyOf = (r: Run) => r.score?.accuracy ?? 0;

/** The mean cost per CV, or "unknown" when any run reported no usage. */
function costCell(rs: Run[]): string {
  if (rs.every((r) => r.local)) return 'on device';
  const known = rs.filter((r) => r.costMicroUsd != null);
  if (!known.length) return 'unknown';
  const m = usd(mean(known.map((r) => r.costMicroUsd!)));
  return known.length === rs.length ? m : `${m} (${rs.length - known.length} unreported)`;
}

function report(meta: Record<string, unknown>, runs: Run[], cvs: FixtureCv[]): string {
  const out: string[] = [];
  out.push(`# Whole-CV parse evaluation, ${String(meta.date)}`, '');
  out.push(
    'Generated by `test/workParse.eval.test.ts` (WORK_PARSE_EVAL=1) on the synthetic CVs of `test/fixtures/work/parse/`; ' +
      `${String(meta.runs)} run(s) per model, path and CV, ${Math.round(Number(meta.durationMs) / 1000)} s in all. ` +
      'Accuracy is correct fields and paired list items over everything scored, spurious entries included (`test/work-eval/parseScore.ts`). ' +
      'Cost is per CV, from the neurons a model reported, else its token prices; an on-device reader runs on the Mac and costs nothing.',
    '',
  );
  // Keyed by a separator no label holds, since a reader's label is free text.
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    const k = `${r.model}\u0000${r.path}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  out.push('## Summary', '', '| Model | Path | OK | Accuracy (mean) | Worst CV | Median ms | Max ms | Cost per CV |', '|---|---|---|---|---|---|---|---|');
  const rows = [...groups.entries()].map(([k, rs]) => {
    const [model, path] = k.split('\u0000') as [string, string];
    const ok = rs.filter((r) => r.ok);
    const byCv = cvs.map((cv) => mean(rs.filter((r) => r.cv === cv.id).map(accuracyOf)));
    return { model, path, rs, ok, acc: mean(rs.map(accuracyOf)), worst: Math.min(...byCv) };
  });
  rows.sort((a, b) => b.acc - a.acc);
  for (const r of rows) {
    out.push(
      `| ${short(r.model)} | ${r.path} | ${r.ok.length}/${r.rs.length} | ${pct(r.acc)} | ${pct(r.worst)} | ${median(r.ok.map((x) => x.ms))} | ${Math.max(0, ...r.ok.map((x) => x.ms))} | ${costCell(r.rs)} |`,
    );
  }
  out.push('');
  for (const cv of cvs) {
    out.push(`## ${cv.id} (${cv.locale}, ${cv.layout})`, '');
    out.push('| Model | Path | Accuracy | Identity | Headline | Experience | Education | Expiry + level | Skills | Certificates | Languages | Spurious jobs | Median ms |');
    out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
      const rs = r.rs.filter((x) => x.cv === cv.id);
      const worst = rs.filter((x) => x.ok && x.score).sort((a, b) => a.score!.accuracy - b.score!.accuracy)[0]; // the worst run that answered
      if (!worst?.score) {
        out.push(`| ${short(r.model)} | ${r.path} | failed: ${rs.map((x) => x.failure).join('; ')} |||||||||||`);
        continue;
      }
      const s = worst.score;
      const sec = (n: string) => {
        const x = sectionScore(s, n);
        return `${x.right}/${x.total}`;
      };
      const extra = ['certificates', 'languages'].map((n) => sectionScore(s, n)).reduce((a, b) => ({ right: a.right + b.right, total: a.total + b.total }));
      out.push(
        `| ${short(r.model)} | ${r.path} | ${pct(mean(rs.map(accuracyOf)))} | ${sec('identity')} | ${sec('headline')} | ${sec('experience')} | ${sec('education')} | ${extra.right}/${extra.total} | ${list(s, 'skills')} | ${list(s, 'certificates')} | ${list(s, 'languages')} | ${s.spurious.experience} | ${median(rs.filter((x) => x.ok).map((x) => x.ms))} |`,
      );
    }
    out.push('', 'Misses in each model\'s worst run (synthetic values):', '');
    for (const r of rows) {
      const worst = r.rs.filter((x) => x.cv === cv.id && x.ok && x.score).sort((a, b) => a.score!.accuracy - b.score!.accuracy)[0];
      const miss = worst?.score?.fields.filter((f) => !f.correct) ?? [];
      if (!miss.length) continue;
      out.push(`- ${short(r.model)} (${r.path}): ${miss.map((f) => `${f.path} = ${JSON.stringify(f.pred)} (truth ${JSON.stringify(f.gold)})`).join('; ')}`);
    }
    out.push('');
  }
  out.push('Cells: fields right over scored; lists as paired over truth (+ extra predictions). "Expiry + level" is the certificates\' validity dates and the languages\' levels.', '');
  return out.join('\n');
}

/** A stand-in for Workers AI that answers the first CV's truth to every call, for the dry run. */
function dryAi(truth: ParseTruth): AiBinding {
  const answer = {
    name: truth.identity.name,
    email: truth.identity.email,
    phone: truth.identity.phone,
    location: truth.identity.location,
    headline_title: truth.headline.title,
    years_experience: truth.headline.years,
    experience: truth.experience.map((e) => ({ ...e, location: null, skills: [] })),
    education: truth.education,
    skills: truth.skills,
    certificates: truth.certificates,
    languages: truth.languages.map((l) => ({ name: l.code === 'pt' ? 'Português' : l.code === 'en' ? 'Inglês' : 'Espanhol', level: l.level })),
  };
  const run = async () => {
    await sleep(5);
    return { choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 1500, completion_tokens: 500 } };
  };
  return { run } as unknown as AiBinding;
}

describe.skipIf(!LIVE && !DRY)('Whole-CV parse evaluation (live: Workers AI and on-device readers)', () => {
  it('parses each synthetic CV on each model and path and writes the report', async () => {
    const ids = (v: string | undefined, d: string[]) => (v ?? d.join(',')).split(',').map((m) => m.trim()).filter(Boolean);
    const imageModels = ids(process.env.WORK_PARSE_IMAGE_MODELS, IMAGE_MODELS);
    const textModels = ids(process.env.WORK_PARSE_TEXT_MODELS, TEXT_MODELS);
    const localReaders = parseLocalReaders(process.env.WORK_PARSE_LOCAL);
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const cloud = imageModels.length + textModels.length > 0;
    if (!DRY && cloud && (!accountId || !token)) {
      throw new Error('WORK_PARSE_EVAL needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN for Workers AI (set WORK_PARSE_IMAGE_MODELS= and WORK_PARSE_TEXT_MODELS= to run on-device readers alone)');
    }
    const runsPer = Number(process.env.WORK_PARSE_RUNS ?? 3);
    // Every call gives up after this long, so one hung server costs a failed run, not the report.
    const callTimeoutMs = Number(process.env.WORK_PARSE_CALL_TIMEOUT_MS ?? 300_000);
    const gap = DRY ? 0 : Number(process.env.WORK_PARSE_GAP_MS ?? 500);
    const dir = join(__dirname, 'fixtures/work/parse');
    const cvs = (JSON.parse(readFileSync(join(dir, 'cvs.json'), 'utf8')) as { cvs: FixtureCv[] }).cvs;
    const pages = new Map(cvs.map((cv) => [cv.id, readFileSync(join(dir, cv.image)).toString('base64')]));
    const cloudAi = DRY ? dryAi(cvs[0]!.truth) : cloud ? createRestAi({ accountId: accountId!, token: token! }) : null;
    const started = Date.now();
    const runs: Run[] = [];

    const plan: { model: string; path: 'image' | 'text'; ai: AiBinding; local: boolean }[] = [
      ...(cloudAi ? imageModels.map((model) => ({ model, path: 'image' as const, ai: cloudAi, local: false })) : []),
      ...(cloudAi ? textModels.map((model) => ({ model, path: 'text' as const, ai: cloudAi, local: false })) : []),
      ...localReaders.flatMap((reader) => {
        const ai = DRY ? dryAi(cvs[0]!.truth) : createLocalAi(reader);
        // The parse request's family follows the id: a local id is never llama's, so it gets the OpenAI JSON-schema wrapper.
        return (reader.paths ?? ['image']).map((path) => ({ model: `local:${reader.label}`, path, ai, local: true }));
      }),
    ];
    if (!plan.length) throw new Error('nothing to run: every model list is empty and WORK_PARSE_LOCAL names no reader');
    for (const { model, path, ai, local } of plan) {
      for (const cv of cvs) {
        const input: ParseInput =
          path === 'image'
            ? { kind: 'image', pages: [{ mime: 'image/png', base64: pages.get(cv.id)! }] }
            : { kind: 'text', text: cv.ocr.join('\n') };
        for (let run = 0; run < runsPer; run++) {
          const request = parseRequest(model, input);
          const t0 = Date.now();
          let result: unknown = null;
          let failure: string | null = null;
          let parsed = null;
          try {
            result = await ai.run(model as never, request as never, { signal: AbortSignal.timeout(callTimeoutMs) } as never);
            parsed = readParse(result);
          } catch (err) {
            failure =
              err instanceof ParseShapeError
                ? `shape: ${err.reason}`
                : (err as { name?: string })?.name === 'TimeoutError' || /aborted|timeout/i.test(String(err))
                  ? `timed out after ${callTimeoutMs} ms`
                  : err instanceof RestAiError || err instanceof LocalAiError
                  ? err.message
                  : String(err).slice(0, 200);
          }
          const ms = Date.now() - t0;
          const u = usageOf(result);
          const r: Run = {
            model,
            local,
            path,
            cv: cv.id,
            run,
            ok: parsed != null,
            failure,
            ms,
            tokensIn: u.tokensIn,
            tokensOut: u.tokensOut,
            neurons: u.neurons,
            costMicroUsd: local ? 0 : cost(model, result),
            score: parsed ? scoreParse(parsed, cv.truth) : null,
            dropped: parsed?.dropped ?? [],
          };
          runs.push(r);
          console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${short(model)} ${path} ${cv.id} #${run} ${ms} ms ${pct(accuracyOf(r))}${failure ? ` (${failure})` : ''}`);
          if (!local) await sleep(gap);
        }
      }
    }

    const date = new Date().toISOString().slice(0, 10);
    const meta = {
      date,
      imageModels,
      textModels,
      localReaders: localReaders.map((r) => ({ label: r.label, model: r.model, paths: r.paths ?? ['image'] })),
      runs: runsPer,
      durationMs: Date.now() - started,
    };
    // The report goes beside the other evaluations; the runs' data, every predicted value included, stays outside the repository.
    const reportPath = freePath(DRY ? tmpdir() : join(__dirname, 'work-eval'), `parse-${date}`, 'md');
    const dataPath = freePath(tmpdir(), `cofferdam-parse-${date}`, 'json');
    writeFileSync(reportPath, report(meta, runs, cvs));
    writeFileSync(dataPath, JSON.stringify({ meta, runs }, null, 2) + '\n');
    console.log(`report: ${reportPath}\nruns: ${dataPath}`);
    expect(runs).toHaveLength(plan.length * cvs.length * runsPer);
  }, 3_600_000);
});
