-- Migration 573 — harness_shared.owner_activity (owner-presence-human-turn-signal-2026-07-11 P-001).
--
-- ownerPresent (coord:orient → readOwnerPresence) is PRESENT iff the owner was
-- seen recently. Until now the ONLY signal was power_user_sessions.last_seen_at,
-- bumped exclusively by the OMP/web token-refresh chain — so an owner who drives
-- an agent over the CLI/desktop pty channel (typing into a terminal) was invisible
-- and read as ABSENT even mid-conversation. This table carries a second,
-- backend-agnostic signal: one row per workspace, last_human_turn_at stamped by the
-- psu pty-host on every human keystroke (onStdin -> POST /admin/owner-presence/touch;
-- covers claude/codex/omp uniformly). readOwnerPresence ORs it in with last_seen_at.
--
-- The presence tables (harness_shared.coord_presence / power_user_sessions) were
-- historically runtime-ensured (ensureCoordPresenceTable), which is NOT called at
-- native-box boot — so this new table gets a real migration, the reliable
-- cross-machine boot path (db-boot-migrate.ts / embedded-pg apply). Additive +
-- idempotent: a re-run is a no-op.
--
-- The migration runner wraps each file in its own transaction, so this file
-- carries NO top-level BEGIN;/COMMIT; (migration-runner contract; lint:migrations,
-- files >=215).

CREATE SCHEMA IF NOT EXISTS harness_shared;

CREATE TABLE IF NOT EXISTS harness_shared.owner_activity (
  workspace_id       text        NOT NULL PRIMARY KEY,
  last_human_turn_at timestamptz NOT NULL DEFAULT now()
);
