// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * What a Work call adds to the usage meter (workspace decision 0047 (3);
 * `services/chatUsageStore.ts`). Every hosted call records to the account's
 * month and to the plane-wide `plane:global` row, so the account's
 * `CHAT_MONTHLY_USD_CAP` and the plane's `AI_MONTHLY_BUDGET_USD` count
 * document parsing with the chat. A Work call is no chat turn: it adds no
 * turn and no router call, only its model's tokens and cost, under the
 * model's own id (the app lists it by the model's name).
 *
 * The cost is Workers AI's own bill when the model reports neurons ($0.011
 * per 1,000 neurons, so 11 micro-dollars a neuron), else the tokens priced by
 * `MODEL_PRICES` (Clairic and Clef report tokens only). A call that threw or
 * reported nothing is metered at its estimated input (`estimatedUsage`), so a
 * failing model never runs unmetered.
 */

import type { ChatUsageDelta } from '../chatUsageStore.js';
import { modelCostMicroUsd } from '../inference/index.js';
import type { WorkCall } from './fields.js';

export const MICRO_USD_PER_NEURON = 11;

/** A call's cost in millionths of a dollar: its neurons when reported, else its priced tokens. */
export function callCostMicroUsd(call: WorkCall, log?: (fields: Record<string, unknown>) => void): number {
  const { neurons, tokensIn, tokensOut } = call.usage;
  if (neurons != null && neurons > 0) return Math.round(neurons * MICRO_USD_PER_NEURON);
  return modelCostMicroUsd(call.model, tokensIn, tokensOut, log);
}

/**
 * The meter deltas for a request's calls: one per model that used anything, its calls' tokens and costs summed, so a
 * hirer search's fifty decision calls are two meter writes, not a hundred (the store keeps sums, never a count of calls).
 */
export function workUsageDeltas(calls: readonly WorkCall[], at: number, log?: (fields: Record<string, unknown>) => void): ChatUsageDelta[] {
  const byModel = new Map<string, ChatUsageDelta>();
  for (const call of calls) {
    const cost = callCostMicroUsd(call, log);
    if (!cost && !call.usage.tokensIn && !call.usage.tokensOut) continue;
    const d = byModel.get(call.model);
    if (d) {
      d.tokensIn += call.usage.tokensIn;
      d.tokensOut += call.usage.tokensOut;
      d.estimatedMicroUsd += cost;
      d.modelMicroUsd += cost;
      continue;
    }
    byModel.set(call.model, {
      turns: 0,
      tokensIn: call.usage.tokensIn,
      tokensOut: call.usage.tokensOut,
      routerCalls: 0,
      estimatedMicroUsd: cost,
      model: call.model,
      modelMicroUsd: cost,
      at,
    });
  }
  return [...byModel.values()];
}
