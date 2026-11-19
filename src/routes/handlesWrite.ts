// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * /v1/handles — the registry's authenticated routes (workspace decision 0086,
 * rules 3 to 9; runbook `docs/runbooks/handles-build.md`, step 3, the parts
 * that sign and relay). The contract the app builds against is the workspace
 * note "handles-claim-plane-api" and, authoritatively, this file:
 *
 *   POST /v1/handles/mine                      (fast) the identity's held, active and releasing rows
 *   POST /v1/handles/hold                      (fast) q20: onboarding's 14-day reservation
 *   POST /v1/handles/claim                     (fast) the claim, queued for the relay
 *   POST /v1/handles/:label/discoverable       (fast) "Let people find me" (rule 6)
 *   POST /v1/handles/:label/self               (fast) a one-time address the phone derived or found (rule 5, q18)
 *   POST /v1/handles/:label/release            (slow) give the label up (rule 7)
 *   POST /v1/handles/:label/rename             (slow) claim a new label and release this one (rule 7)
 *   POST /v1/handles/:label/hold-record        (slow) the registrar's hold, renewal or veto (rule 3)
 *   POST /v1/handles/:label/advance            (slow) the registrar's signature on the immediate advance (rule 3)
 *   POST /v1/handles/:label/unfreeze           (slow) the registrar's signature on `unfreeze` (q15)
 *   POST /v1/handles/:label/verified           (fast) the Verified statement (rule 9)
 *
 * Every route takes `{ account, … }` and passes one gate, in order: the
 * family's global brake and per-IP ceiling, the `csa1:` session pinned to the
 * account (`slow` asks a fresh Face ID), an active High passkey on Base (the
 * five-minute memo, read live on slow routes), the unbuilt gates the route
 * names (`services/handles/config.ts`), then the per-account bucket. Each
 * handle-scoped request is then signed by the record's pinned handle key, in
 * the registry's EIP-712 domain, with a nonce taken once and an expiry at most
 * ten minutes ahead.
 *
 * What these routes keep: a row per label naming a random identity id, the
 * identity map's keyed tag of the account, the key history, the relay's queue
 * and the watched addresses sealed. The claim route keeps no request log
 * (rule 4); no route logs a label, an account, an inbox id or an IP.
 */

import { Hono, type Context } from 'hono';
import { getAddress, isAddress, type Address, type Hex } from 'viem';

import type { Env } from '../env.js';
import { checkOnChainAuthority, type AuthorityCheck } from '../services/authorityCheck.js';
import { TIER } from '../services/ceremony.js';
import { createAuthorityMemo, type AuthorityMemo } from '../services/chat/authorityMemo.js';
import { AnchorRevert, CHANGE_KIND, rpcAnchorChain, ZERO_ADDRESS, type AnchorChain, type AnchorRecord } from '../services/handles/anchor.js';
import {
  anchorAddressOf,
  claimDelayRange,
  HANDLES_CHAIN_ID,
  HOLD_MS,
  LIMIT_WINDOW_MS,
  LIMITS,
  randomDelayMs,
  releaseDelayRange,
  REQUEST_MAX_AHEAD_S,
  skipsGate,
  VERIFIED_TTL_S,
  type UnbuiltGate,
} from '../services/handles/config.js';
import { handleIdOf, readHandle } from '../services/handles/grammar.js';
import { handlesLog } from '../services/handles/limits.js';
import { mapKeysOf, type MapKeys } from '../services/handles/mapKey.js';
import { D1HandleRegistry, RegistryConflict } from '../services/handles/registry.js';
import { isCompressedPoint, isRegistrationOf, oneTimeFactoryOf, splitMetaAddress } from '../services/handles/stealth.js';
import { quarantineMs, type HandleRow } from '../services/handles/store.js';
import { anchorSigner, registrySigner, signAnchor, signRegistry, type RegistryPrimaryType } from '../services/handles/typedData.js';
import { envReplayStore, type ReplayStore } from '../services/popReplayStore.js';
import type { PasskeySession, SessionTier } from '../services/sessionAttestation.js';
import { checkSession, isRefusal } from '../services/sessionGate.js';
import { readAccountBound } from './workListing.js';

export interface HandlesWriteDeps {
  attestationMaxAgeMs: number;
  now(): number;
  authorityCheck(env: Env, att: PasskeySession): Promise<AuthorityCheck>;
  authorityMemo: AuthorityMemo;
  replayStore?(env: Env): ReplayStore | null;
  /** The registry, or null when `HANDLES_DB` is unbound (default: from the env). */
  registry?(env: Env): D1HandleRegistry | null;
  /** The anchor, or null while its address or the registrar key is missing (default: JSON-RPC). */
  chain?(env: Env): AnchorChain | null;
  /** Whether the account is bound to a passport on `chainId` (default: the identity registry). */
  bound?(env: Env, account: Address, chainId: number): Promise<boolean>;
}

export const defaultHandlesWriteDeps: HandlesWriteDeps = {
  attestationMaxAgeMs: 60 * 60 * 1000,
  now: () => Date.now(),
  authorityCheck: (env, att) => checkOnChainAuthority(att, env),
  authorityMemo: createAuthorityMemo(),
};

type HContext = Context<{ Bindings: Env }>;

/** How long a registrar route waits for its transaction's receipt, as the AA relay does. */
export const RECEIPT_WAIT_MS = 20_000;
/** Registrar-paid transactions per record per day (hold, renewal, veto, advance, unfreeze). */
export const REGISTRAR_SENDS_PER_DAY = 6;
/** Watched addresses per identity: every payment received, for years (0083 R9). */
export const WATCHED_PER_IDENTITY = 10_000;
/** Watched addresses in all, about 1 GB at most: past it a registration is refused, and the registry's other tables keep their room. */
export const WATCHED_CEILING = 1_000_000;

