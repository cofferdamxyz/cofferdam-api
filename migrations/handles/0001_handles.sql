-- The handle registry on the plane (workspace decision 0086, rule 4; runbook
-- docs/runbooks/handles-build.md, step 3). D1 `cofferdam-handles`, binding
-- HANDLES_DB, apart from WORK_DB and from 0083 R10's address map. No account,
-- no address, no name, no avatar and no IP is stored here: a row names a label,
-- its handle id, the pinned handle key and a random identity id, which only the
-- address map ties to accounts.
--
-- Built on 2026-11-17 before questions 11 to 23 are ruled; the schema takes the
-- recommended options and says so beside each (ASSUMPTION lines).

-- ── One row per label ────────────────────────────────────────────────────────
CREATE TABLE handles (
  -- The ENSIP-15 normalised label without `@`: a-z, 0-9 and the hyphen, 3 to 64
  -- characters, no hyphen at either end, no `--` in places three and four.
  label TEXT PRIMARY KEY CHECK (length(label) BETWEEN 3 AND 64),
  -- keccak256("cofferdam-handle-v1:" || label), 0x and 64 lower-case hex (rule 2).
  handle_id TEXT NOT NULL UNIQUE CHECK (handle_id GLOB '0x[0-9a-f]*' AND length(handle_id) = 66),
  -- The random identity id (rule 4), minted in the address map at the identity's
  -- first claim or first job; never an account, never a hash of a passport identifier.
  identity TEXT NOT NULL,
  -- held: onboarding's reservation, in the registry only, nothing on chain
  --   (ASSUMPTION(0086 q20): the recommended `held` state, 14 days, one per identity).
  -- active: claimed; `onchain` says whether the anchor's claim has landed.
  -- releasing: the old label of a rename while its `release` waits (resolves to nothing,
  --   ASSUMPTION(0086 q13)).
  -- quarantined: released on chain; claimable again 365 days after `released_at`.
  -- reserved: kept by Cofferdam (a reassignment after `forceRelease`, rule 3).
  state TEXT NOT NULL CHECK (state IN ('held', 'active', 'releasing', 'quarantined', 'reserved')),
  -- The anchor's serial (rule 3); null while held.
  serial INTEGER CHECK (serial IS NULL OR serial >= 1),
  -- The pinned handle key's address, 0x and 40 lower-case hex.
  owner TEXT CHECK (owner IS NULL OR (owner GLOB '0x[0-9a-f]*' AND length(owner) = 42)),
  -- ERC-5564 scheme 1 meta-address: spending then viewing key, 33 bytes each
  -- compressed, 0x and 132 lower-case hex (rule 1). Null while held.
  meta_address TEXT CHECK (meta_address IS NULL OR (meta_address GLOB '0x[0-9a-f]*' AND length(meta_address) = 134)),
  -- 0 while the claim is queued for the relay, 1 once the anchor holds it.
  -- ASSUMPTION(0086 q22): a queued claim resolves with its pending owner, marked unchecked.
  onchain INTEGER NOT NULL DEFAULT 0 CHECK (onchain IN (0, 1)),
  -- "Let people find me" (rule 6), off by default; the Tier 1 inbox id only while on.
  discoverable INTEGER NOT NULL DEFAULT 0 CHECK (discoverable IN (0, 1)),
  inbox_id TEXT,
  -- For a held label: when the hold lapses (q20: 14 days from onboarding).
  held_until INTEGER,
  -- When the anchor's release took effect, for the 365-day quarantine (rule 3).
  released_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (discoverable = 1 OR inbox_id IS NULL),
  CHECK ((state = 'held') = (held_until IS NOT NULL)),
  -- A held label has nothing on chain and no keys published yet; any other state has them.
  CHECK (state = 'held' OR state = 'reserved' OR (serial IS NOT NULL AND owner IS NOT NULL AND meta_address IS NOT NULL)),
  CHECK (state <> 'held' OR onchain = 0),
  CHECK (state <> 'quarantined' OR released_at IS NOT NULL)
);

-- One label per identity at a time, held or active (rule 4, q5; q20 counts a held
-- label too). A releasing row does not count, so a rename claims the new label at once.
CREATE UNIQUE INDEX handles_one_per_identity ON handles (identity) WHERE state IN ('held', 'active');
CREATE INDEX handles_held_until ON handles (held_until) WHERE state = 'held';
-- Search by prefix runs only over discoverable, active rows (rule 6).
CREATE INDEX handles_discoverable ON handles (label) WHERE discoverable = 1 AND state = 'active';

-- ── The hold log (q20) ───────────────────────────────────────────────────────
-- ASSUMPTION(0086 q20): a held label counts against the per-install and
-- per-identity limits over a rolling 30 days, and after a hold lapses the same
-- identity and install cannot hold that label again for 30 days. The `handles`
-- row of a lapsed hold is deleted; this log keeps what the limits read, and its
-- rows are deleted 31 days after they end. `install_tag` is the future held
-- route's keyed hash of the device assertion's key id, never the id itself.
CREATE TABLE handle_holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  identity TEXT NOT NULL,
  install_tag TEXT NOT NULL,
  held_at INTEGER NOT NULL,
  held_until INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('claimed', 'lapsed', 'released')),
  CHECK ((ended_at IS NULL) = (outcome IS NULL))
);
CREATE INDEX handle_holds_identity ON handle_holds (identity, held_at);
CREATE INDEX handle_holds_install ON handle_holds (install_tag, held_at);
CREATE INDEX handle_holds_label ON handle_holds (label, ended_at);
CREATE INDEX handle_holds_open ON handle_holds (held_until) WHERE outcome IS NULL;

