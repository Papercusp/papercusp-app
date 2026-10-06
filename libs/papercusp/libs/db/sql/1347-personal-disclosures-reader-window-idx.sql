-- WI-10005669 (plan personal-data-reader-set-labels-2026-10-01, D-006): serve the transcript
-- reader rule's correlated EXISTS over the disclosure ledger with an index.
--
-- restrictedTurnSql (packages/operator-core/lib/personal-vault/transcript-exclusion.ts) asks, for
-- every candidate session_turns row: is there a disclosure window for this turn's owner with
--   agent_owner_id = <owner> AND delivered_at <= <at> AND (released_at IS NULL OR <at> < released_at)
-- Released windows count, so the predicate spans released AND active rows. Both ledger indexes from
-- migration 1302 are PARTIAL (WHERE released_at IS NULL) and lead with workspace_id, which this
-- predicate does not filter on, so neither can serve it and every agent-facing transcript read
-- seq-scanned the ledger. This non-partial index matches the predicate's shape: equality on the
-- owner, range on delivered_at, and released_at carried for an index-only check.
--
-- Additive only (a new non-unique index on a table no deployed release writes with ON CONFLICT
-- against it), so it is safe while :3070 still serves the previous release.
CREATE INDEX IF NOT EXISTS personal_disclosures_owner_window_idx
  ON harness_shared.personal_disclosures (agent_owner_id, delivered_at)
  INCLUDE (released_at);
