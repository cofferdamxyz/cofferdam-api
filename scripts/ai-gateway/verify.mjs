// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Read the plane's AI Gateways back and fail on any setting that could store
 * user content, that departs from the gateway's class (DLP Block on the
 * strict one, none on the documents one) or that leaves authentication off.
 * Prints the proof table; exit 1 on a violation or a missing gateway.
 *
 *   cd cofferdam-api && direnv exec .. node scripts/ai-gateway/verify.mjs [--allow-no-dlp]
 *
 * Needs CLOUDFLARE_ACCOUNT_ID and a token with AI Gateway Read.
 */

import { credentials, getGateway, readSpec, summary, table, violations } from './common.mjs';

const allowNoDlp = process.argv.includes('--allow-no-dlp');
const creds = credentials();
const spec = readSpec();
const rows = [];
let failed = false;
for (const g of spec.gateways) {
  const live = await getGateway(creds, g.id);
  if (!live) {
    console.log(`${g.id}: missing`);
    failed = true;
    continue;
  }
  rows.push(summary(live));
  const bad = violations(g, live).filter((v) => !(allowNoDlp && v.startsWith('dlp.')));
  if (bad.length) {
    console.log(`${g.id}: violations:\n - ${bad.join('\n - ')}`);
    failed = true;
  }
}
if (rows.length) console.log(table(rows));
console.log(failed ? 'FAIL: a gateway could store, departs from the spec, or is missing' : 'OK: no gateway can store user content');
process.exit(failed ? 1 : 0);
