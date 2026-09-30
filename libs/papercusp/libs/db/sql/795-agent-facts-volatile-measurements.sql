-- 795-agent-facts-volatile-measurements.sql — EI-20191740437408337
--
-- A standing fact is normally a durable conclusion. A measurement of an
-- artifact that is still being written is different: the value can be correct
-- at assert time and false minutes later. Keep the assert-time declaration and
-- sample timestamp on the fact so every reader can see that distinction.
--
-- The store validates the bounded shape and applies the short TTL. The column
-- is jsonb, rather than two nullable scalars, because measured_at has no
-- meaning without subject_volatile=true and the pair is read on the same hot
-- fact paths as source_provenance/depends_on.
--
-- No top-level BEGIN/COMMIT: the migration runner wraps each file in one
-- transaction and records it in schema_migrations.

ALTER TABLE harness_shared.agent_facts
  ADD COLUMN IF NOT EXISTS measurement jsonb;

COMMENT ON COLUMN harness_shared.agent_facts.measurement IS
  'EI-20191740437408337: assert-time moving-subject snapshot metadata, {subjectVolatile:true, measuredAt:<ISO>}; the store renders a SNAPSHOT marker and bounds its TTL to 15 minutes.';
