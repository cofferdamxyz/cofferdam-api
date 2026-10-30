// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The registry replica the Mac-side benchmarks share (`test/workJobs.eval.test.ts`,
 * `test/workResume.eval.test.ts`): the ESCO import's SQL and the US layer's SQL
 * in node:sqlite, the v3 label vectors (EmbeddingGemma 2 at 768) in memory, and
 * the phone's embeddings from llama-embedding. Moved here unchanged from the
 * job-ad benchmark on 2026-10-28. Like production since 2026-10-30, it holds no
 * certificate token (workspace decision 0070), and it leaves out the deleted
 * certificate seed's vectors that v3 files written before then still carry.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { D1RegistryStore, EMBEDDINGGEMMA_2_GGUF, type IndexMatch, type IndexVector, type VectorIndex } from '../../src/services/work/registry.js';
import { sqliteD1 } from '../fixtures/work/d1.js';
import { llamaEmbed } from '../fixtures/work/registryTools.js';

const MODEL = EMBEDDINGGEMMA_2_GGUF;
const DIMS = 768;

// ── The registry replica ───────────────────────────────────────────────────

interface Meta {
  id: string;
  token: string;
  kind: string;
  lang: string;
  label: string;
  source: string;
  isco: string;
}

/** The v3 vectors (`vectors-v3-NNN.ndjson`, 768 wide) in memory, with brute-force retrieval by kind; mints go to a side list. */
export class ReplicaIndex implements VectorIndex {
  private readonly rows: Meta[] = [];
  private values = new Float32Array(0);
  private readonly byKind = new Map<string, Int32Array>();
  private readonly extra = new Map<string, IndexVector>();
  readonly queries = { count: 0, ms: 0 };

  static load(dir: string): ReplicaIndex {
    const idx = new ReplicaIndex();
    const cacheDir = join(dir, 'bench-cache');
    const f32 = join(cacheDir, `v3-${DIMS}.f32`);
    const meta = join(cacheDir, `v3-${DIMS}.meta.json`);
    if (existsSync(f32) && existsSync(meta)) {
      const buf = readFileSync(f32);
      idx.values = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      for (const r of JSON.parse(readFileSync(meta, 'utf8')) as Meta[]) idx.rows.push(r);
    } else {
      const files = readdirSync(dir)
        .filter((f) => /^vectors-v3-\d{3}\.ndjson$/.test(f))
        .sort();
      if (!files.length) throw new Error(`no vectors-v3-NNN.ndjson in ${dir}`);
      const chunks: Float32Array[] = [];
      for (const f of files) {
        for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
          if (!line) continue;
          const r = JSON.parse(line) as { id: string; values: number[]; metadata: Record<string, string> };
          if (r.values.length !== DIMS) throw new Error(`${f}: a vector of ${r.values.length}`);
          chunks.push(Float32Array.from(r.values));
          idx.rows.push({ id: r.id, token: r.metadata.token ?? '', kind: r.metadata.kind ?? '', lang: r.metadata.lang ?? '', label: r.metadata.label ?? '', source: r.metadata.source ?? '', isco: r.metadata.isco ?? '' });
        }
        process.stdout.write(`${f}: ${idx.rows.length} vectors\n`);
      }
      idx.values = new Float32Array(idx.rows.length * DIMS);
      chunks.forEach((c, i) => idx.values.set(c, i * DIMS));
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(f32, Buffer.from(idx.values.buffer, idx.values.byteOffset, idx.values.byteLength));
      writeFileSync(meta, JSON.stringify(idx.rows));
    }
    const lists = new Map<string, number[]>();
    idx.rows.forEach((r, i) => {
      // The deleted certificate seed's labels (kind cert, source seed), which v3 files written before 2026-10-30 still hold.
      if (r.kind === 'cert' && r.source === 'seed') return;
      (lists.get(r.kind) ?? lists.set(r.kind, []).get(r.kind)!).push(i);
    });
    for (const [k, l] of lists) idx.byKind.set(k, Int32Array.from(l));
    return idx;
  }

  /** The vectors it serves, the deleted seed's left out. */
  get size() {
    let n = 0;
    for (const l of this.byKind.values()) n += l.length;
    return n;
  }

  async query(vector: number[], opts: { topK: number; namespace?: string; filter?: Record<string, string | number | boolean> }): Promise<IndexMatch[]> {
    const t0 = Date.now();
    const kind = typeof opts.filter?.kind === 'string' ? opts.filter.kind : null;
    const q = Float32Array.from(vector);
    const top: { i: number; s: number }[] = [];
    const consider = (i: number, s: number) => {
      if (top.length < opts.topK) {
        top.push({ i, s });
        if (top.length === opts.topK) top.sort((a, b) => a.s - b.s);
      } else if (s > top[0]!.s) {
        top[0] = { i, s };
        for (let k = 0; k + 1 < top.length && top[k]!.s > top[k + 1]!.s; k++) [top[k], top[k + 1]] = [top[k + 1]!, top[k]!];
      }
    };
    const rows = kind ? (this.byKind.get(kind) ?? new Int32Array(0)) : Int32Array.from(this.rows.keys());
    const V = this.values;
    for (const i of rows) {
      const o = i * DIMS;
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      for (let d = 0; d < DIMS; d += 4) {
        s0 += V[o + d]! * q[d]!;
        s1 += V[o + d + 1]! * q[d + 1]!;
        s2 += V[o + d + 2]! * q[d + 2]!;
        s3 += V[o + d + 3]! * q[d + 3]!;
      }
      consider(i, s0 + s1 + s2 + s3);
    }
    const out: IndexMatch[] = top.map(({ i, s }) => {
      const r = this.rows[i]!;
      return { id: r.id, score: s, metadata: { token: r.token, kind: r.kind, lang: r.lang, label: r.label, source: r.source } };
    });
    // Minted labels (the side list), the same filter.
    for (const v of this.extra.values()) {
      if (kind && v.metadata.kind !== kind) continue;
      let s = 0;
      for (let d = 0; d < DIMS; d++) s += v.values[d]! * q[d]!;
      out.push({ id: v.id, score: s, metadata: { ...v.metadata } });
    }
    this.queries.count++;
    this.queries.ms += Date.now() - t0;
    return out.sort((a, b) => b.score - a.score).slice(0, opts.topK);
  }

  async upsert(vectors: IndexVector[]): Promise<void> {
    for (const v of vectors) this.extra.set(v.id, v);
  }

  async deleteByIds(ids: string[]): Promise<void> {
    for (const id of ids) this.extra.delete(id);
  }
}

