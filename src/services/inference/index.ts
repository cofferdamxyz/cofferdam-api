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
export type InferenceOp = 'chat-router' | 'chat-action' | 'chat-answer' | 'chat-long';

export type InferenceModelVar = 'CHAT_ROUTER_MODEL' | 'CHAT_ACTION_MODEL' | 'CHAT_ANSWER_MODEL' | 'CHAT_LONG_MODEL';

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
  'chat-long': { model: '@cf/zai-org/glm-5.3-flash', envVar: 'CHAT_LONG_MODEL', timeoutMs: 30_000 },
};

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
      const id = await model(op);
      const ctl = new AbortController();
      if (call.signal?.aborted) ctl.abort(call.signal.reason);
      else call.signal?.addEventListener('abort', () => ctl.abort(call.signal!.reason), { once: true });
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ctl.abort();
          reject(new InferenceTimeout(op, spec.timeoutMs));
        }, spec.timeoutMs);
      });
      try {
        return await Promise.race([ai.run(id as never, input as never, aiOptions(env, op, ctl.signal) as never), timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
