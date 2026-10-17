// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The chat gate's five-minute memory of a passed authority check.
 *
 * The check reads the account's authorities on Base one call at a time, which
 * cost about 2 s per turn on the public node (deployed plane, 2026-10-17). A
 * chat turn only spends Workers AI, so the chat remembers a passed check for
 * five minutes per account, scheme and key: a device revoked on chain keeps
 * chatting for at most that long. Only chat uses it; the bind-bundle pickup,
 * `verify-attestation` and anything that moves funds keep reading Base live.
 *
 * Two levels: this isolate's map, then the data centre's Cache API (shared by
 * the isolates there; a no-op on workers.dev). Keys are hashed, and the cache
 * URL sits under `/v1/`, where only this Worker answers public requests.
 */

import type { AuthorityCheck } from '../authorityCheck.js';
import type { SessionAttestation } from '../sessionAttestation.js';

export const CHAT_AUTHORITY_TTL_MS = 5 * 60_000;

export interface AuthorityMemo {
  get(att: SessionAttestation): Promise<AuthorityCheck | null>;
  put(att: SessionAttestation, check: AuthorityCheck): Promise<void>;
}

/** Account, scheme and key: the same facts the on-chain check matches. */
export function authorityKey(att: SessionAttestation): string {
  return [att.accountAddress, att.alg, att.publicKey.qx, att.publicKey.qy].join(':').toLowerCase();
}

async function digest(key: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const MAX_LOCAL = 1_000;

interface Entry {
  check: AuthorityCheck;
  until: number;
}

export interface MemoOptions {
  now?: () => number;
  ttlMs?: number;
  /** The Cache API; defaults to `caches.default` where the runtime has it. */
  edge?: Cache | null;
  /** Origin of the synthetic cache URL. */
  origin?: string;
}

export function createAuthorityMemo(opts: MemoOptions = {}): AuthorityMemo {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? CHAT_AUTHORITY_TTL_MS;
  const edge =
    opts.edge !== undefined
      ? opts.edge
      : typeof caches !== 'undefined'
        ? ((caches as unknown as { default?: Cache }).default ?? null)
        : null;
  const origin = opts.origin ?? 'https://cofferdam.xyz';
  const local = new Map<string, Entry>();
  const url = async (key: string) => `${origin}/v1/__cache/chat-authority/${await digest(key)}`;

  return {
    async get(att) {
      const key = authorityKey(att);
      const hit = local.get(key);
      if (hit && hit.until > now()) return hit.check;
      if (hit) local.delete(key);
      if (!edge) return null;
      try {
        const res = await edge.match(await url(key));
        if (!res) return null;
        const entry = (await res.json()) as Entry;
        if (!(entry.until > now())) return null;
        local.set(key, entry);
        return entry.check;
      } catch {
        return null;
      }
    },
    async put(att, check) {
      const key = authorityKey(att);
      const entry: Entry = { check, until: now() + ttlMs };
      local.set(key, entry);
      if (local.size > MAX_LOCAL) local.delete(local.keys().next().value!);
      if (!edge) return;
      try {
        await edge.put(
          await url(key),
          new Response(JSON.stringify(entry), {
            headers: { 'content-type': 'application/json', 'cache-control': `max-age=${Math.ceil(ttlMs / 1000)}` },
          }),
        );
      } catch {
        // The isolate's map still holds it.
      }
    },
  };
}
