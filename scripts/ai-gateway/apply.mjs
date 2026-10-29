// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Create or update the plane's AI Gateways from infra/ai-gateways.json, then
 * verify them. Idempotent: a gateway that exists is updated to the spec, one
 * that does not is created. Prints the privacy-relevant fields before and
 * after, never the token.
 *
 *   cd cofferdam-api && direnv exec .. node scripts/ai-gateway/apply.mjs [--list-profiles] [--no-dlp] [--dry-run]
 *
 * Needs CLOUDFLARE_ACCOUNT_ID and a token with AI Gateway Edit; the strict
 * gateway's DLP profiles need Zero Trust DLP Read as well. `--list-profiles`
 * prints the account's DLP profiles (name and id) and exits; `--no-dlp`
 * applies the strict gateway without DLP when the account has none (this
 * script's own check then skips the DLP rule; `verify.mjs` without
 * `--allow-no-dlp` still reports it); `--dry-run` shows what would change.
 */

import { credentials, dlpProfiles, getGateway, api, readSpec, summary, table, violations } from './common.mjs';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const creds = credentials();
const spec = readSpec();

if (flag('--list-profiles')) {
  const p = await dlpProfiles(creds);
  if (!p.ok) {
    console.log(`DLP profiles: HTTP ${p.status} ${p.codes}`);
    process.exit(1);
  }
  for (const [name, id] of p.byName) console.log(`${id}  ${name}`);
  process.exit(0);
}

let failed = false;
for (const g of spec.gateways) {
  const { dlp_profile_names: names, dlp: wantDlp, ...fields } = g;
  const body = { ...fields };
  const live = await getGateway(creds, g.id);
  let dlpOn = false;
  if (wantDlp?.enabled) {
    const p = await dlpProfiles(creds);
    const ids = (names ?? []).map((n) => p.byName.get(n)).filter(Boolean);
    const missing = (names ?? []).filter((n) => !p.byName.get(n));
    if (!p.ok || !ids.length) {
      if (!flag('--no-dlp')) {
        console.log(`${g.id}: cannot resolve DLP profiles (${p.ok ? `none of ${JSON.stringify(names)} exists; run --list-profiles` : `HTTP ${p.status} ${p.codes}`}); pass --no-dlp to apply without DLP`);
        failed = true;
        continue;
      }
    } else {
      if (missing.length) console.log(`${g.id}: DLP profiles not found, left out: ${missing.join(', ')}`);
      body.dlp = { action: wantDlp.action ?? 'BLOCK', enabled: true, profiles: ids };
      dlpOn = true;
    }
  }
  // DLP off: the API refuses `{ enabled: false }` on its own (7001 on body.dlp, 2026-10-29), so a create leaves the
  // field out, and an update that turns DLP off repeats the live shape with `enabled: false`.
  if (!dlpOn) {
    if (live?.dlp?.enabled === true) {
      body.dlp = Array.isArray(live.dlp.policies) ? { enabled: false, policies: live.dlp.policies } : { action: live.dlp.action ?? 'BLOCK', enabled: false, profiles: live.dlp.profiles ?? [] };
    } else {
      delete body.dlp;
    }
  }
  console.log(`${g.id}: ${live ? 'exists' : 'absent'}${live ? `\n${table([summary(live)])}` : ''}`);
  if (flag('--dry-run')) {
    console.log(`would ${live ? 'PUT' : 'POST'} ${JSON.stringify(body)}`);
    continue;
  }
  const r = live ? await api(creds, 'PUT', `/ai-gateway/gateways/${encodeURIComponent(g.id)}`, body) : await api(creds, 'POST', '/ai-gateway/gateways', body);
  if (!r.ok) {
    console.log(`${g.id}: ${live ? 'update' : 'create'} failed: HTTP ${r.status} ${r.codes}`);
    failed = true;
    continue;
  }
  const after = await getGateway(creds, g.id);
  const bad = violations(g, after).filter((v) => !(flag('--no-dlp') && v.startsWith('dlp.')));
  console.log(`${g.id}: ${live ? 'updated' : 'created'}\n${table([summary(after)])}`);
  if (bad.length) {
    console.log(`${g.id}: violations:\n - ${bad.join('\n - ')}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
