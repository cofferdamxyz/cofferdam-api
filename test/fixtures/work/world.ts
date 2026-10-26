// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A small Work plane for the route tests: the registry and the listing
 * records on `node:sqlite` with the real migrations, both Vectorize indexes
 * in memory (Vectorize's 50 enforced), a keyword embedder that gives seed
 * labels, listings and queries one geometry, and a Clef fake for the hirer
 * query. Synthetic data only.
 */

import type { InferenceOp } from '../../../src/services/inference/index.js';
import { D1ListingStore } from '../../../src/services/work/listings.js';
import { D1RegistryStore, labelIdOf, labelNorm, type TokenKind } from '../../../src/services/work/registry.js';
import type { WorkStores } from '../../../src/services/work/stores.js';
import { sqliteD1 } from './d1.js';
import { fakeInference, jsonModeResult, memoryIndex, type FakeCall, type FakeResponses } from './fakes.js';

const FEATURES: [RegExp, number][] = [
  [/electric|eletric/i, 0],
  [/plumb|encanad|plomer|sink|fregadero/i, 1],
  [/leak|vazament|fuga/i, 3],
  [/licen/i, 5],
  [/charger|carregador|cargador/i, 6],
  [/translat|tradu/i, 7],
  [/contract|contrato/i, 8],
];

export function keywordVector(text: string): number[] {
  const v = new Array<number>(1024).fill(0);
  for (const [re, dim] of FEATURES) if (re.test(text)) v[dim]! += 1;
  v[1023] = 0.05;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

/** `work-embed` over the keyword geometry, billed in neurons as bge-m3 reports. */
export const keywordEmbed = (input: Record<string, unknown>) => {
  const texts = input.text as string[];
  return { data: texts.map(keywordVector), meta: { cost_metric_value_1: 8 * texts.length, neurons: 0.001 } };
};

export const SEED: { token: string; kind: TokenKind; label: string }[] = [
  { token: 'pos:plumber', kind: 'pos', label: 'plumber' },
  { token: 'pos:electrician', kind: 'pos', label: 'electrician' },
  { token: 'pos:translator', kind: 'pos', label: 'translator' },
  { token: 'skill:leak-repair', kind: 'skill', label: 'leak repair' },
  { token: 'skill:ev-charger-installation', kind: 'skill', label: 'EV charger installation' },
  { token: 'skill:legal-translation', kind: 'skill', label: 'contract translation' },
  { token: 'cert:plumber-license:us-tx', kind: 'cert', label: 'Texas journeyman plumber license' },
];

/** The hirer intent parse's answer for the sink request, with overrides. */
export const intentAnswer = (over: Record<string, unknown> = {}) =>
  jsonModeResult({ task: 'kitchen sink is leaking under the cabinet', when: 'today after 2pm', budget: 120, credential: null, language: null, recurrence: null, ...over });

/** Clef: the safety checks it is given, the scope, and yes to every candidate whose label matches `yes`. */
export const clefSays =
  (yes: RegExp, scope = 'onsite', safety: { harmful?: number; injection?: number } = {}) =>
  (input: Record<string, unknown>) => {
    const questions = input.questions as Record<string, { instructions: string }>;
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (id === 'scope') answers[id] = { type: 'choice', choice: scope, probabilities: { [scope]: 0.93 } };
      else if (id === 'harmful' || id === 'injection') answers[id] = { type: 'noul', noul: safety[id] ?? 0.02 };
      else if (id.startsWith('need_')) answers[id] = { type: 'noul', noul: yes.test(q.instructions) ? 0.9 : 0.05 };
    }
    return { answers, usage: { input_tokens: 300 } };
  };

/** The seeded registry and empty listings, with the inference seam over `responses` (and its pins, `models`). */
export async function workWorld(responses: FakeResponses = {}, calls: FakeCall[] = [], models: Partial<Record<InferenceOp, string>> = {}) {
  const db = sqliteD1();
  const tokenIndex = memoryIndex();
  const listingIndex = memoryIndex();
  const registry = new D1RegistryStore(db.d1);
  for (const s of SEED) {
    const norm = labelNorm(s.label);
    const labelId = await labelIdOf(s.token, 'en', norm);
    await registry.insertToken(
      { token: s.token, kind: s.kind, source: 'seed', labelEn: s.label, escoUri: null, iscoCode: null, status: 'active', mergedInto: null },
      [{ labelId, token: s.token, lang: 'en', label: s.label, labelNorm: norm, kind: 'preferred', embedded: true }],
      0,
    );
    await tokenIndex.upsert([{ id: labelId, values: keywordVector(s.label), metadata: { token: s.token, kind: s.kind, lang: 'en', label: s.label, source: 'seed' } }]);
  }
  const listings = new D1ListingStore(db.d1);
  const inference = fakeInference({ 'work-embed': keywordEmbed, ...responses }, calls, models);
  const stores: WorkStores = { registry, listings, tokenIndex, listingIndex };
  return { db, registry, listings, tokenIndex, listingIndex, inference, stores, calls };
}
