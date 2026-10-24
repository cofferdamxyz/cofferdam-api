// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/** Fakes for the Work pipeline tests: the inference seam keyed by op, and an in-memory usage meter. */

import { GLOBAL_USAGE_NAME, type ChatMonthUsage, type ChatUsageDelta, type ChatUsageStore } from '../../../src/services/chatUsageStore.js';
import { OPS, type Inference, type InferenceCall, type InferenceOp } from '../../../src/services/inference/index.js';

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
      const v = typeof r === 'function' ? await (r as (input: Record<string, unknown>) => unknown)(input) : r;
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
