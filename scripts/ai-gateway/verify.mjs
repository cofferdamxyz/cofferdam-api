// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Read the plane's AI Gateways back and fail on any setting that could store
 * user content, that departs from the gateway's class (DLP Block on the
 * strict one, none on the documents one), that leaves authentication off, or
 * that leaves a DLP profile on the strict gateway without the detectors the
 * spec names (Cloudflare ships every entry off). Prints the proof table; exit 1
 * on a violation or a missing gateway.
 *
 *   cd cofferdam-api && direnv exec .. node scripts/ai-gateway/verify.mjs [--allow-no-dlp]
 *
 * Needs CLOUDFLARE_ACCOUNT_ID and a token with AI Gateway Read and Zero Trust
 * Read (the profiles).
 */

import { credentials, dlpProfile, gatewayProfileIds, getGateway, readSpec, summary, table, violations } from './common.mjs';

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
  let profiles = null;
  if (live.dlp?.enabled) {
    profiles = new Map();
    for (const id of gatewayProfileIds(live)) {
      const d = await dlpProfile(creds, id);
      if (!d.ok) {
        console.log(`${g.id}: DLP profile ${id} could not be read: HTTP ${d.status} ${d.codes} (the token needs Zero Trust Read)`);
        profiles = null;
        break;
      }
      profiles.set(id, d.profile);
    }
  }
  rows.push(summary(live, profiles));
  const bad = violations(g, live, profiles).filter((v) => !(allowNoDlp && v.startsWith('dlp.')));
  if (bad.length) {
    console.log(`${g.id}: violations:\n - ${bad.join('\n - ')}`);
    failed = true;
  }
}
if (rows.length) console.log(table(rows));
console.log(failed ? 'FAIL: a gateway could store, departs from the spec, or is missing' : 'OK: no gateway can store user content, and the strict gateway detects what the spec names');
process.exit(failed ? 1 : 0);
