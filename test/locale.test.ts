import { describe, expect, it } from 'vitest';

import { localeRoutes } from '../src/routes/locale.js';

function request(cf?: Record<string, unknown>): Request {
  const req = new Request('https://api.cofferdam.xyz/');
  if (cf) Object.defineProperty(req, 'cf', { value: cf });
  return req;
}

describe('GET /v1/locale', () => {
  it('returns the country Cloudflare saw, uncached', async () => {
    const res = await localeRoutes.fetch(request({ country: 'BR', colo: 'GRU' }), {} as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ country: 'BR' });
  });

  it('returns null when the request carries no country', async () => {
    const res = await localeRoutes.fetch(request(), {} as never);
    expect(await res.json()).toEqual({ country: null });
  });
});
