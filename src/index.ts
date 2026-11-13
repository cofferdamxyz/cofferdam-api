// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cofferdam API Worker — entry point.
 *
 * Hono app composed of feature-scoped sub-routers. New surfaces are
 * added by creating `src/routes/<feature>.ts` exporting a Hono
 * sub-router and mounting it here.
 *
 * Run locally: `yarn dev` (wrangler dev on :8787).
 * Deploy:     `yarn deploy` (wrangler deploy to Cloudflare).
 */

import { Hono, type Context } from 'hono';

// Durable Object classes must be exported from the Worker entry module.
export { BindBundleDO } from './services/bindBundleDO.js';
export { ActivityDO } from './services/activityDO.js';
export { ChatUsageDO } from './services/chatUsageDO.js';
export { PopReplayDO } from './services/popReplayDO.js';
export { VaultHandoffDO } from './services/vaultHandoffDO.js';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { BaseError } from 'viem';
import type { Env } from './env.js';
import { activityRoutes } from './routes/activity.js';
import { chatRoutes } from './routes/chat.js';
import { attesterRoutes } from './routes/attester.js';
import { ceremonyRoutes } from './routes/ceremony.js';
import { enterpriseRoutes } from './routes/enterprise.js';
import { healthRoutes } from './routes/health.js';
import { privacyRoutes } from './routes/privacy.js';
import { localeRoutes } from './routes/locale.js';
import { aaRoutes } from './routes/aa.js';
import { selfRoutes } from './routes/self.js';
import { sepoliaRoutes } from './routes/sepolia.js';
import { sessionRoutes } from './routes/session.js';
import { jobsRoutes } from './routes/jobs.js';
import { workRoutes } from './routes/work.js';
import { workListingRoutes } from './routes/workListing.js';
import { redactVaultPath, vaultRoutes } from './routes/vault.js';
import { identityLogLine, scrubIdentifiers } from './services/identityLog.js';

const app = new Hono<{ Bindings: Env }>();

