// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The synthetic registry seed (`test/fixtures/work/registry-seed.json`),
 * embedded with the real `work-embed` model into an in-memory registry
 * (node:sqlite for D1, a cosine index for Vectorize), for the live
 * evaluations. No ESCO data: its codes come only from the founder's download.
 */

import type { Inference } from '../../src/services/inference/index.js';
import { D1RegistryStore, embedTexts, labelIdOf, labelNorm, type RegistryDeps, type RegistryLabel, type TokenKind } from '../../src/services/work/registry.js';
import { sqliteD1 } from '../fixtures/work/d1.js';
import { memoryIndex } from '../fixtures/work/fakes.js';
import seed from '../fixtures/work/registry-seed.json';

export interface SeedToken {
  token: string;
  kind: TokenKind;
  labels: Partial<Record<string, string[]>>;
}

export const SEED_TOKENS = seed.tokens as SeedToken[];

export async function seededRegistry(inference: Inference) {
  const db = sqliteD1();
  const store = new D1RegistryStore(db.d1);
  const index = memoryIndex();
  for (const t of SEED_TOKENS) {
    const labels: RegistryLabel[] = [];
    for (const [lang, list] of Object.entries(t.labels)) {
      for (const label of list ?? []) {
        const norm = labelNorm(label);
        labels.push({ labelId: await labelIdOf(t.token, lang, norm), token: t.token, lang, label, labelNorm: norm, kind: 'preferred', embedded: true });
      }
    }
    const e = await embedTexts(inference, labels.map((l) => l.label));
    if (!e.ok) throw new Error(`seed embedding failed for ${t.token}`);
    await store.insertToken({ token: t.token, kind: t.kind, source: 'seed', labelEn: t.labels.en?.[0] ?? t.token, escoUri: null, iscoCode: null, status: 'active', mergedInto: null }, labels, 0);
    await index.upsert(labels.map((l, i) => ({ id: l.labelId, values: e.vectors[i]!, metadata: { token: t.token, kind: t.kind, lang: l.lang, label: l.label, source: 'seed' } })));
  }
  const registry: RegistryDeps = { inference, store, index };
  return { db, store, index, registry };
}
