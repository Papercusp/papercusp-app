-- Migration 566 — coord_presence.capability_tags (WI-1546, Gate DG-3 follow-up).
--
-- DG-3 shard scheduling (pot-git/gate/scheduling.ts) matches a shard's
-- required capabilities (platform/deps/DB — 'node'/'docker'/'pg') against a
-- machine's tag set, but until now every machine advertised the same
-- DEFAULT_MACHINE_TAGS placeholder — the scheduling.ts file header named this
-- exact gap as a follow-up: "Carrying a machine's tag set in its
-- session-presence row is the wiring half — filed as a follow-up work item".
--
-- This adds the column the wiring writes into. Populate-once-then-keep, same
-- family as agent_role/pot_slug (mig 277): a write that omits/empties it never
-- clobbers a previously-detected tag set (see PgPresenceStore.write's
-- COALESCE(NULLIF(...), existing) pattern).
--
-- Additive + defaulted: existing rows read capability_tags = '[]' (unknown
-- capabilities) until their next presence write recomputes real tags — never
-- a hard failure, matching every other coord_presence column's rollout shape.
--
-- The migration runner wraps each file in its own transaction, so this file
-- carries NO top-level BEGIN;/COMMIT; — an inner COMMIT would end the wrapper
-- txn early and break apply+ledger atomicity (migration-runner contract;
-- lint:migrations, files >=215).

ALTER TABLE harness_shared.coord_presence
  ADD COLUMN IF NOT EXISTS capability_tags jsonb NOT NULL DEFAULT '[]'::jsonb;
