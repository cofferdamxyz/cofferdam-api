// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The real-resume benchmark on the phones, each taking the CV's text layer with its own PDF parser
 * (workspace decision 0021, the founder's ruling of 2026-10-30: "Use the text layer from the Native
 * parser on iOS and Android"), and Gemma 4 E2B reading it there through LiteRT-LM. Opt-in, from the
 * Mac, under the founder's exception for real resumes (decision 0021): the PDFs go to the phones over
 * the developer's own cable and are deleted after; the texts, answers and counts stay in
 * `~/Development/cv-bench`, never in a repository.
 *
 *   PHONE_PDF_PLAN=1      writes the iPhone's plan (`plan.json`, the PDFs, a blank page) into
 *                         `<PHONE_OUT>/ios-plan/` for the app's reader benchmark (`input: "pdf"`, PDFKit).
 *   PHONE_IOS_RESULTS=<results.json>  turns the iPhone's results into `<PHONE_OUT>/ios/texts/<id>.txt`
 *                         and `<PHONE_OUT>/ios/answers.json`.
 *   PHONE_ANDROID=<url>   drives the LiteRT-LM test app (`scripts/work/litert-bench/`, through
 *                         `adb forward`): each PDF through its `POST /v1/pdf-text` (Android's
 *                         `PdfRenderer`), then the TPU, and the CPU with MTP for a CV whose answer
 *                         the TPU's 4,096-token context cuts (the founder's rule for long CVs), into
 *                         `<PHONE_OUT>/android/`.
 *
 * Each phone's text is compared with the Mac's text layer (`scripts/work/pdf-pages.swift`), counts
 * only, and the real-resume benchmark then scores both phones' answers beside the Mac's and the
 * cloud's: the `RESUME_LOCAL` this prints, with `textDir` (`test/workResume.eval.test.ts`).
 * PHONE_SAMPLE (default: the twenty of `resumes-2026-10-30-n20.json`) names the run whose sample to read.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseRequest, readParse } from '../src/services/work/parse.js';
import { localAnswerKey, localRequest, type LocalReader } from './work-eval/localAi.js';
import { joinPdfPages, parsePhoneResults, PDF_PLAN_PAGE, pdfPlan, phoneAnswers, textAgreement, type PhoneReader } from './work-eval/phoneBench.js';
import { readResumeCsv } from './work-eval/resumeBench.js';

const pdfMode = process.env.PHONE_PDF_PLAN === '1';
const iosResults = (process.env.PHONE_IOS_RESULTS ?? '').trim();
const androidUrl = (process.env.PHONE_ANDROID ?? '').trim().replace(/\/+$/, '');
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

/** The iPhone's reader in the app's plan: Metal, 32-bit activations, MTP (the founder's ruling of 2026-10-29). */
const IOS_PHONE: PhoneReader = {
  label: 'Gemma 4 E2B, LiteRT-LM, Metal, 32-bit, MTP, PDFKit',
  model: 'gemma-4-e2b',
  imageMaxTokens: null,
  schema: 'regex',
  input: 'pdf',
  litert: { file: 'gemma-4-E2B-it.litertlm', backend: 'gpu', mtp: true, activation: 'f32' },
};

