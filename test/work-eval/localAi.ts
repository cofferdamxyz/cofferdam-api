// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A local reader behind an OpenAI-compatible server, for the whole-CV parse
 * evaluation only (`test/workParse.eval.test.ts`): the on-device candidates
 * run on the Mac, MiniCPM-V 4.7 through llama.cpp's `llama-server` and
 * Gemma 4 E2B through LiteRT-LM's `litert-lm serve`, and answer the same
 * request the cloud models get (`parseRequest`), so one truth and one scorer
 * measure them all (workspace decision 0068, amendments). A phone serves it
 * too through `adb forward`: `llama-server` built with the NDK, or the test
 * app `scripts/work/litert-bench/` for LiteRT-LM's Kotlin API (the Pixel's
 * TPU, Gemma 4's per-image visual budget).
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
 * Workers AI chat result. Nothing leaves the Mac, or the phone on its cable.
 *
 * The schema goes to the server as the request's `response_format`, which
 * llama.cpp turns into a grammar, unless a reader sets `schema: "prompt"`:
 * then the request carries no `response_format` and the schema is written
 * into the system prompt, in the words of the LiteRT-LM test app's
 * `schema=prompt` (`SCHEMA_IN_PROMPT`), so llama.cpp and LiteRT-LM read one
 * prompt. Gemma 4 E2B scored 92% that way on the Pixel's TPU and 41% under
 * LiteRT-LM's constrained decoding (2026-10-28).
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
  /** `prompt`: the schema in the system prompt and no `response_format`; the server's grammar when absent. */
  schema?: 'prompt';
}

/** The answer's cap with thinking on: the reasoning block and the JSON after it (LFM3-VL's card allows 16,384). */
export const THINKING_MAX_TOKENS = 8_192;

/**
 * What `scripts/work/litert-bench/` (`BenchServer.kt`, `schema=prompt`) appends
 * to the system prompt before the schema's JSON, word for word. The app's
 * reader benchmark gets it from the phone plan (`test/workParsePhone.eval.test.ts`).
 */
export const SCHEMA_IN_PROMPT =
  '\n\nAnswer with one JSON object only, no Markdown fence, matching this JSON schema exactly: the same keys and nesting, and only the listed enum values.\n';

/**
 * The request with its JSON schema moved into the system prompt: no
 * `response_format`, so no grammar, and the schema's compact JSON after
 * `SCHEMA_IN_PROMPT` at the end of the system message, as the LiteRT-LM test
 * app writes it. A request without a JSON schema only loses its `response_format`.
 */
export function withSchemaInPrompt(request: Record<string, unknown>): Record<string, unknown> {
  const { response_format: format, ...rest } = request;
  const js = (format as { type?: unknown; json_schema?: unknown } | undefined)?.json_schema;
  const schema = js && typeof js === 'object' ? ((js as { schema?: unknown }).schema ?? js) : null;
  if (!schema || typeof schema !== 'object') return rest;
  const text = SCHEMA_IN_PROMPT + JSON.stringify(schema);
  const messages = Array.isArray(request.messages) ? (request.messages as { role?: unknown; content?: unknown }[]) : [];
  const at = messages.findIndex((m) => m.role === 'system');
  const textOf = (content: unknown) =>
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((p) => (typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('')
        : '';
  return {
    ...rest,
    messages: at >= 0 ? messages.map((m, i) => (i === at ? { ...m, content: textOf(m.content) + text } : m)) : [{ role: 'system', content: text }, ...messages],
  };
}

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
    throw new Error('WORK_PARSE_LOCAL must be a JSON array of {label, url, model, paths?, thinking?, schema?}');
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
    if (o.schema != null && o.schema !== 'prompt' && o.schema !== 'grammar') throw new Error(`WORK_PARSE_LOCAL[${i}].schema must be "prompt" or "grammar"`);
    return {
      label: field('label'),
      url,
      model: field('model'),
      ...(paths ? { paths } : {}),
      ...(o.thinking === true ? { thinking: true } : {}),
      ...(o.schema === 'prompt' ? { schema: 'prompt' as const } : {}),
    };
  });
  // The report groups runs by label, so two readers must not share one.
  const seen = new Set<string>();
  for (const r of readers) {
    if (seen.has(r.label)) throw new Error(`WORK_PARSE_LOCAL names the label ${JSON.stringify(r.label)} twice`);
    seen.add(r.label);
  }
  return readers;
}

/**
 * The request a local server gets: the parse request, the server's model name,
 * no stream, thinking off unless the reader asks, and the schema in the system
 * prompt instead of `response_format` when the reader sets `schema: "prompt"`.
 */
export function localRequest(reader: LocalReader, parse: Record<string, unknown>): Record<string, unknown> {
  const request = reader.schema === 'prompt' ? withSchemaInPrompt(parse) : parse;
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
