-- 990-memory-write-journal-shareable.sql — WI-3985.
--
-- The write journal originally persisted only scope/kind/metadata/verbatim,
-- but MemoryBackend.remember also accepts the separate opt-in `shareable`
-- option. Recovery therefore replayed a shareable memory as private. Preserve
-- the option as a first-class nullable value: NULL keeps historical rows on
-- the backend's private-by-default path; TRUE/FALSE replay exactly as written.

ALTER TABLE harness_shared.memory_write_journal
  ADD COLUMN IF NOT EXISTS shareable boolean;

COMMENT ON COLUMN harness_shared.memory_write_journal.shareable IS
  'MemoryBackend remember option preserved for journal replay. NULL means the historical/default private path; TRUE/FALSE were explicitly supplied by the caller.';
