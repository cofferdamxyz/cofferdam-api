// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * `/v1/messages/attachments/*` — the attachment token issuer (workspace decision 0093, rule 4; built 2026-11-23, not
 * deployed). The phone blinds Privacy Pass tokens (type 2) for size classes; the plane counts the classes against the
 * account's rolling 30-day allowance and the plane-wide day, then signs them blind with the current epoch's class keys
 * (30-day epochs, a new one every 27 days). It never sees a token it signed, so nothing here ties an account to an
 * upload; the gate Worker (not built) checks a spent token against the public key of a live epoch alone.
 *
 *   GET  /v1/messages/attachments/keys     public; the live epochs and, once made, the next, each with its dates and
 *                                          every class's bytes, token key id and public key
 *   POST /v1/messages/attachments/tokens   fast session; { account, epoch, requests: [{ class, request }] }
 *                                          (base64url TokenRequests under that epoch's keys, at most 8; the epoch
 *                                          must be the current one) → { epoch, responses, used, limit, windowDays }
 *
 *   Authorization: DPoP csa1:…  + DPoP: <proof>   (or Bearer csa1:… v1 while CSA1_V1_ACCEPTED allows)
 *
 * The tokens route runs, in order: the global brake (`ATTACHMENT_GLOBAL_RL`), the per-IP ceiling
 * (`ATTACHMENT_IP_RL`), the body, the session pinned to the body's account (the account never rides in the path, so
 * no request line names it), the on-chain High check (remembered five minutes, as the Vault's fast routes), the
 * per-account bucket (`ATTACHMENT_RL`, only now: account addresses are public), each request read whole against its
 * class's current key, then the reservations: the account's window first (`429 attachment_quota`), then the
 * plane-wide day (`503 attachment_ceiling`), then the signatures, each checked against its key; whatever fails after
 * a reservation gives it back. Log lines carry counts and error names only, never an account, a class list or a token.
 */

import { Hono, type Context } from 'hono';
import { getAddress, isAddress, type Address } from 'viem';

import type { Env } from '../env.js';
import { checkOnChainAuthority, type AuthorityCheck } from '../services/authorityCheck.js';
import {
  ATTACHMENT_ACCOUNT_LIMIT,
  ATTACHMENT_CLASSES,
  ATTACHMENT_DAILY_CEILING,
  ATTACHMENT_MAX_TOKENS_PER_REQUEST,
  ATTACHMENT_WINDOW_DAYS,
  classBytes,
  dayOf,
  epochAt,
  epochNotBefore,
  isAttachmentClass,
  liveEpochs,
  prepareNext,
  type AttachmentClass,
} from '../services/attachments/classes.js';
import {
  DurableIssuerKeySource,
  issueTokens,
  loadEpochIssuers,
  readTokenRequests,
  TOKEN_REQUEST_BYTES,
  TokenRequestError,
  type ClassIssuer,
  type IssuerKeySource,
} from '../services/attachments/issuer.js';
import { DurableQuotaStore, type QuotaStore } from '../services/attachments/quotaStore.js';
import { TIER } from '../services/ceremony.js';
import { createAuthorityMemo, type AuthorityMemo } from '../services/chat/authorityMemo.js';
import { envReplayStore, type ReplayStore } from '../services/popReplayStore.js';
import type { PasskeySession } from '../services/sessionAttestation.js';
import { checkSession, isRefusal } from '../services/sessionGate.js';

export interface AttachmentKeys {
  source: IssuerKeySource;
  /** The secret `ATTACHMENT_KEY_WRAP`. */
  wrapSecret: string;
}

export interface AttachmentRouteDeps {
  /** Max age of a `csa1:` v1 bearer token (a v2 token carries its own expiry). */
  attestationMaxAgeMs: number;
  now(): number;
  authorityCheck(env: Env, att: PasskeySession): Promise<AuthorityCheck>;
  authorityMemo: AuthorityMemo;
  /** The quota objects, or null when `ATTACHMENT_QUOTA_DO` is not bound. */
  quota(env: Env): QuotaStore | null;
  /** The issuer's keys, or null when `ATTACHMENT_ISSUER_DO` or `ATTACHMENT_KEY_WRAP` is missing. */
  keys(env: Env): AttachmentKeys | null;
  /** Tests only: sign through the library's JavaScript path where `RSA-RAW` is missing (Node). */
  allowJsSigning?: boolean;
  replayStore?(env: Env): ReplayStore | null;
}

export const defaultAttachmentRouteDeps: AttachmentRouteDeps = {
  attestationMaxAgeMs: 60 * 60 * 1000,
  now: () => Date.now(),
  authorityCheck: (env, att) => checkOnChainAuthority(att, env.BASE_SEPOLIA_RPC_URL),
  authorityMemo: createAuthorityMemo(),
  quota: (env) => (env.ATTACHMENT_QUOTA_DO ? new DurableQuotaStore(env.ATTACHMENT_QUOTA_DO) : null),
  keys: (env) =>
    env.ATTACHMENT_ISSUER_DO && env.ATTACHMENT_KEY_WRAP
      ? { source: new DurableIssuerKeySource(env.ATTACHMENT_ISSUER_DO), wrapSecret: env.ATTACHMENT_KEY_WRAP }
      : null,
};

type AttachmentContext = Context<{ Bindings: Env }>;

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ kind: 'attachment_tokens', ...fields }));

