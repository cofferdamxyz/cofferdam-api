// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * ESCO's occupations as an in-memory registry for the live evaluations, read
 * from the founder's download and never from the live registry:
 *
 * - the classification CSVs in `ESCO_DIR` (`occupations_en.csv`, `_pt`, `_es`),
 *   planned as the import plans them (`esco.ts`), so the tokens, their names
 *   and their labels are the ones loaded on 2026-10-24;
 * - every label's `work-embed` vector, from the cache `test/onet.eval.test.ts`
 *   writes (`esco-occupation-vectors.json` and `.f32` in `ESCO_VECTORS`),
 *   embedded and written there when it is missing or holds another model's.
 *
 * D1 is node:sqlite with the real migrations. The index searches every
 * label's unit vector exhaustively and answers with the metadata
 * `token-registry-v1` holds. `reset()` drops what a snap added (its alias, a
 * mint, its decision), so each string meets the registry as loaded.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Inference } from '../../src/services/inference/index.js';
import { planEscoImport, type EscoLang } from '../../src/services/work/esco.js';
import { D1RegistryStore, embedTexts, type IndexMatch, type IndexVector, type RegistryLabel, type VectorIndex } from '../../src/services/work/registry.js';
import { sqliteD1 } from '../fixtures/work/d1.js';

export const homePath = (p: string) => p.replace(/^~(?=\/)/, homedir());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function unit(v: ArrayLike<number>): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  const d = Math.sqrt(n) || 1;
  return Float32Array.from({ length: v.length }, (_, i) => v[i]! / d);
}

/** Every label's unit vector in one array, searched exhaustively; what a snap upserts (a mint's labels) sits beside them. */
function poolIndex(dims: number, rows: Float32Array, labels: readonly RegistryLabel[]): VectorIndex & { reset(): void } {
  const extra = new Map<string, IndexVector>();
  return {
    async query(vector, opts) {
      const q = unit(vector);
      const k = Math.min(50, opts.topK);
      const top: { i: number; s: number }[] = [];
      const consider = (i: number, s: number) => {
        if (top.length === k && s <= top[k - 1]!.s) return;
        let at = top.length;
        while (at > 0 && top[at - 1]!.s < s) at--;
        top.splice(at, 0, { i, s });
        if (top.length > k) top.pop();
      };
      if (!opts.filter?.kind || opts.filter.kind === 'pos') {
        for (let i = 0; i < labels.length; i++) {
          let s = 0;
          const o = i * dims;
          for (let d = 0; d < dims; d++) s += rows[o + d]! * q[d]!;
          consider(i, s);
        }
      }
      const matches: IndexMatch[] = top.map(({ i, s }) => {
        const l = labels[i]!;
        return { id: l.labelId, score: s, metadata: { token: l.token, kind: 'pos', lang: l.lang, label: l.label, source: 'esco' } };
      });
      for (const v of extra.values()) {
        if (opts.filter && Object.entries(opts.filter).some(([key, want]) => v.metadata[key] !== want)) continue;
        const w = unit(v.values);
        let s = 0;
        for (let d = 0; d < dims; d++) s += w[d]! * q[d]!;
        matches.push({ id: v.id, score: s, metadata: { ...v.metadata } });
      }
      return matches.sort((a, b) => b.score - a.score).slice(0, k);
    },
    async upsert(vectors) {
      for (const v of vectors) extra.set(v.id, v);
    },
    async deleteByIds(ids) {
      for (const id of ids) extra.delete(id);
    },
    reset() {
      extra.clear();
    },
  };
}

/** ESCO's occupation label texts embedded with `work-embed`, from the cache or, when it is missing or another model's, embedded and cached. */
async function labelVectors(inference: Inference, texts: string[], cacheDir: string): Promise<{ dims: number; vectors: Float32Array }> {
  const model = await inference.model('work-embed');
  const cacheText = join(cacheDir, 'esco-occupation-vectors.json');
  const cacheBin = join(cacheDir, 'esco-occupation-vectors.f32');
  if (existsSync(cacheText) && existsSync(cacheBin)) {
    const cached = JSON.parse(readFileSync(cacheText, 'utf8')) as { model: string; texts: string[] };
    if (cached.model === model) {
      const buf = readFileSync(cacheBin);
      const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      const dims = all.length / cached.texts.length;
      const at = new Map(cached.texts.map((t, i) => [t, i]));
      const vectors = new Float32Array(texts.length * dims);
      texts.forEach((t, i) => {
        const j = at.get(t);
        if (j === undefined) throw new Error(`the cache lacks "${t}": delete ${cacheText}`);
        vectors.set(all.subarray(j * dims, (j + 1) * dims), i * dims);
      });
      return { dims, vectors };
    }
  }
  let dims = 0;
  let vectors = new Float32Array();
  for (let from = 0; from < texts.length; from += 100) {
    const batch = texts.slice(from, from + 100);
    for (let attempt = 0; ; attempt++) {
      const e = await embedTexts(inference, batch);
      if (e.ok) {
        if (!dims) {
          dims = e.vectors[0]!.length;
          vectors = new Float32Array(texts.length * dims);
        }
        e.vectors.forEach((v, j) => vectors.set(unit(v), (from + j) * dims));
        break;
      }
      if (attempt >= 4) throw new Error(`${model} failed five times at text ${from}`);
      await sleep(1_000 * 2 ** attempt);
    }
  }
  writeFileSync(cacheBin, Buffer.from(vectors.buffer));
  writeFileSync(cacheText, JSON.stringify({ model, texts }));
  return { dims, vectors };
}

export interface EscoRegistry {
  store: D1RegistryStore;
  index: VectorIndex;
  /** Drop what the last snap added: aliases, mints and decisions. */
  reset(): void;
  tokens: number;
  labels: number;
}

/** ESCO's occupations, as loaded, in memory; see the module comment. */
export async function escoOccupationRegistry(inference: Inference, escoDir: string, cacheDir: string): Promise<EscoRegistry> {
  const occupations: Partial<Record<EscoLang, string>> = {};
  for (const lang of ['en', 'pt', 'es'] as const) {
    const path = join(escoDir, `occupations_${lang}.csv`);
    if (existsSync(path)) occupations[lang] = readFileSync(path, 'utf8');
  }
  const plan = await planEscoImport({ occupations });
  const texts = [...new Set(plan.labels.map((l) => l.label))];
  const { dims, vectors } = await labelVectors(inference, texts, cacheDir);
  const row = new Map(texts.map((t, i) => [t, i]));
  const rows = new Float32Array(plan.labels.length * dims);
  plan.labels.forEach((l, i) => {
    const j = row.get(l.label)!;
    rows.set(vectors.subarray(j * dims, (j + 1) * dims), i * dims);
  });
  const index = poolIndex(dims, rows, plan.labels);

  const db = sqliteD1();
  const store = new D1RegistryStore(db.d1);
  const byToken = new Map<string, RegistryLabel[]>();
  for (const l of plan.labels) (byToken.get(l.token) ?? byToken.set(l.token, []).get(l.token)!).push(l);
  // Loaded at 0: everything a snap writes later is newer, which is what reset() drops.
  for (const t of plan.tokens) await store.insertToken(t, byToken.get(t.token) ?? [], 0);
  return {
    store,
    index,
    reset() {
      db.sqlite.exec('DELETE FROM registry_decisions; DELETE FROM registry_labels WHERE created_at > 0; DELETE FROM registry_tokens WHERE created_at > 0;');
      index.reset();
    },
    tokens: plan.tokens.length,
    labels: plan.labels.length,
  };
}
