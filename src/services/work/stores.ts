// Copyright (c) 2026 Cofferdam Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Work plane's stores as the routes reach them (decisions 0018 and 0019):
 * D1 `WORK_DB` (`cofferdam-work`: the registry rows and the listing records),
 * Vectorize `TOKEN_REGISTRY` (`token-registry-v1`) and `JOBS_LISTINGS`
 * (`jobs-listings-v1`). Each is null while its binding is commented in
 * `wrangler.jsonc`, and a route that needs it answers `503` with its
 * `UNPROVISIONED` code instead of failing on the first call.
 */

import type { Env } from '../../env.js';
import { D1ListingStore, type ListingStore } from './listings.js';
import { D1RegistryStore, vectorizeIndex, type RegistryStore, type VectorIndex } from './registry.js';

export interface WorkStores {
  /** D1 `WORK_DB`: the token registry's rows. */
  registry: RegistryStore | null;
  /** D1 `WORK_DB`: the listing records. */
  listings: ListingStore | null;
  /** Vectorize `TOKEN_REGISTRY`. */
  tokenIndex: VectorIndex | null;
  /** Vectorize `JOBS_LISTINGS`. */
  listingIndex: VectorIndex | null;
}

export type BoundWorkStores = { [K in keyof WorkStores]: NonNullable<WorkStores[K]> };

export function envWorkStores(env: Env): WorkStores {
  return {
    registry: env.WORK_DB ? new D1RegistryStore(env.WORK_DB) : null,
    listings: env.WORK_DB ? new D1ListingStore(env.WORK_DB) : null,
    tokenIndex: env.TOKEN_REGISTRY ? vectorizeIndex(env.TOKEN_REGISTRY) : null,
    listingIndex: env.JOBS_LISTINGS ? vectorizeIndex(env.JOBS_LISTINGS) : null,
  };
}

export type WorkStoreName = 'WORK_DB' | 'TOKEN_REGISTRY' | 'JOBS_LISTINGS';

/** The `503` error code of an unbound store. */
export const UNPROVISIONED: Record<WorkStoreName, string> = {
  WORK_DB: 'work_db_unprovisioned',
  TOKEN_REGISTRY: 'token_registry_unprovisioned',
  JOBS_LISTINGS: 'jobs_listings_unprovisioned',
};

/** Every store (publish and the hirer query need them all), or the first one unbound. */
export function allStores(s: WorkStores): BoundWorkStores | WorkStoreName {
  if (!s.registry || !s.listings) return 'WORK_DB';
  if (!s.tokenIndex) return 'TOKEN_REGISTRY';
  if (!s.listingIndex) return 'JOBS_LISTINGS';
  return { registry: s.registry, listings: s.listings, tokenIndex: s.tokenIndex, listingIndex: s.listingIndex };
}

/** What taking a listing down needs, the records and their index, or the first one unbound. */
export function listingStores(s: WorkStores): Pick<BoundWorkStores, 'listings' | 'listingIndex'> | WorkStoreName {
  if (!s.listings) return 'WORK_DB';
  if (!s.listingIndex) return 'JOBS_LISTINGS';
  return { listings: s.listings, listingIndex: s.listingIndex };
}