/** ESCO's and the US layer's SQL (the import files the founder loads into D1) into node:sqlite. */
export async function loadReplica(escoSql: string, usSql: string) {
  const db = sqliteD1();
  const files = (dir: string, re: RegExp) =>
    readdirSync(dir)
      .filter((f) => re.test(f))
      .sort()
      .map((f) => join(dir, f));
  db.sqlite.exec('PRAGMA foreign_keys = OFF');
  let statements = 0;
  for (const f of [...files(escoSql, /^registry-\d{3}\.sql$/), ...files(usSql, /^national-\d{3}\.sql$/)]) {
    const sql = readFileSync(f, 'utf8');
    db.sqlite.exec(sql);
    statements += (sql.match(/^INSERT /gm) ?? []).length;
  }
  db.sqlite.exec('PRAGMA foreign_keys = ON');
  const store = new D1RegistryStore(db.d1);
  const tokens = (db.sqlite.prepare('SELECT COUNT(*) AS n FROM registry_tokens').get() as { n: number }).n;
  const labels = (db.sqlite.prepare('SELECT COUNT(*) AS n FROM registry_labels').get() as { n: number }).n;
  return { db, store, statements, tokens, labels };
}

// ── Vectors, as the phone makes them ──────────────────────────────────────

/** Every distinct text embedded once per role, in runs of 2,000, read back by text. */
export function embedAll(texts: Iterable<string>, role: 'query' | 'document'): Map<string, number[]> {
  const all = [...new Set([...texts].map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean))];
  const out = new Map<string, number[]>();
  for (let i = 0; i < all.length; i += 2_000) {
    const batch = all.slice(i, i + 2_000);
    llamaEmbed(MODEL, batch, role).forEach((v, j) => out.set(batch[j]!, v));
    process.stdout.write(`${role}: ${Math.min(i + 2_000, all.length)} of ${all.length}\n`);
  }
  return out;
}
