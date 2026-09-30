-- 770: memory_recall_stats.client — WHICH TUI actually received this injection.
--
-- Plan: codex-context-injection-parity-2026-08-09 P-005 (D-001's closing clause,
-- worded identically in omp-context-injection-parity-2026-08-09).
--
-- WHY THIS COLUMN EXISTS — it is the DETECTOR, and it matters more than the
-- adapter work it accompanies.
--
-- Dynamic context injection was Claude-Code-only for months and NOTHING ANYWHERE
-- REPORTED IT. That is not an oversight, it is a structural blind spot: this
-- table records what the injector DID, so it cannot record a call that was never
-- made. "codex received no per-turn injection" and "codex ran no sessions" and
-- "codex injections all returned empty" were indistinguishable in every existing
-- surface. Recording the client turns "which clients are actually receiving
-- per-turn context" from an archaeology exercise into a one-line query:
--
--   SELECT client, surface, count(*)
--     FROM harness_shared.memory_recall_stats
--    WHERE created_at > now() - interval '7 days'
--    GROUP BY 1,2;
--
-- ...and a client missing from that result is the alarm condition. Without this
-- column, a regression of the very work this plan ships would be exactly as
-- invisible as the gap it closes.
--
-- NULLABLE, NO DEFAULT, NO BACKFILL — deliberate, and do not "tidy" it:
--   * NULL means "this row predates client attribution, or the writer did not
--     supply one". That is HONESTLY UNKNOWN and must stay distinguishable from
--     a real client. Defaulting to 'claude' would manufacture 56k+ rows of
--     evidence for a claim nobody measured — and would do it on the exact table
--     used to judge whether client attribution is working.
--   * No CHECK constraint. The surface column two migrations back was pinned by
--     a stale CHECK that silently rejected every per-port write for hours (see
--     583-drop-memory-recall-stats-surface-check.sql). Free-text is the lesson
--     already paid for here; a new client must never be able to fail a write.
--
-- EXPAND-ONLY, so no FORWARD-COMPAT line is required: this adds a nullable
-- column and an index. The currently-deployed release simply never references
-- `client`, and its INSERTs (which name their columns explicitly) keep working
-- untouched while the DB is ahead of the code.

ALTER TABLE harness_shared.memory_recall_stats
  ADD COLUMN IF NOT EXISTS client text;

COMMENT ON COLUMN harness_shared.memory_recall_stats.client IS
  'TUI client that received this recall (claude|codex|omp). NULL = unattributed/pre-P-005. Free-text by design: a new client must never be able to fail a write. Set from InjectionRequest.client via the shared dispatcher at apps/operator/scripts/hooks/inject/.';

-- Supports the coverage question this column exists to answer ("per client, per
-- surface, in the trailing window"), which is always time-bounded — hence
-- created_at leading. Partial on NOT NULL: unattributed rows are never the
-- subject of a coverage query, and excluding them keeps the index proportional
-- to attributed traffic rather than to the whole table's history.
CREATE INDEX IF NOT EXISTS memory_recall_stats_client_surface_idx
  ON harness_shared.memory_recall_stats (created_at DESC, client, surface)
  WHERE client IS NOT NULL;