/** An answer the route gives as it is. */
class Refusal extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
    readonly error: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(error);
  }
}

const refuse = (status: Refusal['status'], error: string, extra: Record<string, unknown> = {}): never => {
  throw new Refusal(status, error, extra);
};

// ── Field readers ─────────────────────────────────────────────────────────

type Body = Record<string, unknown>;

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HEX_SIG = /^0x[0-9a-fA-F]{130}$/;
const INBOX_ID = /^[0-9a-f]{64}$/;

function str(b: Body, key: string): string {
  const v = b[key];
  return typeof v === 'string' ? v : refuse(400, 'bad_request', { field: key });
}
function address(b: Body, key: string): Address {
  const v = str(b, key);
  return isAddress(v, { strict: false }) ? getAddress(v) : refuse(400, 'bad_request', { field: key });
}
function hex32(b: Body, key: string): Hex {
  const v = str(b, key);
  return HEX32.test(v) ? (v.toLowerCase() as Hex) : refuse(400, 'bad_request', { field: key });
}
function signature(b: Body, key: string): Hex {
  const v = str(b, key);
  return HEX_SIG.test(v) ? (v.toLowerCase() as Hex) : refuse(400, 'bad_request', { field: key });
}
function meta(b: Body, key: string): Hex {
  const v = str(b, key);
  return splitMetaAddress(v) ? (v.toLowerCase() as Hex) : refuse(400, 'bad_meta_address', { field: key });
}
function uint(b: Body, key: string, max = Number.MAX_SAFE_INTEGER): number {
  const v = b[key];
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max ? v : refuse(400, 'bad_request', { field: key });
}
function labelOf(raw: unknown): string {
  return readHandle(raw) ?? refuse(400, 'bad_label', { hint: 'a handle is 3 to 64 of a-z, 0-9 and -, with no - at either end' });
}

/** A registry request's `nonce` and `expiresAt` (unix seconds, ahead of now by at most ten minutes). */
function requestWindow(b: Body, nowMs: number): { nonce: Hex; expiresAt: number } {
  const nonce = hex32(b, 'nonce');
  const expiresAt = uint(b, 'expiresAt');
  const nowS = Math.floor(nowMs / 1000);
  if (expiresAt <= nowS) refuse(400, 'expired');
  if (expiresAt > nowS + REQUEST_MAX_AHEAD_S) refuse(400, 'bad_request', { field: 'expiresAt', hint: 'at most ten minutes ahead' });
  return { nonce, expiresAt };
}

async function overLimit(rl: RateLimit | undefined, key: string): Promise<boolean> {
  if (!rl) return false;
  try {
    return !(await rl.limit({ key })).success;
  } catch {
    return false;
  }
}

/** What the gate hands a route. */
interface Admitted {
  account: Address;
  session: PasskeySession;
  identity: string;
  installTag: string;
  registry: D1HandleRegistry;
  keys: MapKeys;
  body: Body;
}

