// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * cofferdam-xmtp-cleanup: deletes expired XMTP envelopes every hour
 * (workspace decision 0042; design in the project file
 * xmtp-hosting/message-cleanup-job.md). The XMTP backend stamps expiry_ns and
 * never deletes; this applies it.
 *
 * Hyperdrive is right here, unlike for the backend: the job is short,
 * transaction-scoped SQL with no session state. Query caching is off on that
 * Hyperdrive config (a DELETE … RETURNING must never be served from cache).
 *
 * It logs one line per run with counts only: no topic, no id, nothing about a
 * user. Alert on zero deletions for several days while the database grows.
 *
 * Each run first checks the schema (health.ts) and stores the result under the
 * `health` key; before the backend's first boot has migrated the database it
 * skips the deletion instead of failing. `GET /health` answers the same check
 * live. The Worker has no route and no workers.dev URL, so that is reachable
 * only from the Mac: `npx wrangler dev --remote`, then curl localhost:8787/health.
 */

import { Client } from 'pg';

import { checkDatabase, cleanupBlockedBy } from './health.js';
import { runCleanup, type CleanupConfig, type CleanupState, type Query } from './run.js';

export interface Env {
  HYPERDRIVE: Hyperdrive;
  /** One key, `state`: the per-kind resume points and the retention fingerprint. */
  CLEANUP_STATE: KVNamespace;
  RETENTION_GROUP_MESSAGE_SECONDS: string;
  RETENTION_WELCOME_SECONDS: string;
  RETENTION_KEY_PACKAGE_SECONDS: string;
  GRACE_SECONDS?: string;
  BATCH_SIZE?: string;
  /** "off" only if the backend runs without [push]. */
  PUSH_CURSOR_GUARD?: string;
}

const STATE_KEY = 'state';
const HEALTH_KEY = 'health';

function positive(name: string, value: string | undefined, fallback?: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (n === undefined || !Number.isInteger(n) || n <= 0) throw new Error(`xmtp-cleanup: bad ${name}`);
  return n;
}

export function configFrom(env: Env): CleanupConfig {
  return {
    retention: {
      groupMessageS: positive('RETENTION_GROUP_MESSAGE_SECONDS', env.RETENTION_GROUP_MESSAGE_SECONDS),
      welcomeS: positive('RETENTION_WELCOME_SECONDS', env.RETENTION_WELCOME_SECONDS),
      keyPackageS: positive('RETENTION_KEY_PACKAGE_SECONDS', env.RETENTION_KEY_PACKAGE_SECONDS),
    },
    graceS: positive('GRACE_SECONDS', env.GRACE_SECONDS, 7 * 86400),
    marginS: 3600,
    batch: positive('BATCH_SIZE', env.BATCH_SIZE, 5000),
    budgetMs: 45_000,
    pushCursorGuard: env.PUSH_CURSOR_GUARD !== 'off',
  };
}

async function withClient<T>(env: Env, ctx: ExecutionContext, use: (query: Query) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  try {
    return await use(async (text, params) => (await client.query<Record<string, unknown>>(text, params)).rows);
  } finally {
    ctx.waitUntil(client.end());
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cfg = configFrom(env);
    await withClient(env, ctx, async (query) => {
      const health = await checkDatabase(query);
      await env.CLEANUP_STATE.put(HEALTH_KEY, JSON.stringify(health));
      const blocked = cleanupBlockedBy(health, cfg.pushCursorGuard);
      if (blocked.length > 0) {
        // Before the backend's first boot: nothing to delete yet, and no error.
        console.log(JSON.stringify({ job: 'xmtp-cleanup', skipped: 'schema_missing', missing: blocked.length }));
        return;
      }
      const previous = await env.CLEANUP_STATE.get<CleanupState>(STATE_KEY, 'json');
      const report = await runCleanup(query, cfg, previous);
      await env.CLEANUP_STATE.put(STATE_KEY, JSON.stringify(report.state));
      console.log(JSON.stringify({ job: 'xmtp-cleanup', ...report.deleted, timedOut: report.timedOut }));
    });
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/health') return new Response(null, { status: 404 });
    const health = await withClient(env, ctx, (query) => checkDatabase(query));
    return Response.json(health, { status: health.ok ? 200 : 503, headers: { 'cache-control': 'no-store' } });
  },
} satisfies ExportedHandler<Env>;
