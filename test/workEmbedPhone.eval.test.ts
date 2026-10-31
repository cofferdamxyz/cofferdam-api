// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The phone-vs-Mac check of the v2 embedder (workspace decision 0068, the
 * open item before the switch), opt-in, from the Mac. The texts and the
 * scoring are `test/work-eval/embedPhone.ts`.
 *
 *   WORK_EMBED_PHONE_PLAN=<dir> yarn vitest run test/workEmbedPhone.eval.test.ts
 *     writes <dir>/plan.json, the app's embed mode (cofferdam-app
 *     `src/lib/localAi/readerBench.ts`), and <dir>/meta.json, the Mac's own.
 *   Push plan.json into each phone's bench folder, run `?bench=run`, and pull
 *   `embeddings.json` back as <dir>/embeddings-<device>.json (workspace
 *   runbooks: device builds, Android build).
 *   WORK_EMBED_PHONE=<dir> yarn vitest run test/workEmbedPhone.eval.test.ts
 *     embeds every text on the Mac with the pinned file (cached in
 *     <dir>/mac.json and mac.f32 under the plan's digest, so a changed plan is
 *     embedded again), compares each phone's vectors with the Mac's and with
 *     each other, and the decisions they feed on the v2 replica, and writes
 *     test/work-eval/embed-phone-<date>.md: counts and scores only, ending with
 *     a verdict per phone. A phone file holding an id or a role the plan does
 *     not (another plan's run) stops the run; one from an older plan with the
 *     same ids scores as failures, since its vectors are other texts'.
 *
 * WORK_EMBED_V2_DIR is the v2 files' folder (default
 * ~/Development/esco/import/registry-embeddinggemma-2-litert), WORK_EMBED_FILE
 * the pinned .litertlm (default ~/models/embeddinggemma-2-litert/).
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { INTENT_MAX_CHARS } from '../src/services/work/intent.js';
import { DRAFT_LIMITS } from '../src/services/work/listings.js';
import { TIER2_FLOOR_BY_MODEL } from '../src/services/work/recall.js';
import { ADJUDICATION_CANDIDATES, DEFAULT_TAU_BY_MODEL, EMBEDDINGGEMMA_2_LITERT, labelLangs, readClientVector } from '../src/services/work/registry.js';
import { macEmbed } from './fixtures/work/registryTools.js';
import {
  buildPlan,
  cosine,
  decodeVector,
  LONG_TEXT_CHARS,
  nearest,
  planDigest,
  sameDecision,
  sameTop,
  snapOf,
  spread,
  stepOf,
  type ReplicaRow,
  type Role,
  type Snap,
  type TextMeta,
} from './work-eval/embedPhone.js';
import { ReplicaIndex } from './work-eval/replica.js';

const MODEL = EMBEDDINGGEMMA_2_LITERT;
const DIMS = 768;
/** Rule (2)'s bar: a phone's vector against the Mac's for the same text. */
const BAR = 0.9998;
const EPS = 0.001;
const home = (p: string) => p.replace(/^~(?=\/)/, homedir());
const PLAN_DIR = process.env.WORK_EMBED_PHONE_PLAN ? home(process.env.WORK_EMBED_PHONE_PLAN) : null;
const SCORE_DIR = process.env.WORK_EMBED_PHONE ? home(process.env.WORK_EMBED_PHONE) : null;
const V2_DIR = home(process.env.WORK_EMBED_V2_DIR ?? '~/Development/esco/import/registry-embeddinggemma-2-litert');
const FILE = home(process.env.WORK_EMBED_FILE ?? '~/models/embeddinggemma-2-litert/embeddinggemma-2-text-270m.litertlm');
const FIXTURES = join(__dirname, 'fixtures', 'work');

