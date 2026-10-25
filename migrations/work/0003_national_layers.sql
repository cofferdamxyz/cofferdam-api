-- National alias layers over the ESCO spine (workspace decision 0066). A market's own
-- occupation classification (O*NET in the US, then Brazil's CBO and Mexico's SINCO)
-- adds labels and codes to ESCO's tokens, never a second token space.

-- A layer's label is an alternative label of its token, tagged with where it comes from
-- (source: the layer, its release and the national code, e.g. 'onet:31.0:47-2152.00') and
-- the region whose words it is ('us', 'br', 'mx'). ESCO's own labels, the certificate
-- seed's and the aliases snaps observe leave both NULL.
ALTER TABLE registry_labels ADD COLUMN source TEXT;
ALTER TABLE registry_labels ADD COLUMN region TEXT;
CREATE INDEX registry_labels_source ON registry_labels (source);

-- A token's codes in the national classifications, with how the crosswalk matched them:
-- exact, close, broad (the national occupation is wider than the token), narrow (it is
-- narrower) or isco (the crosswalk named only the ISCO-08 unit group). Codes come only
-- from the official files; a model never writes one.
CREATE TABLE registry_codes (
  token TEXT NOT NULL REFERENCES registry_tokens (token),
  -- The classification and its version: 'onet-soc-2019', later 'cbo-2002', 'sinco-2019'.
  scheme TEXT NOT NULL,
  code TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('exact', 'close', 'broad', 'narrow', 'isco')),
  -- The crosswalk or correspondence the pair comes from, e.g. 'esco-onet-crosswalk-v1'.
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (token, scheme, code)
);
CREATE INDEX registry_codes_code ON registry_codes (scheme, code);
