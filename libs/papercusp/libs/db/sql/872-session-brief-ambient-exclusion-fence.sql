-- 872: durable per-session ambient-retrieval exclusion fence (EI-21096338043071922).
--
-- A nullable JSONB array keeps the legacy/absent state distinguishable from an
-- explicit empty fence. The session-brief adapter treats omission as preserve,
-- [] as clear, and a malformed/read-failed value as unavailable (fail closed
-- for ambient corpus retrieval).

ALTER TABLE harness_shared.session_briefs
  ADD COLUMN IF NOT EXISTS ambient_excluded_refs jsonb;

COMMENT ON COLUMN harness_shared.session_briefs.ambient_excluded_refs IS
  'Per-owner work-item/session refs that ambient corpus retrieval must never inject; NULL is legacy/unset, [] is an explicit empty fence.';