/** The replica's rows and regions (`bench-cache`, which `ReplicaIndex.load` writes on its first read). */
function replicaRows(): { rows: ReplicaRow[]; regions: Record<string, string> } {
  const cache = join(V2_DIR, 'bench-cache');
  if (!existsSync(join(cache, 'v2-768.meta.json'))) ReplicaIndex.load(V2_DIR, MODEL);
  return {
    rows: JSON.parse(readFileSync(join(cache, 'v2-768.meta.json'), 'utf8')) as ReplicaRow[],
    regions: JSON.parse(readFileSync(join(cache, 'v2-768.regions.json'), 'utf8')) as Record<string, string>,
  };
}

/** Every text embedded on the Mac, by role, a batch at a time; a batch that fails goes one text at a time, each error kept. */
function macVectors(texts: readonly { id: string; text: string; role: Role }[]): { vectors: Map<string, Float32Array>; errors: Map<string, string> } {
  const vectors = new Map<string, Float32Array>();
  const errors = new Map<string, string>();
  const one = (t: { id: string; text: string; role: Role }) => {
    try {
      vectors.set(t.id, Float32Array.from(macEmbed(MODEL, [t.text], t.role, FILE)[0]!));
    } catch (err) {
      errors.set(t.id, (err instanceof Error ? err.message : String(err)).slice(0, 300));
    }
  };
  for (const role of ['query', 'document'] as const) {
    const mine = texts.filter((t) => t.role === role);
    // A text past the file's 1,024 tokens fails the whole run, so the long ones go alone.
    const long = mine.filter((t) => t.text.length > LONG_TEXT_CHARS);
    const short = mine.filter((t) => t.text.length <= LONG_TEXT_CHARS);
    for (let i = 0; i < short.length; i += 1_000) {
      const batch = short.slice(i, i + 1_000);
      try {
        macEmbed(MODEL, batch.map((t) => t.text), role, FILE).forEach((v, j) => vectors.set(batch[j]!.id, Float32Array.from(v)));
      } catch {
        batch.forEach(one);
      }
      process.stdout.write(`mac ${role} ${Math.min(i + 1_000, short.length)} of ${short.length}\n`);
    }
    long.forEach(one);
  }
  return { vectors, errors };
}

interface PhoneResults {
  device: { model: string | null; os: string | null };
  runtime: { litertLm: string | null };
  cooledMs?: number | null;
  loadMs: number | null;
  error: string | null;
  /** Stopped on the phone before every text or the listing. */
  stopped?: boolean;
  /** The long text being embedded when the file was last written: set in a run that never finished, the text it ended on. */
  inFlight?: string | null;
  items: { id: string; role: Role; ms: number; vector: string | null; error: string | null }[];
  listing: { queries: number; documents: number; ms: number[] } | null;
  finishedAt: string | null;
}

/** One embedder's answers: its vectors, the texts it failed, and (a phone's) the vectors the plane would refuse. */
interface Side {
  name: string;
  vectors: Map<string, Float32Array>;
  errors: Map<string, string>;
}

const fmt = (v: number, d = 6) => (Number.isNaN(v) ? 'NaN' : Number.isFinite(v) ? v.toFixed(d) : '—');
/** A statistic of a spread, or a dash when nothing was compared. */
const stat = (s: { n: number }, v: number, d = 6) => (s.n ? fmt(v, d) : '—');
const pct = (n: number, of: number) => (of ? `${((100 * n) / of).toFixed(1)}%` : '—');
const median = (a: readonly number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};
const p95 = (a: readonly number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(0.95 * s.length))]! : NaN;
};

