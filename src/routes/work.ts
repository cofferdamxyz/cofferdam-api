// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * /v1/work — the Cofferdam Work parser's cloud routes (workspace decisions
 * 0020 and 0021, `docs/product/engine.md`, Parser).
 *
 *   POST /v1/work/parse     { account, text }                               → the identity and `claimed` of a cofferdam.cv.v1
 *   POST /v1/work/classify  { account, blocks: [{ kind, lang, text }, …] }  → the document type
 *   POST /v1/work/extract   { account, block: { kind, lang, text } }        → one cofferdam.cv.v1 fragment
 *
 *   Authorization: DPoP csa1:… + DPoP: <proof>   (a fast or slow session, decision 0055)
 *   (or Authorization: Bearer csa1:…, a v1 token, while CSA1_V1_ACCEPTED allows it)
 *
 * The parse is Cofferdam Cloud's reading of a whole CV, sent after the
 * worker's opt-in on the consent screen (decision 0021, ruled 2026-10-28): the
 * CV's text only (the PDF's text layer, else the phone's text recognition,
 * after the phone's identity strip; never a page image), read in one call on
 * `work-parse` (`services/work/parse.ts`, a second only when the first fails)
 * through the documents AI Gateway, which cannot store. The plane keeps
 * nothing of the request or the answer: no store, Durable Object, KV, D1 or
 * cache write of either, and no text of either in a log line, an error or a
 * metric, only sizes and reason codes (decision 0021 (h);
 * `test/workParseRoute.test.ts` fails on any). The identity goes to the
 * phone only, which keeps it in the Vault.
 *
 * Classify and extract are the block protocol, which CVs no longer take; they
 * stay until the founder retires them. The phone sends de-identified blocks,
 * one block per extraction, never the header, contact, references or personal
 * blocks, never an image, a PDF or raw OCR text.
 *
 * Outside development every route answers `503 strict_gateway_required` until
 * `AI_GATEWAY_ID` names the strict AI Gateway (no cache, DLP in Block mode, no
 * log), which decision 0021 (f) requires before the cloud executor ships, and
 * the parse also `503 documents_gateway_required` until
 * `AI_GATEWAY_DOCUMENTS_ID` names the documents one: the strict gateway's DLP
 * would refuse the fields a CV must give.
 *
 * The gate is the Work gate (`routes/workGate.ts`), the chat's in the chat's
 * order, which the listing toggle (`routes/workListing.ts`) and /v1/jobs share:
 * a global brake, the strict gateway, the body, a per-IP ceiling, a session
 * pinned to the account, an active High authority on the account (remembered
 * five minutes, `services/chat/authorityMemo.ts`), the per-account bucket, then
 * the chat's caps before any model call: the account's `CHAT_MONTHLY_USD_CAP`
 * and the plane's `AI_MONTHLY_BUDGET_USD`. Every model call is metered to the
 * account and to `plane:global` through `waitUntil`, with no turn counted
 * (decision 0047 (3), `services/work/meter.ts`).
 *
 * The plane re-checks every block (`services/work/blocks.ts`) and answers a
 * refusal with its reason, never the text. Nothing is stored, and nothing
 * ties two blocks of one document together: the account is read for the gate
 * and the meter only and never reaches a model or a log line with a block or
 * a CV.
 */

import { Hono } from 'hono';

import type { Env } from '../env.js';
import { checkBlock, type DeidentifiedBlock } from '../services/work/blocks.js';
import { CV_SCHEMA } from '../services/work/cv.js';
import { classifyDocument, extractBlock } from '../services/work/executor.js';
import { parseCv, readParseBody, withoutPlaceholders } from '../services/work/parse.js';
import { createWorkGate, defaultWorkRouteDeps, WORK_KEYS, workLog as log, type WorkContext, type WorkRouteDeps } from './workGate.js';

export { defaultWorkRouteDeps, type WorkRouteDeps } from './workGate.js';

/** Blocks a classification reads at most: the first few are enough to name a document. */
export const CLASSIFY_MAX_BLOCKS = 4;

