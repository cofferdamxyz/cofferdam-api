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
import { localAnswerKey, localRequest, SCHEMA_IN_PROMPT, type LocalReader } from './localAi.js';
import { scoreParse, sectionScore, type ParseScore, type ParseTruth } from './parseScore.js';
import { withSchemaAsRegex } from './schemaRegex.js';

export interface PhoneReader {
  /** The name in the report. */
  label: string;
  /** The app's reader id (`src/lib/localAi/models.ts`): `gemma-4-e2b`, since llama.rn's readers (`lfm3-vl-2b`, `minicpm-v-4.7-1b`) left the app on 2026-10-30. */
  model: string;
  /** llama.rn's `image_max_tokens` for the projector; null for the model's own limit. */
  imageMaxTokens: number | null;
  /**
   * `grammar`: the schema as llama.rn's `response_format` (the chat template's grammar, as `llama-server` does);
   * `json`: llama.rn's own `json_schema` (a plain JSON grammar from the first token); `prompt`: in the system prompt, no grammar;
   * `regex`: the plan's `text.regex`, for LiteRT-LM.
   */
  schema: 'grammar' | 'json' | 'prompt' | 'regex';
  /**
   * `text`: the CV's OCR lines through the cloud parse's text path (the plan's `text`), no image; `pdf`: the text layer the
   * phone's own parser reads from the CV's PDF (PDFKit; LiteRT-LM readers only), after the plan's `text.userPrefix`; the
   * page image when absent.
   */
  input?: 'text' | 'pdf';
  /** With `input: "pdf"`, the phone parser's path to the text (cofferdam-app `modules/pdf-text`); `string` when absent. */
  pdfText?: PhonePdfMethod;
  /**
   * A LiteRT-LM reader (the app's `modules/litert-lm`): the `.litertlm` file copied beside the plan, Metal (`gpu`), the
   * Pixel's TPU (`npu`, its compiled file, whose context `contextLimit` holds) or the CPU, multi-token prediction on or
   * off, and on the Pixel a `fallback` engine that reads again what the first cut at its context or left out of shape.
   * It reads text with the schema as a regex, as `scripts/work/litert-answers.py` does on the Mac.
   */
  litert?: PhoneEngine & { fallback?: PhoneEngine };
}

/** A LiteRT-LM engine in the app's plan (cofferdam-app `readerBenchPlan.ts` `LiteRtEngine`). */
export interface PhoneEngine {
  file: string;
  backend: 'gpu' | 'cpu' | 'npu';
  mtp: boolean;
  activation?: 'f32' | 'f16';
  /** The engine's fixed context, prompt and answer together: 4,096 for the Pixel's TPU file. */
  contextLimit?: number;
}

/** The cloud parse's text path for each CV, as the Mac's in-process LiteRT-LM reader receives it (`localRequest` with `schema: "regex"`). */
export interface PhoneText {
  system: string;
  /** The JSON schema as one regex whose whitespace also takes U+2581 (`schemaRegex.ts`). */
  regex: string;
  /** The answer's cap: the Mac's LiteRT-LM reader's (4,000), above the parse's own 2,500. */
  maxTokens: number;
  temperature: number;
  users: { id: string; user: string }[];
  /** What the text path writes before a CV's text, for a reader that reads the CV's PDF itself (`input: "pdf"`). */
  userPrefix?: string;
}

/** The iPhone's text paths (cofferdam-app `modules/pdf-text`): PDFKit's string, attributed string, whole-page selection, the string's spaces rebuilt from the glyphs' positions, and Vision's recognition on the rendered page. */
export const PHONE_PDF_METHODS = ['string', 'attributed', 'selection', 'rebuilt', 'vision'] as const;
export type IphonePdfMethod = (typeof PHONE_PDF_METHODS)[number];
/** Every text path the app's `modules/pdf-text` offers: the iPhone's, and `pdfbox`, Apache PDFBox's Android port on Android. */
export const APP_PDF_METHODS = [...PHONE_PDF_METHODS, 'pdfbox'] as const;
export type PhonePdfMethod = (typeof APP_PDF_METHODS)[number];

