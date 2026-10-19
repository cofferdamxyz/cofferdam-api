// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

import { Hono } from 'hono';
import type { Env } from '../env.js';

export const localeRoutes = new Hono<{ Bindings: Env }>();

/**
 * The country this request comes from, as Cloudflare saw it (`request.cf.country`,
 * ISO 3166-1 alpha-2, or Cloudflare's own `XX` / `T1`). The app asks once at
 * onboarding to pick its number format (workspace decision 0046). No auth: the
 * answer only repeats what the caller's own connection shows. Nothing is
 * stored or logged, and the answer is never cached, since it follows the
 * connection.
 */
localeRoutes.get('/', (c) => {
  const country = c.req.raw.cf?.country;
  c.header('cache-control', 'no-store');
  return c.json({ country: typeof country === 'string' && country ? country : null });
});
