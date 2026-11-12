// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `/v1/vault/:account/*` — the Vault mirror (workspace decision 0081, item 4;
 * runbook `docs/runbooks/vault-build.md`, step 4). The app mirrors each sealed
 * document, the sealed database snapshot and its key wrap into the R2 bucket
 * `cofferdam-vault` (`VAULT`); the plane stores and deletes opaque bytes and
 * never holds a key or a plaintext.
 *
 *   PUT    /v1/vault/:account/objects/:kind/:id   fast; binary body, content-length required
 *   GET    /v1/vault/:account/objects/:kind/:id   fast; the bytes, application/octet-stream
 *   HEAD   /v1/vault/:account/objects/:kind/:id   fast
 *   DELETE /v1/vault/:account/objects/:kind/:id   fast
 *   POST   /v1/vault/:account/list                fast; { cursor? }
 *   DELETE /v1/vault/:account                     slow; wipes the whole prefix
 *   PUT    /v1/vault/:account/handover/:keyHash   slow; sealed blob ≤ 4 KiB, content-length required, once per account
 *   GET    /v1/vault/:account/handover/:keyHash   fast; the blob once, 404 handover_pending, 410 handover_taken
 *
 *   Authorization: DPoP csa1:…  + DPoP: <proof>   (or Bearer csa1:… v1 while CSA1_V1_ACCEPTED allows)
 *
 * The grant is the `csa1:` session attestation itself (decision 0081, ruling
 * 4): no second token. Every route runs, in order: the global brake
 * (`VAULT_GLOBAL_RL`, `vault:global`), the per-IP ceiling (`VAULT_IP_RL`),
 * the session pinned to `:account` at the route's tier, the on-chain High
 * check (remembered five minutes by `authorityMemo` on the fast routes: they
 * move sealed bytes the plane cannot read, so a revoked device gains at most
 * five minutes, in which it can still read, overwrite or delete single objects;
 * the wipe, which no one can undo, always reads Base live), and only then the per-account bucket
 * (`VAULT_RL`, `vault:<account>`): account addresses are public, so a bucket
 * spent before the gate would let anyone lock the owner out.
 *
 * The prefix is the lower-cased `accountAddress` of the session the gate
 * verified, never the path's spelling; only under `ENVIRONMENT=development`
 * with no token at all (the pickup's tolerance, `routes/self.ts`) is it the
 * path's `:account`, lower-cased. Keys are `${prefix}/<kind>/<id>.bin`, with
 * `kind` one of `VAULT_KINDS` and `id` matching `VAULT_ID`; the key sits in the
 * path so the proof's `htu` binds it. No log line carries a key beside an
 * account: the store's failures log the operation and the error's name only,
 * and the request logger sees `redactVaultPath`'s path.
 *
 * The handover routes are the device-link ceremony's relay (step 5): the old
 * phone puts the two Vault roots sealed to the new phone's X25519 key, the
 * new phone takes them once. They pass the same gate, but sit on
 * `VAULT_HANDOFF_DO`, not on the bucket, so each route checks its own store.
 * The `keyHash` (the base64url SHA-256 of the new phone's public key) names
 * the object; it never authorizes the take, which is pinned to the attested
 * account's own slot, and it never reaches a log.
 */

import { Hono, type Context } from 'hono';
import { getAddress, isAddress } from 'viem';

import type { Env } from '../env.js';
import { checkOnChainAuthority, type AuthorityCheck } from '../services/authorityCheck.js';
import { TIER } from '../services/ceremony.js';
import { createAuthorityMemo, type AuthorityMemo } from '../services/chat/authorityMemo.js';
import { envReplayStore, type ReplayStore } from '../services/popReplayStore.js';
import type { PasskeySession, SessionTier } from '../services/sessionAttestation.js';
import { checkSession, isRefusal } from '../services/sessionGate.js';
import { envVaultStore, isChecksumMismatch, type VaultObjectBody, type VaultStore } from '../services/vault/store.js';
import { envHandoffStore, type HandoffStore } from '../services/vaultHandoffStore.js';

/** The largest object a put takes. */
export const VAULT_MAX_OBJECT_BYTES = 64 * 1024 * 1024;
/** What a key's `<kind>` may be. */
export const VAULT_KINDS = ['documents', 'db', 'contacts', 'prf'] as const;
export type VaultKind = (typeof VAULT_KINDS)[number];
/** What a key's `<id>` may be: no dot, no slash, so the plane alone appends `.bin`. */
export const VAULT_ID = /^[A-Za-z0-9_-]{1,96}$/;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;
/** The largest handover blob a put takes; the app's is 125 bytes. */
export const VAULT_HANDOVER_MAX_BYTES = 4 * 1024;
/** How long a handover waits for its take: the new phone's poll. */
export const VAULT_HANDOVER_TTL_MS = 10 * 60 * 1000;
/** A `keyHash`: the base64url of a SHA-256, 43 characters without padding. */
export const HANDOVER_KEY_HASH = /^[A-Za-z0-9_-]{43}$/;
const MAX_CURSOR = 1_024;

const GLOBAL_KEY = 'vault:global';
/**
 * How old a v1 bearer token may be on the slow route (the wipe): the pickup's
 * ten minutes (`routes/self.ts`), not the fast routes' hour.
 */
export const VAULT_SLOW_V1_MAX_AGE_MS = 10 * 60 * 1000;

export interface VaultRouteDeps {
  /** Max age of a `csa1:` v1 bearer token (a v2 token carries its own expiry). */
  attestationMaxAgeMs: number;
  now(): number;
  authorityCheck(env: Env, att: PasskeySession): Promise<AuthorityCheck>;
  /** The five-minute memory of a passed High check (`services/chat/authorityMemo.ts`). */
  authorityMemo: AuthorityMemo;
  /** The bucket behind the routes, or null when `VAULT` is not bound. */
  store(env: Env): VaultStore | null;
  /** The v2 proof replay cache, or null when `POP_REPLAY_DO` is not bound (default: from the env). */
  replayStore?(env: Env): ReplayStore | null;
  /** The handover relay, or null when `VAULT_HANDOFF_DO` is not bound (default: from the env). */
  handoffStore?(env: Env): HandoffStore | null;
}

export const defaultVaultRouteDeps: VaultRouteDeps = {
  attestationMaxAgeMs: 60 * 60 * 1000,
  now: () => Date.now(),
  authorityCheck: (env, att) => checkOnChainAuthority(att, env.BASE_SEPOLIA_RPC_URL),
  authorityMemo: createAuthorityMemo(),
  store: envVaultStore,
};

/**
 * A request line with the Vault's account and object id taken out, for the
 * request logger: `/v1/vault/:account/objects/<kind>/:id`, `/v1/vault/:account/list`,
 * `/v1/vault/:account/handover/:keyHash`.
 * Each word is matched as decoded, since the router matches the decoded path: a
 * percent-encoded `/v1/%76ault/…` reaches the routes and is redacted the same.
 */
export function redactVaultPath(line: string): string {
  return line.replace(/\S+/g, (word) => {
    let path = word;
    try {
      path = decodeURIComponent(word);
    } catch {
      // not percent-encoded text; matched as it is
    }
    return /\/v1\/vault(?:[/?#]|$)/i.test(path) ? redactPath(path) : word;
  });
}

function redactPath(path: string): string {
  return path.replace(/\/v1\/vault(\/[^\s]*)?/gi, (_m, rest: string | undefined) => {
    if (!rest) return '/v1/vault';
    const parts = rest.split(/[?#]/)[0]!.split('/').slice(1);
    const out = ['', 'v1', 'vault', ':account'];
    if (parts[1] === 'objects') {
      out.push('objects', (VAULT_KINDS as readonly string[]).includes(parts[2] ?? '') ? parts[2]! : ':kind', ':id');
    } else if (parts[1] === 'list') {
      out.push('list');
    } else if (parts[1] === 'handover') {
      out.push('handover', ':keyHash');
    } else if (parts.length > 1) {
      out.push('…');
    }
    return out.join('/');
  });
}

async function overLimit(rl: RateLimit | undefined, key: string): Promise<boolean> {
  if (!rl) return false;
  try {
    const { success } = await rl.limit({ key });
    return !success;
  } catch {
    return false;
  }
}

type VaultContext = Context<{ Bindings: Env }>;

/** What the gate hands a route that may go on. */
interface Admitted {
  /** The lower-cased attested account address; every key starts with it and a slash. */
  prefix: string;
}

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify(fields));

/** A store failure: 503 with the error's name only, logged without account or key. */
function unavailable(c: VaultContext, op: string, err: unknown): Response {
  const name = err instanceof Error ? err.name : typeof err;
  log({ kind: 'vault', op, error: name });
  return c.json({ ok: false, error: 'vault_unavailable', name }, 503);
}

const rateLimited = (c: VaultContext) => c.json({ ok: false, error: 'rate_limited', retryAfterSeconds: 10 }, 429);

export function createVaultRoutes(deps: VaultRouteDeps = defaultVaultRouteDeps) {
  const routes = new Hono<{ Bindings: Env }>();

  // Nothing the Vault answers may sit in a cache: the bytes, a listing, a refusal.
  routes.use('*', async (c, next) => {
    await next();
    c.res.headers.set('cache-control', 'no-store');
  });

  /** The on-chain check, remembered for five minutes once it passes. */
  /** The High check; `live` (the wipe) always reads Base, since a delete of the whole prefix cannot be undone. */
  async function authority(env: Env, att: PasskeySession, live: boolean): Promise<AuthorityCheck> {
    const remembered = live ? null : await deps.authorityMemo.get(att);
    if (remembered) return remembered;
    const check = await deps.authorityCheck(env, att);
    if (check.status === 'active' && check.tier === TIER.High) await deps.authorityMemo.put(att, check);
    return check;
  }

  /**
   * The gate every Vault route shares, in its order. Answers the refusal, or
   * the attested prefix. The caller checks its own store first: the bucket for
   * the mirror, the relay for the handover.
   */
  async function admit(c: VaultContext, requiredTier: SessionTier): Promise<Admitted | Response> {
    const raw = c.req.param('account') ?? '';
    if (!isAddress(raw)) {
      return c.json({ ok: false, error: 'bad_account', hint: 'expected 0x-prefixed address' }, 400);
    }
    const account = getAddress(raw);

    // The global brake first, then a generous per-IP ceiling (carriers put
    // many phones behind one address).
    if (await overLimit(c.env.VAULT_GLOBAL_RL, GLOBAL_KEY)) return rateLimited(c);
    const ip = c.req.header('cf-connecting-ip');
    if (ip && (await overLimit(c.env.VAULT_IP_RL, `vault-ip:${ip}`))) return rateLimited(c);

    const result = await checkSession(
      {
        env: c.env,
        authorization: c.req.header('authorization'),
        proof: c.req.header('dpop'),
        method: c.req.method,
        url: c.req.url,
      },
      {
        account,
        requiredTier,
        v1MaxAgeMs: requiredTier === 'slow' ? Math.min(deps.attestationMaxAgeMs, VAULT_SLOW_V1_MAX_AGE_MS) : deps.attestationMaxAgeMs,
        now: deps.now(),
        replay: (deps.replayStore ?? envReplayStore)(c.env),
      },
    );

    let prefix: string;
    if (isRefusal(result)) {
      // `wrangler dev` without sign-in, exactly as the pickup tolerates it; a
      // deployed Worker never takes the prefix from the path.
      const tolerated = result.body.error === 'attestation_required' && c.env.ENVIRONMENT === 'development';
      if (!tolerated) return c.json(result.body, result.status);
      prefix = account.toLowerCase();
    } else {
      const att = result.session;
      // Anyone can mint an envelope for any address; only a High passkey on
      // the account itself may read or write its mirror.
      const check = await authority(c.env, att, requiredTier === 'slow');
      if (check.status === 'check_failed') {
        return c.json({ ok: false, error: 'authority_check_unavailable', message: check.message }, 503);
      }
      if (check.status !== 'active' || check.tier !== TIER.High) {
        const why = check.status === 'active' ? `authority ${check.authorityId} is not High` : check.status;
        return c.json(
          // `reason` tells the app a fresh session would change nothing (no new Face ID for a refused account).
          { ok: false, error: 'attestation_rejected', reason: 'authority', message: `the token's key is not an active High authority on ${account} (${why})` },
          401,
        );
      }
      prefix = att.accountAddress.toLowerCase();
    }

    // Counted only now: account addresses are public on Base.
    if (await overLimit(c.env.VAULT_RL, `vault:${prefix}`)) return rateLimited(c);
    return { prefix };
  }

  /** The bucket behind the mirror routes, or the 503 when `VAULT` is not bound. */
  function vaultStore(c: VaultContext): VaultStore | Response {
    return deps.store(c.env) ?? c.json({ ok: false, error: 'vault_unprovisioned' }, 503);
  }

  /** The object's `<kind>/<id>.bin` from the path, or the 400 to answer. */
  function objectPath(c: VaultContext): string | Response {
    const kind = c.req.param('kind') ?? '';
    const id = c.req.param('id') ?? '';
    if (!(VAULT_KINDS as readonly string[]).includes(kind)) {
      return c.json({ ok: false, error: 'bad_kind', hint: `one of ${VAULT_KINDS.join(', ')}` }, 400);
    }
    if (!VAULT_ID.test(id)) {
      return c.json({ ok: false, error: 'bad_id', hint: 'letters, digits, _ and -, 1 to 96 characters' }, 400);
    }
    return `${kind}/${id}.bin`;
  }

  /** Path checks, then the gate: the key under the attested prefix, or the refusal. */
  async function objectGate(c: VaultContext): Promise<{ store: VaultStore; key: string } | Response> {
    const path = objectPath(c);
    if (typeof path !== 'string') return path;
    const store = vaultStore(c);
    if (store instanceof Response) return store;
    const admitted = await admit(c, 'fast');
    if (admitted instanceof Response) return admitted;
    return { store, key: `${admitted.prefix}/${path}` };
  }

  routes.put('/:account/objects/:kind/:id', async (c) => {
    // The path's kind and id are checked before the gate, the length, the
    // cap and the checksum header after it; nothing reads the body before all pass.
    const gate = await objectGate(c);
    if (gate instanceof Response) return gate;

    const length = c.req.header('content-length');
    if (length === undefined || !/^\d+$/.test(length)) {
      return c.json({ ok: false, error: 'length_required', hint: 'send the sealed bytes with a content-length' }, 411);
    }
    const size = Number(length);
    if (size > VAULT_MAX_OBJECT_BYTES) {
      return c.json({ ok: false, error: 'object_too_large', maxBytes: VAULT_MAX_OBJECT_BYTES }, 413);
    }
    const sha256 = c.req.header('x-cofferdam-sha256');
    if (sha256 !== undefined && !SHA256_HEX.test(sha256)) {
      return c.json({ ok: false, error: 'bad_checksum', hint: 'x-cofferdam-sha256 is the bytes\' SHA-256 in hex' }, 400);
    }

    try {
      // Streamed straight to R2, which checks the length and the checksum.
      const body = c.req.raw.body ?? new Uint8Array(0);
      const o = await gate.store.put(gate.key, body, sha256 ? { sha256: sha256.toLowerCase() } : undefined);
      return c.json({ ok: true, key: o.key, size: o.size, etag: o.etag });
    } catch (err) {
      // Retrying the same bytes would fail the same way: tell the app so.
      if (isChecksumMismatch(err)) {
        return c.json({ ok: false, error: 'checksum_mismatch', hint: 'the bytes received do not match x-cofferdam-sha256' }, 400);
      }
      return unavailable(c, 'put', err);
    }
  });

  // GET, and HEAD, which Hono serves through the GET route with the method kept.
  routes.get('/:account/objects/:kind/:id', async (c) => {
    const gate = await objectGate(c);
    if (gate instanceof Response) return gate;
    const head = c.req.method === 'HEAD';
    try {
      const o = head ? await gate.store.head(gate.key) : await gate.store.get(gate.key);
      if (!o) return c.json({ ok: false, error: 'not_found' }, 404);
      const headers = {
        'content-type': 'application/octet-stream',
        'content-length': String(o.size),
        etag: o.etag,
        'cache-control': 'no-store',
      };
      const body = 'body' in o ? (o as VaultObjectBody).body : null;
      return new Response(body, { status: 200, headers });
    } catch (err) {
      return unavailable(c, head ? 'head' : 'get', err);
    }
  });

  routes.delete('/:account/objects/:kind/:id', async (c) => {
    const gate = await objectGate(c);
    if (gate instanceof Response) return gate;
    try {
      await gate.store.delete([gate.key]);
      return c.json({ ok: true });
    } catch (err) {
      return unavailable(c, 'delete', err);
    }
  });

  routes.post('/:account/list', async (c) => {
    const store = vaultStore(c);
    if (store instanceof Response) return store;
    const admitted = await admit(c, 'fast');
    if (admitted instanceof Response) return admitted;

    let cursor: string | undefined;
    const text = await c.req.text();
    if (text.trim()) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return c.json({ ok: false, error: 'bad_request', message: 'the body is JSON: { "cursor"?: string }' }, 400);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => k !== 'cursor')) {
        return c.json({ ok: false, error: 'bad_request', message: 'the body is JSON: { "cursor"?: string }' }, 400);
      }
      const raw = (body as { cursor?: unknown }).cursor;
      if (raw !== undefined && (typeof raw !== 'string' || !raw || raw.length > MAX_CURSOR)) {
        return c.json({ ok: false, error: 'bad_request', message: 'cursor is the string a previous page answered' }, 400);
      }
      cursor = raw;
    }

    try {
      const page = await store.list({ prefix: `${admitted.prefix}/`, cursor });
      return c.json({
        ok: true,
        objects: page.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString() })),
        ...(page.cursor ? { cursor: page.cursor } : {}),
      });
    } catch (err) {
      return unavailable(c, 'list', err);
    }
  });

  // Deleting the account wipes the prefix (decision 0081): a slow route, one
  // fresh passkey confirmation.
  routes.delete('/:account', async (c) => {
    const store = vaultStore(c);
    if (store instanceof Response) return store;
    const admitted = await admit(c, 'slow');
    if (admitted instanceof Response) return admitted;
    let deleted = 0;
    try {
      let cursor: string | undefined;
      do {
        const page = await store.list({ prefix: `${admitted.prefix}/`, cursor });
        const keys = page.objects.map((o) => o.key);
        await store.delete(keys);
        deleted += keys.length;
        cursor = page.cursor;
      } while (cursor);
    } catch (err) {
      return unavailable(c, 'wipe', err);
    }
    return c.json({ ok: true, deleted });
  });

  /**
   * The handover's checks, then the gate: the key hash's format before any
   * limiter is spent, then the relay's binding, then the shared gate. Answers
   * the refusal, or the relay, the key hash and the attested prefix.
   */
  async function handoverGate(
    c: VaultContext,
    requiredTier: SessionTier,
  ): Promise<{ store: HandoffStore; keyHash: string; prefix: string } | Response> {
    const keyHash = c.req.param('keyHash') ?? '';
    if (!HANDOVER_KEY_HASH.test(keyHash)) {
      return c.json({ ok: false, error: 'bad_key_hash', hint: 'the base64url SHA-256 of the handover key, 43 characters' }, 400);
    }
    const store = (deps.handoffStore ?? envHandoffStore)(c.env);
    if (!store) return c.json({ ok: false, error: 'handover_unprovisioned' }, 503);
    const admitted = await admit(c, requiredTier);
    if (admitted instanceof Response) return admitted;
    return { store, keyHash, prefix: admitted.prefix };
  }

  // The old phone's put: a slow route, since it hands over the keys to every
  // sealed object, so Base is read live and a revoked device cannot use a
  // remembered check.
  routes.put('/:account/handover/:keyHash', async (c) => {
    const gate = await handoverGate(c, 'slow');
    if (gate instanceof Response) return gate;

    const length = c.req.header('content-length');
    if (length === undefined || !/^\d+$/.test(length)) {
      return c.json({ ok: false, error: 'length_required', hint: 'send the sealed blob with a content-length' }, 411);
    }
    if (Number(length) > VAULT_HANDOVER_MAX_BYTES) {
      return c.json({ ok: false, error: 'object_too_large', maxBytes: VAULT_HANDOVER_MAX_BYTES }, 413);
    }
    const sha256 = c.req.header('x-cofferdam-sha256');
    if (sha256 !== undefined && !SHA256_HEX.test(sha256)) {
      return c.json({ ok: false, error: 'bad_checksum', hint: 'x-cofferdam-sha256 is the bytes\' SHA-256 in hex' }, 400);
    }

    // Small enough to read whole once the header passed the cap.
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength !== Number(length)) {
      return c.json({ ok: false, error: 'bad_length', hint: 'the body is not the content-length it announced' }, 400);
    }
    if (sha256 !== undefined) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
      if (hex !== sha256.toLowerCase()) {
        return c.json({ ok: false, error: 'checksum_mismatch', hint: 'the bytes received do not match x-cofferdam-sha256' }, 400);
      }
    }

    try {
      const now = deps.now();
      const answer = await gate.store.put(gate.keyHash, gate.prefix, bytes, now + VAULT_HANDOVER_TTL_MS, now);
      // A second put by the same account: the app reads it as already sent.
      if (answer === 'exists') return c.json({ ok: false, error: 'handover_exists' }, 409);
      return c.json({ ok: true });
    } catch (err) {
      return unavailable(c, 'handover_put', err);
    }
  });

  // The new phone's take, polled on its fast session. Hono serves HEAD through
  // this route, and a HEAD must not spend the one take, so it is refused first.
  routes.get('/:account/handover/:keyHash', async (c) => {
    if (c.req.method === 'HEAD') return c.json({ ok: false, error: 'method_not_allowed' }, 405);
    const gate = await handoverGate(c, 'fast');
    if (gate instanceof Response) return gate;
    try {
      const answer = await gate.store.take(gate.keyHash, gate.prefix, deps.now());
      if (answer.status === 'pending') return c.json({ ok: false, error: 'handover_pending' }, 404);
      if (answer.status === 'taken') return c.json({ ok: false, error: 'handover_taken' }, 410);
      return new Response(answer.blob, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(answer.blob.byteLength),
          'cache-control': 'no-store',
        },
      });
    } catch (err) {
      return unavailable(c, 'handover_take', err);
    }
  });

  return routes;
}

export const vaultRoutes = createVaultRoutes();
