-- Cupboard server schema (D1 / SQLite).
--
-- Cupboard is the public listing service for shared Papercusp harnesses.
-- A harness owner publishes their harness here; other users browse + install.
--
-- Data model (v5 §10.2 + addendum 1):
--
--   harnesses          — published harness listings (one per github_repository_id)
--   reports            — abuse reports against listings
--   publish_rate_limit — per-user publish counter (5/h)
--   indexer_runs       — daily indexer run audit (tier-A stats refresh)
--   audit              — generic event log
--
-- IDs:
--   harness id = uuid v4 (server-issued).
--   github_repository_id = GitHub's numeric id (canonical binding per addendum 1).
--   github_user_id        = GitHub's numeric user id (publisher).
--
-- Visibility:
--   All listings are public. Private GitHub repos cannot be published.
--   Publisher can unlist; Cupboard operator can unlist on resolved report.

CREATE TABLE IF NOT EXISTS harnesses (
  id TEXT PRIMARY KEY NOT NULL,                      -- uuid v4
  github_repository_id INTEGER NOT NULL UNIQUE,      -- canonical binding (§5.1)
  github_owner TEXT NOT NULL,                        -- snapshot of owner login at publish-time
  github_name TEXT NOT NULL,                         -- snapshot of repo name at publish-time
  github_url TEXT NOT NULL,                          -- denormalised for cheap rendering
  title TEXT NOT NULL,                               -- display title (defaults to repo name)
  description TEXT,                                  -- short prose, ≤ 280 chars
  topic_hex TEXT NOT NULL,                           -- Hypercore topic for join (Entry 4 link)
  publisher_github_user_id INTEGER NOT NULL,
  publisher_github_login TEXT NOT NULL,              -- snapshot at publish-time
  claim_status TEXT NOT NULL DEFAULT 'unclaimed',    -- unclaimed | claimed | stale | superseded
  claimant_github_user_id INTEGER,                   -- set on claim by maintain/admin perm
  claimant_github_login TEXT,
  superseded_by TEXT,                                -- id of successor listing
  -- Tier-A stats refreshed by hourly indexer (P-076):
  stars INTEGER NOT NULL DEFAULT 0,
  contributor_count INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER,                          -- unix ms; from GitHub pushed_at
  languages TEXT,                                    -- JSON object {language: byte_count}
  stats_refreshed_at INTEGER,                        -- unix ms; null = never indexed
  created_at INTEGER NOT NULL,                       -- unix ms
  updated_at INTEGER NOT NULL,                       -- unix ms
  unlisted_at INTEGER,                               -- unix ms; null = listed
  unlisted_reason TEXT                               -- 'by_publisher' | 'by_operator' | report id
);

CREATE INDEX IF NOT EXISTS harnesses_listed_idx
  ON harnesses (unlisted_at, last_activity_at DESC);

CREATE INDEX IF NOT EXISTS harnesses_publisher_idx
  ON harnesses (publisher_github_user_id);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY NOT NULL,                      -- uuid v4
  harness_id TEXT NOT NULL REFERENCES harnesses(id),
  reporter_github_user_id INTEGER NOT NULL,
  reporter_github_login TEXT NOT NULL,
  reason TEXT NOT NULL,                              -- short prose, ≤ 1000 chars
  ip_hash TEXT,                                      -- hashed reporter IP (per-report; dedupe)
  status TEXT NOT NULL DEFAULT 'pending',            -- pending | resolved_unlist | resolved_dismiss
  resolved_at INTEGER,
  resolved_by_operator_note TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS reports_pending_idx
  ON reports (status, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS reports_harness_idx
  ON reports (harness_id);

-- Per-user publish rate-limit table (5/hr per github_user_id).
-- Kept in D1 rather than KV so the source of truth is queryable from the
-- audit trail later (KV would be opaque).
CREATE TABLE IF NOT EXISTS publish_rate_limit (
  github_user_id INTEGER NOT NULL,
  window_start INTEGER NOT NULL,                     -- unix ms, floor(now/3600000)*3600000
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (github_user_id, window_start)
);

CREATE TABLE IF NOT EXISTS indexer_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  harnesses_examined INTEGER NOT NULL DEFAULT 0,
  harnesses_updated INTEGER NOT NULL DEFAULT 0,
  errors_count INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT                                 -- last-error sample, not exhaustive
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS audit_kind_idx ON audit (kind, ts DESC);
