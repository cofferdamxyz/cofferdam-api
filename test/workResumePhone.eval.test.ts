// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The real-resume benchmark on the phones, each taking the CV's text with its own parser (workspace
 * decision 0021, the founder's ruling of 2026-10-30: "Use the text layer from the Native parser on iOS
 * and Android"), and Gemma 4 E2B reading it there through LiteRT-LM (decision 0068, the entry of that
 * day). Opt-in, from the Mac, under the founder's exception for real resumes (decision 0021): the PDFs
 * go to the phones over the developer's own cable and are deleted after; the texts, answers and counts
 * stay in `~/Development/cv-bench`, never in a repository.
 *
 * The text paths. The iPhone's (cofferdam-app `modules/pdf-text`): PDFKit's `string`, `attributed`,
 * `selection`, the string's spaces `rebuilt` from the glyphs' positions, and `vision`, Vision's text
 * recognition on the rendered page. The Pixel's (the test app's `/v1/pdf-text`): `PdfRenderer`'s
 * `contents` and `selection`, and `mlkit`, ML Kit's text recognition on the rendered page.
 *
 *   PHONE_PDF_PLAN=1      writes the iPhone's plan into `<PHONE_OUT>/ios-plan/` (`plan.json`, the
 *                         PDFs, a blank page): with PHONE_PDF_EXTRACT=<paths> the paths alone, no
 *                         model; with PHONE_PDF_FROM_TEXT=<path> a reader of the texts that path gave
 *                         in an earlier extraction run, carried in the plan (Vision's recognition and a
 *                         loaded Gemma do not fit in one app process on the iPhone 16, 2026-10-30);
 *                         else a reader on PHONE_PDF_METHOD's path (`string` by default).
 *   PHONE_IOS_RESULTS=<results.json>  reads the iPhone's results: each path's texts into
 *                         `<PHONE_OUT>/ios-extract/<path>/`, and a reader's answers into its folder.
 *   PHONE_ANDROID=<url>   drives the LiteRT-LM test app (`scripts/work/litert-bench/`, through
 *                         `adb forward`): with PHONE_ANDROID_EXTRACT=<paths> the paths alone, else each
 *                         PDF's text on PHONE_ANDROID_TEXT's path (`contents` by default) read on the TPU,
 *                         and on the CPU with MTP when the TPU's 4,096 tokens cut the answer (the
 *                         founder's rule for long CVs).
 *
 * Each path's text is compared with the Mac's text layer (`scripts/work/pdf-pages.swift`) word by word,
 * a recognised one also with the Mac's Vision lines, counts only; the real-resume benchmark then scores
 * the phones' answers beside the Mac's and the cloud's with the `RESUME_LOCAL` this prints (`textDir`).
 * PHONE_SAMPLE (default: the twenty of `resumes-2026-10-30-n20.json`) names the run whose sample to read.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseRequest, readParse } from '../src/services/work/parse.js';
import { localAnswerKey, localRequest, type LocalReader } from './work-eval/localAi.js';
import {
  joinPdfPages,
  parsePhoneResults,
  PDF_PLAN_PAGE,
  pdfPlan,
  phoneAnswers,
  phonePlan,
  PHONE_PDF_METHODS,
  wordAgreement,
  type PhonePdfMethod,
  type PhoneReader,
} from './work-eval/phoneBench.js';
import { readResumeCsv } from './work-eval/resumeBench.js';

const ANDROID_METHODS = ['contents', 'selection', 'mlkit'] as const;
type AndroidMethod = (typeof ANDROID_METHODS)[number];

const list = <T extends string>(raw: string | undefined, allowed: readonly T[], name: string): T[] => {
  const items = (raw ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const x of items) if (!(allowed as readonly string[]).includes(x)) throw new Error(`${name} takes ${allowed.join(', ')}, not ${x}`);
  return items as T[];
};