async function overLimit(rl: RateLimit | undefined, key: string): Promise<boolean> {
  if (!rl) return false;
  try {
    const { success } = await rl.limit({ key });
    return !success;
  } catch {
    return false;
  }
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** A TokenRequest's base64url length, unpadded. */
const REQUEST_CHARS = Math.ceil((TOKEN_REQUEST_BYTES * 4) / 3);

interface ParsedBody {
  account: Address;
  epoch: number;
  requests: { class: AttachmentClass; request: Uint8Array }[];
}

function parseBody(raw: unknown): ParsedBody | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { account, epoch, requests } = raw as { account?: unknown; epoch?: unknown; requests?: unknown };
  if (typeof account !== 'string' || !isAddress(account)) return null;
  if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 0) return null;
  if (!Array.isArray(requests) || requests.length === 0 || requests.length > ATTACHMENT_MAX_TOKENS_PER_REQUEST) return null;
  const out: ParsedBody['requests'] = [];
  for (const r of requests) {
    if (!r || typeof r !== 'object') return null;
    const { class: c, request } = r as { class?: unknown; request?: unknown };
    if (!isAttachmentClass(c) || typeof request !== 'string' || request.length !== REQUEST_CHARS) return null;
    const bytes = fromBase64url(request);
    if (!bytes) return null;
    out.push({ class: c, request: bytes });
  }
  return { account: getAddress(account), epoch, requests: out };
}

/** Runs `p` after the answer when the runtime has a context, and lets it fail quietly. */
function background(c: AttachmentContext, p: Promise<unknown>): void {
  const quiet = p.catch((err: unknown) => log({ op: 'prepare', error: err instanceof Error ? err.name : typeof err }));
  try {
    c.executionCtx.waitUntil(quiet);
  } catch {
    // No execution context (the tests): it simply runs.
  }
}

/** How long an isolate trusts what it read of another epoch, and how often it asks for the next one to be made. */
const STORED_TTL_MS = 5 * 60 * 1000;
const PREPARE_EVERY_MS = 10 * 60 * 1000;

