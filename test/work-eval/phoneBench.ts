// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The whole-CV parse benchmark inside the app on a phone (workspace decision
 * 0068): readers that only the app reaches, llama.rn on the iPhone's Metal,
 * read the two synthetic CVs with the cloud parse's request, and the answers
 * come back here to be scored with the truth and scorer of
 * `test/workParse.eval.test.ts`. The I/O is `test/workParsePhone.eval.test.ts`;
 * this module is pure, so `test/workParse.test.ts` checks it offline.
 *
 * The plan carries everything the phone needs from the plane's side: the
 * system prompt, the user text and the JSON schema of `parseRequest`, the
 * words of `SCHEMA_IN_PROMPT`, the answer cap, the temperature, the readers
 * and the runs. The app keeps no copy of the prompt, so the phone reads what
 * the cloud models read. The app's half is cofferdam-app
 * `src/lib/localAi/readerBench.ts` (the same `v: 1` shapes).
 */

import { parseRequest, readParse, ParseShapeError } from '../../src/services/work/parse.js';
import { SCHEMA_IN_PROMPT } from './localAi.js';
import { scoreParse, sectionScore, type ParseScore, type ParseTruth } from './parseScore.js';

export interface PhoneReader {
  /** The name in the report. */
  label: string;
  /** The app's model id (`src/lib/localAi/models.ts`): `lfm3-vl-2b`, `gemma-4-e2b`, `minicpm-v-4.7-1b`. */
  model: string;
  /** llama.rn's `image_max_tokens` for the projector; null for the model's own limit. */
  imageMaxTokens: number | null;
  /**
   * `grammar`: the schema as llama.rn's `response_format` (the chat template's grammar, as `llama-server` does);
   * `json`: llama.rn's own `json_schema` (a plain JSON grammar from the first token); `prompt`: in the system prompt, no grammar.
   */
  schema: 'grammar' | 'json' | 'prompt';
}

export interface PhonePlan {
  v: 1;
  /** What wrote the plan and when. */
  source: string;
  system: string;
  /** The text part before the page image. */
  user: string;
  schema: Record<string, unknown>;
  /** Appended to the system prompt before the schema's JSON when a reader puts the schema in the prompt. */
  schemaInPrompt: string;
  maxTokens: number;
  temperature: number;
  /** Reads in a row per reader and CV. */
  runs: number;
  /** The page images, by file name beside `plan.json`. */
  cvs: { id: string; file: string }[];
  readers: PhoneReader[];
}

export interface PhoneRun {
  reader: string;
  cv: string;
  run: number;
  /** False when the call threw; the answer is then empty. */
  ok: boolean;
  error: string | null;
  /** llama.rn's whole stream, the chat template's generation prompt included. */
  text: string;
  /** The answer as llama.rn's chat parser reads it (what `llama-server` returns on the Mac); null when it gave none. */
  content: string | null;
  /** From the call to the finished answer: the image, the prompt and the JSON. */
  msToJson: number;
  /** From the call to the first answer token, or null when none came. */
  msFirstToken: number | null;
  promptTokens: number | null;
  predictedTokens: number | null;
  /** The app's memory footprint (iOS `phys_footprint`), the most sampled during the read, in bytes. */
  peakFootprint: number | null;
  /** The least memory iOS said the app had left during the read (`os_proc_available_memory`), in bytes. */
  minAvailable: number | null;
  thermalBefore: string | null;
  thermalAfter: string | null;
  /** The answer stopped at the token cap. */
  stoppedLimit: boolean | null;
}

export interface PhoneResults {
  v: 1;
  device: { model: string | null; os: string | null; totalMemory: number | null };
  app: { version: string | null; build: string | null };
  runtime: { llamaRn: string | null; llamaCpp: string | null };
  startedAt: string;
  finishedAt: string | null;
  readers: {
    label: string;
    model: string;
    loadMs: number | null;
    gpu: boolean | null;
    reasonNoGPU: string | null;
    error: string | null;
    /** The footprint once the model and projector were loaded, in bytes. */
    loadedFootprint: number | null;
    /** How long the reader waited for the phone to cool to nominal before it loaded. */
    cooledMs: number | null;
    /** The most footprint and the least memory left while it loaded (written every second, so a load iOS ends still shows them). */
    loadPeakFootprint: number | null;
    loadMinAvailable: number | null;
  }[];
  runs: PhoneRun[];
}

