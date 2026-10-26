// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every registry label embedded again for a new `work-embed` model's index
 * (workspace decision 0067, rule 7: EmbeddingGemma into `token-registry-v2`),
 * from the Mac (opt-in: REEMBED=1). Nothing in D1 changes: a label's id is its
 * vector's id whatever the model, so the new index takes the same ids with new
 * values. Writes, for `wrangler vectorize upsert token-registry-v2`, one file
 * at a time:
 *
 *   <REEMBED_OUT>/vectors-v2-001.ndjson, …   (5,000 vectors a file)
 *
 *   cd cofferdam-api && REEMBED=1 WORK_EMBED_MODEL=@cf/google/embeddinggemma-300m ESCO_DIR=~/Development/esco/import ONET_OUT=~/Development/us-layer-data/cofferdam-import direnv exec .. yarn vitest run test/registry.reembed.test.ts
 *
 * The labels, each embedded as a document:
 * - ESCO's, as the import planned them from the files in ESCO_DIR
 *   (occupations and skills, hidden labels included, as loaded 2026-10-24);
 *   `test/registry.tau.test.ts`'s vectors in TAU_CACHE (default
 *   `<ESCO_DIR>/tau-cache`) are reused when they are this model's documents;
 * - the curated certificate seed's (`certificates.json`);
 * - the US layer's, read from its `national-vectors-*.ndjson` in ONET_OUT
 *   (ids and metadata kept, values new).
 *
 * WORK_EMBED_MODEL is required, so the run never writes another model's
 * vectors by mistake. Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
 * (Workers AI run). Nothing is written to Cloudflare by this run.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInference } from '../src/services/inference/index.js';
import { certificates, planCertificateImport } from '../src/services/work/certificates.js';
import { planEscoImport, vectorLine, type EscoLang } from '../src/services/work/esco.js';
import { EMBED_DIMS_BY_MODEL, EMBED_PROMPTS_BY_MODEL, embedTexts } from '../src/services/work/registry.js';
import { createRestAi } from './chat-eval/restAi.js';

const RUN = process.env.REEMBED === '1';
const PER_FILE = 5_000;
const PARALLEL = Number(process.env.REEMBED_PARALLEL ?? 8);

