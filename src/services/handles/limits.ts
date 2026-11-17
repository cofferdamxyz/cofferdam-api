// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The rate limits of the handle registry's public routes (workspace decision
 * 0086, rule 4): Cloudflare's rate-limiting binding, whose window is 10 or 60
 * seconds, so no per-IP limit runs longer than a minute and no IP is stored.
 * A global brake (`HANDLES_GLOBAL_RL`) first, then a per-IP ceiling
 * (`HANDLES_IP_RL`), each route family on keys of its own. Any daily bound is a
 * per-handle counter in `HANDLES_DB` (none is built yet: the routes that would
 * count one, the pay link and `self`, wait on step 3's signer parts).
 *
 * A limiter that throws lets the request through, as every limiter in the
 * plane does (`routes/vault.ts`): the binding is a brake, not a gate.
 */

import type { Context } from 'hono';

import type { Env } from '../../env.js';

export type PublicFamily = 'handles' | 'handshake' | 'announce';

async function over(rl: RateLimit | undefined, key: string): Promise<boolean> {
  if (!rl) return false;
  try {
    const { success } = await rl.limit({ key });
    return !success;
  } catch {
    return false;
  }
}

/** A `429 rate_limited` when the family's global brake or this IP's ceiling is spent, else null. */
export async function publicLimit(c: Context<{ Bindings: Env }>, family: PublicFamily): Promise<Response | null> {
  const ip = c.req.header('cf-connecting-ip');
  if ((await over(c.env.HANDLES_GLOBAL_RL, `${family}:global`)) || (ip && (await over(c.env.HANDLES_IP_RL, `${family}-ip:${ip}`)))) {
    return c.json({ ok: false, error: 'rate_limited', retryAfterSeconds: 10 }, 429, { 'cache-control': 'no-store' });
  }
  return null;
}

/** One JSON log line of a handle route: counts and codes only, never a label, a token, an inbox id or an IP. */
export function handlesLog(fields: Record<string, string | number | boolean>): void {
  console.log(JSON.stringify({ kind: 'handles', ...fields }));
}