export interface ScoredPhoneRun extends PhoneRun {
  failure: string | null;
  score: ParseScore | null;
}

export interface PlanCv {
  id: string;
  image: string;
}

/** The plan for the phone: the cloud parse's request for one page, the readers and the runs. */
export function phonePlan(cvs: PlanCv[], readers: PhoneReader[], runs: number, source: string): PhonePlan {
  if (!readers.length) throw new Error('a phone plan needs at least one reader');
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`runs must be a positive integer, not ${runs}`);
  const request = parseRequest('local:phone', { kind: 'image', pages: [{ mime: 'image/png', base64: '' }] });
  const messages = request.messages as { role: string; content: unknown }[];
  const system = messages.find((m) => m.role === 'system')?.content;
  const user = (messages.find((m) => m.role === 'user')?.content as { type: string; text?: string }[] | undefined)?.find((p) => p.type === 'text')?.text;
  const schema = (request.response_format as { json_schema?: { schema?: Record<string, unknown> } } | undefined)?.json_schema?.schema;
  if (typeof system !== 'string' || typeof user !== 'string' || !schema) throw new Error('parseRequest changed shape: no system prompt, user text or schema');
  return {
    v: 1,
    source,
    system,
    user,
    schema,
    schemaInPrompt: SCHEMA_IN_PROMPT,
    maxTokens: Number(request.max_tokens),
    temperature: Number(request.temperature),
    runs,
    cvs: cvs.map((cv) => ({ id: cv.id, file: cv.image })),
    readers,
  };
}

/** Reads `WORK_PARSE_PHONE_READERS`: a JSON array of readers. Throws on anything else, naming what is wrong. */
export function parsePhoneReaders(raw: string): PhoneReader[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('WORK_PARSE_PHONE_READERS must be a JSON array of {label, model, imageMaxTokens?, schema?}');
  }
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('WORK_PARSE_PHONE_READERS must be a non-empty JSON array');
  const seen = new Set<string>();
  return parsed.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o.label !== 'string' || !o.label.trim()) throw new Error(`WORK_PARSE_PHONE_READERS[${i}].label must be a non-empty string`);
    if (typeof o.model !== 'string' || !o.model.trim()) throw new Error(`WORK_PARSE_PHONE_READERS[${i}].model must be a non-empty string`);
    const max = o.imageMaxTokens ?? null;
    if (max !== null && (!Number.isInteger(max) || (max as number) < 1)) throw new Error(`WORK_PARSE_PHONE_READERS[${i}].imageMaxTokens must be a positive integer or null`);
    const schema = o.schema ?? 'grammar';
    if (schema !== 'grammar' && schema !== 'json' && schema !== 'prompt') {
      throw new Error(`WORK_PARSE_PHONE_READERS[${i}].schema must be "grammar", "json" or "prompt"`);
    }
    const label = o.label.trim();
    if (seen.has(label)) throw new Error(`WORK_PARSE_PHONE_READERS names the label ${JSON.stringify(label)} twice`);
    seen.add(label);
    return { label, model: o.model.trim(), imageMaxTokens: max as number | null, schema };
  });
}

const isObject = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object' && !Array.isArray(v);
const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown) => (typeof v === 'string' ? v : null);

