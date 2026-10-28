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
 */

import type { AiBinding } from '../../src/services/inference/index.js';
import type { RecordedCall } from '../chat-eval/restAi.js';

export interface LocalClef {
  /** The name in the report ("d1-2B Q4_K_M (llama.cpp)"). */
  label: string;
  /** The server's base URL, without `/v1` ("http://127.0.0.1:8090"). */
  url: string;
}

/** Reads `{label, url}` from an environment variable's value; null when it is unset. */
export function parseLocalClef(raw: string | undefined, name: string): LocalClef | null {
  if (!raw?.trim()) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON object {label, url}`);
  }
  const r = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const label = typeof r.label === 'string' ? r.label.trim() : '';
  const url = typeof r.url === 'string' ? r.url.trim().replace(/\/+$/, '').replace(/\/v1(\/systemone)?$/, '') : '';
  if (!label) throw new Error(`${name}.label must be a non-empty string`);
  if (!/^https?:\/\//.test(url)) throw new Error(`${name}.url must start with http:// or https://`);
  return { label, url };
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
    readonly status: number | 'network',
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
  const run: Run = async (model, input, options) => {
    if (!CLEF_MODEL.test(model)) return inner(model, input, options);
    // Clef's body names its model; the local server serves one and takes the rest as is.
    const { model: _name, ...rest } = input;
    const body = JSON.stringify({ ...rest, state: rest.state ?? null });
    const t0 = now();
    const record = (fields: Partial<RecordedCall>) =>
      opts.onCall?.({ model: localClefModel(clef), stream: false, inputChars: body.length, ms: now() - t0, status: 0, aborted: false, outputChars: 0, ...fields });
    let res: Response;
    try {
      res = await doFetch(`${clef.url}/v1/systemone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: options?.signal });
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