/** The benchmark's readers for the two phones' answers: an answer's key is the body the benchmark builds for them. */
const IOS_READER: LocalReader = {
  label: 'Gemma 4 E2B LiteRT-LM on the iPhone 16, Metal, 32-bit, MTP, the text PDFKit gives',
  answers: join(out, 'ios', 'answers.json'),
  model: 'gemma-4-E2B-it.litertlm,gpu,mtp=on,act=f32',
  paths: ['text'],
  schema: 'regex',
  maxTokens: MAX_TOKENS,
  textDir: join(out, 'ios', 'texts'),
};
const ANDROID_READER: LocalReader = {
  label: 'Gemma 4 E2B LiteRT-LM 0.19.0 on the Pixel 10, the TPU and the CPU for long CVs, the text PdfRenderer gives',
  answers: join(out, 'android', 'answers.json'),
  model: TPU,
  paths: ['text'],
  schema: 'regex',
  maxTokens: MAX_TOKENS,
  textDir: join(out, 'android', 'texts'),
};

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);
/** A 1×1 PNG: the app checks a page beside the plan, which a PDF reader never opens. */
const BLANK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe.skipIf(!RUN)('Real resumes on the phones, from their PDFs (live: the phones)', () => {
  it('writes the plan, reads the phones\' answers, or drives the Pixel', async () => {
    const sample = readJson<{ sample: string[] }>(sampleFile).sample;
    expect(sample.length).toBeGreaterThan(0);
    const category = new Map(readResumeCsv(readFileSync(join(dataset, 'Resume', 'Resume.csv'), 'utf8')).map((r) => [r.id, r.category]));
    const pdfOf = (id: string) => join(dataset, 'data', 'data', category.get(id) ?? '', `${id}.pdf`);
    const macText = (id: string) => readFileSync(join(runs, 'pages', id, 'text.txt'), 'utf8');
    for (const id of sample) if (!existsSync(pdfOf(id))) throw new Error(`no PDF for ${id}`);

    /** Counts only: how many phone texts equal the Mac's, and how many of the Mac's lines they keep in order. */
    const agreement = (texts: { id: string; text: string }[]) => {
      const each = texts.map((t) => ({ id: t.id, ...textAgreement(t.text, macText(t.id)) }));
      const share = each.map((e) => e.sharedLines / Math.max(1, e.macLines));
      return {
        texts: each.length,
        identical: each.filter((e) => e.identical).length,
        medianSharedLineShare: median(share),
        lowestSharedLineShare: share.length ? Math.min(...share) : null,
        each: each.map((e) => ({ id: e.id, identical: e.identical, macLines: e.macLines, phoneLines: e.phoneLines, sharedLines: e.sharedLines, charDelta: e.charDelta })),
      };
    };

    if (pdfMode) {
      const dir = join(out, 'ios-plan');
      mkdirSync(dir, { recursive: true });
      const plan = pdfPlan(sample, [IOS_PHONE], 1, `test/workResumePhone.eval.test.ts, ${new Date().toISOString()}`);
      writeFileSync(join(dir, 'plan.json'), JSON.stringify(plan, null, 1) + '\n');
      writeFileSync(join(dir, PDF_PLAN_PAGE), BLANK_PNG);
      for (const id of sample) copyFileSync(pdfOf(id), join(dir, `${id}.pdf`));
      process.stdout.write(`plan: ${dir} (${sample.length} PDFs, reader ${IOS_PHONE.label})\n`);
    }

    if (iosResults) {
      const results = parsePhoneResults(readJson<unknown>(iosResults));
      const { texts, answers } = phoneAnswers(results, IOS_PHONE.label, IOS_READER);
      mkdirSync(IOS_READER.textDir!, { recursive: true });
      for (const t of texts) writeFileSync(join(IOS_READER.textDir!, `${t.id}.txt`), t.text);
      writeFileSync(IOS_READER.answers!, JSON.stringify(answers, null, 1) + '\n');
      const parsed = (results.texts ?? []).filter((t) => !t.error);
      const summary = {
        device: results.device,
        runtime: results.runtime,
        parserMsMedian: median(parsed.map((t) => t.ms)),
        parserMsMax: parsed.length ? Math.max(...parsed.map((t) => t.ms)) : null,
        parserFailed: (results.texts ?? []).filter((t) => t.error).length,
        answered: Object.keys(answers).length,
        agreement: agreement(texts),
      };
      writeFileSync(join(out, 'ios', 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
      process.stdout.write(`iPhone: ${texts.length} texts, ${Object.keys(answers).length} answers; ${summary.agreement.identical} texts identical to the Mac's\n`);
    }

    if (androidUrl) {
      const textDir = ANDROID_READER.textDir!;
      mkdirSync(textDir, { recursive: true });
      const answersFile = ANDROID_READER.answers!;
      const answers: Record<string, unknown> = existsSync(answersFile) ? readJson<Record<string, unknown>>(answersFile) : {};
      const parser: { id: string; ms: number; pages: number; pieces: number[] }[] = [];
      const texts: { id: string; text: string }[] = [];
      const engines: { id: string; engine: 'tpu' | 'cpu' | 'failed'; ms: number; tpuMs: number | null }[] = [];
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
      for (const [n, id] of sample.entries()) {
        const parsed = await post('/v1/pdf-text', readFileSync(pdfOf(id)), 'application/pdf');
        if (parsed.status !== 200) throw new Error(`pdf-text ${id}: HTTP ${parsed.status}`);
        const pages = parsed.json.pages as string[];
        const text = joinPdfPages(pages);
        writeFileSync(join(textDir, `${id}.txt`), text);
        texts.push({ id, text });
        parser.push({ id, ms: Number(parsed.json.ms), pages: pages.length, pieces: parsed.json.pieces as number[] });
        const parse = parseRequest(`local:${ANDROID_READER.label}`, { kind: 'text', text });
        const key = localAnswerKey(JSON.stringify(localRequest(ANDROID_READER, parse)));
        if (answers[key]) continue;
        // The TPU first; the CPU with MTP when its answer is cut at the context or out of shape.
        const send = (model: string) => post('/v1/chat/completions', JSON.stringify({ ...localRequest(ANDROID_READER, parse), model }), 'application/json');
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
      const summary = {
        parserMsMedian: median(parser.map((p) => p.ms)),
        parserMsMax: parser.length ? Math.max(...parser.map((p) => p.ms)) : null,
        piecesPerPage: median(parser.flatMap((p) => p.pieces)),
        engines,
        agreement: agreement(texts),
      };
      writeFileSync(join(out, 'android', 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
      process.stdout.write(`Pixel: ${texts.length} texts, ${engines.filter((e) => e.engine === 'cpu').length} read on the CPU; ${summary.agreement.identical} texts identical to the Mac's\n`);
    }

    process.stdout.write(`RESUME_LOCAL for the benchmark: ${JSON.stringify([IOS_READER, ANDROID_READER].filter((r) => existsSync(r.answers!)))}\n`);
  }, 4 * 3_600_000);
});
