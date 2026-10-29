// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Create or update the plane's AI Gateways from infra/ai-gateways.json, enable
 * the DLP detectors the spec names in the strict gateway's profiles, then
 * verify. Idempotent: a gateway that exists is updated to the spec, one that
 * does not is created; a profile's enabled entries are set to the spec's list.
 * Prints the privacy-relevant fields before and after, never the token.
 *
 *   cd cofferdam-api && direnv exec .. node scripts/ai-gateway/apply.mjs [--list-profiles] [--no-dlp] [--dry-run]
 *
 * Needs CLOUDFLARE_ACCOUNT_ID and a token with AI Gateway Edit; the strict
 * gateway's DLP profiles need Zero Trust Read to resolve and Zero Trust Edit to
 * enable their detectors, since Cloudflare ships a predefined profile with
 * every entry off. `--list-profiles` prints the account's DLP profiles with
 * each entry's state and exits; `--no-dlp` applies the strict gateway without
 * DLP when the account has none (this script's own check then skips the DLP
 * rules; `verify.mjs` without `--allow-no-dlp` still reports them); `--dry-run`
 * shows what would change.
 */

import { api, credentials, detectors, dlpProfile, dlpProfiles, entryAvailable, gatewayProfileIds, getGateway, readSpec, summary, table, violations } from './common.mjs';

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
  for (const [name, id] of p.byName) {
    console.log(`${id}  ${name}`);
    const d = await dlpProfile(creds, id);
    for (const e of d.profile?.entries ?? []) console.log(`    ${!entryAvailable(e) ? 'n/a' : e.enabled ? 'on ' : 'off'}  ${e.name}`);
  }
  process.exit(0);
}

/** The gateway's profiles read back (id to profile), or null when the token cannot read them. */
async function readProfiles(live) {
  if (!live?.dlp?.enabled) return null;
  const map = new Map();
  for (const id of gatewayProfileIds(live)) {
    const d = await dlpProfile(creds, id);
    if (!d.ok) return null;
    map.set(id, d.profile);
  }
  return map;
}

let failed = false;
for (const g of spec.gateways) {
  const { dlp_profiles: wantProfiles, dlp: wantDlp, ...fields } = g;
  const body = { ...fields };
  const live = await getGateway(creds, g.id);
  console.log(`${g.id}: ${live ? 'exists' : 'absent'}${live ? `\n${table([summary(live, await readProfiles(live))])}` : ''}`);
  let dlpOn = false;
  if (wantDlp?.enabled) {
    const names = Object.keys(wantProfiles ?? {});
    const p = await dlpProfiles(creds);
    const ids = names.map((n) => p.byName.get(n)).filter(Boolean);
    const missing = names.filter((n) => !p.byName.get(n));
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
      // The detectors. Cloudflare ships a predefined profile with every entry off (2026-10-29), so a profile on the
      // gateway detects nothing until its entries are enabled: PUT /dlp/profiles/predefined/<id> with
      // `enabled_entries` (Zero Trust Edit), set to the spec's list exactly.
      for (const name of names) {
        const id = p.byName.get(name);
        if (!id) continue;
        const d = await dlpProfile(creds, id);
        if (!d.ok) {
          console.log(`${g.id}: cannot read DLP profile "${name}": HTTP ${d.status} ${d.codes} (the token needs Zero Trust Read)`);
          failed = true;
          continue;
        }
        const det = detectors(d.profile, wantProfiles[name] ?? []);
        if (det.unknown.length) console.log(`${g.id}: "${name}" has no entry named: ${det.unknown.join(', ')}`);
        if (det.unavailable.length) console.log(`${g.id}: "${name}": not on this plan, left off: ${det.unavailable.join(', ')}`);
        const current = (d.profile.entries ?? []).filter((e) => e.enabled === true).map((e) => e.id).sort();
        const wanted = [...det.wantIds].sort();
        if (JSON.stringify(current) === JSON.stringify(wanted)) {
          console.log(`${g.id}: "${name}": ${wanted.length} detector(s) on, as the spec says`);
          continue;
        }
        if (flag('--dry-run')) {
          console.log(`${g.id}: would PUT /dlp/profiles/predefined/${id} enabled_entries, ${wanted.length} detector(s): ${(wantProfiles[name] ?? []).join(', ')}`);
          continue;
        }
        const r = await api(creds, 'PUT', `/dlp/profiles/predefined/${encodeURIComponent(id)}`, { enabled_entries: wanted });
        if (!r.ok) {
          console.log(`${g.id}: enabling detectors in "${name}" failed: HTTP ${r.status} ${r.codes}${r.status === 403 ? ' (the token needs Zero Trust Edit)' : ''}`);
          failed = true;
          continue;
        }
        console.log(`${g.id}: "${name}": ${wanted.length} detector(s) on (${det.off.length} turned on now)`);
      }
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
  const profiles = await readProfiles(after);
  const bad = violations(g, after, profiles).filter((v) => !(flag('--no-dlp') && v.startsWith('dlp.')));
  console.log(`${g.id}: ${live ? 'updated' : 'created'}\n${table([summary(after, profiles)])}`);
  if (bad.length) {
    console.log(`${g.id}: violations:\n - ${bad.join('\n - ')}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
