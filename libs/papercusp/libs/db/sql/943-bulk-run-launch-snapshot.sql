-- 943 — Per-run resolver launch snapshot on the generalized bulk-run table.
--
-- Plan: bulk-resolver-controls-and-run-lifecycle-2026-08-24 (P-003)
-- Decision D-003: "Persist effective settings on every run — P-003 snapshots the
-- validated effective resolver launch settings on the durable run row so
-- reloads, reports, diagnostics, restarts, and audits use the exact click-time
-- configuration rather than mutable defaults."
--
-- WHY A SNAPSHOT COLUMN AND NOT A JOIN TO THE STORED PROFILE.
-- The per-kind resolver profiles added in P-002 (agent-config `resolverProfiles`)
-- are MUTABLE settings: the owner can change the Inbox model between clicking
-- Start and reading the report. A run that renders its launch settings by
-- re-reading that profile would therefore show today's defaults on last week's
-- run — the exact drift `filter_snapshot` already exists to prevent for
-- membership. This column is the same idea for launch configuration: written
-- once at creation, never re-derived.
--
-- BACKWARD COMPATIBILITY. This is a pure EXPAND: additive, with a default, and
-- no destructive DDL (no DROP/RENAME/ALTER ... SET NOT NULL on an existing
-- column), so no FORWARD-COMPAT acknowledgment is required. The currently
-- deployed :3070 release inserts runs WITHOUT this column and keeps working —
-- those rows land '{}'::jsonb, which readers treat as "no snapshot recorded"
-- and fall back to the launcher default exactly as they do today. Adding a
-- NOT NULL column that HAS a default does not rewrite the table on PG11+, so
-- this is safe to apply while runs are live.
--
-- SHAPE (mirrors BulkRunLaunchSnapshot in attention/bulk-run-store.ts):
--   { model, effort, account, carry, backend }
-- `backend` is the CLI backend resolved from `model` at click time. Storing it
-- is deliberate and does NOT contradict D-002's "backend is derived from model,
-- never a second independently editable truth": D-002 governs the mutable
-- PROFILE, whereas this row is an immutable historical record of what was
-- actually launched. If the model→backend derivation changes later, the audit
-- must still report the backend the run really used.

ALTER TABLE harness_shared.attention_bulk_runs
  ADD COLUMN IF NOT EXISTS launch_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN harness_shared.attention_bulk_runs.launch_snapshot IS
  'Click-time snapshot of the effective resolver launch settings for this run '
  '({ model, effort, account, carry, backend }). Written once at creation and '
  'never re-derived, so reports/audits show what the run actually launched with '
  'rather than the current mutable profile. ''{}'' means no snapshot was '
  'recorded (a run created before migration 943, or by an older release).';