/** The text the phone's parser read from one CV's PDF, as the app writes it back (once per CV and path). */
export interface PhonePdfText {
  cv: string;
  /** The parser's path; `string` in results written before the paths existed. */
  method: PhonePdfMethod;
  pages: number;
  chars: number;
  ms: number;
  /** The pages joined as `scripts/work/pdf-pages.swift` joins them: each page's text and a blank line. */
  text: string;
  error: string | null;
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
  /** The page images, by file name beside `plan.json`, and a CV's PDF for a reader with `input: "pdf"`. */
  cvs: { id: string; file: string; pdf?: string }[];
  readers: PhoneReader[];
  /** Text paths the app takes from every CV's PDF before any reader, with no model (the paths' comparison). */
  extract?: PhonePdfMethod[];
  /** The text path, when a reader reads text; null otherwise. */
  text: PhoneText | null;
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
  /** The answer's decode speed as the runtime reports it (llama.rn's timings, LiteRT-LM's benchmark info). */
  decodeTokensPerSec: number | null;
  /** LiteRT-LM: the backend whose answer this is. */
  backend?: PhoneEngine['backend'];
  /** LiteRT-LM: the reader stopped the answer on a run of whitespace; `content` is what it read, closed (the app's `closeAnswer`). */
  stalled?: boolean;
  /** LiteRT-LM: tokens in the conversation once the answer ended. */
  contextTokens?: number | null;
  /** LiteRT-LM: the first engine's try, when this answer is its fallback's (the Pixel: the TPU's, before the CPU's). */
  firstTry?: { backend: PhoneEngine['backend']; reason: string; error: string | null; msToJson: number; promptTokens: number | null; predictedTokens: number | null; contextTokens: number | null };
}

export interface PhoneResults {
  v: 1;
  device: { model: string | null; os: string | null; totalMemory: number | null };
  app: { version: string | null; build: string | null };
  runtime: { llamaRn: string | null; llamaCpp: string | null; litertLm: string | null };
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
  /** The text layer of each CV a reader read from its PDF. */
  texts?: PhonePdfText[];
}

export interface ScoredPhoneRun extends PhoneRun {
  failure: string | null;
  score: ParseScore | null;
}

export interface PlanCv {
  id: string;
  image: string;
  /** The CV's OCR lines, for the text path. */
  ocr?: string[];
}

/** The Mac's LiteRT-LM reader's cap on the answer (`WORK_PARSE_LOCAL`'s `maxTokens` in the runs of 2026-10-29). */
export const TEXT_MAX_TOKENS = 4_000;

/** Each CV's text request as the Mac's in-process LiteRT-LM reader gets it: the parse's text path with the schema as a regex. */
function phoneText(cvs: PlanCv[]): PhoneText {
  const shaped = (text: string) => withSchemaAsRegex(parseRequest('local:phone', { kind: 'text', text }));
  const message = (request: Record<string, unknown>, role: string) => (request.messages as { role: string; content: unknown }[]).find((m) => m.role === role)?.content;
  const sample = shaped('');
  const system = message(sample, 'system');
  const pattern = (sample.response_format as { type?: unknown; pattern?: unknown } | undefined)?.pattern;
  if (typeof system !== 'string' || typeof pattern !== 'string') throw new Error('parseRequest changed shape: no system prompt or regex on the text path');
  const users = cvs.map((cv) => {
    if (!cv.ocr?.length) throw new Error(`${cv.id} has no OCR lines for the text path`);
    const user = message(shaped(cv.ocr.join('\n')), 'user');
    if (typeof user !== 'string') throw new Error('parseRequest changed shape: no user text on the text path');
    return { id: cv.id, user };
  });
  return { system, regex: pattern, maxTokens: TEXT_MAX_TOKENS, temperature: Number(sample.temperature), users };
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
    text: readers.some((r) => r.input === 'text') ? phoneText(cvs) : null,
  };
}

/** What the parse's text path writes before a CV's text ("The CV, as OCR lines:" and a blank line), read from `parseRequest`. */
export function textUserPrefix(): string {
  const request = parseRequest('local:phone', { kind: 'text', text: '' });
  const user = (request.messages as { role: string; content: unknown }[]).find((m) => m.role === 'user')?.content;
  if (typeof user !== 'string') throw new Error('parseRequest changed shape: no user text on the text path');
  return user;
}

