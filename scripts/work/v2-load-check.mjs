// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The v2 load's check (workspace runbook, Cloudflare deploys, "The v2
 * generation"; decision 0068): after the founder loads the 46 files into
 * `token-registry-v2`, the live index must answer as the Mac's copy of the
 * same files does.
 *
 *   cd cofferdam-api && direnv exec .. node scripts/work/v2-load-check.mjs \
 *     [--phone <embeddings-<device>.json> --plan <the embed check's folder>] [--n 50] [--dir <v2 folder>] [--dry-run]
 *
 * Vectorize scores a query approximately unless the query sets
 * `returnValues: true` (its docs, "Control over scoring precision and query
 * accuracy"), and the plane's queries do not. So each check asks twice: with
 * exact scores, which must answer as the copy does (a vector missing or
 * wrong fails), and as the plane asks (approximate scores, metadata `all`,
 * the 20 nearest of a kind), whose distance from the exact scores is
 * reported and never fails: τ and the tier-2 floor were set on exact
 * cosines, and what the plane does about the gap is the founder's ruling.
 *
 * 1. The count: Vectorize's `vectorCount` against the files' lines (229,654;
 *    D1's embedded labels are the runbook's own check).
 * 2. Labels: `--n` labels drawn across every file, each asked by its own
 *    stored vector: the exact nearest must be that label, or one with the
 *    same text (so the same vector), at a cosine of at least 0.9999.
 * 3. Phone vectors: `--n` claim queries a phone made in the embed check
 *    (`test/workEmbedPhone.eval.test.ts`; its plan folder gives each claim's
 *    kind), each asked of the live index and of the Mac's copy, the ten
 *    nearest of its kind: the exact nearest must be the same label, and the
 *    ten must share at least eight (Vectorize's search is approximate, the
 *    copy's exact), their scores within 0.0001. As the plane asks, it counts
 *    the claims whose nearest token, or side of τ (0.96, 0.81) and the 0.65
 *    floor, differs from the copy's.
 *
 * Reads the Mac's copy from the replica's cache (`<dir>/bench-cache/v2-768.*`,
 * which `test/work-eval/replica.ts` writes). Needs CLOUDFLARE_ACCOUNT_ID and
 * CLOUDFLARE_API_TOKEN (the workspace's .envrc); prints counts and scores
 * only, never the token. `--dry-run` asks the Mac's copy in place of the live
 * index, to check the script itself. Exits 1 when an exact check fails.
 */

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIMS = 768;
const INDEX = 'token-registry-v2';
const EXPECTED = 229_654;
/** v2's τ (registry.ts `DEFAULT_TAU_BY_MODEL`) and tier-2 floor (recall.ts `TIER2_FLOOR_BY_MODEL`). */
const THRESHOLDS = [0.96, 0.81, 0.65];
/** The plane's registry query: a snap's 20 nearest of a kind (registry.ts). */
const PLANE_TOP_K = 20;

/** `--name value` or `--name=value`; '' when the flag is there without a value, undefined when it is not there. */
function option(name) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}
const home = (p) => p?.replace(/^~(?=\/)/, homedir());
const dir = home(option('dir') || '~/Development/esco/import/registry-embeddinggemma-2-litert');
const n = Number(option('n') || '50');
const phoneFile = home(option('phone'));
const planDir = home(option('plan'));
const dryRun = process.argv.includes('--dry-run');
if (!Number.isInteger(n) || n < 1 || ['n', 'dir', 'phone', 'plan'].some((x) => option(x) === '') || !phoneFile !== !planDir) {
  console.error('usage: v2-load-check.mjs [--phone <embeddings-<device>.json> --plan <folder>] [--n 50] [--dir <v2 folder>] [--dry-run]');
  process.exit(2);
}

// The Mac's copy.
const rows = JSON.parse(readFileSync(join(dir, 'bench-cache', 'v2-768.meta.json'), 'utf8'));
const buf = readFileSync(join(dir, 'bench-cache', 'v2-768.f32'));
const values = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
if (values.length !== rows.length * DIMS) throw new Error('the replica cache does not match its metadata');
const vectorAt = (i) => values.subarray(i * DIMS, (i + 1) * DIMS);
const rowById = new Map(rows.map((r, i) => [r.id, i]));
/** A label's text as embedded: labels of one text share one vector, which Vectorize lists in no set order. */
const textKey = (label) => label.replace(/\s+/g, ' ').trim();
const keyOf = (id) => {
  const i = rowById.get(id);
  return i == null ? `?${id}` : textKey(rows[i].label);
};
const byScore = (matches) => [...matches].sort((a, b) => b.score - a.score);

/** The copy's `topK` nearest of a kind, exact. */
function copyQuery(q, kind, topK) {
  const top = [];
  for (let i = 0; i < rows.length; i++) {
    if (kind && rows[i].kind !== kind) continue;
    const v = vectorAt(i);
    let s = 0;
    for (let d = 0; d < DIMS; d++) s += v[d] * q[d];
    if (top.length < topK || s > top[top.length - 1].score) {
      top.push({ id: rows[i].id, token: rows[i].token, score: s });
      top.sort((a, b) => b.score - a.score);
      if (top.length > topK) top.pop();
    }
  }
  return top;
}

// The live index, over Cloudflare's REST API.
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!dryRun && (!account || !token)) {
  console.error('needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (direnv exec ..)');
  process.exit(2);
}
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/vectorize/v2/indexes/${INDEX}`;
async function api(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) throw new Error(`${path || '/'} answered ${res.status}: ${JSON.stringify(json?.errors ?? json).slice(0, 300)}`);
  return json.result;
}
/** Exact: `returnValues` makes Vectorize score with the stored values. */
async function exactQuery(q, kind, topK) {
  if (dryRun) return copyQuery(q, kind, topK);
  const result = await api('/query', { vector: Array.from(q), topK, returnValues: true, returnMetadata: 'none', ...(kind ? { filter: { kind } } : {}) });
  return byScore(result.matches.map((m) => ({ id: m.id, token: rows[rowById.get(m.id)]?.token, score: m.score })));
}
/** As the plane asks (registry.ts `vectorizeIndex`): approximate scores. */
async function planeQuery(q, kind) {
  if (dryRun) return copyQuery(q, kind, PLANE_TOP_K);
  const result = await api('/query', { vector: Array.from(q), topK: PLANE_TOP_K, returnMetadata: 'all', ...(kind ? { filter: { kind } } : {}) });
  return byScore(result.matches.map((m) => ({ id: m.id, token: m.metadata?.token, score: m.score })));
}

let failures = 0;
const fail = (line) => {
  failures++;
  console.log(`FAIL ${line}`);
};
const side = (s) => THRESHOLDS.filter((t) => s >= t).length;
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
/** |approximate − exact| for every id both answers hold. */
function gapsOf(plane, exact, into) {
  const exactScore = new Map(exact.map((m) => [m.id, m.score]));
  for (const m of plane) if (exactScore.has(m.id)) into.push(Math.abs(m.score - exactScore.get(m.id)));
}
const gapLine = (gaps) => `off the exact by up to ${Math.max(0, ...gaps).toFixed(5)} (median ${median(gaps).toFixed(5)}, ${gaps.length} matches)`;

// 1. The count.
if (dryRun) console.log(`count: (dry run) the copy holds ${rows.length}`);
else {
  const info = await api('/info');
  const count = info.vectorCount;
  console.log(`count: ${INDEX} holds ${count} vectors, the files ${rows.length} (expected ${EXPECTED}), processed up to ${info.processedUpToDatetime ?? '?'}`);
  if (count < rows.length) fail(`the index holds ${rows.length - count} fewer vectors than the files: the load is not complete, or Vectorize has not processed it yet`);
}

// 2. Labels by their own vectors, drawn across every file (a stride, so the same labels each run).
const textOf = new Map();
rows.forEach((r) => {
  const t = textKey(r.label);
  (textOf.get(t) ?? textOf.set(t, new Set()).get(t)).add(r.id);
});
let labelsOk = 0;
let labelsPlaneFirst = 0;
const labelGaps = [];
for (let k = 0; k < n; k++) {
  const i = Math.floor(((k + 0.5) * rows.length) / n);
  const r = rows[i];
  const same = textOf.get(textKey(r.label));
  const exact = await exactQuery(vectorAt(i), r.kind, 10);
  const top = exact[0];
  if (top && same.has(top.id) && top.score >= 0.9999) labelsOk++;
  else fail(`label row ${i} (${r.kind}): the nearest is ${top ? `${same.has(top.id) ? 'itself' : 'another label'} at ${top.score.toFixed(6)}` : 'nothing'}`);
  const plane = await planeQuery(vectorAt(i), r.kind);
  if (plane[0] && same.has(plane[0].id)) labelsPlaneFirst++;
  gapsOf(plane, exact, labelGaps);
}
console.log(`labels: ${labelsOk} of ${n} come back as themselves`);
console.log(`labels as the plane asks: ${labelsPlaneFirst} of ${n} first; approximate scores ${gapLine(labelGaps)}`);

// 3. Phone vectors against the copy, compared by text: labels of one text share a vector and tie in any order.
if (phoneFile) {
  const phone = JSON.parse(readFileSync(phoneFile, 'utf8'));
  const meta = new Map(JSON.parse(readFileSync(join(planDir, 'meta.json'), 'utf8')).map((m) => [m.id, m]));
  const claims = (phone.items ?? []).filter((it) => it.vector && meta.get(it.id)?.set === 'claim' && it.role === 'query');
  const m = Math.min(n, claims.length);
  const picked = Array.from({ length: m }, (_, k) => claims[Math.floor(((k + 0.5) * claims.length) / m)]);
  if (!picked.length) fail(`${phoneFile} holds no claim query vector for the plan in ${planDir}: nothing to compare`);
  let same = 0;
  let worstOverlap = 10;
  let worstDiff = 0;
  let tokenFlips = 0;
  let sideFlips = 0;
  let sideFlipsAtEdge = 0;
  const phoneGaps = [];
  for (const it of picked) {
    const b = Buffer.from(it.vector, 'base64');
    if (b.length !== DIMS * 4) {
      fail(`${it.id}: the phone's vector holds ${b.length / 4} values, not ${DIMS}`);
      continue;
    }
    const q = Float32Array.from({ length: DIMS }, (_, d) => b.readFloatLE(d * 4));
    const kind = meta.get(it.id).kind === 'cert' ? 'skill' : meta.get(it.id).kind;
    const copy = copyQuery(q, kind, PLANE_TOP_K);
    /** The copy's best score per text among its 20 nearest. */
    const copyByKey = new Map();
    for (const x of copy) if (!copyByKey.has(keyOf(x.id))) copyByKey.set(keyOf(x.id), x.score);
    const exact = await exactQuery(q, kind, 10);
    const shared = exact.filter((x) => copyByKey.has(keyOf(x.id)));
    const diff = Math.max(0, ...shared.map((x) => Math.abs(x.score - copyByKey.get(keyOf(x.id)))));
    const nearestSame = !!exact[0] && !!copy[0] && (keyOf(exact[0].id) === keyOf(copy[0].id) || Math.abs(exact[0].score - copy[0].score) <= 1e-6);
    worstOverlap = Math.min(worstOverlap, shared.length);
    worstDiff = Math.max(worstDiff, diff);
    if (nearestSame && shared.length >= 8 && diff < 0.0001) same++;
    else fail(`${it.id}: nearest ${nearestSame ? 'the same' : 'different'}, ${shared.length} of 10 among the copy's 20 nearest, scores within ${diff.toFixed(5)}`);
    // As the plane asks: a different token counts only when the copy has no tie for it.
    const plane = await planeQuery(q, kind);
    gapsOf(plane, copy, phoneGaps);
    const copyTokenBest = new Map();
    for (const x of copy) if (!copyTokenBest.has(x.token)) copyTokenBest.set(x.token, x.score);
    const tie = plane[0] && copy[0] && Math.abs((copyTokenBest.get(plane[0].token) ?? -Infinity) - copy[0].score) <= 1e-6;
    if (plane[0]?.token !== copy[0]?.token && !tie) tokenFlips++;
    else if (plane[0] && side(plane[0].score) !== side(copy[0].score)) {
      sideFlips++;
      if (THRESHOLDS.some((t) => Math.abs(plane[0].score - t) <= 0.001 && Math.abs(copy[0].score - t) <= 0.001)) sideFlipsAtEdge++;
    }
  }
  console.log(`phone vectors: ${same} of ${picked.length} answer as the copy does (the ten share at least ${worstOverlap}; scores within ${worstDiff.toFixed(5)})`);
  console.log(
    `phone vectors as the plane asks: nearest token differs for ${tokenFlips} of ${picked.length}, side of τ or the floor for ${sideFlips} (${sideFlipsAtEdge} within 0.001 of it); approximate scores ${gapLine(phoneGaps)}`,
  );
}

console.log(failures ? `${failures} checks failed: do not deploy until they pass` : 'the live index answers as the files do');
process.exit(failures ? 1 : 0);
