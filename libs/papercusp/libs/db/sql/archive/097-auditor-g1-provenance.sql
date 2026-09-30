-- 097: G1 Provenance — stamp origin + author_pubkey on projected actionable tables.
--
-- Plan: papercusp-user-protection-gate-2026-05-31 P-001.
--
-- These four tables are the "actionable projected tables" named in P-001:
-- harness features, issues, feature queue, and feature working set. Every
-- op applied from Hyperbee now stamps:
--
--   author_pubkey  TEXT NULL    — hex-encoded Noise/hypercore device pubkey that
--                                 wrote the op. NULL for rows inserted before this
--                                 migration; populated on next upsert.
--   origin         TEXT NOT NULL DEFAULT 'local'
--                               — 'local' | 'remote'. 'local' = this device's own
--                                 log wrote it (unforgeable via writerPubkey check).
--                                 'remote' = an admitted peer's log wrote it.
--                                 Existing rows default 'local' (written by this
--                                 device before the substrate was multi-peer).
--
-- D-006: the auditor-bypass condition MUST key on origin (derived from
-- op.writerPubkey, the Noise key that signed the op), NOT on
-- created_by_github_user_id (which is payload-level and forgeable).
--
-- Idempotent (PG 9.6+ IF NOT EXISTS). Pure ALTER statements — no dollar-quoted
-- blocks, no bash-heredoc hazard.

ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS author_pubkey TEXT;
ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'local';

ALTER TABLE harness_shared.harness_issues_consolidated
  ADD COLUMN IF NOT EXISTS author_pubkey TEXT;
ALTER TABLE harness_shared.harness_issues_consolidated
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'local';

-- feature_queue + feature_working_set are created by ensure-schema (the operator
-- sidecar), NOT by any migration — so on the embedded-PG boot path the migration
-- runner executes 097 BEFORE those tables exist. A bare ALTER throws 42P01, and
-- because the runner wraps each migration file in one BEGIN…COMMIT, that rolls
-- back the WHOLE of 097 (including the origin add to the *_consolidated tables
-- above) → the migration is skipped → 098's `WHERE origin='remote'` index then
-- crashes the entire embedded-PG boot (42703 column "origin" does not exist).
-- `IF EXISTS` makes these a graceful no-op at boot; ensure-schema's CREATE
-- already defines author_pubkey + origin on both tables, so nothing is lost.
ALTER TABLE IF EXISTS harness_shared.feature_queue
  ADD COLUMN IF NOT EXISTS author_pubkey TEXT;
ALTER TABLE IF EXISTS harness_shared.feature_queue
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'local';

ALTER TABLE IF EXISTS harness_shared.feature_working_set
  ADD COLUMN IF NOT EXISTS author_pubkey TEXT;
ALTER TABLE IF EXISTS harness_shared.feature_working_set
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'local';

-- Index for the G2 auditor gate: readFeaturesPg and the orchestrator pick loop
-- will filter on origin to screen remote-authored features. A partial index on
-- remote features is small (most features are local) and fast for the "pending
-- audit" sweep.
CREATE INDEX IF NOT EXISTS hfc_origin_idx
  ON harness_shared.harness_features_consolidated (harness_slug, origin)
  WHERE origin = 'remote';

CREATE INDEX IF NOT EXISTS hic_origin_idx
  ON harness_shared.harness_issues_consolidated (harness_slug, origin)
  WHERE origin = 'remote';
