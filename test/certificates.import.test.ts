// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The curated certificate seed's import (workspace decision 0018), run from
 * the Mac (opt-in: CERT_IMPORT=1), as `esco.import.test.ts` does it for ESCO.
 * Plans the registry rows from `src/services/work/certificates.json`
 * (`services/work/certificates.ts`), embeds every worker's label with bge-m3
 * over the Workers AI REST API, and writes:
 *
 *   <CERT_OUT>/registry-certificates.sql     → wrangler d1 execute cofferdam-work --remote --file=registry-certificates.sql
 *   <CERT_OUT>/vectors-certificates.ndjson   → wrangler vectorize insert token-registry-v1 --file=vectors-certificates.ndjson
 *
 *   cd cofferdam-api && CERT_IMPORT=1 direnv exec .. yarn vitest run test/certificates.import.test.ts
 *
 * CERT_OUT defaults to ~/Downloads/cofferdam-import. Needs CLOUDFLARE_ACCOUNT_ID
 * and CLOUDFLARE_API_TOKEN (Workers AI run). Nothing is written to Cloudflare
 * by this run: the founder loads the files after creating `cofferdam-work`,
 * applying its migrations, and creating `token-registry-v1` with its `kind`
 * metadata index. A second load inserts nothing twice; a label removed from
 * the seed stays in D1 and the index until it is deleted by hand. The hirer's
 * phrases, the levels and the modules are not loaded: the plane reads them
 * from the seed it is deployed with.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createInference } from '../src/services/inference/index.js';
import { certificates, planCertificateImport } from '../src/services/work/certificates.js';
import { registrySql, vectorLine } from '../src/services/work/esco.js';
import { embedTexts } from '../src/services/work/registry.js';
import { createRestAi } from './chat-eval/restAi.js';

const RUN = process.env.CERT_IMPORT === '1';
/** Labels per bge-m3 call. */
const BATCH = 100;

describe.skipIf(!RUN)('certificate seed import (opt-in, from the Mac)', () => {
  it('plans the seed, embeds every label and writes the files wrangler loads', async () => {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !token) throw new Error('CERT_IMPORT needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
    const catalogue = certificates();
    if (catalogue.problems.length) throw new Error(`the seed has problems:\n${catalogue.problems.join('\n')}`);
    const out = (process.env.CERT_OUT ?? join(homedir(), 'Downloads', 'cofferdam-import')).replace(/^~(?=\/)/, homedir());
    mkdirSync(out, { recursive: true });

    const plan = await planCertificateImport(catalogue);
    console.log(`plan: ${JSON.stringify(plan.counts)} (seed ${catalogue.version})`);
    writeFileSync(join(out, 'registry-certificates.sql'), registrySql(plan, Date.now()));

    const inference = createInference({}, { ai: createRestAi({ accountId, token }) })!;
    const tokens = new Map(plan.tokens.map((t) => [t.token, t]));
    const lines: string[] = [];
    for (let i = 0; i < plan.labels.length; i += BATCH) {
      const batch = plan.labels.slice(i, i + BATCH);
      const e = await embedTexts(inference, batch.map((l) => l.label));
      if (!e.ok) throw new Error(`bge-m3 failed at label ${i}`);
      e.vectors.forEach((v, j) => lines.push(vectorLine(batch[j]!, tokens.get(batch[j]!.token)!, v)));
    }
    writeFileSync(join(out, 'vectors-certificates.ndjson'), lines.join('\n') + '\n');
    console.log(
      [
        `wrote ${out}/registry-certificates.sql (${plan.tokens.length} certificates, ${plan.labels.length} labels) and ${out}/vectors-certificates.ndjson`,
        'load them, after the resources exist (wrangler.jsonc, Cofferdam Work):',
        `  wrangler d1 execute cofferdam-work --remote --file=${out}/registry-certificates.sql`,
        `  wrangler vectorize insert token-registry-v1 --file=${out}/vectors-certificates.ndjson`,
      ].join('\n'),
    );
    expect(lines).toHaveLength(plan.labels.length);
  }, 10 * 60 * 1000);
});
