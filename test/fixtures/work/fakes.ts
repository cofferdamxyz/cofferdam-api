// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/** Fakes for the Work pipeline tests: the inference seam keyed by op, and an in-memory usage meter. */

import { GLOBAL_USAGE_NAME, type ChatMonthUsage, type ChatUsageDelta, type ChatUsageStore } from '../../../src/services/chatUsageStore.js';
import { OPS, type Inference, type InferenceCall, type InferenceOp } from '../../../src/services/inference/index.js';
import type { IndexMatch, IndexVector, VectorIndex } from '../../../src/services/work/registry.js';

export interface FakeCall {
  op: InferenceOp;
  input: Record<string, unknown>;
}

/** Responses per op: a value, an Error to throw, or a function of the input returning either. */
export type FakeResponses = Partial<Record<InferenceOp, unknown>>;

export function fakeInference(responses: FakeResponses, calls: FakeCall[] = [], models: Partial<Record<InferenceOp, string>> = {}): Inference {
  return {
    async model(op) {
      return models[op] ?? OPS[op].model;
    },
    async run(op, input, _call: InferenceCall = {}) {
      calls.push({ op, input });
      const r = responses[op];
      const v = typeof r === 'function' ? await (r as (input: Record<string, unknown>, call: InferenceCall) => unknown)(input, _call) : r;
      if (v instanceof Error) throw v;
      return v;
    },
  };
}

export interface Recorded {
  account: string;
  month: string;
  delta: ChatUsageDelta;
}

/** The meter in memory, with rows a test can preset. */
export function memoryUsageStore(rows: Map<string, ChatMonthUsage> = new Map()) {
  const recorded: Recorded[] = [];
  const add = (key: string, month: string, d: ChatUsageDelta) => {
    const r = rows.get(key) ?? { month, turns: 0, tokensIn: 0, tokensOut: 0, routerCalls: 0, estimatedMicroUsd: 0, lastTurnAt: 0, models: [] };
    rows.set(key, {
      ...r,
      turns: r.turns + d.turns,
      tokensIn: r.tokensIn + d.tokensIn,
      tokensOut: r.tokensOut + d.tokensOut,
      estimatedMicroUsd: r.estimatedMicroUsd + d.estimatedMicroUsd,
    });
  };
  const store: ChatUsageStore = {
    async record(account, month, delta) {
      recorded.push({ account, month, delta });
      add(`${account.toLowerCase()}:${month}`, month, delta);
    },
    async read(account, month) {
      return rows.get(`${account.toLowerCase()}:${month}`) ?? null;
    },
    async recordGlobal(month, delta) {
      recorded.push({ account: 'global', month, delta });
      add(`${GLOBAL_USAGE_NAME}:${month}`, month, delta);
    },
    async readGlobal(month) {
      return rows.get(`${GLOBAL_USAGE_NAME}:${month}`) ?? null;
    },
  };
  return { store, recorded, rows };
}

/** A llama JSON-mode result as Workers AI answers it: the object under `response`, the bill in neurons. */
export function jsonModeResult(answer: Record<string, unknown>, usage = { prompt_tokens: 360, completion_tokens: 80, neurons: 26.7 }) {
  return {
    choices: [{ message: { role: 'assistant', content: JSON.stringify(answer) } }],
    usage,
    response: answer,
  };
}

/** A Clairic result: one answer per field, spans with confidence and p_null. */
export function clairicResult(values: Record<string, unknown>, usage = { input_tokens: 1350, output_tokens: 0 }) {
  const answers: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    answers[k] = Array.isArray(v) ? { type: 'list', value: v, confidence: 0.8 } : { type: 'text', value: v, confidence: 0.9, p_null: v == null ? 0.9 : 0.01 };
  }
  return { model: 'clairic', answers, usage };
}

/** A Clef `choice` answer. */
export function clefChoice(id: string, choice: string, probabilities: Record<string, number>, inputTokens = 260) {
  return { model: 'clef-flash', answers: { [id]: { type: 'choice', choice, probabilities } }, usage: { input_tokens: inputTokens } };
}

// ── An in-memory vector index (Vectorize's shape) ───────────────────────────


export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Vectorize caps topK at 50 when metadata comes back (decision 0019); the fake enforces it. */
export const TOPK_WITH_METADATA = 50;

export interface MemoryIndex extends VectorIndex {
  vectors: Map<string, IndexVector>;
  queries: { namespace?: string; topK: number; filter?: Record<string, unknown> }[];
}

export function memoryIndex(): MemoryIndex {
  const vectors = new Map<string, IndexVector>();
  const queries: MemoryIndex['queries'] = [];
  return {
    vectors,
    queries,
    async query(vector, opts) {
      if (opts.topK > TOPK_WITH_METADATA) throw new Error(`topK ${opts.topK} is above Vectorize's ${TOPK_WITH_METADATA} with metadata`);
      queries.push({ namespace: opts.namespace, topK: opts.topK, filter: opts.filter });
      const matches: IndexMatch[] = [];
      for (const v of vectors.values()) {
        if ((v.namespace ?? '') !== (opts.namespace ?? '')) continue;
        if (opts.filter && Object.entries(opts.filter).some(([k, want]) => v.metadata[k] !== want)) continue;
        matches.push({ id: v.id, score: cosine(vector, v.values), metadata: { ...v.metadata } });
      }
      return matches.sort((a, b) => b.score - a.score).slice(0, opts.topK);
    },
    async upsert(list) {
      for (const v of list) vectors.set(v.id, v);
    },
    async deleteByIds(ids) {
      for (const id of ids) vectors.delete(id);
    },
  };
}

/** The unit vector along axis `a`. */
export function axis(a: number, dims = 1024): number[] {
  const v = new Array<number>(dims).fill(0);
  v[a] = 1;
  return v;
}

/** A unit vector with cosine `cos` to `axis(a)`, the rest along axis `b`. */
export function near(a: number, b: number, cos: number, dims = 1024): number[] {
  const v = new Array<number>(dims).fill(0);
  v[a] = cos;
  v[b] = Math.sqrt(Math.max(0, 1 - cos * cos));
  return v;
}

/** A `work-embed` answer from a lookup of text to vector; unknown texts throw, so a test names every embedding it expects. */
export function embedAnswer(table: Record<string, number[]>) {
  return (input: Record<string, unknown>) => {
    const texts = input.text as string[];
    return {
      shape: [texts.length, 1024],
      data: texts.map((t) => {
        const v = table[t];
        if (!v) throw new Error(`no fake embedding for "${t}"`);
        return v;
      }),
      meta: { cost_metric_value_1: texts.length * 4, neurons: 0.002 * texts.length },
    };
  };
}