export function createAttachmentRoutes(deps: AttachmentRouteDeps = defaultAttachmentRouteDeps) {
  const routes = new Hono<{ Bindings: Env }>();
  const opts = { allowJsSigning: deps.allowJsSigning === true };
  // Per isolate: what another epoch's keys looked like (null included), and when the next epoch was last asked for,
  // so a public route never calls the one issuer object on every request.
  const storedSeen = new Map<number, { at: number; issuers: ClassIssuer[] | null }>();
  let preparedAt = new Map<number, number>();

  async function authority(env: Env, att: PasskeySession): Promise<AuthorityCheck> {
    const remembered = await deps.authorityMemo.get(att);
    if (remembered) return remembered;
    const check = await deps.authorityCheck(env, att);
    if (check.status === 'active' && check.tier === TIER.High) await deps.authorityMemo.put(att, check);
    return check;
  }

  /**
   * The keys refusal: unset, or unusable. Its reason is logged (our own messages, which never carry a key; an error
   * from the issuer object crosses RPC as a plain Error with its message).
   */
  function keysUnavailable(c: AttachmentContext, err: unknown): Response {
    log({ op: 'keys', error: err instanceof Error ? err.message.slice(0, 160) || err.name : typeof err });
    return c.json({ ok: false, error: 'attachment_issuer_unavailable' }, 503);
  }

  /** The current epoch's issuers; asks for the next epoch's keys in the background once it is near, every ten minutes at most. */
  async function currentIssuers(c: AttachmentContext, keys: AttachmentKeys): Promise<ClassIssuer[]> {
    const now = deps.now();
    const epoch = epochAt(now);
    const issuers = await loadEpochIssuers(keys.source, keys.wrapSecret, epoch, opts);
    if (prepareNext(now) && now - (preparedAt.get(epoch + 1) ?? -Infinity) >= PREPARE_EVERY_MS) {
      preparedAt = new Map([[epoch + 1, now]]);
      background(c, keys.source.epochKeys(epoch + 1));
    }
    return issuers;
  }

  /** Another epoch's issuers if its keys were ever made (never makes them), read from the object at most every five minutes. */
  async function storedIssuers(keys: AttachmentKeys, epoch: number): Promise<ClassIssuer[] | null> {
    const now = deps.now();
    const seen = storedSeen.get(epoch);
    if (seen && now - seen.at < STORED_TTL_MS) return seen.issuers;
    // Another epoch is optional: a failure to read it leaves it out (and is remembered as a miss), never the answer.
    let issuers: ClassIssuer[] | null = null;
    try {
      const stored = await keys.source.storedEpoch(epoch);
      issuers = stored ? await loadEpochIssuers(keys.source, keys.wrapSecret, epoch, opts, stored) : null;
    } catch (err) {
      log({ op: 'stored', error: err instanceof Error ? err.name : typeof err });
    }
    storedSeen.set(epoch, { at: now, issuers });
    for (const e of storedSeen.keys()) if (e < epoch - 2) storedSeen.delete(e);
    return issuers;
  }

  routes.get('/keys', async (c) => {
    // Public and unauthenticated: the per-IP ceiling first, so one address over it spends nothing of the brake
    // everyone shares (the order of the handle registry's public routes, services/handles/limits.ts).
    const ip = c.req.header('cf-connecting-ip');
    if (ip && (await overLimit(c.env.ATTACHMENT_IP_RL, `attachments-keys-ip:${ip}`))) {
      return c.json({ ok: false, error: 'rate_limited', retryAfterSeconds: 10 }, 429);
    }
    if (await overLimit(c.env.ATTACHMENT_GLOBAL_RL, 'attachments-keys:global')) return c.json({ ok: false, error: 'rate_limited', retryAfterSeconds: 10 }, 429);
    const keys = deps.keys(c.env);
    if (!keys) return c.json({ ok: false, error: 'attachment_issuer_unprovisioned' }, 503);
    try {
      const now = deps.now();
      const [current, ...older] = liveEpochs(now);
      const epochs: ClassIssuer[][] = [];
      // The next epoch once made (three days ahead), so phones and the gate hold its keys before it starts.
      const next = await storedIssuers(keys, current! + 1);
      if (next) epochs.push(next);
      epochs.push(await currentIssuers(c, keys));
      for (const e of older) {
        // An earlier epoch is served only if it was ever made; it is never made now.
        const stored = await storedIssuers(keys, e);
        if (stored) epochs.push(stored);
      }
      // Never cached past the next epoch's start, nor longer than an hour.
      const untilNext = Math.floor((epochNotBefore(current! + 1) - now) / 1000);
      c.header('cache-control', `public, max-age=${Math.max(60, Math.min(3600, untilNext))}`);
      return c.json({
        ok: true,
        tokenType: 2,
        current,
        epochs: epochs.map((list) => ({
          epoch: list[0]!.epoch,
          notBefore: new Date(list[0]!.notBefore).toISOString(),
          notAfter: new Date(list[0]!.notAfter).toISOString(),
          classes: list.map((i) => ({
            class: i.class,
            bytes: ATTACHMENT_CLASSES[i.class],
            tokenKeyId: base64url(i.tokenKeyId),
            publicKey: base64url(i.publicKeyBytes),
          })),
        })),
        limit: { bytes: ATTACHMENT_ACCOUNT_LIMIT, windowDays: ATTACHMENT_WINDOW_DAYS },
      });
    } catch (err) {
      return keysUnavailable(c, err);
    }
  });

  routes.post('/tokens', async (c) => {
    c.header('cache-control', 'no-store');
    if (await overLimit(c.env.ATTACHMENT_GLOBAL_RL, 'attachments:global')) return c.json({ ok: false, error: 'rate_limited', retryAfterSeconds: 10 }, 429);
    const ip = c.req.header('cf-connecting-ip');
    if (ip && (await overLimit(c.env.ATTACHMENT_IP_RL, `attachments-ip:${ip}`))) {
      return c.json({ ok: false, error: 'rate_limited', retryAfterSeconds: 10 }, 429);
    }

    let body: ParsedBody | null;
    try {
      body = parseBody(await c.req.json());
    } catch {
      body = null;
    }
    if (!body) return c.json({ ok: false, error: 'bad_request' }, 400);

    const result = await checkSession(
      { env: c.env, authorization: c.req.header('authorization'), proof: c.req.header('dpop'), method: c.req.method, url: c.req.url },
      {
        account: body.account,
        requiredTier: 'fast',
        v1MaxAgeMs: deps.attestationMaxAgeMs,
        now: deps.now(),
        replay: (deps.replayStore ?? envReplayStore)(c.env),
      },
    );
    if (isRefusal(result)) return c.json(result.body, result.status);
    const check = await authority(c.env, result.session);
    if (check.status === 'check_failed') return c.json({ ok: false, error: 'authority_check_unavailable' }, 503);
    if (check.status !== 'active' || check.tier !== TIER.High) {
      return c.json({ ok: false, error: 'attestation_rejected', reason: 'authority' }, 401);
    }
    const account = getAddress(result.session.accountAddress);
    if (await overLimit(c.env.ATTACHMENT_RL, `attachments:${account.toLowerCase()}`)) {
      return c.json({ ok: false, error: 'rate_limited', retryAfterSeconds: 60 }, 429);
    }

    const quota = deps.quota(c.env);
    if (!quota) return c.json({ ok: false, error: 'attachment_quota_unprovisioned' }, 503);
    const keys = deps.keys(c.env);
    if (!keys) return c.json({ ok: false, error: 'attachment_issuer_unprovisioned' }, 503);
    // A request blinded under another epoch's keys is refused by name before anything else, so the phone refetches.
    const epoch = epochAt(deps.now());
    if (body.epoch !== epoch) return c.json({ ok: false, error: 'stale_epoch', epoch }, 400);
    let issuers: ClassIssuer[];
    try {
      issuers = await currentIssuers(c, keys);
    } catch (err) {
      return keysUnavailable(c, err);
    }

    let requests;
    try {
      requests = readTokenRequests(issuers, body.requests);
    } catch (err) {
      if (err instanceof TokenRequestError) {
        return c.json({ ok: false, error: 'bad_token_request', index: err.index, reason: err.reason, epoch: issuers[0]!.epoch }, 400);
      }
      throw err;
    }

    const classes = body.requests.map((r) => r.class);
    const bytes = classes.reduce((n, cls) => n + classBytes(cls), 0);
    const day = dayOf(deps.now());

    let mine;
    try {
      mine = await quota.reserve(account, day, bytes, ATTACHMENT_ACCOUNT_LIMIT, ATTACHMENT_WINDOW_DAYS);
    } catch (err) {
      log({ op: 'quota', error: err instanceof Error ? err.name : typeof err });
      return c.json({ ok: false, error: 'attachment_quota_unavailable' }, 503);
    }
    if (!mine.ok) {
      log({ op: 'refused', reason: 'quota', tokens: classes.length });
      return c.json({ ok: false, error: 'attachment_quota', used: mine.used, limit: ATTACHMENT_ACCOUNT_LIMIT, windowDays: ATTACHMENT_WINDOW_DAYS }, 429);
    }
    // From here, whatever fails gives back what this request reserved.
    const giveBack = async (global: boolean) => {
      const settled = await Promise.allSettled([quota.release(account, day, bytes), global ? quota.releaseGlobal(day, bytes) : Promise.resolve()]);
      for (const s of settled) if (s.status === 'rejected') log({ op: 'release', error: s.reason instanceof Error ? s.reason.name : typeof s.reason });
    };
    let all;
    try {
      all = await quota.reserveGlobal(day, bytes, ATTACHMENT_DAILY_CEILING);
    } catch (err) {
      await giveBack(false);
      log({ op: 'ceiling', error: err instanceof Error ? err.name : typeof err });
      return c.json({ ok: false, error: 'attachment_quota_unavailable' }, 503);
    }
    if (!all.ok) {
      await giveBack(false);
      log({ op: 'refused', reason: 'ceiling', tokens: classes.length, globalUsed: all.used });
      return c.json({ ok: false, error: 'attachment_ceiling', retryAfterSeconds: 3600 }, 503);
    }

    let responses: Uint8Array[];
    try {
      responses = await issueTokens(issuers, classes, requests);
    } catch (err) {
      await giveBack(true);
      log({ op: 'sign', error: err instanceof Error ? err.name : typeof err });
      return c.json({ ok: false, error: 'attachment_sign_failed' }, 503);
    }
    // Half the plane-wide ceiling granted today is the operator's alert.
    if (all.used >= ATTACHMENT_DAILY_CEILING / 2 && all.used - bytes < ATTACHMENT_DAILY_CEILING / 2) {
      log({ op: 'alert', alert: 'attachment_ceiling_half', globalUsed: all.used });
    }
    log({ op: 'issued', tokens: classes.length });
    return c.json({
      ok: true,
      epoch: issuers[0]!.epoch,
      responses: responses.map(base64url),
      used: mine.used,
      limit: ATTACHMENT_ACCOUNT_LIMIT,
      windowDays: ATTACHMENT_WINDOW_DAYS,
    });
  });

  return routes;
}

export const attachmentRoutes = createAttachmentRoutes();
