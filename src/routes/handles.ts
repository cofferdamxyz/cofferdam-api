// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * /v1/handles — the handle registry's public reads (workspace decision 0086,
 * rules 4 and 5; runbook `docs/runbooks/handles-build.md`, step 3, the parts
 * that need no signer and no session).
 *
 *   GET /v1/handles/:label/available
 *        → 200 { ok, label, available: true }
 *        | 200 { ok, label, available: false, reason: 'taken' | 'reserved' }
 *        | 400 { ok: false, error: 'bad_label' }
 *   GET /v1/handles/:label
 *        → 200 { ok, label, handleId, serial, owner, metaAddress, schemeId: 1, onChain }
 *        | 404 { ok: false, error: 'not_found' }
 *
 * `:label` is the handle in its stored form, a leading `@` and ASCII upper
 * case accepted (`services/handles/grammar.ts`); the answers name the stored
 * form. Both routes are unauthenticated, rate-limited per IP through the
 * binding (`services/handles/limits.ts`), answer `cache-control: no-store`
 * and log no label and no IP: the request logger's line goes through
 * `redactHandlePath`.
 *
 * `available` reads the reserved list and the row: a held label is taken
 * until its hold lapses (ASSUMPTION(0086 q20)), a released one until its
 * 365-day quarantine ends (rule 3). The lookup answers only an active row:
 * a held, releasing (ASSUMPTION(0086 q13)), quarantined or reserved label
 * answers exactly as a label nobody holds. A claim the relay has not landed
 * answers its pending owner and meta-address with `onChain: false`, which the
 * client treats as unchecked (ASSUMPTION(0086 q22)); the client checks every
 * answer against the anchor on Base (rule 5), so the plane's answer is a hint.
 *
 * Not built here (they wait on the SDK's typed data, the anchor, device
 * attestation and device sync): claim, the hold, `self`, search, inbox,
 * discovery, rename, release, hold and veto, the pay link and the relay.
 * ASSUMPTION(0086 q18): there is no pending route, so none is built later.
 */

import { Hono, type Context } from 'hono';

import type { Env } from '../env.js';
import { readHandle } from '../services/handles/grammar.js';
import { handlesLog, publicLimit } from '../services/handles/limits.js';
import { availabilityOf, D1HandleStore, quarantineMs, resolutionOf, type HandleStore } from '../services/handles/store.js';

export interface HandlesRouteDeps {
  /** The registry, or null when `HANDLES_DB` is not bound (default: from the env). */
  store?(env: Env): HandleStore | null;
  now(): number;
}

export const defaultHandlesRouteDeps: HandlesRouteDeps = { now: () => Date.now() };

export function envHandleStore(env: Env): HandleStore | null {
  return env.HANDLES_DB ? new D1HandleStore(env.HANDLES_DB) : null;
}

type HandlesContext = Context<{ Bindings: Env }>;

const unprovisioned = (c: HandlesContext) => c.json({ ok: false, error: 'handles_db_unprovisioned' }, 503);
const badLabel = (c: HandlesContext) =>
  c.json({ ok: false, error: 'bad_label', hint: 'a handle is 3 to 64 of a-z, 0-9 and -, with no - at either end' }, 400);

/** A store failure: 503 with the error's name only. */
function unavailable(c: HandlesContext, route: string, err: unknown): Response {
  const name = err instanceof Error ? err.name : typeof err;
  handlesLog({ route, error: name });
  return c.json({ ok: false, error: 'handles_unavailable' }, 503);
}

/** The words a path under `/v1/handles/:label/` may end in that a log line keeps. */
const HANDLE_ROUTE_WORDS = new Set(['available', 'inbox', 'self']);

/** `/v1/handles/…` or `/v1/handshake/links/…`, with any run of slashes, in a decoded word. */
const HANDLES_PREFIX = /\/+v1\/+handles(?:\/|$)/i;
const SHARE_LINK_PREFIX = /\/+v1\/+handshake\/+links\/+\S/i;

/**
 * The request logger's line with every handle and share-link token cut out.
 * The logger writes the raw URL path, one whitespace-free word, so each word
 * is decoded only to recognise the prefix, and the whole word is then
 * replaced: `/v1/handles/:label`, with one known route word kept
 * (`/available`), or `/v1/handshake/links/:token`. Nothing of the raw word
 * after the prefix survives, so no encoding, slash or newline in a label
 * carries part of it into the line.
 */
export function redactHandlePath(line: string): string {
  return line.replace(/\S+/g, (word) => {
    let path = word;
    try {
      path = decodeURIComponent(word);
    } catch {
      // not percent-encoded text; matched as it is
    }
    if (SHARE_LINK_PREFIX.test(path) || SHARE_LINK_PREFIX.test(word)) return '/v1/handshake/links/:token';
    const at = HANDLES_PREFIX.exec(path);
    if (!at) return HANDLES_PREFIX.test(word) ? '/v1/handles/:label' : word;
    const parts = path.slice(at.index + at[0].length).split(/[?#]/)[0]!.split('/').filter(Boolean);
    if (!parts.length) return '/v1/handles';
    const known = parts.length === 2 && HANDLE_ROUTE_WORDS.has(parts[1]!) ? `/${parts[1]}` : parts.length > 1 ? '/…' : '';
    return `/v1/handles/:label${known}`;
  });
}

export function createHandlesRoutes(deps: HandlesRouteDeps = defaultHandlesRouteDeps) {
  const routes = new Hono<{ Bindings: Env }>();
  const storeOf = (env: Env) => (deps.store ?? envHandleStore)(env);

  routes.use('*', async (c, next) => {
    await next();
    c.res.headers.set('cache-control', 'no-store');
  });

  routes.get('/:label/available', async (c) => {
    const limited = await publicLimit(c, 'handles');
    if (limited) return limited;
    const label = readHandle(c.req.param('label'));
    if (!label) return badLabel(c);
    const store = storeOf(c.env);
    if (!store) return unprovisioned(c);
    try {
      const [row, reserved] = await Promise.all([store.row(label), store.reserved(label)]);
      const answer = availabilityOf(row, reserved, deps.now(), quarantineMs(c.env.HANDLES_QUARANTINE_DAYS));
      handlesLog({ route: 'available', available: answer.available });
      return c.json({ ok: true, label, ...answer });
    } catch (err) {
      return unavailable(c, 'available', err);
    }
  });

  routes.get('/:label', async (c) => {
    const limited = await publicLimit(c, 'handles');
    if (limited) return limited;
    const label = readHandle(c.req.param('label'));
    if (!label) return badLabel(c);
    const store = storeOf(c.env);
    if (!store) return unprovisioned(c);
    try {
      const resolution = resolutionOf(await store.row(label));
      handlesLog({ route: 'lookup', found: resolution !== null });
      if (!resolution) return c.json({ ok: false, error: 'not_found' }, 404);
      return c.json({ ok: true, ...resolution });
    } catch (err) {
      return unavailable(c, 'lookup', err);
    }
  });

  return routes;
}

export const handlesRoutes = createHandlesRoutes();