/**
 * The plan for real resumes read from their PDFs on the phone (workspace decision 0021, the founder's ruling of
 * 2026-10-30): each CV's PDF beside the plan (`<id>.pdf`) and a blank page in place of its image, every reader with
 * `input: "pdf"`, and the text path with its prefix and no users, since the phone's own parser gives the text.
 */
export function pdfPlan(ids: readonly string[], readers: PhoneReader[], runs: number, source: string, extract: readonly PhonePdfMethod[] = []): PhonePlan {
  if ((!readers.length && !extract.length) || readers.some((r) => r.input !== 'pdf' || !r.litert)) {
    throw new Error('a PDF plan reads with LiteRT-LM readers whose input is "pdf", or only takes text paths (extract)');
  }
  // The base plan needs a reader to write the text path; a reader that reads the CVs' OCR lines stands in for it.
  const stand = { label: 'stand-in', model: 'gemma-4-e2b', imageMaxTokens: null, schema: 'regex' as const, input: 'text' as const, litert: { file: 'g.litertlm', backend: 'gpu' as const, mtp: true } };
  const base = phonePlan(ids.map((id) => ({ id, image: PDF_PLAN_PAGE, ocr: ['-'] })), [stand], runs, source);
  return {
    ...base,
    cvs: ids.map((id) => ({ id, file: PDF_PLAN_PAGE, pdf: `${id}.pdf` })),
    readers,
    ...(extract.length ? { extract: [...extract] } : {}),
    text: { ...base.text!, users: [], userPrefix: textUserPrefix() },
  };
}

/**
 * How a phone's text compares with the Mac's word by word, counts only: the words each holds (split on whitespace) and
 * how many of the Mac's the phone's text holds in the same order (their longest common subsequence). A word split in
 * two or two words joined both cost shared words, so the share tells a parser's spacing apart from the Mac's.
 */
export function wordAgreement(phone: string, mac: string): { macWords: number; phoneWords: number; sharedWords: number } {
  const a = mac.split(/\s+/).filter(Boolean);
  const b = phone.split(/\s+/).filter(Boolean);
  let prev = new Uint16Array(b.length + 1);
  for (const x of a) {
    const cur = new Uint16Array(b.length + 1);
    for (let j = 1; j <= b.length; j++) cur[j] = x === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    prev = cur;
  }
  return { macWords: a.length, phoneWords: b.length, sharedWords: prev[b.length]! };
}

/** A PDF's pages as one text, joined as `scripts/work/pdf-pages.swift` and the app join them: each page's text and a blank line. */
export function joinPdfPages(pages: readonly string[]): string {
  return pages.map((p) => `${p}\n\n`).join('');
}

/** The blank page a PDF plan names in place of each CV's image (the app checks a page beside the plan). */
export const PDF_PLAN_PAGE = 'blank.png';

/**
 * The phone's answers as an answers file for the real-resume benchmark (`localAnswerKey` of the body the eval sends for
 * `reader` with each CV's phone text): the eval then scores them as any local reader's, reading the text from
 * `reader.textDir`. A failed read is an answer with its error; a CV the phone read no text from has no answer.
 */
export function phoneAnswers(
  results: PhoneResults,
  phoneLabel: string,
  reader: LocalReader,
  method: PhonePdfMethod = 'string',
  given?: { id: string; text: string }[],
): { texts: { id: string; text: string }[]; answers: Record<string, unknown> } {
  // A reader that read text the plan carried (`given`, taken from the PDFs in an earlier run) has none in its results.
  const texts = given ?? (results.texts ?? []).filter((t) => !t.error && t.method === method).map((t) => ({ id: t.cv, text: t.text }));
  const answers: Record<string, unknown> = {};
  for (const run of results.runs.filter((r) => r.reader === phoneLabel && r.run === 0)) {
    const text = texts.find((t) => t.id === run.cv)?.text;
    if (text == null) continue;
    const key = localAnswerKey(JSON.stringify(localRequest(reader, parseRequest(`local:${reader.label}`, { kind: 'text', text }))));
    answers[key] = run.ok
      ? {
          choices: [{ index: 0, message: { role: 'assistant', content: answerOf(run) }, finish_reason: run.stoppedLimit ? 'length' : 'stop' }],
          usage: { prompt_tokens: run.promptTokens, completion_tokens: run.predictedTokens },
          timing: {
            // A fallback's answer took the first engine's try too, as the Pixel's test app counted it.
            ms: run.msToJson + (run.firstTry?.msToJson ?? 0),
            ttftMs: run.msFirstToken,
            decodeTps: run.decodeTokensPerSec,
            peakFootprintMb: run.peakFootprint == null ? null : Math.round(run.peakFootprint / 1e6),
            ...(run.backend ? { engine: run.backend } : {}),
            ...(run.firstTry ? { firstTry: { backend: run.firstTry.backend, reason: run.firstTry.reason, ms: run.firstTry.msToJson } } : {}),
            ...(run.stalled ? { stalled: true } : {}),
          },
        }
      : { error: run.error ?? 'the read failed' };
  }
  return { texts, answers };
}

