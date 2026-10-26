// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The inference seam (workspace `docs/product/engine.md`, "Inference seam and
 * gateways"): every Workers AI call on the plane goes through `createInference`,
 * and `test/inference.test.ts` fails the build if `env.AI` is used anywhere
 * else.
 *
 * An op class names what a call is for. Its model is a pin: the `AI_PINS` KV
 * key `model:<op>` when that namespace is bound, else the op's variable
 * (decision 0037's `CHAT_*_MODEL`), else the default below, so a model swap is
 * one key and no deploy. KV pins are read through a one-minute cache.
 *
 * Every call carries the op as a Workers AI tag, which splits usage per op in
 * the dashboard. With `AI_GATEWAY_ID` set, calls go through that gateway with
 * its cache skipped and no gateway log kept (`collectLog: false`), because
 * these ops see user text (the strict gateway). A timeout covers each call
 * until the model answers, or until a stream starts; the caller's signal
 * cancels it at any time, stream included.
 */

/** What a call is for. Tags allow letters, digits and `: - . / @`, so op ids use dashes. */
export type InferenceOp =
  | 'chat-router'
  | 'chat-action'
  | 'chat-answer'
  | 'chat-long'
  | 'chat-reasoning'
  | 'work-classify'
  | 'work-extract'
  | 'work-extract-fallback'
  | 'work-intent'
  | 'work-embed'
  | 'work-adjudicate'
  | 'work-pivot';

export type InferenceModelVar =
  | 'CHAT_ROUTER_MODEL'
  | 'CHAT_ACTION_MODEL'
  | 'CHAT_ANSWER_MODEL'
  | 'CHAT_LONG_MODEL'
  | 'CHAT_REASONING_MODEL'
  | 'WORK_CLASSIFY_MODEL'
  | 'WORK_EXTRACT_MODEL'
  | 'WORK_EXTRACT_FALLBACK_MODEL'
  | 'WORK_INTENT_MODEL'
  | 'WORK_EMBED_MODEL'
  | 'WORK_ADJUDICATE_MODEL'
  | 'WORK_PIVOT_MODEL';

export interface OpSpec {
  /** The model when neither KV nor the environment pins one. */
  model: string;
  /** The environment variable that pins it. */
  envVar: InferenceModelVar;
  /** Until the model answers; for a stream, until it starts. */
  timeoutMs: number;
}

export const OPS: Record<InferenceOp, OpSpec> = {
  // clef-flash answered in 0.5-0.9 s warm and 1.5 s cold from the Mac; 1.9 and 3.5 s on the deployed plane (2026-10-17).
  'chat-router': { model: '@cf/cloudflare/clef-flash', envVar: 'CHAT_ROUTER_MODEL', timeoutMs: 6_000 },
  // gemma-4 fills the action fields as well as glm-4.7-flash and stays near 1 s;
  // glm-4.7-flash spiked to 7-11 s on the same call (checked 2026-10-17).
  'chat-action': { model: '@cf/google/gemma-4-26b-a4b-it', envVar: 'CHAT_ACTION_MODEL', timeoutMs: 6_000 },
  'chat-answer': { model: '@cf/google/gemma-4-26b-a4b-it', envVar: 'CHAT_ANSWER_MODEL', timeoutMs: 15_000 },
  // glm-5.3-flash took 1.8-2.9 s to its first token and 7-20 s in all on long
  // answers, gemma-4 0.5-1.0 s and 4-7 s for as much text (2026-10-17).
  'chat-long': { model: '@cf/google/gemma-4-26b-a4b-it', envVar: 'CHAT_LONG_MODEL', timeoutMs: 30_000 },
  // The Thinking tier (decision 0047, amended 2026-10-21): DeepSeek V4.1 Flash at
  // low reasoning effort gave its first word in 3.7 s median and 8.1 s at worst
  // over 27 evaluation answers, where GLM-5.3 ran 4.6 s median with eight of 28
  // past 10 s (up to 44 s), at a third of the cost (2026-10-21). The wait to the
  // first byte is still seconds, so the app shows a thinking state meanwhile;
  // each model stalled once in 28 with nothing by this window, so the turn
  // retries once (`chat/run.ts`, `REASONING_FIRST_TRY_MS`).
  'chat-reasoning': { model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017', envVar: 'CHAT_REASONING_MODEL', timeoutMs: 45_000 },
  // Cofferdam Work, the cloud executor (workspace decisions 0020 and 0021,
  // `services/work/`). The document type, read by Clef from de-identified
  // blocks (decision 0021 (d)); clef-flash answered in 1.2 s from the Mac.
  'work-classify': { model: '@cf/cloudflare/clef-flash', envVar: 'WORK_CLASSIFY_MODEL', timeoutMs: 6_000 },
  // One block's fields. JSON mode on llama-3.3-70b took 5.0 s on an
  // experience entry from the Mac, Clairic 1.9 s, gpt-oss-120b 3.9 s
  // (2026-10-24). The adapter follows the pinned model's family.
  'work-extract': { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', envVar: 'WORK_EXTRACT_MODEL', timeoutMs: 20_000 },
  // When the primary fails or answers out of shape (decision 0020); it reasons before answering, so it waits longer.
  'work-extract-fallback': { model: '@cf/openai/gpt-oss-120b', envVar: 'WORK_EXTRACT_FALLBACK_MODEL', timeoutMs: 30_000 },
  // A hirer's sentence into the intent's fields (S5): once per vacancy, its own pin and meter.
  'work-intent': { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', envVar: 'WORK_INTENT_MODEL', timeoutMs: 15_000 },
  // The token registry (S3, decision 0018): embeddings for retrieve-then-choose
  // (bge-m3 answered two short labels in 0.7 s from the Mac), Clef's choice
  // in the τ band, and the English pivot of a new token (free text by nature,
  // JSON mode, validated as a pivot). The index pins its embedding model:
  // a change of `work-embed` is a re-embed migration, never a quiet swap.
  'work-embed': { model: '@cf/baai/bge-m3', envVar: 'WORK_EMBED_MODEL', timeoutMs: 10_000 },
  'work-adjudicate': { model: '@cf/cloudflare/clef-flash', envVar: 'WORK_ADJUDICATE_MODEL', timeoutMs: 6_000 },
  'work-pivot': { model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', envVar: 'WORK_PIVOT_MODEL', timeoutMs: 15_000 },
};

/**
 * Workers AI prices in US dollars per million tokens, input and output, for
 * the chat meter (`services/chatUsageStore.ts`). Read 2026-10-17, checked 2026-10-20 and 2026-10-21 (DeepSeek) against the Workers AI pricing page (workspace
 * `docs/product/engine.md`, Cost and latency); re-check when a pin moves.
 * Clef bills input only. A dollar per million tokens is a millionth of a
 * dollar per token, so `tokens × price` is already in micro-dollars. Cached
 * input is cheaper on the reasoning models ($0.006 / M on DeepSeek V4.1 Flash,
 * $0.26 / M on `glm-5.3`, $0.03 / M on `glm-5.3-flash`), which the meter sees
 * through the neurons a model reports: these rates price a call only when its
 * model reported none (`services/chatUsageStore.ts`, `usageDelta`).
 */
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  '@cf/google/gemma-4-26b-a4b-it': { input: 0.1, output: 0.3 },
  '@cf/cloudflare/clef-flash': { input: 0.038, output: 0 },
  // The Thinking tier's model (workspace decision 0047, amended 2026-10-21); read 2026-10-21.
  '@cf/deepseek-ai/deepseek-v4.1-flash-1017': { input: 0.3, output: 1.2 },
  // The Thinking tier's model until 2026-10-21, kept for a pin; read 2026-10-20.
  '@cf/zai-org/glm-5.3': { input: 1.4, output: 4.4 },
  '@cf/zai-org/glm-5.3-flash': { input: 0.15, output: 0.5 },
  '@cf/zai-org/glm-4.7-flash': { input: 0.06, output: 0.4 },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { input: 0.293, output: 2.253 },
  // Cofferdam Work (read 2026-10-24 on the Workers AI pricing page). Clairic
  // and Clef bill input only; Clairic counts its field schema as input
  // (about 1,000 tokens of a block's 1,350 on 2026-10-24).
  '@cf/cloudflare/clairic': { input: 0.1, output: 0 },
  '@cf/cloudflare/clef': { input: 0.24, output: 0 },
  '@cf/openai/gpt-oss-120b': { input: 0.35, output: 0.75 },
  // Embeddings bill input only; bge-m3 also reports neurons, which the Work meter prefers.
  '@cf/baai/bge-m3': { input: 0.012, output: 0 },
  // EmbeddingGemma (decision 0067, rule 7) reports neither usage nor neurons, so every call is priced
  // here; Cloudflare's pricing page did not list it on 2026-10-26, so this is bge-m3's rate as a stand-in.
  '@cf/google/embeddinggemma-300m': { input: 0.012, output: 0 },
};

const unpriced = new Set<string>();

/**
 * The estimated cost of a call in millionths of a dollar, rounded to an
 * integer. A model missing from `MODEL_PRICES` prices at zero and logs
 * `chat_price_unknown` once per isolate.
 */
export function modelCostMicroUsd(
  model: string,
  tokensIn: number,
  tokensOut: number,
  log: (fields: Record<string, unknown>) => void = (f) => console.log(JSON.stringify(f)),
): number {
  const price = MODEL_PRICES[model];
  if (!price) {
    if (!unpriced.has(model)) {
      unpriced.add(model);
      log({ event: 'chat_price_unknown', model });
    }
    return 0;
  }
  return Math.round(Math.max(0, tokensIn) * price.input + Math.max(0, tokensOut) * price.output);
}

/** Forget which unknown models were already logged (tests). */
export function clearUnpricedModels(): void {
  unpriced.clear();
}

export interface InferenceEnv extends Partial<Record<InferenceModelVar, string>> {
  AI?: Ai;
  /** Model pins, `model:<op>`; optional until the namespace is created. */
  AI_PINS?: KVNamespace;
  /** The strict AI Gateway; unset, calls go straight to Workers AI. */
  AI_GATEWAY_ID?: string;
}

export interface InferenceCall {
  /** Cancels the call at any time, a started stream included. */
  signal?: AbortSignal;
  /** Overrides the op's timeout for this call (a first router attempt waits less, then retries). */
  timeoutMs?: number;
}

export interface Inference {
  run(op: InferenceOp, input: Record<string, unknown>, call?: InferenceCall): Promise<unknown>;
  /** The model an op runs on now. */
  model(op: InferenceOp): Promise<string>;
}

export class InferenceTimeout extends Error {
  constructor(
    readonly op: InferenceOp,
    readonly ms: number,
  ) {
    super(`${op} gave no answer within ${ms} ms`);
    this.name = 'InferenceTimeout';
  }
}

/** Workers AI's `run`, as the seam calls it; tests pass a fake. */
export type AiBinding = Pick<Ai, 'run'>;

const PIN_TTL_MS = 60_000;
const pinCache = new Map<string, { model: string; until: number }>();

/** Forget cached KV pins (tests). */
export function clearPinCache(): void {
  pinCache.clear();
}

export async function resolveModel(env: InferenceEnv, op: InferenceOp, now = Date.now()): Promise<string> {
  const spec = OPS[op];
  const fallback = env[spec.envVar] || spec.model;
  if (!env.AI_PINS) return fallback;
  const key = `model:${op}`;
  const hit = pinCache.get(key);
  if (hit && hit.until > now) return hit.model;
  let model = fallback;
  try {
    const pinned = (await env.AI_PINS.get(key, { cacheTtl: 60 }))?.trim();
    if (pinned) model = pinned;
  } catch {
    // An unreadable pin keeps the call on the environment's model.
  }
  pinCache.set(key, { model, until: now + PIN_TTL_MS });
  return model;
}

/** The per-call options: the op tag, the gateway when set, and the cancel signal. */
export function aiOptions(env: InferenceEnv, op: InferenceOp, signal: AbortSignal): Record<string, unknown> {
  const options: Record<string, unknown> = { tags: ['cofferdam-api', `op:${op}`], signal };
  if (env.AI_GATEWAY_ID) {
    options.gateway = { id: env.AI_GATEWAY_ID, skipCache: true, collectLog: false, metadata: { op } };
  }
  return options;
}

export interface CreateInferenceOptions {
  /** Overrides `env.AI` (tests). */
  ai?: AiBinding;
  now?: () => number;
}

/** The seam for one request, or null when Workers AI is not bound. */
export function createInference(env: InferenceEnv, opts: CreateInferenceOptions = {}): Inference | null {
  const ai = opts.ai ?? env.AI;
  if (!ai) return null;
  const now = opts.now ?? Date.now;
  const model = (op: InferenceOp) => resolveModel(env, op, now());
  return {
    model,
    async run(op, input, call = {}) {
      const spec = OPS[op];
      const timeoutMs = call.timeoutMs ?? spec.timeoutMs;
      const id = await model(op);
      const ctl = new AbortController();
      if (call.signal?.aborted) ctl.abort(call.signal.reason);
      else call.signal?.addEventListener('abort', () => ctl.abort(call.signal!.reason), { once: true });
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ctl.abort();
          reject(new InferenceTimeout(op, timeoutMs));
        }, timeoutMs);
      });
      try {
        return await Promise.race([ai.run(id as never, input as never, aiOptions(env, op, ctl.signal) as never), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