-- ── The reserved list (rule 4, q9) ───────────────────────────────────────────
-- Labels nobody may claim or hold: Cofferdam's own names, the plane's route
-- words under /v1/handles, roles people trust, and names payers would take for a
-- service they already know. The founder edits this list; a later migration adds
-- to it. Every entry is already in the stored form.
CREATE TABLE reserved_labels (
  label TEXT PRIMARY KEY CHECK (length(label) BETWEEN 3 AND 64),
  reason TEXT NOT NULL CHECK (reason IN ('brand', 'route', 'role', 'service'))
);
INSERT INTO reserved_labels (label, reason) VALUES
  ('cofferdam', 'brand'), ('cofferdam-inc', 'brand'), ('cofferdamxyz', 'brand'), ('cofferdam-work', 'brand'),
  ('cofferdam-wallet', 'brand'), ('cofferdam-cloud', 'brand'), ('cofferdam-passport', 'brand'), ('coff', 'brand'),
  ('available', 'route'), ('search', 'route'), ('claim', 'route'), ('inbox', 'route'), ('self', 'route'),
  ('pending', 'route'), ('held', 'route'), ('hold', 'route'), ('links', 'route'), ('verified', 'role'),
  ('admin', 'role'), ('administrator', 'role'), ('root', 'role'), ('system', 'role'), ('support', 'role'),
  ('help', 'role'), ('helpdesk', 'role'), ('security', 'role'), ('official', 'role'), ('team', 'role'),
  ('staff', 'role'), ('moderator', 'role'), ('mod', 'role'), ('abuse', 'role'), ('legal', 'role'),
  ('privacy', 'role'), ('compliance', 'role'), ('billing', 'role'), ('payments', 'role'), ('payment', 'role'),
  ('pay', 'role'), ('wallet', 'role'), ('treasury', 'role'), ('escrow', 'role'), ('arbiter', 'role'),
  ('registrar', 'role'), ('verify', 'role'), ('verification', 'role'), ('account', 'role'), ('accounts', 'role'),
  ('recovery', 'role'), ('noreply', 'role'), ('no-reply', 'role'), ('info', 'role'), ('contact', 'role'),
  ('hello', 'role'), ('news', 'role'), ('status', 'role'), ('settings', 'role'), ('profile', 'role'),
  ('everyone', 'role'), ('anonymous', 'role'), ('unknown', 'role'), ('null', 'role'), ('undefined', 'role'),
  ('api', 'role'), ('www', 'role'), ('app', 'role'), ('mail', 'role'), ('email', 'role'), ('test', 'role'),
  ('base', 'service'), ('coinbase', 'service'), ('ethereum', 'service'), ('ens', 'service'), ('usdc', 'service'),
  ('circle', 'service'), ('xmtp', 'service'), ('zkpassport', 'service'), ('passport', 'service');

-- ── Share links (rule 8, the share-link path) ────────────────────────────────
-- A handshake half encrypted under a key that sits only in the link's `#`
-- fragment: the plane holds ciphertext, at most 2 KiB, for at most 7 days, and
-- deletes it at the first fetch. The row is keyed by the SHA-256 of the 128-bit
-- token, so a read of the table gives no working link. No account, no IP.
CREATE TABLE share_links (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  ciphertext BLOB NOT NULL CHECK (length(ciphertext) BETWEEN 1 AND 2048),
  expires_at INTEGER NOT NULL
);
CREATE INDEX share_links_expires ON share_links (expires_at);

-- The live share links, counted by triggers, so an upload can be refused past a
-- ceiling without counting the table: anonymous uploads may fill the share
-- links, never the database the registry's other tables share.
CREATE TABLE handles_counters (
  name TEXT PRIMARY KEY,
  n INTEGER NOT NULL CHECK (n >= 0)
);
INSERT INTO handles_counters (name, n) VALUES ('share_links', 0);
CREATE TRIGGER share_links_counted_in AFTER INSERT ON share_links
BEGIN
  UPDATE handles_counters SET n = n + 1 WHERE name = 'share_links';
END;
CREATE TRIGGER share_links_counted_out AFTER DELETE ON share_links
BEGIN
  UPDATE handles_counters SET n = n - 1 WHERE name = 'share_links';
END;

-- ── The announcement feed (rule 5, corrected 2026-11-16; q18) ────────────────
-- Every ERC-5564 scheme 1 announcement of the announcer singleton that the
-- plane keeps: those whose transaction also moved value to the announced
-- address, and those its own announcer sent. Public chain data, the same for
-- every caller. ASSUMPTION(ruling B): the plane reads the public chain itself
-- and filters it; no vendor is given the address set.
CREATE TABLE announcements (
  chain_id INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  -- The announced address: the one-time account, never its signer (rule 5).
  stealth_address TEXT NOT NULL,
  caller TEXT NOT NULL,
  -- A compressed secp256k1 key, 33 bytes in hex (scheme 1).
  ephemeral_pub_key TEXT NOT NULL CHECK (length(ephemeral_pub_key) = 68),
  -- The announcement's metadata, 1 to 512 bytes in hex; its first byte is the view tag.
  metadata TEXT NOT NULL CHECK (length(metadata) BETWEEN 4 AND 1026),
  PRIMARY KEY (chain_id, block_number, log_index)
);

-- Where the indexer reads next, per chain.
CREATE TABLE announcement_cursor (
  chain_id INTEGER PRIMARY KEY,
  next_block INTEGER NOT NULL CHECK (next_block >= 0),
  updated_at INTEGER NOT NULL
);