export function createWorkRoutes(deps: WorkRouteDeps = defaultWorkRouteDeps) {
  const routes = new Hono<{ Bindings: Env }>();
  const gate = createWorkGate(deps, WORK_KEYS);

  const refusal = (c: WorkContext, reason: string, index?: number) =>
    c.json({ ok: false, error: 'block_refused', reason, ...(index != null ? { index } : {}) }, 422);

  routes.post('/parse', async (c) => {
    // The answer is the worker's CV: nothing between the plane and the phone may keep it.
    c.header('cache-control', 'no-store');
    const admitted = await gate.admit<string>(c, (b) => {
      if (c.env.ENVIRONMENT !== 'development' && !c.env.AI_GATEWAY_DOCUMENTS_ID) {
        return c.json({ ok: false, error: 'documents_gateway_required', message: 'the parse runs only behind the documents AI Gateway' }, 503);
      }
      const r = readParseBody(b);
      if (r.ok) return r.text;
      return r.status === 413 ? c.json({ ok: false, error: r.error, max: r.max }, 413) : c.json({ ok: false, error: r.error, message: r.message }, 400);
    });
    if (admitted instanceof Response) return admitted;
    const { account, input: text, inference, store } = admitted;
    // The phone's request signal: a phone that gives up cancels the model call where the runtime reports it.
    const outcome = await parseCv(inference, text, { now: () => deps.now(), log, signal: c.req.raw.signal });
    gate.meter(c, store, account, outcome.calls);
    const result = outcome.ok ? { ...outcome, parsed: withoutPlaceholders(outcome.parsed) } : outcome;
    // Sizes and reason codes only: never the text, a value, or the account.
    log({
      event: 'work_parse',
      model: result.model,
      ok: result.ok,
      ...(result.ok ? { dropped: result.parsed.dropped.length } : { reason: result.reason }),
      attempts: result.calls.length,
      ms: result.calls.reduce((s, x) => s + x.ms, 0),
      chars: text.length,
      tokens_in: result.calls.reduce((s, x) => s + x.usage.tokensIn, 0),
      tokens_out: result.calls.reduce((s, x) => s + x.usage.tokensOut, 0),
    });
    if (!result.ok) return c.json({ ok: false, error: 'parse_failed', reason: result.reason }, 502);
    const { parsed } = result;
    return c.json({
      ok: true,
      schema: CV_SCHEMA,
      identity: parsed.identity,
      claimed: parsed.claimed,
      dropped: parsed.dropped,
      provenance: { executor: 'cloud', models: [result.model], parsedAt: new Date(deps.now()).toISOString() },
    });
  });

  routes.post('/extract', async (c) => {
    const admitted = await gate.admit<DeidentifiedBlock[]>(c, (b) => {
      const r = checkBlock(b.block);
      if (!r.ok) {
        log({ event: 'work_block_refused', reason: r.reason });
        return refusal(c, r.reason);
      }
      if (r.block.kind === 'body') return c.json({ ok: false, error: 'kind_not_extractable', message: 'no extraction schema takes a body block' }, 422);
      return [r.block];
    });
    if (admitted instanceof Response) return admitted;
    const { account, input: blocks, inference, store } = admitted;
    const block = blocks[0]!;
    const outcome = await extractBlock(inference, block, { now: () => deps.now(), log });
    gate.meter(c, store, account, outcome.calls);
    for (const call of outcome.calls) {
      log({ event: 'work_extract', kind: block.kind, lang: block.lang, op: call.op, model: call.model, ok: call.ok, ms: call.ms, tokens_in: call.usage.tokensIn, tokens_out: call.usage.tokensOut });
    }
    if (!outcome.ok) return c.json({ ok: false, error: outcome.error }, outcome.error === 'kind_not_extractable' ? 422 : 502);
    const e = outcome.extraction;
    return c.json({
      ok: true,
      schema: e.schema,
      kind: e.kind,
      fragment: e.fragment,
      fields: e.fields,
      violations: e.violations,
      model: e.model,
      executor: 'cloud',
    });
  });

  routes.post('/classify', async (c) => {
    const admitted = await gate.admit<DeidentifiedBlock[]>(c, (b) => {
      if (!Array.isArray(b.blocks) || b.blocks.length === 0 || b.blocks.length > CLASSIFY_MAX_BLOCKS) {
        return c.json({ ok: false, error: 'bad_request', message: `blocks must hold 1 to ${CLASSIFY_MAX_BLOCKS} blocks` }, 400);
      }
      const blocks: DeidentifiedBlock[] = [];
      for (const [i, raw] of (b.blocks as unknown[]).entries()) {
        const r = checkBlock(raw);
        if (!r.ok) {
          log({ event: 'work_block_refused', reason: r.reason });
          return refusal(c, r.reason, i);
        }
        blocks.push(r.block);
      }
      return blocks;
    });
    if (admitted instanceof Response) return admitted;
    const { account, input: blocks, inference, store } = admitted;
    const outcome = await classifyDocument(inference, blocks, { now: () => deps.now(), log });
    gate.meter(c, store, account, outcome.calls);
    if (!outcome.ok) return c.json({ ok: false, error: outcome.error }, 502);
    log({ event: 'work_classify', type: outcome.type, confidence: outcome.confidence, blocks: blocks.length, model: outcome.model });
    return c.json({
      ok: true,
      type: outcome.type,
      confidence: outcome.confidence,
      probabilities: outcome.probabilities,
      schema: outcome.schema,
      model: outcome.model,
    });
  });

  return routes;
}

export const workRoutes = createWorkRoutes();
