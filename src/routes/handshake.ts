// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * /v1/handshake/links — the share-link path of the handshake (workspace
 * decision 0086, rule 8; runbook `docs/runbooks/handles-build.md`, step 3).
 *
 *   POST /v1/handshake/links          body: the ciphertext (application/octet-stream), 1 to 2,048 bytes, content-length required
 *        → 201 { ok, token, expiresAt }
 *   GET  /v1/handshake/links/:token   → 200 the ciphertext, once
 *        | 404 { ok: false, error: 'not_found' }   (never stored, expired, or already fetched)
 *
 * A uploads its handshake half encrypted under a key that sits only in the
 * link's `#` fragment (`cofferdam.xyz/h/<token>#<key>`), so the plane holds
 * ciphertext it cannot read. The plane draws the token, 128 random bits in
 * base64url (22 characters), and keeps only its SHA-256. The first fetch
 * deletes the ciphertext, in the same statement that reads it, so a second
 * phone finds nothing; an unfetched link is gone after 7 days (the cron's
 * sweep, and a fetch after expiry answers nothing either).
 *
 * Both routes are unauthenticated and keep no IP and no account, so the
 * plane cannot pair the two sides (decision 0039 (2)); they are rate-limited
 * per IP through the binding, with a global brake. Hono serves HEAD through
 * the GET route, and a HEAD must not spend the one fetch, so it answers 405
 * first. The request logger's line names no token (`redactHandlePath`).
 */

import { Hono, type Context } from 'hono';

import type { Env } from '../env.js';
import { handlesLog, publicLimit } from '../services/handles/limits.js';
import type { HandleStore } from '../services/handles/store.js';
import { envHandleStore } from './handles.js';

/** The largest ciphertext a link takes (rule 8). */
export const SHARE_LINK_MAX_BYTES = 2048;
/** How long an unfetched link lives (rule 8). */
export const SHARE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A token: 16 random bytes in unpadded base64url. */
export const SHARE_TOKEN = /^[A-Za-z0-9_-]{22}$/;

export interface HandshakeRouteDeps {
  store?(env: Env): HandleStore | null;
  now(): number;
  /** 16 random bytes; the platform's CSPRNG by default. */
  randomBytes?(): Uint8Array;
}

export const defaultHandshakeRouteDeps: HandshakeRouteDeps = { now: () => Date.now() };

type HandshakeContext = Context<{ Bindings: Env }>;

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The hex SHA-256 of a token's characters: the only form the plane stores. */
export async function shareTokenHash(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

const unprovisioned = (c: HandshakeContext) => c.json({ ok: false, error: 'handles_db_unprovisioned' }, 503);

function unavailable(c: HandshakeContext, op: string, err: unknown): Response {
  handlesLog({ route: 'share_link', op, error: err instanceof Error ? err.name : typeof err });
  return c.json({ ok: false, error: 'handles_unavailable' }, 503);
}

export function createHandshakeRoutes(deps: HandshakeRouteDeps = defaultHandshakeRouteDeps) {
  const routes = new Hono<{ Bindings: Env }>();
  const storeOf = (env: Env) => (deps.store ?? envHandleStore)(env);
  const random = () => (deps.randomBytes ? deps.randomBytes() : crypto.getRandomValues(new Uint8Array(16)));

  routes.use('*', async (c, next) => {
    await next();
    c.res.headers.set('cache-control', 'no-store');
  });

  routes.post('/links', async (c) => {
    const limited = await publicLimit(c, 'handshake');
    if (limited) return limited;
    const length = c.req.header('content-length');
    if (length === undefined || !/^\d+$/.test(length)) {
      return c.json({ ok: false, error: 'length_required', hint: 'send the ciphertext with a content-length' }, 411);
    }
    if (Number(length) > SHARE_LINK_MAX_BYTES) return c.json({ ok: false, error: 'too_large', maxBytes: SHARE_LINK_MAX_BYTES }, 413);
    const store = storeOf(c.env);
    if (!store) return unprovisioned(c);
    // Small enough to read whole once the header passed the cap.
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength !== Number(length)) {
      return c.json({ ok: false, error: 'bad_length', hint: 'the body is not the content-length it announced' }, 400);
    }
    try {
      const expiresAt = deps.now() + SHARE_LINK_TTL_MS;
      // 128 random bits never collide in practice; a second draw covers a broken generator rather than chance.
      for (let attempt = 0; attempt < 2; attempt++) {
        const draw = random();
        if (draw.byteLength !== 16) throw new Error('random source gave the wrong length');
        const token = base64url(draw);
        if (await store.putShareLink(await shareTokenHash(token), bytes, expiresAt)) {
          handlesLog({ route: 'share_link', op: 'put', bytes: bytes.byteLength });
          return c.json({ ok: true, token, expiresAt }, 201);
        }
      }
      handlesLog({ route: 'share_link', op: 'put', error: 'collision' });
      return c.json({ ok: false, error: 'handles_unavailable' }, 503);
    } catch (err) {
      return unavailable(c, 'put', err);
    }
  });

  routes.get('/links/:token', async (c) => {
    if (c.req.method === 'HEAD') return c.json({ ok: false, error: 'method_not_allowed' }, 405);
    const limited = await publicLimit(c, 'handshake');
    if (limited) return limited;
    const token = c.req.param('token');
    if (!SHARE_TOKEN.test(token)) return c.json({ ok: false, error: 'bad_token' }, 400);
    const store = storeOf(c.env);
    if (!store) return unprovisioned(c);
    try {
      const bytes = await store.takeShareLink(await shareTokenHash(token), deps.now());
      handlesLog({ route: 'share_link', op: 'take', found: bytes !== null });
      if (!bytes) return c.json({ ok: false, error: 'not_found' }, 404);
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength), 'cache-control': 'no-store' },
      });
    } catch (err) {
      return unavailable(c, 'take', err);
    }
  });

  return routes;
}

export const handshakeRoutes = createHandshakeRoutes();
