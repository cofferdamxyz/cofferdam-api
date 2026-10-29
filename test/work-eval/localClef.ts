// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A local decision model in Clef's place, for the evaluations only
 * (`test/workClef.eval.test.ts`, `test/chat.eval.test.ts`). Liquid AI's d1
 * models, served by llama.cpp's `llama-server`, answer `noul`, `choice` and
 * `score` questions at `/v1/systemone` from the same `{state, questions}` body
 * Clef takes, in the same `{answers: {name: answer}}` shape `clef.ts` reads,
 * so the fixtures and scorers that measure `clef-flash` measure them too
 * (workspace decision 0068, proposed amendment). Every other call (the
 * embeddings, the chat models) still goes to the binding it wraps.
 *
 *   POST <baseUrl>/v1/systemone  {state, questions}
 *
 * Each local call is recorded like a Workers AI one under the model name
 * `local:<label>`, so a report names the model that answered and prices it at
 * nothing. Nothing a Clef call carries leaves the Mac.
 *
 * A model that runs in process rather than behind a server (Convai's Laya,
 * `scripts/work/laya-answers.py`) answers from a file instead: `answers`
 * names a JSON file of answers by request key. A request the file lacks is
 * written to `<answers>.pending.jsonl` and given a neutral stand-in answer, so
 * the run goes on and lists every request; an evaluation then refuses to
 * write its report (`localClefPending`). The script answers the list and the
 * next run reads the answers.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

import type { AiBinding } from '../../src/services/inference/index.js';
import type { RecordedCall } from '../chat-eval/restAi.js';

export interface LocalClef {
  /** The name in the report ("d1-2B Q4_K_M (llama.cpp)"). */
  label: string;
  /** The server's base URL, without `/v1` ("http://127.0.0.1:8090"); or, for a model run in process, `answers`. */
  url?: string;
  /** A JSON file of answers by request key (`localClefKey`), written by `scripts/work/laya-answers.py`. */
  answers?: string;
}

/** Reads `{label, url}` or `{label, answers}` from an environment variable's value; null when it is unset. */
export function parseLocalClef(raw: string | undefined, name: string): LocalClef | null {
  if (!raw?.trim()) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON object {label, url} or {label, answers}`);
  }
  const r = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const label = typeof r.label === 'string' ? r.label.trim() : '';
  if (!label) throw new Error(`${name}.label must be a non-empty string`);
  if (typeof r.answers === 'string' && r.answers.trim()) return { label, answers: r.answers.trim() };
  const url = typeof r.url === 'string' ? r.url.trim().replace(/\/+$/, '').replace(/\/v1(\/systemone)?$/, '') : '';
  if (!/^https?:\/\//.test(url)) throw new Error(`${name}.url must start with http:// or https:// (or name an answers file)`);
  return { label, url };
}

/** A request's key in an answers file: SHA-256 of the body a server would get. */
export const localClefKey = (body: string): string => createHash('sha256').update(body).digest('hex');

/** Requests listed in this process per answers file: a run with any is not a measurement. */
const pendingByFile = new Map<string, number>();
export const localClefPending = (clef: LocalClef): number => (clef.answers ? (pendingByFile.get(clef.answers) ?? 0) : 0);

/** An answer that says nothing: every choice even, every yes-or-no at a half, every score at its lowest level. */
function standIn(questions: unknown): { answers: Record<string, unknown> } {
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries((questions ?? {}) as Record<string, { type?: string; criteria?: unknown }>)) {
    if (q?.type === 'choice' && q.criteria && typeof q.criteria === 'object') {
      const keys = Object.keys(q.criteria);
      answers[id] = { type: 'choice', choice: keys[0] ?? null, probabilities: Object.fromEntries(keys.map((k) => [k, 1 / Math.max(1, keys.length)])) };
    } else if (q?.type === 'score') answers[id] = { type: 'score', score: 0 };
    else answers[id] = { type: 'noul', noul: 0.5 };
  }
  return { answers };
}

/** The model name a local Clef's calls are recorded under. */
export const localClefModel = (clef: LocalClef): string => `local:${clef.label}`;

/** A file-name part for a local Clef's reports ("d1-2b-q4-k-m-llama-cpp"). */
export const localClefSlug = (clef: LocalClef): string =>
  clef.label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Clef's models on Workers AI: `clef-flash` (Instant) and `clef` (Curated). */
const CLEF_MODEL = /^@cf\/cloudflare\/clef(-|$)/;

export class LocalClefError extends Error {
  constructor(
    readonly label: string,
    readonly status: number | 'network' | 'pending',
    detail: string,
  ) {
    super(`${label} answered ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'LocalClefError';
  }
}

type Run = (model: string, input: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<unknown>;

/** Wraps a binding so every Clef model is answered by the local server; the other models pass through. */
export function withLocalClef(
  ai: AiBinding,
  clef: LocalClef,
  opts: { fetch?: typeof fetch; onCall?: (call: RecordedCall) => void; now?: () => number } = {},
): AiBinding {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const inner = (ai as unknown as { run: Run }).run;
  const file = clef.answers;
  const known: Record<string, unknown> = file && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  const listed = new Set<string>();
  const run: Run = async (model, input, options) => {
    if (!CLEF_MODEL.test(model)) return inner(model, input, options);
    // Clef's body names its model; the local server serves one and takes the rest as is.
    const { model: _name, ...rest } = input;
    const body = JSON.stringify({ ...rest, state: rest.state ?? null });
    const t0 = now();
    const record = (fields: Partial<RecordedCall>) =>
      opts.onCall?.({ model: localClefModel(clef), stream: false, inputChars: body.length, ms: now() - t0, status: 0, aborted: false, outputChars: 0, ...fields });
    if (file) {
      // A model run in process: its answer is in the file, or the request is listed for it and fails this run.
      const key = localClefKey(body);
      if (key in known) {
        record({ status: 200, result: known[key] });
        return known[key];
      }
      if (!listed.has(key)) {
        listed.add(key);
        appendFileSync(`${file}.pending.jsonl`, JSON.stringify({ key, ...(JSON.parse(body) as object) }) + '\n');
        pendingByFile.set(file, (pendingByFile.get(file) ?? 0) + 1);
      }
      return standIn((JSON.parse(body) as { questions?: unknown }).questions);
    }
    let res: Response;
    try {
      res = await doFetch(`${clef.url!}/v1/systemone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: options?.signal });
    } catch (err) {
      const aborted = options?.signal?.aborted === true;
      record({ status: aborted ? 'aborted' : 'network', aborted });
      throw new LocalClefError(clef.label, 'network', String(err).slice(0, 200));
    }
    const text = await res.text();
    if (!res.ok) {
      record({ status: res.status });
      throw new LocalClefError(clef.label, res.status, text.slice(0, 300));
    }
    let result: unknown;
    try {
      result = JSON.parse(text);
    } catch {
      record({ status: res.status });
      throw new LocalClefError(clef.label, res.status, `not JSON: ${text.slice(0, 200)}`);
    }
    const inputTokens = (result as { usage?: { input_tokens?: unknown } } | null)?.usage?.input_tokens;
    record({ status: res.status, usage: typeof inputTokens === 'number' ? { prompt_tokens: inputTokens, completion_tokens: 0 } : undefined, result });
    return result;
  };
  return { ...(ai as object), run } as unknown as AiBinding;
}