/**
 * How a phone's text layer compares with the Mac's (`pdf-pages.swift`), counts only: identical or not, and the share of
 * the Mac's non-empty lines the phone's text holds in the same order (their longest common subsequence).
 */
export function textAgreement(phone: string, mac: string): { identical: boolean; macLines: number; phoneLines: number; sharedLines: number; charDelta: number } {
  const lines = (t: string) => t.split(/\r?\n/).map((l) => l.trim().replace(/\s+/g, ' ')).filter(Boolean);
  const a = lines(mac);
  const b = lines(phone);
  let prev = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) cur[j] = x === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    prev = cur;
  }
  return { identical: phone === mac, macLines: a.length, phoneLines: b.length, sharedLines: prev[b.length]!, charDelta: phone.length - mac.length };
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
    if (schema !== 'grammar' && schema !== 'json' && schema !== 'prompt' && schema !== 'regex') {
      throw new Error(`WORK_PARSE_PHONE_READERS[${i}].schema must be "grammar", "json", "prompt" or "regex"`);
    }
    const input = o.input ?? 'image';
    if (input !== 'image' && input !== 'text' && input !== 'pdf') throw new Error(`WORK_PARSE_PHONE_READERS[${i}].input must be "image", "text" or "pdf"`);
    let litert: PhoneReader['litert'];
    if (o.litert != null) {
      const engine = (v: unknown, where: string): PhoneEngine => {
        const l = (v ?? {}) as Record<string, unknown>;
        if (typeof l.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.litertlm$/.test(l.file) || l.file.includes('..')) {
          throw new Error(`${where}.file must be a .litertlm file name`);
        }
        if (l.backend !== 'gpu' && l.backend !== 'cpu' && l.backend !== 'npu') throw new Error(`${where}.backend must be "gpu", "cpu" or "npu"`);
        if (typeof l.mtp !== 'boolean') throw new Error(`${where}.mtp must be true or false`);
        if (l.activation != null && l.activation !== 'f32' && l.activation !== 'f16') throw new Error(`${where}.activation must be "f32" or "f16"`);
        if (l.contextLimit != null && (!Number.isInteger(l.contextLimit) || (l.contextLimit as number) < 1)) throw new Error(`${where}.contextLimit must be a positive integer`);
        return {
          file: l.file,
          backend: l.backend,
          mtp: l.mtp,
          ...(l.activation ? { activation: l.activation as 'f32' | 'f16' } : {}),
          ...(l.contextLimit ? { contextLimit: l.contextLimit as number } : {}),
        };
      };
      const where = `WORK_PARSE_PHONE_READERS[${i}].litert`;
      const fallback = (o.litert as Record<string, unknown>).fallback;
      litert = { ...engine(o.litert, where), ...(fallback != null ? { fallback: engine(fallback, `${where}.fallback`) } : {}) };
    }
    if (litert && (input === 'image' || schema !== 'regex')) throw new Error(`WORK_PARSE_PHONE_READERS[${i}]: a LiteRT-LM reader reads text with schema "regex"`);
    if (input === 'pdf' && !litert) throw new Error(`WORK_PARSE_PHONE_READERS[${i}].input "pdf" is for LiteRT-LM readers`);
    if (!litert && schema === 'regex') throw new Error(`WORK_PARSE_PHONE_READERS[${i}].schema "regex" is for LiteRT-LM readers`);
    const label = o.label.trim();
    if (seen.has(label)) throw new Error(`WORK_PARSE_PHONE_READERS names the label ${JSON.stringify(label)} twice`);
    seen.add(label);
    return {
      label,
      model: o.model.trim(),
      imageMaxTokens: max as number | null,
      schema,
      ...(input === 'text' || input === 'pdf' ? { input } : {}),
      ...(litert ? { litert } : {}),
    };
  });
}

