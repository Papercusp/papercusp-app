-- 104-substrate-meta.sql
--
-- Feature-content + issue federation, Stage 4 (the one-time backfill).
-- Plan: papercusp-feature-content-federation-2026-06-01.
--
-- Stages 1-3 federate NEW feature/issue writes (the AFTER trigger from 102
-- enqueues local-origin writes into substrate_outbox; the drain appends them to
-- the own log). But rows that already existed BEFORE the federation shipped
-- never fired the capture trigger, so a later-joining peer never sees them.
-- Stage 4 adds a one-time backfill (backfill-local-state.ts) that enqueues every
-- existing local *_consolidated row into substrate_outbox (reusing the drain).
--
-- The backfill must be IDEMPOTENT: a second boot must not re-enqueue the whole
-- table. This migration adds a tiny per-(workspace, harness) key/value marker
-- table the backfill stamps with `backfill_done`. The backfill's first line
-- checks for that marker and returns `{skipped:true}` if present.
--
-- harness_shared (not a per-harness schema) so the runtime roles can read/write
-- it (mirrors substrate_outbox in 102). Named dollar-quote convention is moot
-- here — no functions. No \set / BEGIN / COMMIT (the embedded-pg migration
-- runner wraps each file in its own txn). Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS harness_shared.substrate_meta (
  workspace_id TEXT NOT NULL,
  harness_slug TEXT NOT NULL,
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  PRIMARY KEY (workspace_id, harness_slug, key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.substrate_meta TO harness_app, harness_admin;
