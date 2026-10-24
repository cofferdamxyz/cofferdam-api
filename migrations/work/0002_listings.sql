-- Published Work listings (workspace docs/product/engine.md, S4, E3 and E10; decision
-- 0019). One row per published listing, deleted when the worker turns Looking for work
-- off. The listing is the disclosure unit: the row holds what the matcher may read and
-- nothing from the CV beyond it. Keyed by the account's Work pseudonym and a profile id
-- from the first build, so several listings per account (Work Profiles) need no migration.

CREATE TABLE listings (
  -- Also the jobs-listings-v1 vector id; derived from (pseudonym, profile_id).
  listing_id TEXT PRIMARY KEY,
  pseudonym TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  -- The coarse region (us-tx, br-sp, mx) and the scope; the namespace is both.
  region TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('onsite', 'remote')),
  namespace TEXT NOT NULL,
  -- Personhood tier: 0 unbound, 1 bound, 2 bound with verified experience.
  tier INTEGER NOT NULL CHECK (tier IN (0, 1, 2)),
  -- JSON array: the exact token list the certificate confirm reads (E10).
  tokens TEXT NOT NULL,
  -- The embedding model the vector was made with; a change is a re-embed.
  embed_model TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (pseudonym, profile_id)
);
CREATE INDEX listings_namespace ON listings (namespace);
