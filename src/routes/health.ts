// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from 'hono';
import type { Env } from '../env.js';

export const healthRoutes = new Hono<{ Bindings: Env }>();

/**
 * Liveness probe. Returns enough metadata for the RN app + uptime
 * checks to confirm the Worker is up and which environment served the
 * request.
 */
healthRoutes.get('/', (c) => {
  return c.json({
    ok: true,
    service: 'cofferdam-api',
    environment: c.env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
    region: c.req.raw.cf?.colo ?? null,
  });
});