export function createHandlesWriteRoutes(deps: HandlesWriteDeps = defaultHandlesWriteDeps) {
  const routes = new Hono<{ Bindings: Env }>();
  const registryOf = (env: Env) => (deps.registry ? deps.registry(env) : env.HANDLES_DB ? new D1HandleRegistry(env.HANDLES_DB) : null);
  const chainOf = (env: Env) => (deps.chain ? deps.chain(env) : rpcAnchorChain(env, anchorAddressOf(env)));
  const boundOf = (env: Env, account: Address, chainId: number) => (deps.bound ? deps.bound(env, account, chainId) : readAccountBound(env, account, chainId));

  routes.use('*', async (c, next) => {
    await next();
    c.res.headers.set('cache-control', 'no-store');
  });

  async function authority(env: Env, att: PasskeySession, live: boolean): Promise<AuthorityCheck> {
    const remembered = live ? null : await deps.authorityMemo.get(att);
    if (remembered) return remembered;
    const check = await deps.authorityCheck(env, att);
    if (check.status === 'active' && check.tier === TIER.High) await deps.authorityMemo.put(att, check);
    return check;
  }

  /** The gate, in its order; throws the refusal. */
  async function admit(c: HContext, tier: SessionTier, gates: readonly UnbuiltGate[]): Promise<Admitted> {
    if (await overLimit(c.env.HANDLES_GLOBAL_RL, 'handles-write:global')) refuse(429, 'rate_limited', { retryAfterSeconds: 10 });
    const ip = c.req.header('cf-connecting-ip');
    if (ip && (await overLimit(c.env.HANDLES_IP_RL, `handles-write-ip:${ip}`))) refuse(429, 'rate_limited', { retryAfterSeconds: 10 });

    let body: Body;
    try {
      const parsed: unknown = await c.req.json();
      body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Body) : refuse(400, 'bad_request');
    } catch (err) {
      if (err instanceof Refusal) throw err;
      return refuse(400, 'bad_request');
    }
    const account = address(body, 'account');

    const result = await checkSession(
      { env: c.env, authorization: c.req.header('authorization'), proof: c.req.header('dpop'), method: c.req.method, url: c.req.url },
      {
        account,
        requiredTier: tier,
        v1MaxAgeMs: tier === 'slow' ? Math.min(deps.attestationMaxAgeMs, 10 * 60 * 1000) : deps.attestationMaxAgeMs,
        now: deps.now(),
        replay: (deps.replayStore ?? envReplayStore)(c.env),
      },
    );
    if (isRefusal(result)) throw new Refusal(result.status, result.body.error, { ...result.body, ok: undefined, error: undefined });
    const session = result.session;
    if (session.chainId !== HANDLES_CHAIN_ID) refuse(400, 'chain_unsupported', { chainId: session.chainId });
    const check = await authority(c.env, session, tier === 'slow');
    if (check.status === 'check_failed') refuse(503, 'authority_check_unavailable');
    if (check.status !== 'active' || check.tier !== TIER.High) {
      refuse(401, 'attestation_rejected', { reason: 'authority', message: 'the session key is not an active High authority on this account' });
    }

    for (const gate of gates) if (!skipsGate(c.env, gate)) refuse(503, `${gate.replace(/-/g, '_')}_unbuilt`);

    const registry = registryOf(c.env) ?? refuse(503, 'handles_db_unprovisioned');
    const keys = (await mapKeysOf(c.env.HANDLES_MAP_KEY)) ?? refuse(503, 'handles_map_key_unprovisioned');
    if (await overLimit(c.env.HANDLES_ACCOUNT_RL, `handles-acct:${account.toLowerCase()}`)) refuse(429, 'rate_limited', { retryAfterSeconds: 60 });

    const accountTag = await keys.tag('account', account);
    const installTag = await keys.tag('install', `${session.publicKey.qx}:${session.publicKey.qy}`);
    const identity = await registry.ensureIdentity(accountTag, deps.now());
    return { account, session, identity, installTag, registry, keys, body };
  }

  /** Run a route; a `Refusal` becomes its answer, anything else a 503 by name. */
  function handle(route: string, fn: (c: HContext) => Promise<Response>) {
    return async (c: HContext) => {
      try {
        return await fn(c);
      } catch (err) {
        if (err instanceof Refusal) {
          handlesLog({ route, refused: err.error });
          const extra = Object.fromEntries(Object.entries(err.extra).filter(([, v]) => v !== undefined));
          return c.json({ ok: false, error: err.error, ...extra }, err.status);
        }
        handlesLog({ route, error: err instanceof Error ? err.name : typeof err });
        return c.json({ ok: false, error: 'handles_unavailable' }, 503);
      }
    };
  }

  const chainOrRefuse = (c: HContext) => chainOf(c.env) ?? refuse(503, 'anchor_unconfigured');

  /** The label in the path, its row, and that it is the identity's active one. */
  async function ownRow(c: HContext, a: Admitted, states: readonly HandleRow['state'][] = ['active']): Promise<HandleRow> {
    const label = labelOf(c.req.param('label'));
    const row = await a.registry.row(label);
    if (!row || row.identity !== a.identity || !states.includes(row.state)) refuse(404, 'not_found');
    return row!;
  }

  /** A handle-scoped request: signed by `signer`, its nonce taken once. */
  async function signedBy(primaryType: RegistryPrimaryType, message: Record<string, unknown>, sig: Hex, signer: string, a: Admitted, expiresAt: number) {
    const got = await registrySigner(HANDLES_CHAIN_ID, primaryType, message, sig);
    if (!got || got.toLowerCase() !== signer.toLowerCase()) refuse(401, 'bad_signature', { field: primaryType });
    if (!(await a.registry.takeNonce(message.nonce as string, expiresAt * 1000))) refuse(409, 'replayed');
  }

  /** The record must be this row's on chain: the same owner, no pending change and no freeze unless allowed. */
  function onChainAs(rec: AnchorRecord, row: HandleRow, nowMs: number, opts: { frozenOk?: boolean; pendingOk?: boolean } = {}): void {
    if (!row.onchain || rec.owner.toLowerCase() !== (row.owner ?? '').toLowerCase()) refuse(409, 'not_on_chain', { hint: 'the handle is still being set up' });
    if (!opts.pendingOk && rec.pendingKind !== CHANGE_KIND.None) refuse(409, 'change_pending', { pendingNonce: rec.pendingNonce.toString() });
    if (!opts.frozenOk && rec.frozenUntil * 1000 > nowMs) refuse(409, 'frozen', { frozenUntil: rec.frozenUntil });
  }

  /**
   * The identity's row on chain, following the anchor first: when the record's
   * owner moved (an advance mined late, an owner change applied after its 72
   * hours, the Safe's rekey) the row and the key history follow it, so no
   * route checks a signature against a key the chain no longer has.
   */
  async function ownOnChain(c: HContext, a: Admitted, chain: AnchorChain, states: readonly HandleRow['state'][] = ['active']) {
    let row = await ownRow(c, a, states);
    const rec = await chain.record(row.handleId as Hex);
    if (!row.onchain || rec.owner === ZERO_ADDRESS) refuse(409, 'not_on_chain', { hint: 'the handle is still being set up' });
    if (rec.owner.toLowerCase() !== (row.owner ?? '').toLowerCase()) {
      await a.registry.followOwner(row, rec.owner, rec.metaAddress, deps.now());
      row = (await a.registry.row(row.label))!;
    }
    return { row, rec };
  }

  /** Follow the anchor when one is configured (the routes that work without it, discovery and `self`). */
  async function followIfChain(c: HContext, a: Admitted, row: HandleRow): Promise<HandleRow> {
    const chain = chainOf(c.env);
    if (!chain || !row.onchain) return row;
    const rec = await chain.record(row.handleId as Hex);
    if (rec.owner === ZERO_ADDRESS || rec.owner.toLowerCase() === (row.owner ?? '').toLowerCase()) return row;
    await a.registry.followOwner(row, rec.owner, rec.metaAddress, deps.now());
    return (await a.registry.row(row.label))!;
  }

  /** Is `label` claimable now by `identity`, on the row and the reserved list? */
  async function claimable(registry: D1HandleRegistry, c: HContext, label: string, identity: string, now: number): Promise<void> {
    const [row, reserved] = await Promise.all([registry.row(label), registry.reserved(label)]);
    if (reserved) refuse(409, 'reserved');
    if (!row) return;
    if (row.state === 'held' && (row.identity === identity || (row.heldUntil ?? 0) <= now)) return;
    if (row.state === 'quarantined' && (row.releasedAt ?? now) + quarantineMs(c.env.HANDLES_QUARANTINE_DAYS) <= now) return;
    if (row.state === 'reserved') refuse(409, 'reserved');
    refuse(409, 'taken');
  }

  async function claimLimits(a: Admitted, now: number, kind: 'claim' | 'rename'): Promise<void> {
    const since = now - LIMIT_WINDOW_MS;
    if (kind === 'rename' && (await a.registry.countEvents('identity', a.identity, ['rename'], since)) >= LIMITS.renamesPerIdentity) {
      refuse(429, 'rename_limit');
    }
    if ((await a.registry.countEvents('identity', a.identity, ['claim'], since)) >= LIMITS.claimsPerIdentity) refuse(429, 'claim_limit');
    const perInstall = (await a.registry.countEvents('install_tag', a.installTag, ['claim'], since)) + (await a.registry.countHolds('install_tag', a.installTag, since));
    if (perInstall >= LIMITS.perInstall) refuse(429, 'claim_limit');
  }

  /**
   * A claim's checks and write, shared by claim and rename: the registry
   * request by the new key, its `OwnerClaim` over the anchor's next serial, the
   * label free (or held by this identity), and the anchor record unowned.
   */
  async function claimInput(c: HContext, a: Admitted, input: { label: string; owner: Address; metaAddress: Hex; claim: Body }, chain: AnchorChain, now: number) {
    const { label, owner, metaAddress, claim } = input;
    const handleId = handleIdOf(label);
    const { nonce, expiresAt } = requestWindow(claim, now);
    const sig = signature(claim, 'signature');
    const serial = uint(claim, 'serial', 2 ** 32 - 1);
    const ownerClaimSignature = signature(claim, 'ownerClaimSignature');

    const regSigner = await registrySigner(HANDLES_CHAIN_ID, 'RegistryClaim', { label, handleId, owner, metaAddress, nonce, expiresAt: BigInt(expiresAt) }, sig);
    if (!regSigner || regSigner !== owner) refuse(401, 'bad_signature', { field: 'RegistryClaim' });
    const ownerSigner = await anchorSigner(HANDLES_CHAIN_ID, chain.anchor, 'OwnerClaim', { handleId, metaAddress, serial: BigInt(serial) }, ownerClaimSignature);
    if (!ownerSigner || ownerSigner !== owner) refuse(401, 'bad_signature', { field: 'OwnerClaim' });
    // Taken before any other refusal, so a refused request's signature is spent and never reused.
    if (!(await a.registry.takeNonce(nonce, expiresAt * 1000))) refuse(409, 'replayed');

    await claimable(a.registry, c, label, a.identity, now);
    const rec = await chain.record(handleId);
    if (rec.owner !== ZERO_ADDRESS) refuse(409, 'taken');
    if (rec.serial + 1 !== serial) refuse(409, 'serial_mismatch', { serial: rec.serial + 1 });
    return {
      label,
      handleId,
      write: {
        label,
        handleId,
        identity: a.identity,
        installTag: a.installTag,
        serial,
        owner,
        metaAddress,
        ownerClaimSignature,
        relayAt: now + randomDelayMs(claimDelayRange(c.env)),
        now,
        quarantineMs: quarantineMs(c.env.HANDLES_QUARANTINE_DAYS),
      },
    };
  }

  const claimAnswer = (w: { label: string; handleId: Hex; serial: number; owner: Address; metaAddress: Hex }) => ({
    ok: true,
    label: w.label,
    handleId: w.handleId,
    serial: w.serial,
    owner: getAddress(w.owner),
    metaAddress: w.metaAddress,
    schemeId: 1,
    onChain: false,
  });

  /** The owner's anchor `Release`, at the record's nonce now, valid past the relay's longest delay plus a day. */
  async function releaseInput(b: Body, chain: AnchorChain, rec: AnchorRecord, handleId: Hex, owner: string, now: number, maxDelayS: number) {
    const deadline = uint(b, 'anchorDeadline');
    if (deadline < Math.floor(now / 1000) + maxDelayS + 86_400) refuse(400, 'deadline_too_soon', { hint: 'cover the relay delay plus a day' });
    const ownerSig = signature(b, 'releaseSignature');
    const got = await anchorSigner(HANDLES_CHAIN_ID, chain.anchor, 'Release', { handleId, nonce: rec.nonce, deadline: BigInt(deadline) }, ownerSig);
    if (!got || got.toLowerCase() !== owner.toLowerCase()) refuse(401, 'bad_signature', { field: 'Release' });
    return { deadline: String(deadline), ownerSig };
  }

  // ── mine ─────────────────────────────────────────────────────────────────

  routes.post(
    '/mine',
    handle('mine', async (c) => {
      const a = await admit(c, 'fast', []);
      const now = deps.now();
      const rows = (await a.registry.rowsOf(a.identity)).filter((r) => r.state !== 'held' || (r.heldUntil ?? 0) > now);
      return c.json({
        ok: true,
        handles: rows.map((r) => ({
          label: r.label,
          handleId: r.handleId,
          state: r.state,
          serial: r.serial,
          owner: r.owner ? getAddress(r.owner) : null,
          metaAddress: r.metaAddress,
          onChain: r.onchain,
          discoverable: r.discoverable,
          heldUntil: r.heldUntil,
        })),
      });
    }),
  );

  // ── hold (q20) ───────────────────────────────────────────────────────────

  routes.post(
    '/hold',
    handle('hold', async (c) => {
      const a = await admit(c, 'fast', ['device-attestation']);
      const b = a.body;
      const now = deps.now();
      const label = labelOf(b.label);
      const handleId = handleIdOf(label);
      const owner = address(b, 'owner');
      const metaAddress = meta(b, 'metaAddress');
      const { nonce, expiresAt } = requestWindow(b, now);
      const sig = signature(b, 'signature');
      const signer = await registrySigner(HANDLES_CHAIN_ID, 'RegistryClaim', { label, handleId, owner, metaAddress, nonce, expiresAt: BigInt(expiresAt) }, sig);
      if (!signer || signer !== owner) refuse(401, 'bad_signature', { field: 'RegistryClaim' });
      // Taken before any other refusal: a refused hold's signature is spent, never reusable as a claim's.
      if (!(await a.registry.takeNonce(nonce, expiresAt * 1000))) refuse(409, 'replayed');

      const mine = await a.registry.rowsOf(a.identity);
      if (mine.some((r) => r.state === 'active')) refuse(409, 'identity_has_handle');
      const [row, reserved] = await Promise.all([a.registry.row(label), a.registry.reserved(label)]);
      if (reserved) refuse(409, 'reserved');
      // ASSUMPTION(0086 q20): only a label with no row, or a lapsed hold, or this identity's own hold, can be held.
      if (row && !(row.state === 'held' && (row.identity === a.identity || (row.heldUntil ?? 0) <= now))) refuse(409, 'taken');
      const since = now - LIMIT_WINDOW_MS;
      if (await a.registry.lapsedRecently(label, a.identity, a.installTag, since)) refuse(409, 'relapse');
      if ((await a.registry.countHolds('identity', a.identity, since)) >= LIMITS.holdsPerIdentity) refuse(429, 'hold_limit');
      const perInstall = (await a.registry.countEvents('install_tag', a.installTag, ['claim'], since)) + (await a.registry.countHolds('install_tag', a.installTag, since));
      if (perInstall >= LIMITS.perInstall) refuse(429, 'hold_limit');

      const heldUntil = now + HOLD_MS;
      try {
        await a.registry.hold({ label, handleId, identity: a.identity, installTag: a.installTag, owner, now, heldUntil });
      } catch (err) {
        if (err instanceof RegistryConflict) refuse(409, 'taken');
        throw err;
      }
      return c.json({ ok: true, label, state: 'held', heldUntil }, 201);
    }),
  );

  // ── claim (rule 4) ───────────────────────────────────────────────────────

  routes.post(
    '/claim',
    handle('claim', async (c) => {
      const a = await admit(c, 'fast', ['device-attestation', 'locator-pin']);
      const chain = chainOrRefuse(c);
      const now = deps.now();
      if ((await a.registry.rowsOf(a.identity)).some((r) => r.state === 'active')) refuse(409, 'identity_has_handle');
      await claimLimits(a, now, 'claim');
      const b = a.body;
      const { write } = await claimInput(c, a, { label: labelOf(b.label), owner: address(b, 'owner'), metaAddress: meta(b, 'metaAddress'), claim: b }, chain, now);
      try {
        await a.registry.claim(write);
      } catch (err) {
        if (err instanceof RegistryConflict) refuse(409, 'taken');
        throw err;
      }
      return c.json(claimAnswer(write), 201);
    }),
  );

  // ── discovery (rule 6) ───────────────────────────────────────────────────

  routes.post(
    '/:label/discoverable',
    handle('discoverable', async (c) => {
      const a = await admit(c, 'fast', ['install-proof']);
      const row = await followIfChain(c, a, await ownRow(c, a));
      const b = a.body;
      const now = deps.now();
      const discoverable = b.discoverable === true ? true : b.discoverable === false ? false : refuse(400, 'bad_request', { field: 'discoverable' });
      const inboxId = str(b, 'inboxId');
      if (discoverable ? !INBOX_ID.test(inboxId) : inboxId !== '') refuse(400, 'bad_request', { field: 'inboxId' });
      const { nonce, expiresAt } = requestWindow(b, now);
      const message = { handleId: row.handleId, serial: BigInt(row.serial!), discoverable, inboxId, nonce, expiresAt: BigInt(expiresAt) };
      await signedBy('SetDiscoverable', message, signature(b, 'signature'), row.owner!, a, expiresAt);
      if (!(await a.registry.setDiscoverable(row.handleId, a.identity, discoverable, inboxId || null, now))) refuse(404, 'not_found');
      handlesLog({ route: 'discoverable', on: discoverable });
      return c.json({ ok: true, discoverable });
    }),
  );

  // ── self (rule 5, q18) ───────────────────────────────────────────────────

  routes.post(
    '/:label/self',
    handle('self', async (c) => {
      const a = await admit(c, 'fast', ['install-proof']);
      const row = await followIfChain(c, a, await ownRow(c, a));
      const b = a.body;
      const now = deps.now();
      const account = address(b, 'address');
      const ephemeralPublicKey = str(b, 'ephemeralPublicKey').toLowerCase() as Hex;
      if (!isCompressedPoint(ephemeralPublicKey)) refuse(400, 'bad_request', { field: 'ephemeralPublicKey' });
      const sharedSecretHash = hex32(b, 'sharedSecretHash');
      const metaAddress = meta(b, 'metaAddress');
      const { nonce, expiresAt } = requestWindow(b, now);
      const factory = oneTimeFactoryOf(c.env) ?? refuse(503, 'factory_misconfigured');
      // ASSUMPTION(0086 q18): any meta-address this identity's handles have had, signed by the current handle key.
      if (!(await a.registry.hadMetaAddress(a.identity, metaAddress))) refuse(403, 'not_your_meta_address');
      if (!isRegistrationOf(account, metaAddress, sharedSecretHash, factory)) refuse(400, 'not_derived', { hint: 'the address is not the meta-address\'s for h' });
      const message = {
        handleId: row.handleId,
        serial: BigInt(row.serial!),
        account,
        ephemeralPublicKey,
        sharedSecretHash,
        metaAddress,
        nonce,
        expiresAt: BigInt(expiresAt),
      };
      await signedBy('RegisterAddress', message, signature(b, 'signature'), row.owner!, a, expiresAt);
      // R ‖ h ‖ view tag ‖ meta-address, sealed (0083 R10).
      const plain = new Uint8Array(33 + 32 + 1 + 66);
      plain.set(hexToBytes(ephemeralPublicKey));
      plain.set(hexToBytes(sharedSecretHash), 33);
      plain[65] = parseInt(sharedSecretHash.slice(2, 4), 16);
      plain.set(hexToBytes(metaAddress), 66);
      const outcome = await a.registry.watch({
        address: account,
        identity: a.identity,
        handleId: row.handleId,
        source: 'self',
        sealed: await a.keys.seal(plain),
        now,
        perIdentity: WATCHED_PER_IDENTITY,
        ceiling: WATCHED_CEILING,
      });
      handlesLog({ route: 'self', outcome });
      if (outcome === 'theirs') refuse(409, 'address_taken');
      if (outcome === 'limit') refuse(429, 'watch_limit');
      if (outcome === 'full') refuse(503, 'watch_full');
      return c.json({ ok: true, address: account }, outcome === 'added' ? 201 : 200);
    }),
  );

  // ── release (rule 7) ─────────────────────────────────────────────────────

  routes.post(
    '/:label/release',
    handle('release', async (c) => {
      const a = await admit(c, 'slow', ['install-proof', 'locator-pin']);
      const chain = chainOrRefuse(c);
      const { row, rec } = await ownOnChain(c, a, chain, ['active', 'releasing']);
      const b = a.body;
      const now = deps.now();
      if (row.state === 'releasing' && (await a.registry.releaseInFlight(row.handleId))) refuse(409, 'releasing');
      const { nonce, expiresAt } = requestWindow(b, now);
      await signedBy('ReleaseHandle', { handleId: row.handleId, serial: BigInt(row.serial!), nonce, expiresAt: BigInt(expiresAt) }, signature(b, 'signature'), row.owner!, a, expiresAt);
      onChainAs(rec, row, now);
      const range = claimDelayRange(c.env);
      const release = await releaseInput(b, chain, rec, row.handleId as Hex, row.owner!, now, range[1]);
      await a.registry.release({ handleId: row.handleId as Hex, identity: a.identity, installTag: a.installTag, owner: row.owner as Address, ...release, relayAt: now + randomDelayMs(range), now });
      return c.json({ ok: true, label: row.label, state: 'releasing' });
    }),
  );

  // ── rename (rule 7) ──────────────────────────────────────────────────────

  routes.post(
    '/:label/rename',
    handle('rename', async (c) => {
      const a = await admit(c, 'slow', ['install-proof', 'locator-pin']);
      const chain = chainOrRefuse(c);
      const { row, rec } = await ownOnChain(c, a, chain);
      const b = a.body;
      const now = deps.now();
      await claimLimits(a, now, 'rename');
      const newLabel = labelOf(b.newLabel);
      if (newLabel === row.label) refuse(400, 'bad_request', { field: 'newLabel' });
      const newHandleId = handleIdOf(newLabel);
      const newOwner = address(b, 'newOwner');
      const newMetaAddress = meta(b, 'newMetaAddress');
      if (newOwner.toLowerCase() === row.owner!.toLowerCase()) refuse(400, 'bad_request', { field: 'newOwner', hint: 'the next epoch\'s key' });
      const { nonce, expiresAt } = requestWindow(b, now);
      const message = {
        handleId: row.handleId,
        serial: BigInt(row.serial!),
        newLabel,
        newHandleId,
        newOwner,
        newMetaAddress,
        nonce,
        expiresAt: BigInt(expiresAt),
      };
      await signedBy('RenameHandle', message, signature(b, 'signature'), row.owner!, a, expiresAt);
      onChainAs(rec, row, now);
      const range = releaseDelayRange(c.env);
      const release = await releaseInput(b, chain, rec, row.handleId as Hex, row.owner!, now, range[1]);
      const claimBodyIn = b.claim && typeof b.claim === 'object' && !Array.isArray(b.claim) ? (b.claim as Body) : refuse(400, 'bad_request', { field: 'claim' });
      const { write } = await claimInput(c, a, { label: newLabel, owner: newOwner, metaAddress: newMetaAddress, claim: claimBodyIn }, chain, now);
      try {
        await a.registry.rename({ oldHandleId: row.handleId as Hex, claim: { ...write, renameOf: row.handleId as Hex }, release: { owner: row.owner as Address, ...release, relayAt: now + randomDelayMs(range) } });
      } catch (err) {
        if (err instanceof RegistryConflict) refuse(409, 'taken');
        throw err;
      }
      const statement = { oldHandleId: row.handleId, newHandleId, newSerial: BigInt(write.serial), newOwner, issuedAt: BigInt(Math.floor(now / 1000)) };
      const sameIdentity = {
        statement: { ...statement, newSerial: write.serial, issuedAt: Number(statement.issuedAt) },
        signature: await signRegistry(chain.registrar, HANDLES_CHAIN_ID, 'SameIdentity', statement),
      };
      return c.json({ ...claimAnswer(write), sameIdentity }, 201);
    }),
  );

  // ── the registrar's hold, renewal and veto (rule 3) ──────────────────────

  /** The registrar-paid sends on one record in a day: a High session cannot drain the registrar's gas. */
  async function registrarBudget(a: Admitted, handleId: string, now: number): Promise<void> {
    if ((await a.registry.registrarSends(handleId, now - 24 * 60 * 60 * 1000)) >= REGISTRAR_SENDS_PER_DAY) refuse(429, 'registrar_limit');
  }

  /** Send a registrar call, wait for its receipt (as the AA relay does), and answer by it. */
  async function sendAndWait(chain: AnchorChain, call: Parameters<AnchorChain['send']>[0]): Promise<{ txHash: Hex; receipt: 'success' | 'pending' }> {
    let txHash: Hex;
    try {
      txHash = await chain.send(call);
    } catch (err) {
      if (err instanceof AnchorRevert) refuse(409, 'anchor_refused', { reason: err.reason });
      throw err;
    }
    const receipt = await chain.waitReceipt(txHash!, RECEIPT_WAIT_MS);
    if (receipt === 'reverted') return refuse(409, 'anchor_refused', { reason: 'tx_reverted', txHash: txHash! });
    return { txHash: txHash!, receipt };
  }

  routes.post(
    '/:label/hold-record',
    handle('hold-record', async (c) => {
      // High only (q19: hold, veto and renewal stay High, so a user with only a linked phone can stop a thief).
      const a = await admit(c, 'slow', []);
      const chain = chainOrRefuse(c);
      // ASSUMPTION(0086 q13): a releasing record is watched and vetoed like an active one.
      const { row, rec } = await ownOnChain(c, a, chain, ['active', 'releasing']);
      const now = deps.now();
      const op = a.body.op;
      if (op !== 'hold' && op !== 'renew' && op !== 'veto') return refuse(400, 'bad_request', { field: 'op', hint: 'hold, renew or veto' });
      await registrarBudget(a, row.handleId, now);
      const deadline = BigInt(Math.floor(now / 1000) + 600);
      const id = row.handleId as Hex;
      let call: Parameters<AnchorChain['send']>[0];
      if (op === 'hold') {
        if (rec.pendingKind !== CHANGE_KIND.None) refuse(409, 'change_pending', { pendingNonce: rec.pendingNonce.toString() });
        if (rec.frozenUntil * 1000 > now) refuse(409, 'frozen', { frozenUntil: rec.frozenUntil });
        const sig = await signAnchor(chain.registrar, chain.chainId, chain.anchor, 'Hold', { handleId: id, nonce: rec.nonce, deadline });
        call = { functionName: 'hold', args: [id, deadline, sig] };
      } else if (op === 'renew') {
        if (rec.frozenUntil * 1000 <= now) refuse(409, 'not_frozen');
        const frozenUntil = BigInt(rec.frozenUntil);
        const sig = await signAnchor(chain.registrar, chain.chainId, chain.anchor, 'RenewHold', { handleId: id, frozenUntil, nonce: rec.nonce, deadline });
        call = { functionName: 'renewHold', args: [id, frozenUntil, deadline, sig] };
      } else {
        if (rec.pendingKind === CHANGE_KIND.None) refuse(409, 'no_pending_change');
        const pendingNonce = typeof a.body.pendingNonce === 'string' && /^\d{1,20}$/.test(a.body.pendingNonce) ? BigInt(a.body.pendingNonce) : rec.pendingNonce;
        if (pendingNonce !== rec.pendingNonce) refuse(409, 'pending_changed', { pendingNonce: rec.pendingNonce.toString() });
        const sig = await signAnchor(chain.registrar, chain.chainId, chain.anchor, 'Veto', { handleId: id, pendingNonce, nonce: rec.nonce, deadline });
        call = { functionName: 'veto', args: [id, pendingNonce, deadline, sig] };
      }
      // Recorded before the send: a veto that may land always counts against unfreeze (q15), and every send against the budget.
      await a.registry.recordFreeze(row.handleId, op, rec.owner, now);
      const sent = await sendAndWait(chain, call);
      handlesLog({ route: 'hold-record', op, receipt: sent.receipt });
      return c.json({ ok: true, ...sent }, sent.receipt === 'success' ? 200 : 202);
    }),
  );

  // ── the immediate advance (rule 3) ───────────────────────────────────────

  routes.post(
    '/:label/advance',
    handle('advance', async (c) => {
      const a = await admit(c, 'slow', ['install-proof', 'locator-pin']);
      const chain = chainOrRefuse(c);
      // ASSUMPTION(0086 q13): a releasing label is moved to the release key by an advance, and its release queued again.
      const { row, rec } = await ownOnChain(c, a, chain, ['active', 'releasing']);
      const b = a.body;
      const now = deps.now();
      const newOwner = address(b, 'newOwner');
      const newMetaAddress = meta(b, 'newMetaAddress');
      const deadline = uint(b, 'deadline');
      if (deadline <= Math.floor(now / 1000) || deadline > Math.floor(now / 1000) + 3600) refuse(400, 'bad_request', { field: 'deadline', hint: 'within the hour' });
      // An advance is open on a frozen record and clears a pending change (rule 3).
      const id = row.handleId as Hex;
      const fields = { handleId: id, newMetaAddress, nonce: rec.nonce, deadline: BigInt(deadline) };
      const ownerSig = signature(b, 'ownerSignature');
      const newOwnerSig = signature(b, 'newOwnerSignature');
      const o = await anchorSigner(HANDLES_CHAIN_ID, chain.anchor, 'Advance', { ...fields, newOwner }, ownerSig);
      if (!o || o.toLowerCase() !== row.owner!.toLowerCase()) refuse(401, 'bad_signature', { field: 'Advance' });
      const n = await anchorSigner(HANDLES_CHAIN_ID, chain.anchor, 'AdvanceAccept', { ...fields, previousOwner: rec.owner }, newOwnerSig);
      if (!n || n !== newOwner) refuse(401, 'bad_signature', { field: 'AdvanceAccept' });
      // A releasing label's release, signed by the new key at the nonce the advance leaves.
      let release: { deadline: string; ownerSig: Hex } | null = null;
      if (row.state === 'releasing') {
        const after = { ...rec, nonce: rec.nonce + 1n, owner: newOwner };
        release = await releaseInput(b, chain, after, id, newOwner, now, claimDelayRange(c.env)[1]);
      }
      await registrarBudget(a, row.handleId, now);
      const registrarSig = await signAnchor(chain.registrar, chain.chainId, chain.anchor, 'RegistrarAdvance', { ...fields, previousOwner: rec.owner, newOwner });
      await a.registry.recordFreeze(row.handleId, 'advance', rec.owner, now);
      let txHash: Hex;
      try {
        txHash = await chain.send({ functionName: 'advance', args: [id, newOwner, newMetaAddress, BigInt(deadline), ownerSig, newOwnerSig, registrarSig] });
      } catch (err) {
        if (err instanceof AnchorRevert) refuse(409, 'anchor_refused', { reason: err.reason });
        throw err;
      }
      // The row follows only once mined: the relay settles the job if the receipt is late.
      await a.registry.queueAdvance(id, { owner: newOwner, metaAddress: newMetaAddress, ...(release ? { releaseDeadline: release.deadline, releaseSig: release.ownerSig } : {}) }, txHash!, now);
      const receipt = await chain.waitReceipt(txHash!, RECEIPT_WAIT_MS);
      if (receipt === 'reverted') refuse(409, 'anchor_refused', { reason: 'tx_reverted', txHash: txHash! });
      if (receipt === 'success') await a.registry.settleAdvances(id, now, randomDelayMs(claimDelayRange(c.env)));
      return c.json({ ok: true, txHash: txHash!, receipt, owner: newOwner, metaAddress: newMetaAddress }, receipt === 'success' ? 200 : 202);
    }),
  );

  // ── unfreeze (q15) ───────────────────────────────────────────────────────

  routes.post(
    '/:label/unfreeze',
    handle('unfreeze', async (c) => {
      const a = await admit(c, 'slow', ['install-proof', 'locator-pin']);
      const chain = chainOrRefuse(c);
      const { row, rec } = await ownOnChain(c, a, chain, ['active', 'releasing']);
      const b = a.body;
      const now = deps.now();
      const frozenUntil = uint(b, 'frozenUntil');
      const deadline = uint(b, 'deadline');
      if (deadline <= Math.floor(now / 1000) || deadline > Math.floor(now / 1000) + 3600) refuse(400, 'bad_request', { field: 'deadline', hint: 'within the hour' });
      if (rec.frozenUntil * 1000 <= now) refuse(409, 'not_frozen');
      if (rec.frozenUntil !== frozenUntil) refuse(409, 'freeze_changed', { frozenUntil: rec.frozenUntil });
      // ASSUMPTION(0086 q15): never after a veto on this record (see `vetoed`).
      if (await a.registry.vetoed(row.handleId)) refuse(409, 'vetoed');
      const id = row.handleId as Hex;
      const fields = { handleId: id, frozenUntil: BigInt(frozenUntil), nonce: rec.nonce, deadline: BigInt(deadline) };
      const ownerSig = signature(b, 'ownerSignature');
      const o = await anchorSigner(HANDLES_CHAIN_ID, chain.anchor, 'Unfreeze', fields, ownerSig);
      if (!o || o.toLowerCase() !== row.owner!.toLowerCase()) refuse(401, 'bad_signature', { field: 'Unfreeze' });
      await registrarBudget(a, row.handleId, now);
      const registrarSig = await signAnchor(chain.registrar, chain.chainId, chain.anchor, 'RegistrarUnfreeze', fields);
      await a.registry.recordFreeze(row.handleId, 'unfreeze', rec.owner, now);
      const sent = await sendAndWait(chain, { functionName: 'unfreeze', args: [id, BigInt(frozenUntil), BigInt(deadline), ownerSig, registrarSig] });
      return c.json({ ok: true, ...sent }, sent.receipt === 'success' ? 200 : 202);
    }),
  );

  // ── the Verified statement (rule 9) ──────────────────────────────────────

  routes.post(
    '/:label/verified',
    handle('verified', async (c) => {
      const a = await admit(c, 'fast', []);
      const chain = chainOrRefuse(c);
      const { row } = await ownOnChain(c, a, chain);
      let bound: boolean;
      try {
        bound = await boundOf(c.env, a.account, a.session.chainId);
      } catch {
        return refuse(503, 'binding_check_unavailable');
      }
      const expiresAt = Math.floor(deps.now() / 1000) + VERIFIED_TTL_S;
      const message = { handleId: row.handleId, serial: BigInt(row.serial!), owner: getAddress(row.owner!), bound, expiresAt: BigInt(expiresAt) };
      const sig = await signRegistry(chain.registrar, HANDLES_CHAIN_ID, 'VerifiedStatement', message);
      return c.json({ ok: true, statement: { ...message, serial: row.serial, expiresAt }, signature: sig });
    }),
  );

  return routes;
}

function hexToBytes(hex: string): Uint8Array {
  const body = hex.slice(2);
  return Uint8Array.from(body.match(/../g) ?? [], (b) => parseInt(b, 16));
}

export const handlesWriteRoutes = createHandlesWriteRoutes();