const pdfMode = process.env.PHONE_PDF_PLAN === '1';
const iosExtract = list(process.env.PHONE_PDF_EXTRACT, PHONE_PDF_METHODS, 'PHONE_PDF_EXTRACT');
const iosMethod = (list(process.env.PHONE_PDF_METHOD, PHONE_PDF_METHODS, 'PHONE_PDF_METHOD')[0] ?? 'string') as PhonePdfMethod;
const iosFromText = list(process.env.PHONE_PDF_FROM_TEXT, PHONE_PDF_METHODS, 'PHONE_PDF_FROM_TEXT')[0] as PhonePdfMethod | undefined;
const iosResults = (process.env.PHONE_IOS_RESULTS ?? '').trim();
const androidUrl = (process.env.PHONE_ANDROID ?? '').trim().replace(/\/+$/, '');
const androidExtract = list(process.env.PHONE_ANDROID_EXTRACT, ANDROID_METHODS, 'PHONE_ANDROID_EXTRACT');
const androidMethod = (list(process.env.PHONE_ANDROID_TEXT, ANDROID_METHODS, 'PHONE_ANDROID_TEXT')[0] ?? 'contents') as AndroidMethod;
const RUN = pdfMode || !!iosResults || !!androidUrl;

const home = homedir();
const dataset = process.env.RESUME_DIR ?? join(home, 'Development', 'cv-bench', 'kagle-pdf-dataset');
const runs = process.env.RESUME_OUT ?? join(home, 'Development', 'cv-bench', 'runs');
const out = process.env.PHONE_OUT ?? join(runs, 'phone', 'native');
const sampleFile = process.env.PHONE_SAMPLE ?? join(runs, 'reports', 'resumes-2026-10-30-n20.json');

/** The answer's cap, the Mac's LiteRT-LM reader's and the Pixel's earlier runs'. */
const MAX_TOKENS = 4_000;
/** The Pixel's TPU file, its context fixed at 4,096 tokens when Google compiled it, and the general file for the CPU. */
const TPU = 'gemma-4-E2B-it_Google_Tensor_G5.litertlm,npu,ctx=16384,spec=on,act=f32';
const CPU = 'gemma-4-E2B-it.litertlm,cpu,ctx=16384,spec=on,act=f32';
const TPU_CONTEXT = 4_096;

const IOS_WORDS: Record<PhonePdfMethod, string> = {
  string: 'the text PDFKit gives',
  attributed: "PDFKit's attributed text",
  selection: "PDFKit's whole-page selection",
  rebuilt: "PDFKit's text, its spaces rebuilt from the glyphs' positions",
  vision: "Vision's text recognition on the page",
};
const ANDROID_WORDS: Record<AndroidMethod, string> = {
  contents: 'the text PdfRenderer gives',
  selection: "PdfRenderer's whole-page selection",
  mlkit: "ML Kit's text recognition on the page",
};