// ── Global middleware ──────────────────────────────────────────────
// CORS: browser callers are Cofferdam's own hosts (the site, the hosted
// ceremony page) plus local dev servers under ENVIRONMENT=development. The
// native app, Self's relayer and other servers send no Origin header and are
// unaffected. Any other origin gets no Access-Control-Allow-Origin header.
const ALLOWED_ORIGINS = new Set(['https://cofferdam.xyz', 'https://www.cofferdam.xyz', 'https://id.cofferdam.xyz']);
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
export function allowOrigin(origin: string, c: Context<{ Bindings: Env }>): string | undefined {
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (c.env.ENVIRONMENT === 'development' && LOCAL_ORIGIN.test(origin)) return origin;
  return undefined;
}
app.use('*', cors({
  origin: allowOrigin,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

// Request log to Workers Logs. Cheap; very useful in dev. A Vault path names
// an account and an object, so its line drops both (routes/vault.ts).
app.use('*', logger((line) => console.log(redactVaultPath(line))));

// ── Root info ──────────────────────────────────────────────────────
app.get('/', (c) => {
  return c.json({
    service: 'cofferdam-api',
    version: '0.0.0',
    environment: c.env.ENVIRONMENT,
    routes: [
      { method: 'GET', path: '/health' },
      { method: 'GET', path: '/v1/locale' },
      { method: 'GET', path: '/sepolia/block-height' },
      { method: 'GET', path: '/sepolia/contracts' },
      { method: 'GET', path: '/v1/enterprise/resolve?domain=' },
      { method: 'GET', path: '/v1/enterprise/companies/:companyAnchor' },
      { method: 'POST', path: '/v1/enterprise/links' },
      { method: 'GET', path: '/v1/enterprise/links?companyAnchor=' },
      { method: 'GET', path: '/v1/enterprise/links/check?companyAnchor=&consumerId=' },
      { method: 'POST', path: '/v1/enterprise/links/:companyAnchor/:consumerId/revoke' },
      { method: 'GET', path: '/v1/activity?address=' },
      { method: 'GET', path: '/v1/activity/check?address=&sinceBlock=' },
      { method: 'POST', path: '/v1/activity/webhooks/cdp' },
      { method: 'POST', path: '/v1/chat' },
      { method: 'GET', path: '/v1/chat/usage?account=' },
      { method: 'POST', path: '/v1/attester/test-sign', environment: 'development' },
      { method: 'POST', path: '/v1/self/verify' },
      { method: 'GET', path: '/v1/self/bind-bundle/:account' },
      { method: 'POST', path: '/v1/session/verify-attestation' },
      { method: 'POST', path: '/v1/aa/user-operation' },
      { method: 'POST', path: '/v1/ceremony/first-high' },
      { method: 'POST', path: '/v1/work/parse' },
      { method: 'POST', path: '/v1/work/document' },
      { method: 'POST', path: '/v1/work/classify' },
      { method: 'POST', path: '/v1/work/extract' },
      { method: 'PUT', path: '/v1/work/listing' },
      { method: 'DELETE', path: '/v1/work/listing' },
      { method: 'POST', path: '/v1/jobs/intent' },
      { method: 'GET', path: '/v1/privacy/ai' },
      { method: 'PUT', path: '/v1/vault/:account/objects/:kind/:id' },
      { method: 'GET', path: '/v1/vault/:account/objects/:kind/:id' },
      { method: 'HEAD', path: '/v1/vault/:account/objects/:kind/:id' },
      { method: 'DELETE', path: '/v1/vault/:account/objects/:kind/:id' },
      { method: 'POST', path: '/v1/vault/:account/list' },
      { method: 'DELETE', path: '/v1/vault/:account' },
      { method: 'PUT', path: '/v1/vault/:account/handover/:keyHash' },
      { method: 'GET', path: '/v1/vault/:account/handover/:keyHash' },
    ],
    docs: 'https://github.com/cofferdamxyz/cofferdam-api/blob/main/README.md',
  });
});

// ── Sub-routers ────────────────────────────────────────────────────
app.route('/health', healthRoutes);
app.route('/v1/privacy', privacyRoutes);
app.route('/sepolia', sepoliaRoutes);
app.route('/v1/attester', attesterRoutes);
app.route('/v1/self', selfRoutes);
app.route('/v1/enterprise', enterpriseRoutes);
app.route('/v1/activity', activityRoutes);
app.route('/v1/chat', chatRoutes);
app.route('/v1/session', sessionRoutes);
app.route('/v1/aa', aaRoutes);
app.route('/v1/ceremony', ceremonyRoutes);
app.route('/v1/locale', localeRoutes);
app.route('/v1/work', workRoutes);
app.route('/v1/work', workListingRoutes);
app.route('/v1/jobs', jobsRoutes);
app.route('/v1/vault', vaultRoutes);

// ── 404 ────────────────────────────────────────────────────────────
app.notFound((c) => c.json({ ok: false, error: 'not_found' }, 404));

// ── 500 ────────────────────────────────────────────────────────────
/** Identity routes, whose unhandled errors are logged under the identity log policy (`services/identityLog.ts`). */
const IDENTITY_ROUTE = /^\/v1\/(self|aa|attester)(\/|$)/;

app.onError((err, c) => {
  if (IDENTITY_ROUTE.test(c.req.path)) {
    // A viem error's message carries the request's arguments (an op's call
    // data, a proof, a nullifier): log its name and short message, cut.
    const short = err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err);
    console.error(
      identityLogLine({
        event: 'unhandled',
        route: c.req.path.split('/').slice(0, 4).join('/'),
        name: err instanceof Error ? err.name : typeof err,
        message: scrubIdentifiers(short),
      }),
    );
  } else {
    console.error('[cofferdam-api] unhandled', err);
  }
  return c.json(
    {
      ok: false,
      error: 'internal_error',
      message: err instanceof Error ? err.message : String(err),
    },
    500,
  );
});

export default app;