const home = (p: string) => p.replace(/^~(?=\/)/, homedir());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN)('registry labels embedded again for a new model (opt-in, from the Mac)', () => {
  it("embeds ESCO's, the seed's and the US layer's labels as documents and writes the files the new index loads", async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;
    const model = process.env.WORK_EMBED_MODEL;
    const escoDir = home(process.env.ESCO_DIR ?? '');
    const onetOut = home(process.env.ONET_OUT ?? '');
    if (!accountId || !apiToken || !escoDir || !onetOut || !model) throw new Error('REEMBED needs WORK_EMBED_MODEL, ESCO_DIR, ONET_OUT, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    const dims = EMBED_DIMS_BY_MODEL[model];
    if (!dims) throw new Error(`${model} is not in EMBED_DIMS_BY_MODEL`);
    const out = home(process.env.REEMBED_OUT ?? join(escoDir, `registry-${model.split('/').pop()}`));
    mkdirSync(out, { recursive: true });
    const inference = createInference({ WORK_EMBED_MODEL: model }, { ai: createRestAi({ accountId, token: apiToken }) })!;

    /** Texts embedded as documents, 100 a call, PARALLEL calls at once; any failure after six tries stops the run. */
    const embed = async (texts: string[]): Promise<Map<string, number[]>> => {
      const vectors = new Map<string, number[]>();
      const starts: number[] = [];
      for (let i = 0; i < texts.length; i += 100) starts.push(i);
      let next = 0;
      let done = 0;
      const worker = async () => {
        while (next < starts.length) {
          const from = starts[next++]!;
          const batch = texts.slice(from, from + 100);
          for (let attempt = 0; ; attempt++) {
            const e = await embedTexts(inference, batch, { role: 'document' });
            if (e.ok) {
              e.vectors.forEach((v, j) => vectors.set(batch[j]!, v));
              break;
            }
            if (attempt >= 5) throw new Error(`${model} failed six times on a batch starting "${batch[0]}"`);
            await sleep(1_000 * 2 ** attempt);
          }
          done += batch.length;
          if (done % 20_000 < 100 || done === texts.length) process.stdout.write(`embedded ${done} of ${texts.length}\n`);
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      return vectors;
    };

    // ESCO, from the tau run's documents where they are this model's.
    const read = (pillar: string) => {
      const files: Partial<Record<EscoLang, string>> = {};
      for (const lang of ['en', 'pt', 'es'] as const) {
        const path = join(escoDir, `${pillar}_${lang}.csv`);
        if (existsSync(path)) files[lang] = readFileSync(path, 'utf8');
      }
      return files;
    };
    const esco = await planEscoImport({ occupations: read('occupations'), skills: read('skills') });
    const escoVectors = new Map<string, number[]>();
    const cacheDir = home(process.env.TAU_CACHE ?? join(escoDir, 'tau-cache'));
    const prompted = Boolean(EMBED_PROMPTS_BY_MODEL[model]);
    for (const kind of ['pos', 'skill'] as const) {
      const tag = `${model.split('/').pop()}${prompted ? '-prompted' : ''}-${kind}`;
      const textsPath = join(cacheDir, `${tag}.json`);
      const binPath = join(cacheDir, `${tag}.f32`);
      if (!existsSync(textsPath) || !existsSync(binPath)) continue;
      const texts = JSON.parse(readFileSync(textsPath, 'utf8')) as string[];
      const buf = readFileSync(binPath);
      const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      if (all.length !== texts.length * dims) continue;
      texts.forEach((t, i) => escoVectors.set(`${kind}\u0000${t}`, Array.from(all.subarray(i * dims, (i + 1) * dims))));
    }
    const kindOf = (token: string) => (token.startsWith('pos:') ? 'pos' : 'skill');
    const missing = [...new Set(esco.labels.filter((l) => !escoVectors.has(`${kindOf(l.token)}\u0000${l.label}`)).map((l) => l.label))];
    process.stdout.write(`ESCO: ${esco.labels.length} labels, ${esco.labels.length - esco.labels.filter((l) => !escoVectors.has(`${kindOf(l.token)}\u0000${l.label}`)).length} from the cache, ${missing.length} texts to embed\n`);
    const fresh = await embed(missing);
    const tokens = new Map(esco.tokens.map((t) => [t.token, t]));
    const lines: string[] = esco.labels.map((l) => vectorLine(l, tokens.get(l.token)!, escoVectors.get(`${kindOf(l.token)}\u0000${l.label}`) ?? fresh.get(l.label)!));

    // The certificate seed.
    const seed = await planCertificateImport(certificates());
    const seedTokens = new Map(seed.tokens.map((t) => [t.token, t]));
    const seedVectors = await embed([...new Set(seed.labels.map((l) => l.label))]);
    lines.push(...seed.labels.map((l) => vectorLine(l, seedTokens.get(l.token)!, seedVectors.get(l.label)!)));

    // The US layer: its ids and metadata, new values.
    const national: { id: string; metadata: { label: string } }[] = [];
    for (const f of readdirSync(onetOut).filter((f) => /^national-vectors-\d{3}\.ndjson$/.test(f)).sort())
      for (const line of readFileSync(join(onetOut, f), 'utf8').split('\n')) if (line) national.push(JSON.parse(line) as { id: string; metadata: { label: string } });
    const nationalVectors = await embed([...new Set(national.map((n) => n.metadata.label))]);
    const nationalLines = national.map((n) => JSON.stringify({ id: n.id, values: nationalVectors.get(n.metadata.label)!.map((v) => Math.round(v * 1e6) / 1e6), metadata: n.metadata }));
    lines.push(...nationalLines);
    // The US layer's new vectors on their own too, in its files' names, for `test/onet.eval.test.ts` on this model (ONET_OUT=<REEMBED_OUT>/us-layer).
    const usDir = join(out, 'us-layer');
    mkdirSync(usDir, { recursive: true });
    for (const f of readdirSync(usDir)) if (/^national-vectors-\d{3}\.ndjson$/.test(f)) rmSync(join(usDir, f));
    for (let i = 0; i < nationalLines.length; i += PER_FILE)
      writeFileSync(join(usDir, `national-vectors-${String(i / PER_FILE + 1).padStart(3, '0')}.ndjson`), nationalLines.slice(i, i + PER_FILE).join('\n') + '\n');

    const ids = new Set([...esco.labels.map((l) => l.labelId), ...seed.labels.map((l) => l.labelId), ...national.map((n) => n.id)]);
    if (ids.size !== lines.length) throw new Error(`${lines.length - ids.size} vector ids repeat`);
    const sizes = new Set([...escoVectors.values(), ...fresh.values(), ...seedVectors.values(), ...nationalVectors.values()].map((v) => v.length));
    if (sizes.size !== 1 || !sizes.has(dims)) throw new Error(`vector sizes ${[...sizes].join(', ')}, not ${dims}`);
    for (const f of readdirSync(out)) if (/^vectors-v2-\d{3}\.ndjson$/.test(f)) rmSync(join(out, f));
    const names: string[] = [];
    for (let i = 0; i < lines.length; i += PER_FILE) {
      const name = `vectors-v2-${String(i / PER_FILE + 1).padStart(3, '0')}.ndjson`;
      writeFileSync(join(out, name), lines.slice(i, i + PER_FILE).join('\n') + '\n');
      names.push(name);
    }
    process.stdout.write(
      [
        `wrote ${lines.length} vectors (${esco.labels.length} ESCO, ${seed.labels.length} certificate seed, ${national.length} US layer; ${model}, ${dims} dimensions) in ${names.length} files to ${out}`,
        'load them one file at a time into the new index (runbook: docs/runbooks/cloudflare-deploys.md, Cofferdam Work resources):',
        `  for f in ${out}/vectors-v2-[0-9][0-9][0-9].ndjson; do wrangler vectorize upsert token-registry-v2 --file="$f" || break; done`,
      ].join('\n') + '\n',
    );
    expect(names.length).toBe(Math.ceil(lines.length / PER_FILE));
  }, 3 * 60 * 60 * 1000);
});