describe.skipIf(!PLAN_DIR && !SCORE_DIR)('the v2 embedder on the phones against the Mac (opt-in)', () => {
  it.skipIf(!PLAN_DIR)('writes the plan', () => {
    const { rows, regions } = replicaRows();
    const { plan, meta } = buildPlan({ fixtures: FIXTURES, rows, regions });
    writeFileSync(join(PLAN_DIR!, 'plan.json'), JSON.stringify(plan));
    writeFileSync(join(PLAN_DIR!, 'meta.json'), JSON.stringify(meta));
    const bySet = new Map<string, number>();
    for (const m of meta) bySet.set(m.set, (bySet.get(m.set) ?? 0) + 1);
    process.stdout.write(`${meta.length} texts: ${[...bySet].map(([s, n]) => `${s} ${n}`).join(', ')}; digest ${planDigest(plan.embed.texts)}\n`);
    expect(plan.embed.texts.length).toBe(meta.length);
  });

  it.skipIf(!SCORE_DIR)(
    'compares the phones with the Mac and scores the decisions',
    async () => {
      const dir = SCORE_DIR!;
      const plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')) as { embed: { texts: { id: string; text: string; role: Role }[] } };
      const meta = new Map((JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as TextMeta[]).map((m) => [m.id, m]));
      const texts = plan.embed.texts;
      const planned = new Map(texts.map((t) => [t.id, t]));
      const textOf = new Map(texts.map((t) => [t.id, t.text]));
      for (const t of texts) if (meta.get(t.id)?.role !== t.role) throw new Error(`meta.json does not describe plan.json (${t.id}): write the plan again`);

      // The Mac's vectors, cached beside the plan under its digest.
      const digest = planDigest(texts);
      let mac: Side;
      const cached = existsSync(join(dir, 'mac.json')) && existsSync(join(dir, 'mac.f32')) ? (JSON.parse(readFileSync(join(dir, 'mac.json'), 'utf8')) as { digest?: string; ids: string[]; errors: Record<string, string> }) : null;
      if (cached?.digest === digest) {
        const buf = readFileSync(join(dir, 'mac.f32'));
        const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        mac = { name: 'Mac', vectors: new Map(cached.ids.map((id, i) => [id, all.subarray(i * DIMS, (i + 1) * DIMS)])), errors: new Map(Object.entries(cached.errors)) };
      } else {
        mac = { name: 'Mac', ...macVectors(texts) };
        const ids = [...mac.vectors.keys()];
        const all = new Float32Array(ids.length * DIMS);
        ids.forEach((id, i) => all.set(mac.vectors.get(id)!, i * DIMS));
        writeFileSync(join(dir, 'mac.f32'), Buffer.from(all.buffer));
        writeFileSync(join(dir, 'mac.json'), JSON.stringify({ model: MODEL, digest, ids, errors: Object.fromEntries(mac.errors) }));
      }

      // Each phone's vectors, each checked as the plane checks a client's (`readClientVector`).
      const phones = readdirSync(dir)
        .filter((f) => /^embeddings-[a-z0-9-]+\.json$/.test(f))
        .sort()
        .map((f) => {
          const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as PhoneResults;
          const vectors = new Map<string, Float32Array>();
          const errors = new Map<string, string>();
          const refused = new Map<string, string>();
          for (const it of r.items) {
            const t = planned.get(it.id);
            if (!t || t.role !== it.role) throw new Error(`${f}: ${it.id} (${it.role}) is not this plan's: the phone ran another plan`);
            if (it.vector) {
              const v = decodeVector(it.vector);
              const check = readClientVector({ model: MODEL, dims: v.length, values: Array.from(v) }, MODEL);
              if (!check.ok) refused.set(it.id, check.reason);
              vectors.set(it.id, v);
            } else errors.set(it.id, it.error ?? 'no vector');
          }
          const missing = texts.filter((t) => !vectors.has(t.id) && !errors.has(t.id)).length;
          return { name: f.replace(/^embeddings-|\.json$/g, ''), r, vectors, errors, refused, missing };
        });
      expect(phones.length).toBeGreaterThan(0);

      const tau = DEFAULT_TAU_BY_MODEL[MODEL]!;
      const floor = TIER2_FLOOR_BY_MODEL[MODEL]!;
      const thresholds = { auto: tau.auto, low: tau.low };
      const replica = ReplicaIndex.load(V2_DIR, MODEL);
      const rows = JSON.parse(readFileSync(join(V2_DIR, 'bench-cache', 'v2-768.meta.json'), 'utf8')) as ReplicaRow[];
      /** What each phone fails on, for the verdict. */
      const verdict = new Map(phones.map((p) => [p.name, { below: 0, stored: 0, claims: 0, sentences: 0, awkward: 0 }]));
      const lines: string[] = [];
      const date = new Date().toISOString().slice(0, 10);
      lines.push(`# The v2 embedder on the phones against the Mac, ${date}`, '');
      lines.push(
        `Generated by \`test/workEmbedPhone.eval.test.ts\` (texts and scoring: \`test/work-eval/embedPhone.ts\`). ${texts.length} synthetic or public texts, embedded by each phone's app through the reader benchmark's embed mode (cofferdam-app \`readerBench.ts\`: the app's own \`embed\`, the role's prompt and the white space as the app will send them to the Work routes) and by the Mac with the same pinned file (\`${MODEL}\`, LiteRT-LM's Python API on the CPU). Rule (2)'s bar: every phone vector within cosine ${BAR} of the Mac's, and each one a vector the plane takes (\`readClientVector\`: ${DIMS} finite values at unit length). Decisions on the Mac's v2 replica (229,654 labels), as the plane reads the nearest labels at each step: each claim's 20 nearest labels of its kind (a certificate against the skills, since no certificate token has a vector), each token at its best; the best token taken at τ_auto ${tau.auto} on its best score through a label in the claim's language or English, Clef's band from τ_low ${tau.low} with the ${ADJUDICATION_CANDIDATES} tokens it would be shown, and under τ_low nothing the vector chose (the step after reads the string and its English name); each sentence's ten nearest listing texts of set 3 and their side of the tier-2 floor ${floor}, which recall reads on a listing's cosine and no snap reads. A different step passes only when both scores sit within ${EPS} of the threshold between them, a different token or candidate only on a tie within ${EPS}.`,
        '',
      );
      lines.push('## The phones', '');
      lines.push('| Phone | Device | LiteRT-LM | Cooled first, s | Embedder load, ms | Texts | Embedded | Failed (Mac failed too) | Missing | Refused by the plane | Finished | The run |');
      lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
      for (const p of phones) {
        const both = [...p.errors.keys()].filter((id) => mac.errors.has(id)).length;
        // A run's own error (the embedder did not load) or where a run the system ended stopped.
        const run =
          p.r.error ??
          (p.r.stopped
            ? `stopped on the phone after ${p.r.items.length} texts`
            : p.r.finishedAt
              ? p.r.items.length < texts.length
                ? `ended early after ${p.r.items.length} texts`
                : 'ran to the end'
              : p.r.inFlight ? `ended on ${p.r.inFlight} (${textOf.get(p.r.inFlight)?.length ?? '?'} characters)` : `ended after ${p.r.items.length} texts`);
        const cooled = p.r.cooledMs == null ? '—' : fmt(p.r.cooledMs / 1000, 0);
        const refused = p.refused.size ? `${p.refused.size} (${[...new Set(p.refused.values())].join(', ')})` : '0';
        lines.push(
          `| ${p.name} | ${p.r.device.model ?? '—'}, ${p.r.device.os ?? '—'} | ${p.r.runtime.litertLm ?? '—'} | ${cooled} | ${p.r.loadMs ?? '—'} | ${texts.length} | ${p.vectors.size} | ${p.errors.size} (${both}) | ${p.missing} | ${refused} | ${p.r.finishedAt ? 'yes' : 'no'} | ${run.replace(/\|/g, '/')} |`,
        );
      }
      lines.push(`| Mac | | | | | ${texts.length} | ${mac.vectors.size} | ${mac.errors.size} | | | | |`, '');

      // 1. Vectors against the Mac's, by set and role.
      lines.push('## Vectors: each phone against the Mac', '');
      lines.push('Compared: the texts both embedded; the rest of the planned failed on one side or are missing (above).', '');
      lines.push(`| Phone | Set | Role | Planned | Compared | Cosine, least | 0.1th percentile | Median | Below ${BAR} |`);
      lines.push('|---|---|---|---|---|---|---|---|---|');
      const sets = ['label', 'claim', 'listing', 'sentence', 'awkward'] as const;
      let worstAll = 1;
      for (const p of phones) {
        for (const set of sets) {
          for (const role of ['query', 'document'] as const) {
            const mine = texts.filter((t) => meta.get(t.id)?.set === set && t.role === role);
            if (!mine.length) continue;
            const ids = mine.filter((t) => p.vectors.has(t.id) && mac.vectors.has(t.id)).map((t) => t.id);
            const s = spread(ids.map((id) => cosine(p.vectors.get(id)!, mac.vectors.get(id)!)), BAR);
            if (s.n) worstAll = Number.isNaN(s.min) || Number.isNaN(worstAll) ? NaN : Math.min(worstAll, s.min);
            verdict.get(p.name)!.below += s.below;
            lines.push(`| ${p.name} | ${set} | ${role} | ${mine.length} | ${s.n} | ${stat(s, s.min)} | ${stat(s, s.p001)} | ${stat(s, s.median)} | ${s.below} |`);
          }
        }
      }
      lines.push('');
      if (phones.length > 1) {
        lines.push('## Vectors: phone against phone', '');
        lines.push(`| Phones | Compared | Cosine, least | 0.1th percentile | Median | Below ${BAR} |`, '|---|---|---|---|---|---|');
        for (let i = 0; i < phones.length; i++) {
          for (let j = i + 1; j < phones.length; j++) {
            const a = phones[i]!;
            const b = phones[j]!;
            const ids = texts.filter((t) => a.vectors.has(t.id) && b.vectors.has(t.id)).map((t) => t.id);
            const s = spread(ids.map((id) => cosine(a.vectors.get(id)!, b.vectors.get(id)!)), BAR);
            lines.push(`| ${a.name} against ${b.name} | ${s.n} | ${stat(s, s.min)} | ${stat(s, s.p001)} | ${stat(s, s.median)} | ${s.below} |`);
          }
        }
        lines.push('');
      }

      // Set 1: the labels against the stored v2 vectors.
      lines.push('## Labels against the stored v2 vectors', '');
      lines.push(`| Embedder | Planned | Compared | Cosine, least | Median | Below ${BAR} |`, '|---|---|---|---|---|---|');
      const labelIds = texts.filter((t) => meta.get(t.id)?.set === 'label').map((t) => t.id);
      /** A label's stored v2 vector, read from the replica's cache by its row. */
      const fd = openSync(join(V2_DIR, 'bench-cache', 'v2-768.f32'), 'r');
      const storedAt = (row: number) => {
        const buf = Buffer.alloc(DIMS * 4);
        const read = readSync(fd, buf, 0, buf.length, row * DIMS * 4);
        if (read !== buf.length) throw new Error(`the replica cache ends inside row ${row}`);
        return Float32Array.from({ length: DIMS }, (_, i) => buf.readFloatLE(i * 4));
      };
      const storedById = new Map(labelIds.map((id) => [id, storedAt(meta.get(id)!.row!)]));
      closeSync(fd);
      for (const side of [mac, ...phones]) {
        const ids = labelIds.filter((id) => side.vectors.has(id));
        const s = spread(ids.map((id) => cosine(side.vectors.get(id)!, storedById.get(id)!)), BAR);
        if (side !== mac) verdict.get(side.name)!.stored += s.below;
        lines.push(`| ${side.name} | ${labelIds.length} | ${s.n} | ${stat(s, s.min)} | ${stat(s, s.median)} | ${s.below} |`);
      }
      lines.push('');

      // 2. The claims' snaps.
      lines.push('## Decisions: the claims', '');
      lines.push(
        '| Phone | Claims | Compared | Same decision | Other step (passed) | Other token (passed) | Other candidates for Clef (passed) | Failed | In the band on both |',
        '|---|---|---|---|---|---|---|---|---|',
      );
      const claimIds = texts.filter((t) => meta.get(t.id)?.set === 'claim' && t.role === 'query').map((t) => t.id);
      const snap = async (v: Float32Array, m: TextMeta) =>
        snapOf(await replica.query(Array.from(v), { topK: 20, filter: { kind: m.kind === 'cert' ? 'skill' : (m.kind ?? 'skill') } }), labelLangs(m.lang ?? 'en'));
      const macSnaps = new Map<string, Snap>();
      for (const id of claimIds) {
        const v = mac.vectors.get(id);
        const s = v ? await snap(v, meta.get(id)!) : null;
        if (s) macSnaps.set(id, s);
      }
      for (const p of phones) {
        const n = { compared: 0, same: 0, side: 0, sidePassed: 0, token: 0, tokenPassed: 0, candidates: 0, candidatesPassed: 0, failed: 0, band: 0 };
        for (const id of claimIds) {
          const m = macSnaps.get(id);
          const v = p.vectors.get(id);
          if (!m || !v || p.refused.has(id)) continue;
          const s = await snap(v, meta.get(id)!);
          if (!s) continue;
          n.compared++;
          if (stepOf(m, thresholds) === 'band' && stepOf(s, thresholds) === 'band') n.band++;
          const d = sameDecision(m, s, thresholds, EPS);
          if (d.flip == null) n.same++;
          if (d.flip === 'side') {
            n.side++;
            if (d.passed) n.sidePassed++;
          }
          if (d.flip === 'token') {
            n.token++;
            if (d.passed) n.tokenPassed++;
          }
          if (d.flip === 'candidates') {
            n.candidates++;
            if (d.passed) n.candidatesPassed++;
          }
          if (!d.ok) n.failed++;
        }
        verdict.get(p.name)!.claims += n.failed;
        lines.push(
          `| ${p.name} | ${claimIds.length} | ${n.compared} | ${n.same} | ${n.side} (${n.sidePassed}) | ${n.token} (${n.tokenPassed}) | ${n.candidates} (${n.candidatesPassed}) | ${n.failed} | ${n.band} |`,
        );
      }
      const macTaken = [...macSnaps.values()];
      lines.push(
        '',
        `On the Mac's vectors, ${pct(macTaken.filter((s) => stepOf(s, thresholds) === 'auto').length, macTaken.length)} of the claims are taken at τ_auto, ${pct(macTaken.filter((s) => stepOf(s, thresholds) === 'band').length, macTaken.length)} go to Clef's band and ${pct(macTaken.filter((s) => stepOf(s, thresholds) === 'below').length, macTaken.length)} fall under τ_low.`,
        '',
      );

      // 3–4. The sentences' nearest listings.
      lines.push('## Decisions: the sentences against the listing texts', '');
      lines.push('| Phone | Sentences | Compared | Same ten and floor sides | Flips (passed) | Failed |', '|---|---|---|---|---|---|');
      const sentenceIds = texts.filter((t) => meta.get(t.id)?.set === 'sentence').map((t) => t.id);
      const listingIds = texts.filter((t) => meta.get(t.id)?.set === 'listing').map((t) => t.id);
      for (const p of phones) {
        // The listing texts both embedded: one past the 1,024 tokens fails on both.
        const common = listingIds.filter((id) => mac.vectors.has(id) && p.vectors.has(id) && !p.refused.has(id));
        const macDocs = common.map((id) => ({ id, v: mac.vectors.get(id)! }));
        const docs = common.map((id) => ({ id, v: p.vectors.get(id)! }));
        let compared = 0;
        let same = 0;
        let flips = 0;
        let passed = 0;
        let failed = 0;
        for (const id of sentenceIds) {
          const a = mac.vectors.get(id);
          const b = p.vectors.get(id);
          if (!a || !b || p.refused.has(id)) continue;
          compared++;
          const d = sameTop(nearest(a, macDocs, 10), nearest(b, docs, 10), floor, EPS);
          if (!d.flips) same++;
          flips += d.flips;
          passed += d.passed;
          if (!d.ok) failed++;
        }
        verdict.get(p.name)!.sentences += failed;
        lines.push(`| ${p.name} | ${sentenceIds.length} | ${compared} | ${same} | ${flips} (${passed}) | ${failed} |`);
      }
      lines.push('');

      // 5. Awkward texts against their clean forms.
      lines.push('## Awkward texts against their clean forms', '');
      lines.push(
        `Whether a text and its clean form get one vector, on the Mac and on each phone, by change: the least cosine of the pairs, and where the plane takes both and holds them as the same text (a claim: within the draft's ${DRAFT_LIMITS.chars} characters as sent, then NFC, each run of white space one space, trimmed; a sentence: NFC, trimmed, within ${INTENT_MAX_CHARS} characters), how many pairs fall below ${BAR}. Only there must they match.`,
        '',
      );
      const embedders: Side[] = [mac, ...phones];
      lines.push(`| Change | Pairs | The plane: one text | ${embedders.map((e) => `${e.name}: cosine, least (below)`).join(' | ')} |`);
      lines.push(`|---|---|---|${embedders.map(() => '---').join('|')}|`);
      const awkward = texts.filter((t) => meta.get(t.id)?.cleanId).map((t) => meta.get(t.id)!);
      const changes = [...new Set(awkward.map((m) => `${m.change}\u0000${m.planeSame ? 'yes' : 'no'}`))];
      /** Per embedder, the pairs below the bar where the plane holds one text. */
      const awkwardBelow = new Map<string, Set<string>>(embedders.map((e) => [e.name, new Set<string>()]));
      for (const key of changes) {
        const [change, same] = key.split('\u0000') as [string, string];
        const pairs = awkward.filter((m) => m.change === change && (m.planeSame ? 'yes' : 'no') === same);
        const cells = embedders.map((e) => {
          const values = pairs.flatMap((m) => {
            const a = e.vectors.get(m.id);
            const b = e.vectors.get(m.cleanId!);
            return a && b ? [{ id: m.id, c: cosine(a, b) }] : [];
          });
          if (!values.length) return '—';
          const least = fmt(spread(values.map((x) => x.c), BAR).min, 4);
          if (same !== 'yes') return least;
          const below = values.filter((x) => !(x.c >= BAR));
          for (const x of below) awkwardBelow.get(e.name)!.add(x.id);
          return `${least} (${below.length})`;
        });
        lines.push(`| ${change} | ${pairs.length} | ${same} | ${cells.join(' | ')} |`);
      }
      lines.push('');
      // A phone's awkward pair below the bar is the phone's only when the Mac's is not: the rest is the embedder's own.
      for (const p of phones) verdict.get(p.name)!.awkward = [...awkwardBelow.get(p.name)!].filter((id) => !awkwardBelow.get('Mac')!.has(id)).length;
      const notNfc = rows.filter((x) => x.label !== x.label.normalize('NFC')).length;
      lines.push(
        notNfc
          ? `The registry's labels not in NFC: ${notNfc} of ${rows.length}, whose stored vectors would change if text were normalized to NFC before embedding.`
          : `The registry's labels not in NFC: 0 of ${rows.length}, so normalizing to NFC before embedding would change no stored vector.`,
        '',
      );

      // The token limit.
      lines.push("## The embedder's 1,024 tokens", '');
      const lengths = (side: Side) => {
        const failed = [...side.errors.keys()].map((id) => textOf.get(id)!.length);
        const ok = [...side.vectors.keys()].map((id) => textOf.get(id)!.length);
        return { longestOk: Math.max(0, ...ok), shortestFailed: failed.length ? Math.min(...failed) : null, failed: failed.length };
      };
      lines.push('| Embedder | Failed texts | Longest text embedded, characters | Shortest text refused, characters |', '|---|---|---|---|');
      for (const side of embedders) {
        const l = lengths(side);
        lines.push(`| ${side.name} | ${l.failed} | ${l.longestOk} | ${l.shortestFailed ?? '—'} |`);
      }
      const listingFails = listingIds.filter((id) => mac.errors.has(id));
      const listingOk = listingIds.filter((id) => mac.vectors.has(id)).map((id) => textOf.get(id)!.length);
      lines.push(
        '',
        `Listing texts the Mac could not embed: ${listingFails.length} of ${listingIds.length} (the drafts at or near the most \`DRAFT_LIMITS\` allows, ${listingFails.length ? `${Math.min(...listingFails.map((id) => textOf.get(id)!.length))} characters and more` : 'none'}); the longest it embedded holds ${Math.max(0, ...listingOk)} characters.`,
        '',
      );

      // Timing.
      lines.push('## Timing on the phones', '');
      lines.push('| Phone | Set | Texts | Median ms | 95th percentile ms |', '|---|---|---|---|---|');
      for (const p of phones) {
        for (const set of sets) {
          const ms = p.r.items.filter((it) => it.vector && meta.get(it.id)?.set === set).map((it) => it.ms);
          if (ms.length) lines.push(`| ${p.name} | ${set} | ${ms.length} | ${median(ms)} | ${p95(ms)} |`);
        }
      }
      lines.push('', '| Phone | A listing (its claims as queries in one call, then their documents and the listing text) | Runs, ms |', '|---|---|---|');
      for (const p of phones) {
        const l = p.r.listing;
        lines.push(`| ${p.name} | ${l ? `${l.queries} queries and ${l.documents} documents, ${l.queries + l.documents} embeds` : '—'} | ${l?.ms.join(', ') ?? '—'} |`);
      }
      lines.push('');

      // The verdict.
      lines.push('## Verdict', '');
      const summary: string[] = [];
      for (const p of phones) {
        const v = verdict.get(p.name)!;
        const failedOnlyHere = [...p.errors.keys()].filter((id) => !mac.errors.has(id)).length;
        const reasons = [
          p.missing ? `${p.missing} planned texts missing` : '',
          failedOnlyHere ? `${failedOnlyHere} texts the phone failed and the Mac embedded` : '',
          p.refused.size ? `${p.refused.size} vectors the plane would refuse` : '',
          v.below ? `${v.below} vectors below ${BAR} of the Mac's` : '',
          v.stored ? `${v.stored} labels below ${BAR} of their stored v2 vectors` : '',
          v.claims ? `${v.claims} claim decisions changed` : '',
          v.sentences ? `${v.sentences} sentences' listings changed` : '',
          v.awkward ? `${v.awkward} awkward pairs apart where the Mac's are one` : '',
        ].filter(Boolean);
        const line = `${p.name}: ${reasons.length ? `FAIL (${reasons.join('; ')})` : 'PASS'}`;
        summary.push(line);
        lines.push(`- ${line}`);
      }
      const macAwkward = awkwardBelow.get('Mac')!.size;
      lines.push(
        `- The embedder itself, on the Mac as on the phones: ${macAwkward} awkward pairs the plane holds as one text get two vectors${macAwkward ? ` (${[...new Set([...awkwardBelow.get('Mac')!].map((id) => meta.get(id)!.change))].join(', ')})` : ''}.`,
        '',
      );
      writeFileSync(join(__dirname, 'work-eval', `embed-phone-${date}.md`), lines.join('\n') + '\n');
      process.stdout.write(`worst phone cosine ${fmt(worstAll)}; ${summary.join('; ')}; the embedder's own awkward pairs ${macAwkward}\n`);
    },
    60 * 60_000,
  );
});
