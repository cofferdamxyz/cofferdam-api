-- The handle registry's writes (workspace decision 0086, rules 3 to 9; runbook
-- docs/runbooks/handles-build.md, step 3, the parts that sign and relay): the
-- identity map's first table, the key history an address registration (`addresses`) is checked
-- against, the registry requests' nonces, the per-identity counters, the anchor
-- relay's queue, the freezes the registrar signed, and the watched addresses.
--
-- Built on 2026-11-19 before 0086's questions 11 to 23 and rulings A, D and P are
-- ruled; the schema takes the recommended options and says so (ASSUMPTION lines).

-- ── The identity map's first table ───────────────────────────────────────────
-- Rule 4: the identity id is random, minted the first time the plane maps the
-- account, and only the address map (0083 R10) ties it to accounts.
-- ASSUMPTION(ruling D): the address map is to be its own service on its own D1.
-- Until it exists its first table lives here, in a migration of its own, and the
-- production cut takes it with the registry (a fresh database). The account is
-- never stored: `account_tag` is HMAC-SHA-256 under a key derived from the secret
-- HANDLES_MAP_KEY, so a read of the table names no account.
CREATE TABLE identity_accounts (
  account_tag TEXT PRIMARY KEY CHECK (length(account_tag) = 64 AND account_tag NOT GLOB '*[^0-9a-f]*'),
  identity TEXT NOT NULL CHECK (length(identity) BETWEEN 8 AND 64),
  created_at INTEGER NOT NULL
);
CREATE INDEX identity_accounts_identity ON identity_accounts (identity);

-- ── The keys an identity's handles have had ──────────────────────────────────
-- q18 (ASSUMPTION(0086 q18), recommended): an address registration may name any
-- meta-address the same identity's handles have had, so an address that reaches
-- an old epoch's meta-address is still registered. One row per published
-- (handle, serial, owner, meta-address); never deleted while the registry lives.
CREATE TABLE handle_key_history (
  identity TEXT NOT NULL,
  handle_id TEXT NOT NULL,
  serial INTEGER NOT NULL CHECK (serial >= 1),
  owner TEXT NOT NULL CHECK (owner GLOB '0x*' AND substr(owner, 3) NOT GLOB '*[^0-9a-f]*' AND length(owner) = 42),
  meta_address TEXT NOT NULL CHECK (meta_address GLOB '0x*' AND substr(meta_address, 3) NOT GLOB '*[^0-9a-f]*' AND length(meta_address) = 134),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (identity, handle_id, serial, owner, meta_address)
);
CREATE INDEX handle_key_history_meta ON handle_key_history (identity, meta_address);

-- ── Registry requests seen ───────────────────────────────────────────────────
-- Every handle-scoped request carries a random 32-byte nonce and an expiry at
-- most ten minutes ahead; a nonce is taken once, and swept after it expires.
CREATE TABLE registry_nonces (
  nonce TEXT PRIMARY KEY CHECK (length(nonce) = 66 AND nonce GLOB '0x*' AND substr(nonce, 3) NOT GLOB '*[^0-9a-f]*'),
  expires_at INTEGER NOT NULL
);
CREATE INDEX registry_nonces_expires ON registry_nonces (expires_at);

-- ── What each identity did, for the limits ──────────────────────────────────
-- A claim, a rename and a release, per identity and per install (the keyed tag of
-- the session's passkey). The limits read a rolling 30 days; rows go after 31.
CREATE TABLE handle_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity TEXT NOT NULL,
  install_tag TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('claim', 'rename', 'release')),
  at INTEGER NOT NULL
);
CREATE INDEX handle_events_identity ON handle_events (identity, kind, at);
CREATE INDEX handle_events_install ON handle_events (install_tag, kind, at);
CREATE INDEX handle_events_at ON handle_events (at);

