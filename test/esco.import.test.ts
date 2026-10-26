// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one-time ESCO import (workspace decision 0018), run from the Mac
 * (opt-in: ESCO_IMPORT=1). Reads the ESCO classification CSVs the founder
 * downloaded (esco.ec.europa.eu, Use ESCO, Download: classification, CSV, one
 * download per language), plans the registry rows (`services/work/esco.ts`),
 * embeds every label with bge-m3 over the Workers AI REST API, and writes:
 *
 *   <ESCO_OUT>/registry-001.sql, …     → wrangler d1 execute cofferdam-work --remote --yes --file=registry-001.sql (each, in order)
 *   <ESCO_OUT>/vectors-001.ndjson, …   → wrangler vectorize upsert token-registry-v1 --file=vectors-001.ndjson (each, after the SQL)
 *
 *   cd cofferdam-api && ESCO_IMPORT=1 ESCO_DIR=~/Development/esco direnv exec .. yarn vitest run test/esco.import.test.ts
 *
 * One file at a time, never the SQL and the vectors together (a busy uplink
 * makes wrangler fail with "fetch failed"); a file that fails can go again,
 * since the SQL inserts nothing twice and an upsert overwrites by id.
 *
 * ESCO_DIR holds occupations_<lang>.csv and skills_<lang>.csv for the
 * languages in ESCO_LANGS (default en,pt,es; English is required).
 * ESCO_SKILLS=0 imports occupations only, ESCO_HIDDEN=0 leaves the hidden
 * labels out. Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI
 * run). Nothing is written to Cloudflare by this run: the founder loads the
 * files after creating `cofferdam-work`, applying its migrations, and creating
 * `token-registry-v1` with its `kind` metadata index (wrangler.jsonc).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInference } from '../src/services/inference/index.js';
import { ESCO_LANGS, planEscoImport, registrySqlFiles, vectorLine, type EscoFiles, type EscoLang } from '../src/services/work/esco.js';
import { embedTexts } from '../src/services/work/registry.js';
import { createRestAi } from './chat-eval/restAi.js';

const RUN = process.env.ESCO_IMPORT === '1';
/** Labels per bge-m3 call, and vectors per NDJSON file (about 49 MB, far below Vectorize's 100 MB upload; about three minutes a file on 2026-10-24). */
const BATCH = 100;
const PER_FILE = 5_000;
const PARALLEL = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RUN)('ESCO import (opt-in, from the Mac)', () => {
  it('plans the import, embeds every label and writes the files wrangler loads', async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const dir = (process.env.ESCO_DIR ?? '').replace(/^~(?=\/)/, homedir());
    if (!accountId || !token || !dir) throw new Error('ESCO_IMPORT needs ESCO_DIR, CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    const out = (process.env.ESCO_OUT ?? join(dir, 'cofferdam-import')).replace(/^~(?=\/)/, homedir());
    mkdirSync(out, { recursive: true });
    const langs = (process.env.ESCO_LANGS ?? ESCO_LANGS.join(','))
      .split(',')
      .map((l) => l.trim())
      .filter((l): l is EscoLang => (ESCO_LANGS as readonly string[]).includes(l));
    const read = (pillar: string) => {
      const files: Partial<Record<EscoLang, string>> = {};
      for (const lang of langs) {
        const path = join(dir, `${pillar}_${lang}.csv`);
        if (existsSync(path)) files[lang] = readFileSync(path, 'utf8');
      }
      return files;
    };
    const files: EscoFiles = { occupations: read('occupations'), ...(process.env.ESCO_SKILLS === '0' ? {} : { skills: read('skills') }) };
    const plan = await planEscoImport(files, { hidden: process.env.ESCO_HIDDEN !== '0' });
    console.log(`plan: ${JSON.stringify(plan.counts)}`);
    // A previous run's numbered files would load beside this run's.
    for (const f of readdirSync(out)) if (/^(registry-\d{3}\.sql|vectors-\d{3}\.ndjson)$/.test(f)) rmSync(join(out, f));
    const sqlFiles = registrySqlFiles(plan, Date.now());
    sqlFiles.forEach((text, i) => writeFileSync(join(out, `registry-${String(i + 1).padStart(3, '0')}.sql`), text));

    const inference = createInference({}, { ai: createRestAi({ accountId, token }) })!;
    const tokens = new Map(plan.tokens.map((t) => [t.token, t]));
    const batches: { from: number; labels: typeof plan.labels }[] = [];
    for (let i = 0; i < plan.labels.length; i += BATCH) batches.push({ from: i, labels: plan.labels.slice(i, i + BATCH) });
    const lines: string[] = new Array<string>(plan.labels.length);
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < batches.length) {
        const b = batches[next++]!;
        let attempt = 0;
        for (;;) {
          const e = await embedTexts(inference, b.labels.map((l) => l.label), { role: 'document' });
          if (e.ok) {
            e.vectors.forEach((v, j) => (lines[b.from + j] = vectorLine(b.labels[j]!, tokens.get(b.labels[j]!.token)!, v)));
            break;
          }
          if (++attempt >= 4) throw new Error(`bge-m3 failed four times at label ${b.from}`);
          await sleep(1_000 * 2 ** attempt);
        }
        done += b.labels.length;
        if (done % 10_000 < BATCH) console.log(`embedded ${done} of ${plan.labels.length}`);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));

    const names: string[] = [];
    for (let i = 0; i < lines.length; i += PER_FILE) {
      const name = `vectors-${String(i / PER_FILE + 1).padStart(3, '0')}.ndjson`;
      writeFileSync(join(out, name), lines.slice(i, i + PER_FILE).join('\n') + '\n');
      names.push(name);
    }
    console.log(
      [
        `wrote ${sqlFiles.length} SQL files (${plan.tokens.length} tokens, ${plan.labels.length} labels) and ${names.length} vector files to ${out}`,
        'load them one file at a time, the SQL first, after the resources exist (runbook: docs/runbooks/cloudflare-deploys.md, Cofferdam Work resources):',
        `  for f in ${out}/registry-[0-9][0-9][0-9].sql; do wrangler d1 execute cofferdam-work --remote --yes --file="$f" || break; done`,
        `  for f in ${out}/vectors-[0-9][0-9][0-9].ndjson; do wrangler vectorize upsert token-registry-v1 --file="$f" || break; done`,
        'a file that fails can go again: the SQL inserts nothing twice, and an upsert overwrites by id',
      ].join('\n'),
    );
    expect(lines.filter(Boolean)).toHaveLength(plan.labels.length);
  }, 3 * 60 * 60 * 1000);
});
