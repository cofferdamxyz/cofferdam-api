// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A local reader behind an OpenAI-compatible server, for the whole-CV parse
 * evaluation only (`test/workParse.eval.test.ts`): the on-device candidates
 * run on the Mac, MiniCPM-V 4.7 through llama.cpp's `llama-server` and
 * Gemma 4 E2B through LiteRT-LM's `litert-lm serve`, and answer the same
 * request the cloud models get (`parseRequest`), so one truth and one scorer
 * measure them all (workspace decision 0068, proposed amendment).
 *
 *   POST <baseUrl>/v1/chat/completions
 *
 * The body is the parse request with the server's own model name, no stream,
 * and thinking off in both servers' words: `reasoning_effort: "none"` (LiteRT-LM
 * reads `low` as thinking on) and `chat_template_kwargs.enable_thinking: false`
 * (llama.cpp). A reader set to `thinking: true` turns the template's switch on
 * instead, keeps the request's own effort and may answer up to
 * `THINKING_MAX_TOKENS`, so a reasoning block and the JSON after it fit. An
 * image stays an OpenAI `image_url` part with a data URI, which both servers
 * take. The answer is the server's JSON body, which `readParse` reads like a
 * Workers AI chat result. Nothing leaves the Mac.
 */

import type { AiBinding } from '../../src/services/inference/index.js';

export interface LocalReader {
  /** The name in the report ("MiniCPM-V 4.7 1B (llama.cpp)"). */
  label: string;
  /** The server's base URL, without `/v1` ("http://127.0.0.1:8080"). */
  url: string;
  /** The `model` field the server expects (LiteRT-LM: "gemma-4-E2B-it.litertlm,gpu"). */
  model: string;
  /** The parse paths to run on it; the image path when absent. */
  paths?: ('image' | 'text')[];
  /** Thinking on (the template's `enable_thinking`); off when absent, as the phone runs it. */
  thinking?: boolean;
}

/** The answer's cap with thinking on: the reasoning block and the JSON after it (LFM3-VL's card allows 16,384). */
export const THINKING_MAX_TOKENS = 8_192;

export class LocalAiError extends Error {
  constructor(
    readonly label: string,
    readonly status: number | 'network',
    detail: string,
  ) {
    super(`${label} answered ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'LocalAiError';
  }
}

/** Reads `WORK_PARSE_LOCAL`: a JSON array of readers. Throws on anything else, naming what is wrong. */
export function parseLocalReaders(raw: string | undefined): LocalReader[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('WORK_PARSE_LOCAL must be a JSON array of {label, url, model, paths?, thinking?}');
  }
  if (!Array.isArray(parsed)) throw new Error('WORK_PARSE_LOCAL must be a JSON array');
  const readers = parsed.map((r, i): LocalReader => {
    const o = (r ?? {}) as Record<string, unknown>;
    const field = (k: string) => {
      const v = o[k];
      if (typeof v !== 'string' || !v.trim()) throw new Error(`WORK_PARSE_LOCAL[${i}].${k} must be a non-empty string`);
      return v.trim();
    };
    // The base URL; a full endpoint ("…/v1/chat/completions") or "…/v1" is cut back to it.
    const url = field('url').replace(/\/+$/, '').replace(/\/v1(\/chat\/completions)?$/, '');
    if (!/^https?:\/\//.test(url)) throw new Error(`WORK_PARSE_LOCAL[${i}].url must start with http:// or https://`);
    let paths: LocalReader['paths'];
    if (o.paths != null) {
      if (!Array.isArray(o.paths) || !o.paths.length || o.paths.some((p) => p !== 'image' && p !== 'text')) {
        throw new Error(`WORK_PARSE_LOCAL[${i}].paths must list "image" and/or "text"`);
      }
      paths = [...new Set(o.paths as ('image' | 'text')[])];
    }
    if (o.thinking != null && typeof o.thinking !== 'boolean') throw new Error(`WORK_PARSE_LOCAL[${i}].thinking must be true or false`);
    return { label: field('label'), url, model: field('model'), ...(paths ? { paths } : {}), ...(o.thinking === true ? { thinking: true } : {}) };
  });
  // The report groups runs by label, so two readers must not share one.
  const seen = new Set<string>();
  for (const r of readers) {
    if (seen.has(r.label)) throw new Error(`WORK_PARSE_LOCAL names the label ${JSON.stringify(r.label)} twice`);
    seen.add(r.label);
  }
  return readers;
}

/** The request a local server gets: the parse request, the server's model name, no stream, thinking off unless the reader asks. */
export function localRequest(reader: LocalReader, request: Record<string, unknown>): Record<string, unknown> {
  const kwargs = (request.chat_template_kwargs ?? {}) as Record<string, unknown>;
  if (reader.thinking) {
    return { ...request, model: reader.model, stream: false, max_tokens: THINKING_MAX_TOKENS, chat_template_kwargs: { ...kwargs, enable_thinking: true } };
  }
  return {
    ...request,
    model: reader.model,
    stream: false,
    reasoning_effort: 'none',
    chat_template_kwargs: { ...kwargs, enable_thinking: false },
  };
}

/** An `AiBinding`-shaped client for one local reader; the model id passed to `run` is ignored. */
export function createLocalAi(reader: LocalReader, opts: { fetch?: typeof fetch } = {}): AiBinding {
  const doFetch = opts.fetch ?? fetch;
  const run = async (_model: string, input: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
    let res: Response;
    try {
      res = await doFetch(`${reader.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(localRequest(reader, input)),
        signal: options?.signal,
      });
    } catch (err) {
      throw new LocalAiError(reader.label, 'network', String(err).slice(0, 200));
    }
    const text = await res.text();
    if (!res.ok) throw new LocalAiError(reader.label, res.status, text.slice(0, 300));
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new LocalAiError(reader.label, res.status, `not JSON: ${text.slice(0, 200)}`);
    }
  };
  return { run } as unknown as AiBinding;
}