/** The phone's `results.json`, checked: throws when it is not the app's `v: 1` results. */
export function parsePhoneResults(raw: unknown): PhoneResults {
  if (!isObject(raw) || raw.v !== 1) throw new Error('not the reader benchmark\'s results (v: 1)');
  if (!Array.isArray(raw.runs) || !Array.isArray(raw.readers)) throw new Error('the results hold no runs or readers');
  const runs = raw.runs.map((r, i): PhoneRun => {
    if (!isObject(r) || typeof r.reader !== 'string' || typeof r.cv !== 'string' || typeof r.run !== 'number') {
      throw new Error(`runs[${i}] has no reader, cv or run`);
    }
    return {
      reader: r.reader,
      cv: r.cv,
      run: r.run,
      ok: r.ok === true,
      error: strOrNull(r.error),
      text: typeof r.text === 'string' ? r.text : '',
      content: typeof r.content === 'string' ? r.content : null,
      msToJson: numOrNull(r.msToJson) ?? 0,
      msFirstToken: numOrNull(r.msFirstToken),
      promptTokens: numOrNull(r.promptTokens),
      predictedTokens: numOrNull(r.predictedTokens),
      peakFootprint: numOrNull(r.peakFootprint),
      minAvailable: numOrNull(r.minAvailable),
      thermalBefore: strOrNull(r.thermalBefore),
      thermalAfter: strOrNull(r.thermalAfter),
      stoppedLimit: typeof r.stoppedLimit === 'boolean' ? r.stoppedLimit : null,
    };
  });
  const obj = (v: unknown) => (isObject(v) ? v : {});
  const device = obj(raw.device);
  const app = obj(raw.app);
  const runtime = obj(raw.runtime);
  return {
    v: 1,
    device: { model: strOrNull(device.model), os: strOrNull(device.os), totalMemory: numOrNull(device.totalMemory) },
    app: { version: strOrNull(app.version), build: strOrNull(app.build) },
    runtime: { llamaRn: strOrNull(runtime.llamaRn), llamaCpp: strOrNull(runtime.llamaCpp) },
    startedAt: strOrNull(raw.startedAt) ?? '',
    finishedAt: strOrNull(raw.finishedAt),
    readers: raw.readers.map((r) => {
      const o = obj(r);
      return {
        label: strOrNull(o.label) ?? '',
        model: strOrNull(o.model) ?? '',
        loadMs: numOrNull(o.loadMs),
        gpu: typeof o.gpu === 'boolean' ? o.gpu : null,
        reasonNoGPU: strOrNull(o.reasonNoGPU),
        error: strOrNull(o.error),
        loadedFootprint: numOrNull(o.loadedFootprint),
        cooledMs: numOrNull(o.cooledMs),
        loadPeakFootprint: numOrNull(o.loadPeakFootprint),
        loadMinAvailable: numOrNull(o.loadMinAvailable),
      };
    }),
    runs,
  };
}

/**
 * The assistant headers of the readers' chat templates: LFM3-VL's ChatML and
 * Gemma 4's turn marker, as their GGUF templates write them.
 * On 2026-10-28 llama.rn (PR #420's head) gave no parsed `content` for these
 * grammar-bound reads and returned the model's stream as `text`, opening with
 * that header before the JSON; `llama-server`'s chat parser strips it and
 * returns the message alone. Taking the stream after the header is that
 * parser's step, never a repair of the JSON.
 */
export const ASSISTANT_HEADERS: readonly string[] = ['<|im_start|>assistant\n', '<|turn>model\n'];

/** A read's answer as a chat parser gives it: llama.rn's `content` when it has one, else the stream after its template's assistant header. */
export function answerOf(run: Pick<PhoneRun, 'text' | 'content'>): string {
  if (run.content?.trim()) return run.content;
  const header = ASSISTANT_HEADERS.find((h) => run.text.startsWith(h));
  return header ? run.text.slice(header.length) : run.text;
}

/**
 * Every run scored: its answer (`answerOf`) read as the cloud parse reads a
 * chat result, a failed call or an answer out of shape scoring zero, so the
 * phone and the Mac's `llama-server` are scored alike.
 */