const isObject = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object' && !Array.isArray(v);
const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown) => (typeof v === 'string' ? v : null);
const isBackend = (v: unknown): v is PhoneEngine['backend'] => v === 'gpu' || v === 'cpu' || v === 'npu';

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
      decodeTokensPerSec: numOrNull(r.decodeTokensPerSec),
      ...(isBackend(r.backend) ? { backend: r.backend } : {}),
      ...(r.stalled === true ? { stalled: true } : {}),
      ...(r.contextTokens !== undefined ? { contextTokens: numOrNull(r.contextTokens) } : {}),
      ...(isObject(r.firstTry)
        ? {
            firstTry: {
              backend: isBackend(r.firstTry.backend) ? r.firstTry.backend : 'npu',
              reason: strOrNull(r.firstTry.reason) ?? '',
              error: strOrNull(r.firstTry.error),
              msToJson: numOrNull(r.firstTry.msToJson) ?? 0,
              promptTokens: numOrNull(r.firstTry.promptTokens),
              predictedTokens: numOrNull(r.firstTry.predictedTokens),
              contextTokens: numOrNull(r.firstTry.contextTokens),
            },
          }
        : {}),
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
    runtime: { llamaRn: strOrNull(runtime.llamaRn), llamaCpp: strOrNull(runtime.llamaCpp), litertLm: strOrNull(runtime.litertLm) },
    startedAt: strOrNull(raw.startedAt) ?? '',
    finishedAt: strOrNull(raw.finishedAt),
    ...(Array.isArray(raw.texts)
      ? {
          texts: raw.texts.map((t, i): PhonePdfText => {
            const o = obj(t);
            if (typeof o.cv !== 'string' || typeof o.text !== 'string') throw new Error(`texts[${i}] has no cv or text`);
            const method = (APP_PDF_METHODS as readonly string[]).includes(String(o.method)) ? (o.method as PhonePdfMethod) : 'string';
            return { cv: o.cv, method, pages: numOrNull(o.pages) ?? 0, chars: numOrNull(o.chars) ?? 0, ms: numOrNull(o.ms) ?? 0, text: o.text, error: strOrNull(o.error) };
          }),
        }
      : {}),
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
      `${d.totalMemory != null ? `${gb(d.totalMemory)} GB` : 'unknown'} of memory; ` +
      // The app has run LiteRT-LM alone since 2026-10-30; results from before name llama.rn and llama.cpp too.
      `${[results.runtime.llamaRn ? `llama.rn ${results.runtime.llamaRn}` : '', results.runtime.llamaCpp ? `llama.cpp ${results.runtime.llamaCpp}` : '', results.runtime.litertLm ? `LiteRT-LM ${results.runtime.litertLm}` : ''].filter(Boolean).join(', ') || 'runtime unknown'}; ` +
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
    '| Reader | OK | Accuracy (mean) | Worst CV | First read: first token, JSON s | First token, median s | JSON, median s | JSON, max s | Decode tok/s, median | Peak memory, GB | Left, GB | Thermal |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const r of rows) {
    const done = r.rs.filter((x) => x.ok);
    // The reader's first read came after the run waited for the phone to cool: a user's single read.
    const first = done[0];
    out.push(
      `| ${cell(r.label)} | ${r.ok.length}/${r.rs.length} | ${pct(r.acc)} | ${pct(r.worst)} | ${first ? `${secs(first.msFirstToken)}, ${secs(first.msToJson)}` : '—'} | ` +
        `${secs(median(done.map((x) => x.msFirstToken).filter((x): x is number => x != null)))} | ` +
        `${secs(median(done.map((x) => x.msToJson)))} | ${secs(done.length ? Math.max(...done.map((x) => x.msToJson)) : null)} | ` +
        `${median(done.map((x) => x.decodeTokensPerSec).filter((x): x is number => x != null))?.toFixed(1) ?? '—'} | ${gb(r.peak)} | ${gb(r.left)} | ${r.thermal.join(', ') || '—'} |`,
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