-- ── The anchor relay's queue (rule 3, "Relaying") ────────────────────────────
-- A claim waits a random delay of minutes to hours, a rename's release one to
-- seven days, so neither lands beside the account's deployment or the new
-- label's claim. `args` holds the owner's signatures and the call's fields, no
-- account and no label. The cron sends what is due in batches, reads receipts,
-- and queues `apply` once a release's delay has passed.
CREATE TABLE anchor_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- claim, release and apply wait their delay; advance is sent at once by its route and
  -- settled here (the row follows the chain only once the transaction is mined).
  kind TEXT NOT NULL CHECK (kind IN ('claim', 'release', 'apply', 'advance')),
  handle_id TEXT NOT NULL CHECK (length(handle_id) = 66),
  args TEXT NOT NULL,
  not_before INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'sent', 'done', 'failed', 'cancelled')),
  tx_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (state <> 'sent' OR tx_hash IS NOT NULL)
);
CREATE INDEX anchor_jobs_due ON anchor_jobs (not_before) WHERE state IN ('queued', 'sent');
CREATE INDEX anchor_jobs_handle ON anchor_jobs (handle_id, state);

-- One relay run at a time: the cron runs every minute and a run that overlaps
-- another (a slow node) sends nothing, so no job is sent twice.
CREATE TABLE relay_lease (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  until INTEGER NOT NULL
);

-- ── Freezes the registrar signed (q15) ───────────────────────────────────────
-- ASSUMPTION(0086 q15), recommended: the plane signs `unfreeze` only for a freeze
-- with no veto since the record's last owner change; a veto means a key was used
-- against the user. `owner` is the record's owner when the plane signed.
CREATE TABLE handle_freezes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle_id TEXT NOT NULL,
  -- Every transaction the registrar pays for on a user's request: the per-handle
  -- daily cap counts these rows (a hold, a renewal, a veto, an advance, an unfreeze).
  kind TEXT NOT NULL CHECK (kind IN ('hold', 'renew', 'veto', 'advance', 'unfreeze')),
  owner TEXT NOT NULL,
  -- The record's serial when the plane signed: a veto counts against unfreeze only
  -- for the same holding (a label released and claimed again starts clean).
  serial INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX handle_freezes_handle ON handle_freezes (handle_id, serial, kind);
CREATE INDEX handle_freezes_at ON handle_freezes (handle_id, at);

-- ── Watched addresses (0083 R9, R10; 0086 rule 5) ─────────────────────────────
-- The one-time addresses the plane watches for good: those the user's phones
-- derive (`own`, through the `addresses` route) and those a scan of the announcement feed finds (q18). The
-- address is the key the watcher reads; what would let anyone recompute or spend
-- it (R, h, the view tag, the meta-address it derives from) is sealed with
-- AES-256-GCM under a key derived from HANDLES_MAP_KEY. Every read is logged by
-- count. ASSUMPTION(ruling D): here until the address map has its own database.
CREATE TABLE watched_addresses (
  address TEXT PRIMARY KEY CHECK (address GLOB '0x*' AND substr(address, 3) NOT GLOB '*[^0-9a-f]*' AND length(address) = 42),
  identity TEXT NOT NULL,
  handle_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('own', 'pay')),
  sealed BLOB NOT NULL CHECK (length(sealed) BETWEEN 29 AND 1024),
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX watched_addresses_identity ON watched_addresses (identity);

-- The watched addresses, counted like the share links, so a registration can be
-- refused past a ceiling: an address registration costs nothing to compute, and
-- no flood of them may fill the database the registry shares.
INSERT INTO handles_counters (name, n) VALUES ('watched_addresses', 0);
CREATE TRIGGER watched_addresses_counted_in AFTER INSERT ON watched_addresses
BEGIN
  UPDATE handles_counters SET n = n + 1 WHERE name = 'watched_addresses';
END;
CREATE TRIGGER watched_addresses_counted_out AFTER DELETE ON watched_addresses
BEGIN
  UPDATE handles_counters SET n = n - 1 WHERE name = 'watched_addresses';
END;

-- A batch's guard: `INSERT INTO batch_guard (ok) SELECT changes()` right after an
-- UPDATE that must hit fails the CHECK when it did not, and the whole batch rolls
-- back; the batch deletes its row before it ends, so the table stays empty.
CREATE TABLE batch_guard (ok INTEGER NOT NULL CHECK (ok = 1));

-- The rename's 30-day limit and the hold's relapse block read these.
CREATE INDEX handles_identity_state ON handles (identity, state);

-- `POST /v1/handles/mine` and `/:label/addresses` are route words: no one may
-- hold either label, so a lookup of it never reads as someone's handle in the
-- request log.
INSERT INTO reserved_labels (label, reason) VALUES ('mine', 'route'), ('addresses', 'route') ON CONFLICT (label) DO NOTHING;
