-- 618-curation-log-title.sql
-- Plan curation-signal-gaps-2026-07-17, P-003: recovery close-the-loop.
--
-- Adds `title` to operator_curation_log so a later "recovery diff" tick can
-- render "✓ cleared — <title>" for a signal that has disappeared from the
-- current gather without re-fetching the (now-gone) source row. Nullable +
-- backfill-free (idempotent): existing rows simply have title=NULL, which the
-- recovery reader treats as "no clear line, id only" (never a crash).

ALTER TABLE harness_shared.operator_curation_log
    ADD COLUMN IF NOT EXISTS title text;

COMMENT ON COLUMN harness_shared.operator_curation_log.title IS
    'The FleetSignal title at the time it was surfaced/batched. Backs the P-003 recovery diff (cleared:<id> signals render "✓ cleared — <title>" without needing the original, now-vanished source row).';
