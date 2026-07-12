// Copyright (c) 2026 OffshoreSync LLC
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

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { Env } from './env.js';
import { activityRoutes } from './routes/activity.js';
import { attesterRoutes } from './routes/attester.js';
import { enterpriseRoutes } from './routes/enterprise.js';
import { healthRoutes } from './routes/health.js';
import { relayerRoutes } from './routes/relayer.js';
import { sepoliaRoutes } from './routes/sepolia.js';
import { sessionRoutes } from './routes/session.js';

const app = new Hono<{ Bindings: Env }>();

// ── Global middleware ──────────────────────────────────────────────
// CORS — permissive for now (RN app fetches with no Origin header in
// some environments; localhost dev uses arbitrary ports). Tightened to
// an explicit allowlist (cofferdam-app + cofferdam-pages production
// hosts) once those domains are live.
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

// Request log to Workers Logs. Cheap; very useful in dev.
app.use('*', logger());

// ── Root info ──────────────────────────────────────────────────────
app.get('/', (c) => {
  return c.json({
    service: 'cofferdam-api',
    version: '0.0.0',
    environment: c.env.ENVIRONMENT,
    routes: [
      { method: 'GET', path: '/health' },
      { method: 'GET', path: '/sepolia/block-height' },
      { method: 'GET', path: '/sepolia/contracts' },
      { method: 'GET', path: '/v1/enterprise/resolve?domain=' },
      { method: 'GET', path: '/v1/enterprise/companies/:companyAnchor' },
      { method: 'POST', path: '/v1/enterprise/links' },
      { method: 'GET', path: '/v1/enterprise/links?companyAnchor=' },
      { method: 'GET', path: '/v1/enterprise/links/check?companyAnchor=&consumerId=' },
      { method: 'POST', path: '/v1/enterprise/links/:companyAnchor/:consumerId/revoke' },
      { method: 'GET', path: '/v1/activity?address=' },
      { method: 'POST', path: '/v1/attester/test-sign' },
      { method: 'POST', path: '/v1/session/verify-attestation' },
      { method: 'POST', path: '/v1/relayer/setup-investments' },
    ],
    docs: 'See cofferdam-app/backend/README.md',
  });
});

// ── Sub-routers ────────────────────────────────────────────────────
app.route('/health', healthRoutes);
app.route('/sepolia', sepoliaRoutes);
app.route('/v1/attester', attesterRoutes);
app.route('/v1/enterprise', enterpriseRoutes);
app.route('/v1/activity', activityRoutes);
app.route('/v1/session', sessionRoutes);
app.route('/v1/relayer', relayerRoutes);

// ── 404 ────────────────────────────────────────────────────────────
app.notFound((c) => c.json({ ok: false, error: 'not_found' }, 404));

// ── 500 ────────────────────────────────────────────────────────────
app.onError((err, c) => {
  console.error('[cofferdam-api] unhandled', err);
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
