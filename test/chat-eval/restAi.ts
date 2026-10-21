// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * An `AiBinding`-shaped adapter over the Workers AI REST API, for the chat
 * evaluation only (`test/chat.eval.test.ts`): the harness runs the real turn
 * from the Mac, where there is no `env.AI` binding.
 *
 *   POST https://api.cloudflare.com/client/v4/accounts/<account>/ai/run/<model>
 *   Authorization: Bearer <token>
 *
 * The input body passes through unchanged (Clef's `{ model, state, questions }`,
 * the chat models' OpenAI-style messages). A plain call returns the parsed
 * `result`, as the binding does; a call with `stream: true` returns the raw
 * server-sent-event bytes, which `sseJson` in `run.ts` reads. The caller's
 * signal cancels the request. Tags and the gateway option are binding-only
 * and are dropped. Every call is recorded for the report: model, time to the
 * answer (or to the stream's start), the stream's end, and the usage the model
 * reported. The token is read by the caller from the process and never stored
 * or logged here.
 */

import type { AiBinding } from '../../src/services/inference/index.js';

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** Workers AI's bill for the call, cached input priced as cached ($0.011 per 1,000). */
  neurons?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface RecordedCall {
  model: string;
  stream: boolean;
  /** Characters of the JSON input, for estimating input tokens when no usage comes back. */
  inputChars: number;
  /** Until the answer, or until the stream's headers. */
  ms: number;
  /** Until the stream ended or was cancelled. */
  streamMs?: number;
  status: number | 'aborted' | 'network';
  aborted: boolean;
  usage?: Usage;
  /** Characters of streamed or returned text, for estimating output tokens. */
  outputChars: number;
  /** The plain result (Clef's answers), kept for threshold sweeps. */
  result?: unknown;
}

export interface RestAiOptions {
  accountId: string;
  token: string;
  /** Injected in tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  /** Receives each call once it settles (a stream: once it ends or is cancelled). */
  onCall?: (call: RecordedCall) => void;
  now?: () => number;
}

export class RestAiError extends Error {
  constructor(
    readonly model: string,
    readonly status: number,
    detail: string,
  ) {
    super(`Workers AI ${model} answered ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'RestAiError';
  }
}

function errorDetail(body: unknown): string {
  const errors = (body as { errors?: { message?: string }[] } | null)?.errors;
  return Array.isArray(errors) ? errors.map((e) => e?.message ?? '').filter(Boolean).join('; ').slice(0, 300) : '';
}

/** The usage and text of one parsed SSE `data:` object (OpenAI-style or legacy `response`). */
function chunkInfo(chunk: unknown): { usage?: Usage; text: string } {
  const c = (chunk ?? {}) as Record<string, any>;
  const delta = c.choices?.[0]?.delta?.content ?? c.response;
  const usage = c.usage && typeof c.usage === 'object' ? (c.usage as Usage) : undefined;
  return { usage, text: typeof delta === 'string' ? delta : '' };
}

function resultText(result: unknown): string {
  const r = (result ?? {}) as Record<string, any>;
  const text = r.choices?.[0]?.message?.content ?? r.response;
  const call = r.choices?.[0]?.message?.tool_calls?.[0] ?? r.tool_calls?.[0];
  const args = call?.function?.arguments ?? call?.arguments;
  return (typeof text === 'string' ? text : '') + (args == null ? '' : typeof args === 'string' ? args : JSON.stringify(args));
}

/**
 * Pass the stream through to the caller while reading its `data:` lines on the
 * side for usage and text length; record the call when it ends or is cancelled.
 */
function observeStream(body: ReadableStream<Uint8Array>, done: (usage: Usage | undefined, chars: number, aborted: boolean) => void) {
  const decoder = new TextDecoder();
  let buffer = '';
  let usage: Usage | undefined;
  let chars = 0;
  let settled = false;
  const settle = (aborted: boolean) => {
    if (settled) return;
    settled = true;
    done(usage, chars, aborted);
  };
  const scan = (final: boolean) => {
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0 || (final && buffer)) {
      const line = (nl >= 0 ? buffer.slice(0, nl) : buffer).trim();
      buffer = nl >= 0 ? buffer.slice(nl + 1) : '';
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const info = chunkInfo(JSON.parse(data));
        usage = info.usage ?? usage;
        chars += info.text.length;
      } catch {
        // a partial line; the run reads the same bytes and skips it too
      }
    }
  };
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done: end } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          scan(false);
          controller.enqueue(value);
        }
        if (end) {
          scan(true);
          settle(false);
          controller.close();
        }
      } catch (err) {
        settle(true);
        controller.error(err);
      }
    },
    async cancel(reason) {
      settle(true);
      await reader.cancel(reason).catch(() => {});
    },
  });
}

/** The adapter; `run(model, input, options)` like the Workers AI binding. */
export function createRestAi(opts: RestAiOptions): AiBinding {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(opts.accountId)}/ai/run/`;
  const run = async (model: string, input: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
    const body = JSON.stringify(input);
    const stream = input?.stream === true;
    const t0 = now();
    const record = (fields: Partial<RecordedCall>) =>
      opts.onCall?.({ model, stream, inputChars: body.length, ms: now() - t0, status: 0, aborted: false, outputChars: 0, ...fields });
    let res: Response;
    try {
      res = await doFetch(base + model, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' },
        body,
        signal: options?.signal,
      });
    } catch (err) {
      const aborted = options?.signal?.aborted === true;
      record({ status: aborted ? 'aborted' : 'network', aborted });
      throw err;
    }
    const ms = now() - t0;
    if (!res.ok) {
      const detail = errorDetail(await res.json().catch(() => null));
      record({ ms, status: res.status });
      throw new RestAiError(model, res.status, detail);
    }
    if (stream) {
      if (!res.body) throw new RestAiError(model, res.status, 'empty stream');
      return observeStream(res.body, (usage, chars, aborted) =>
        record({ ms, streamMs: now() - t0, status: res.status, aborted, usage, outputChars: chars }),
      );
    }
    const parsed = (await res.json()) as { result?: unknown; success?: boolean; errors?: unknown };
    if (parsed?.success === false) {
      record({ ms, status: res.status });
      throw new RestAiError(model, res.status, errorDetail(parsed));
    }
    const result = parsed?.result;
    const usage = (result as { usage?: Usage } | null)?.usage;
    record({ ms: now() - t0, status: res.status, usage: usage && typeof usage === 'object' ? usage : undefined, outputChars: resultText(result).length, result });
    return result;
  };
  return { run } as unknown as AiBinding;
}
