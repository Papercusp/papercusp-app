-- 1161-capability-class-embedding-profile.sql
-- versioned-embedding-profiles-2026-09-12 P-003 / D-002 / D-003
--
-- capability_class_registry predates exact embedding-space identity. Its
-- vector(768) width prevents a pgvector shape error, but it cannot distinguish
-- two unrelated 768-dimensional spaces. Keep existing vectors as historical
-- data while making them lexical-only: only vectors written with an exact,
-- versioned profile id may participate in similarity ranking.

ALTER TABLE harness_shared.capability_class_registry
  ADD COLUMN IF NOT EXISTS embedding_profile TEXT;

COMMENT ON COLUMN harness_shared.capability_class_registry.embedding_profile IS
  'Exact versioned embedding-space profile for embedding; NULL is legacy/unknown and must be lexical-only.';
