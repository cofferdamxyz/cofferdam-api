-- The Cofferdam Work token registry (workspace decision 0018, docs/product/engine.md,
-- Token registry). ESCO is the spine: occupations and skills are pre-minted from the
-- official ESCO export with their esco: URI and derived isco: code, which no model
-- ever writes. Emergent tokens fill what ESCO lacks; certificates come from a curated
-- seed and are never minted. Apply with:
--   wrangler d1 migrations apply cofferdam-work --remote

CREATE TABLE registry_tokens (
  -- Lower case, hyphenated, prefixed: pos:marine-engineer, skill:welding, cert:bosiet.
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('pos', 'skill', 'cert')),
  source TEXT NOT NULL CHECK (source IN ('esco', 'emergent', 'seed')),
  -- The international-English pivot (industry_english_title).
  label_en TEXT NOT NULL,
  -- From the ESCO export only.
  esco_uri TEXT UNIQUE,
  -- ISCO-08 unit group (four digits), derived from the ESCO export only.
  isco_code TEXT CHECK (isco_code IS NULL OR (length(isco_code) = 4 AND isco_code GLOB '[0-9][0-9][0-9][0-9]')),
  -- pending: minted, waiting for review and an isco code; merged: drift resolved into merged_into.
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'merged')),
  merged_into TEXT REFERENCES registry_tokens (token),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (kind <> 'cert' OR source = 'seed'),
  CHECK (source <> 'esco' OR esco_uri IS NOT NULL),
  CHECK ((status = 'merged') = (merged_into IS NOT NULL))
);

-- Every label a token is known by, per language: the alias table. An embedded label
-- (ESCO, the seed, a minted token's own labels) is one token-registry-v1 vector whose id
-- is label_id; an observed alias needs no vector, the exact-label shortcut finds it.
CREATE TABLE registry_labels (
  label_id TEXT PRIMARY KEY,
  embedded INTEGER NOT NULL DEFAULT 0 CHECK (embedded IN (0, 1)),
  token TEXT NOT NULL REFERENCES registry_tokens (token),
  lang TEXT NOT NULL,
  -- As ESCO, the seed or a CV wrote it (original_raw_title).
  label TEXT NOT NULL,
  -- Accents folded, lower case, runs of space collapsed: the exact-label shortcut.
  label_norm TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('preferred', 'alternative', 'hidden', 'observed')),
  created_at INTEGER NOT NULL
);
CREATE INDEX registry_labels_norm ON registry_labels (label_norm);
CREATE INDEX registry_labels_token ON registry_labels (token);

-- Every decision the canonicalizer took, for review, tau tuning and the alias table.
-- raw is a title, skill or certificate as a published listing or intent wrote it;
-- no account, document or listing id is kept with it.
CREATE TABLE registry_decisions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('pos', 'skill', 'cert')),
  raw TEXT NOT NULL,
  lang TEXT NOT NULL,
  -- label: an exact known label; auto: cosine at or above tau_auto; chosen: Clef picked a
  -- candidate in the band; pivot: the English pivot named an existing token; minted: a
  -- new pending token; unmatched: no token (always so for a certificate below the band).
  decision TEXT NOT NULL CHECK (decision IN ('label', 'auto', 'chosen', 'pivot', 'minted', 'unmatched')),
  token TEXT REFERENCES registry_tokens (token),
  specialization INTEGER NOT NULL DEFAULT 0,
  -- The best candidate's cosine, and Clef's probability when Clef chose.
  score REAL,
  probability REAL,
  -- JSON: [{"token": "...", "score": 0.93}, ...]
  candidates TEXT NOT NULL DEFAULT '[]',
  model TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX registry_decisions_token ON registry_decisions (token);
CREATE INDEX registry_decisions_created ON registry_decisions (created_at);