export function scorePhoneRuns(results: PhoneResults, truths: Map<string, ParseTruth>, now = Date.now()): ScoredPhoneRun[] {
  return results.runs.map((r) => {
    const truth = truths.get(r.cv);
    if (!truth) throw new Error(`the results name a CV the fixtures do not hold: ${r.cv}`);
    if (!r.ok) return { ...r, failure: r.error ?? 'the call failed', score: null };
    try {
      const parsed = readParse({ choices: [{ message: { content: answerOf(r) } }] }, now);
      return { ...r, failure: null, score: scoreParse(parsed, truth) };
    } catch (err) {
      return { ...r, failure: err instanceof ParseShapeError ? `shape: ${err.reason}` : String(err).slice(0, 200), score: null };
    }
  });
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const secs = (ms: number | null) => (ms == null ? '—' : (ms / 1000).toFixed(1));
const gb = (bytes: number | null) => (bytes == null ? '—' : (bytes / 1e9).toFixed(2));
const cell = (s: string) => s.replace(/\|/g, '\\|');
const accuracyOf = (r: ScoredPhoneRun) => r.score?.accuracy ?? 0;

/** The report: the summary per reader, then each CV's sections and the misses of each reader's worst run, as in the Mac's report. */
export function phoneReport(
  results: PhoneResults,
  runs: ScoredPhoneRun[],
  cvs: { id: string; locale: string; layout: string }[],
  meta: { date: string; title: string; note?: string },
): string {
  const out: string[] = [];
  const d = results.device;
  out.push(`# Whole-CV parse on the phone, ${meta.title}, ${meta.date}`, '');
  out.push(
    'Generated by `test/workParsePhone.eval.test.ts` from the results of the reader benchmark on cofferdam-app\'s Local AI test screen ' +
      '(`src/lib/localAi/readerBench.ts`), on the synthetic CVs of `test/fixtures/work/parse/` with the cloud parse\'s request ' +
      '(`parseRequest`: its system prompt, user text and JSON schema), thinking off, temperature 0, ' +
      `scored by \`test/work-eval/parseScore.ts\` like \`test/workParse.eval.test.ts\`. Device: ${d.model ?? 'unknown'}, ${d.os ?? 'unknown OS'}, ` +
      `${d.totalMemory != null ? `${gb(d.totalMemory)} GB` : 'unknown'} of memory; llama.rn ${results.runtime.llamaRn ?? 'unknown'}, llama.cpp ${results.runtime.llamaCpp ?? 'unknown'}; ` +
      `app ${results.app.version ?? '?'} (${results.app.build ?? '?'}). From ${results.startedAt} to ${results.finishedAt ?? 'an unfinished run'}.`,
    '',
    'Times are the phone\'s wall clock from the call: to the first answer token, and to the finished JSON (image, prompt and answer); ' +
      'a reader\'s first read follows the wait for a cool phone, the four after it run on a phone the reads warm. ' +
      'Peak memory is the app\'s footprint (`phys_footprint`, what iOS ends an app by), the most sampled every 250 ms during a read; ' +
      '"left" is the least `os_proc_available_memory` reported. Thermal is `ProcessInfo.thermalState` before and after each read; ' +
      'each reader waited for the phone to cool to nominal (at most ten minutes) before it loaded, and the KV cache was cleared before every read.',
    '',
    ...(meta.note?.trim() ? [meta.note.trim(), ''] : []),
  );
  out.push(
    '## Readers',
    '',
    '| Reader | Model | Cooled first, s | Load s | GPU | Footprint loaded, GB | Load peak, GB | Load left, GB | Error |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  for (const r of results.readers) {
    // A reader with no load time, no error and no reads stopped before its model was in memory: the app ended.
    const error = r.error ? cell(r.error) : r.loadMs == null && !results.runs.some((x) => x.reader === r.label) ? 'the app ended before it loaded' : '';
    out.push(
      `| ${cell(r.label)} | ${r.model} | ${secs(r.cooledMs)} | ${secs(r.loadMs)} | ${r.gpu == null ? '—' : r.gpu ? 'yes' : `no${r.reasonNoGPU ? ` (${cell(r.reasonNoGPU)})` : ''}`} | ` +
        `${gb(r.loadedFootprint)} | ${gb(r.loadPeakFootprint)} | ${gb(r.loadMinAvailable)} | ${error} |`,
    );
  }
  out.push('');
  const labels = [...new Set(runs.map((r) => r.reader))];
  const rows = labels.map((label) => {
    const rs = runs.filter((r) => r.reader === label);
    const ok = rs.filter((r) => r.score);
    const byCv = cvs.map((cv) => mean(rs.filter((r) => r.cv === cv.id).map(accuracyOf)));
    const thermal = [...new Set(rs.flatMap((r) => [r.thermalBefore, r.thermalAfter]).filter((t): t is string => !!t))];
    const peaks = rs.map((r) => r.peakFootprint).filter((x): x is number => x != null);
    const left = rs.map((r) => r.minAvailable).filter((x): x is number => x != null);
    return { label, rs, ok, acc: mean(rs.map(accuracyOf)), worst: byCv.length ? Math.min(...byCv) : 0, thermal, peak: peaks.length ? Math.max(...peaks) : null, left: left.length ? Math.min(...left) : null };
  });
  rows.sort((a, b) => b.acc - a.acc);
  out.push(
    '## Summary',
    '',
    '| Reader | OK | Accuracy (mean) | Worst CV | First read: first token, JSON s | First token, median s | JSON, median s | JSON, max s | Peak memory, GB | Left, GB | Thermal |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const r of rows) {
    const done = r.rs.filter((x) => x.ok);
    // The reader's first read came after the run waited for the phone to cool: a user's single read.
    const first = done[0];
    out.push(
      `| ${cell(r.label)} | ${r.ok.length}/${r.rs.length} | ${pct(r.acc)} | ${pct(r.worst)} | ${first ? `${secs(first.msFirstToken)}, ${secs(first.msToJson)}` : '—'} | ` +
        `${secs(median(done.map((x) => x.msFirstToken).filter((x): x is number => x != null)))} | ` +
        `${secs(median(done.map((x) => x.msToJson)))} | ${secs(done.length ? Math.max(...done.map((x) => x.msToJson)) : null)} | ${gb(r.peak)} | ${gb(r.left)} | ${r.thermal.join(', ') || '—'} |`,
    );
  }
  out.push('');
  for (const cv of cvs) {
    out.push(`## ${cv.id} (${cv.locale}, ${cv.layout})`, '');
    out.push('| Reader | Accuracy | Identity | Headline | Experience | Education | Expiry + level | Skills | Certificates | Languages | Spurious jobs | JSON, median s | Runs |');
    out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
      const rs = r.rs.filter((x) => x.cv === cv.id);
      const worst = rs.filter((x) => x.score).sort((a, b) => a.score!.accuracy - b.score!.accuracy)[0];
      const each = rs.map((x) => (x.score ? pct(x.score.accuracy) : 'failed')).join(' ');
      if (!worst?.score) {
        out.push(`| ${cell(r.label)} | failed: ${cell(rs.map((x) => x.failure).join('; ').slice(0, 300))} ||||||||||| ${each} |`);
        continue;
      }
      const s = worst.score;
      const sec = (n: string) => {
        const x = sectionScore(s, n);
        return `${x.right}/${x.total}`;
      };
      const list = (l: string) => {
        const x = s.lists.find((y) => y.list === l)!;
        return `${x.tp}/${x.goldCount} (+${x.predCount - x.tp})`;
      };
      const extra = ['certificates', 'languages'].map((n) => sectionScore(s, n)).reduce((a, b) => ({ right: a.right + b.right, total: a.total + b.total }));
      out.push(
        `| ${cell(r.label)} | ${pct(mean(rs.map(accuracyOf)))} | ${sec('identity')} | ${sec('headline')} | ${sec('experience')} | ${sec('education')} | ${extra.right}/${extra.total} | ` +
          `${list('skills')} | ${list('certificates')} | ${list('languages')} | ${s.spurious.experience} | ${secs(median(rs.filter((x) => x.ok).map((x) => x.msToJson)))} | ${each} |`,
      );
    }
    out.push('', "Misses in each reader's worst run (synthetic values):", '');
    for (const r of rows) {
      const worst = r.rs.filter((x) => x.cv === cv.id && x.score).sort((a, b) => a.score!.accuracy - b.score!.accuracy)[0];
      const miss = worst?.score?.fields.filter((f) => !f.correct) ?? [];
      if (!miss.length) continue;
      out.push(`- ${cell(r.label)}: ${miss.map((f) => `${f.path} = ${JSON.stringify(f.pred)} (truth ${JSON.stringify(f.gold)})`).join('; ')}`);
    }
    out.push('');
  }
  out.push(
    'Cells: fields right over scored; lists as paired over truth (+ extra predictions). "Expiry + level" is the certificates\' validity dates and the languages\' levels. ' +
      '"Runs" is each read\'s accuracy in order.',
    '',
  );
  return out.join('\n');
}