/** The iPhone's reader of a path's texts taken in an earlier run and carried in the plan. */
const iosTextPhone = (method: PhonePdfMethod): PhoneReader => ({
  label: `Gemma 4 E2B, LiteRT-LM, Metal, 32-bit, MTP, the ${method} text of an earlier run`,
  model: 'gemma-4-e2b',
  imageMaxTokens: null,
  schema: 'regex',
  input: 'text',
  litert: { file: 'gemma-4-E2B-it.litertlm', backend: 'gpu', mtp: true, activation: 'f32' },
});
/** The iPhone's reader in the app's plan: Metal, 32-bit activations, MTP (the founder's ruling of 2026-10-29), on a text path. */
const iosPhone = (method: PhonePdfMethod): PhoneReader => ({
  label: method === 'string' ? 'Gemma 4 E2B, LiteRT-LM, Metal, 32-bit, MTP, PDFKit' : `Gemma 4 E2B, LiteRT-LM, Metal, 32-bit, MTP, PDFKit ${method}`,
  model: 'gemma-4-e2b',
  imageMaxTokens: null,
  schema: 'regex',
  input: 'pdf',
  ...(method === 'string' ? {} : { pdfText: method }),
  litert: { file: 'gemma-4-E2B-it.litertlm', backend: 'gpu', mtp: true, activation: 'f32' },
});
/** The benchmark's readers for the phones' answers: an answer's key is the body the benchmark builds for them. */
const iosReader = (method: PhonePdfMethod): LocalReader => {
  const dir = join(out, method === 'string' ? 'ios' : `ios-${method}`);
  return {
    label: `Gemma 4 E2B LiteRT-LM on the iPhone 16, Metal, 32-bit, MTP, ${IOS_WORDS[method]}`,
    answers: join(dir, 'answers.json'),
    model: 'gemma-4-E2B-it.litertlm,gpu,mtp=on,act=f32',
    paths: ['text'],
    schema: 'regex',
    maxTokens: MAX_TOKENS,
    textDir: join(dir, 'texts'),
  };
};
const androidReader = (method: AndroidMethod): LocalReader => {
  const dir = join(out, method === 'contents' ? 'android' : `android-${method}`);
  return {
    label: `Gemma 4 E2B LiteRT-LM 0.19.0 on the Pixel 10, the TPU and the CPU for long CVs, ${ANDROID_WORDS[method]}`,
    answers: join(dir, 'answers.json'),
    model: TPU,
    paths: ['text'],
    schema: 'regex',
    maxTokens: MAX_TOKENS,
    textDir: join(dir, 'texts'),
  };
};

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);
/** A 1×1 PNG: the app checks a page beside the plan, which a PDF reader never opens. */
const BLANK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe.skipIf(!RUN)('Real resumes on the phones, from their PDFs (live: the phones)', () => {
  it("writes the plan, reads the phones' answers, or drives the Pixel", async () => {
    const sample = readJson<{ sample: string[] }>(sampleFile).sample;
    expect(sample.length).toBeGreaterThan(0);
    const category = new Map(readResumeCsv(readFileSync(join(dataset, 'Resume', 'Resume.csv'), 'utf8')).map((r) => [r.id, r.category]));
    const pdfOf = (id: string) => join(dataset, 'data', 'data', category.get(id) ?? '', `${id}.pdf`);
    const macText = (id: string) => readFileSync(join(runs, 'pages', id, 'text.txt'), 'utf8');
    const macOcr = (id: string) => (existsSync(join(runs, 'pages', id, 'ocr.txt')) ? readFileSync(join(runs, 'pages', id, 'ocr.txt'), 'utf8') : null);
    for (const id of sample) if (!existsSync(pdfOf(id))) throw new Error(`no PDF for ${id}`);

    /** Counts only: texts equal to the Mac's, and the share of the Mac's words each keeps in order (and of its Vision lines). */
    const agreement = (texts: { id: string; text: string }[]) => {
      const share = (x: { macWords: number; sharedWords: number }) => x.sharedWords / Math.max(1, x.macWords);
      const layer = texts.map((t) => share(wordAgreement(t.text, macText(t.id))));
      const ocr = texts.flatMap((t) => {
        const o = macOcr(t.id);
        return o == null ? [] : [share(wordAgreement(t.text, o))];
      });
      return {
        texts: texts.length,
        identicalToTheMacsText: texts.filter((t) => t.text === macText(t.id)).length,
        macTextWordsKeptMedian: median(layer),
        macTextWordsKeptLowest: layer.length ? Math.min(...layer) : null,
        macVisionWordsKeptMedian: median(ocr),
      };
    };
    const saveTexts = (dir: string, texts: { id: string; text: string }[]) => {
      mkdirSync(dir, { recursive: true });
      for (const t of texts) writeFileSync(join(dir, `${t.id}.txt`), t.text);
    };

    if (pdfMode && iosFromText) {
      const dir = join(out, 'ios-plan');
      mkdirSync(dir, { recursive: true });
      const from = join(out, 'ios-extract', iosFromText);
      const cvs = sample.map((id) => {
        if (!existsSync(join(from, `${id}.txt`))) throw new Error(`no ${iosFromText} text for ${id} in ${from}: run the extraction first`);
        return { id, image: PDF_PLAN_PAGE, ocr: [readFileSync(join(from, `${id}.txt`), 'utf8')] };
      });
      const plan = phonePlan(cvs, [iosTextPhone(iosFromText)], 1, `test/workResumePhone.eval.test.ts, ${new Date().toISOString()}`);
      writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 1) + '\n');
      writeFileSync(join(dir, PDF_PLAN_PAGE), BLANK_PNG);
      process.stdout.write(`plan: ${dir} (${sample.length} ${iosFromText} texts in the plan, reader ${iosTextPhone(iosFromText).label})\n`);
    } else if (pdfMode) {
      const dir = join(out, 'ios-plan');
      mkdirSync(dir, { recursive: true });
      const readers = iosExtract.length ? [] : [iosPhone(iosMethod)];
      const plan = pdfPlan(sample, readers, 1, `test/workResumePhone.eval.test.ts, ${new Date().toISOString()}`, iosExtract);
      writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 1) + '\n');
      writeFileSync(join(dir, PDF_PLAN_PAGE), BLANK_PNG);
      for (const id of sample) copyFileSync(pdfOf(id), join(dir, `${id}.pdf`));
      process.stdout.write(`plan: ${dir} (${sample.length} PDFs; ${iosExtract.length ? `paths ${iosExtract.join(', ')}, no reader` : `reader ${readers[0]!.label}`})\n`);
    }

    if (iosResults) {
      const results = parsePhoneResults(readJson<unknown>(iosResults));
      const summary: Record<string, unknown> = { device: results.device, runtime: results.runtime, paths: {} };
      for (const method of PHONE_PDF_METHODS) {
        const parsed = (results.texts ?? []).filter((t) => t.method === method && !t.error);
        if (!parsed.length) continue;
        const texts = parsed.map((t) => ({ id: t.cv, text: t.text }));
        saveTexts(join(out, 'ios-extract', method), texts);
        (summary.paths as Record<string, unknown>)[method] = {
          parserMsMedian: median(parsed.map((t) => t.ms)),
          parserMsMax: Math.max(...parsed.map((t) => t.ms)),
          failed: (results.texts ?? []).filter((t) => t.method === method && t.error).length,
          ...agreement(texts),
        };
        const phone = iosPhone(method);
        if (results.runs.some((r) => r.reader === phone.label)) {
          const reader = iosReader(method);
          const { texts: read, answers } = phoneAnswers(results, phone.label, reader, method);
          saveTexts(reader.textDir!, read);
          writeFileSync(reader.answers!, JSON.stringify(answers, null, 1) + '\n');
          process.stdout.write(`iPhone ${method}: ${Object.keys(answers).length} answers\n`);
        }
      }
      // A reader of texts an earlier run took: its answers keyed by those texts, which the extraction left in ios-extract.
      for (const method of PHONE_PDF_METHODS) {
        const phone = iosTextPhone(method);
        if (!results.runs.some((r) => r.reader === phone.label)) continue;
        const from = join(out, 'ios-extract', method);
        const given = sample.filter((id) => existsSync(join(from, `${id}.txt`))).map((id) => ({ id, text: readFileSync(join(from, `${id}.txt`), 'utf8') }));
        const reader = iosReader(method);
        const { texts: read, answers } = phoneAnswers(results, phone.label, reader, method, given);
        saveTexts(reader.textDir!, read);
        writeFileSync(reader.answers!, JSON.stringify(answers, null, 1) + '\n');
        process.stdout.write(`iPhone ${method} (text of an earlier run): ${Object.keys(answers).length} answers\n`);
      }
      mkdirSync(join(out, 'ios-extract'), { recursive: true });
      writeFileSync(join(out, 'ios-extract', 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
      process.stdout.write(`iPhone paths: ${JSON.stringify(summary.paths)}\n`);
    }

    if (androidUrl) {
      // node:http, not fetch: fetch gives up after 300 s without response headers, and a long CV on the CPU takes longer.
      const post = (path: string, body: string | Buffer, type: string) =>
        new Promise<{ status: number; json: Record<string, unknown>; ms: number }>((resolve, reject) => {
          const t0 = Date.now();
          const req = request(`${androidUrl}${path}`, { method: 'POST', headers: { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              try {
                resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>, ms: Date.now() - t0 });
              } catch (err) {
                reject(err as Error);
              }
            });
          });
          req.setTimeout(30 * 60_000, () => req.destroy(new Error(`${path}: no answer in 30 minutes`)));
          req.on('error', reject);
          req.end(body);
        });
      const textOf = async (id: string, method: AndroidMethod) => {
        const parsed = await post(`/v1/pdf-text?method=${method}`, readFileSync(pdfOf(id)), 'application/pdf');
        if (parsed.status !== 200) throw new Error(`pdf-text ${id} (${method}): HTTP ${parsed.status}`);
        return { text: joinPdfPages(parsed.json.pages as string[]), ms: Number(parsed.json.ms) };
      };

      if (androidExtract.length) {
        const paths: Record<string, unknown> = {};
        for (const method of androidExtract) {
          const texts: { id: string; text: string }[] = [];
          const ms: number[] = [];
          for (const id of sample) {
            const t = await textOf(id, method);
            texts.push({ id, text: t.text });
            ms.push(t.ms);
          }
          saveTexts(join(out, 'android-extract', method), texts);
          paths[method] = { parserMsMedian: median(ms), parserMsMax: Math.max(...ms), ...agreement(texts) };
        }
        mkdirSync(join(out, 'android-extract'), { recursive: true });
        writeFileSync(join(out, 'android-extract', 'summary.json'), JSON.stringify({ paths }, null, 1) + '\n');
        process.stdout.write(`Pixel paths: ${JSON.stringify(paths)}\n`);
      } else {
        const reader = androidReader(androidMethod);
        const textDir = reader.textDir!;
        mkdirSync(textDir, { recursive: true });
        const answersFile = reader.answers!;
        const answers: Record<string, unknown> = existsSync(answersFile) ? readJson<Record<string, unknown>>(answersFile) : {};
        const parser: number[] = [];
        const texts: { id: string; text: string }[] = [];
        const engines: { id: string; engine: 'tpu' | 'cpu' | 'failed'; ms: number; tpuMs: number | null }[] = [];
        for (const [n, id] of sample.entries()) {
          const { text, ms } = await textOf(id, androidMethod);
          writeFileSync(join(textDir, `${id}.txt`), text);
          texts.push({ id, text });
          parser.push(ms);
          const parse = parseRequest(`local:${reader.label}`, { kind: 'text', text });
          const key = localAnswerKey(JSON.stringify(localRequest(reader, parse)));
          if (answers[key]) continue;
          // The TPU first; the CPU with MTP when its answer is cut at the context or out of shape.
          const send = (model: string) => post('/v1/chat/completions', JSON.stringify({ ...localRequest(reader, parse), model }), 'application/json');
          const usable = (r: { status: number; json: Record<string, unknown> }) => {
            if (r.status !== 200) return false;
            const inContext = Number((r.json.timings as { tokens_in_context?: unknown } | undefined)?.tokens_in_context ?? 0);
            if (inContext >= TPU_CONTEXT) return false;
            try {
              readParse(r.json);
              return true;
            } catch {
              return false;
            }
          };
          const tpu = await send(TPU);
          let final = tpu;
          let engine: 'tpu' | 'cpu' | 'failed' = 'tpu';
          if (!usable(tpu)) {
            final = await send(CPU);
            engine = final.status === 200 ? 'cpu' : 'failed';
          }
          engines.push({ id, engine, ms: final.ms, tpuMs: engine === 'cpu' ? tpu.ms : null });
          answers[key] =
            final.status === 200
              ? { ...final.json, timing: { ms: engine === 'cpu' ? tpu.ms + final.ms : final.ms, engine, ...(engine === 'cpu' ? { tpuMs: tpu.ms, cpuMs: final.ms } : {}) } }
              : { error: String((final.json.error as { message?: unknown } | undefined)?.message ?? `HTTP ${final.status}`).slice(0, 200) };
          writeFileSync(answersFile, JSON.stringify(answers, null, 1) + '\n');
          process.stdout.write(`Pixel ${n + 1}/${sample.length}: ${engine}, ${(final.ms / 1000).toFixed(1)} s\n`);
        }
        const summary = { method: androidMethod, parserMsMedian: median(parser), parserMsMax: parser.length ? Math.max(...parser) : null, engines, agreement: agreement(texts) };
        writeFileSync(join(answersFile, '..', 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
        process.stdout.write(`Pixel (${androidMethod}): ${texts.length} texts, ${engines.filter((e) => e.engine === 'cpu').length} read on the CPU\n`);
      }
    }

    const readers = [...PHONE_PDF_METHODS.map(iosReader), ...ANDROID_METHODS.map(androidReader)].filter((r) => existsSync(r.answers!));
    process.stdout.write(`RESUME_LOCAL for the benchmark: ${JSON.stringify(readers)}\n`);
  }, 4 * 3_600_000);
});
