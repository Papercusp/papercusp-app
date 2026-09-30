-- 1243: drop harness_shared.carry_notes.note_embedding (+ mode, profile, 2 indexes).
--
-- generic-rag-chunking-2026-09-29 P-014 / D-020. Nothing reads this vector: the
-- only references were the embed-backfill TARGETS entry (the writer), the
-- prose-vector-dims width registration, and generated schema/index manifests
-- (EI-24609404813504679: zero `<=>` users). Carry notes are recovered by scope
-- key and full text (note_tsv, kept). Each embed sweep and each width migration
-- was spending compute and storage on it. The same change removes the TARGETS
-- entry and the registration.
--
-- FORWARD-COMPAT: the release still serving on :3070 touches note_embedding only from the embed-backfill TARGETS sweep and embed-space-self-check, and both run each target inside its own try/catch, so until this change deploys the carry_notes target just logs one warning per sweep; nothing else in the deployed code reads or writes these columns.

DROP INDEX IF EXISTS harness_shared.carry_notes_embedding_hnsw_idx;
DROP INDEX IF EXISTS harness_shared.carry_notes_embedding_mode_idx;

ALTER TABLE harness_shared.carry_notes
  DROP COLUMN IF EXISTS note_embedding,
  DROP COLUMN IF EXISTS note_embedding_mode,
  DROP COLUMN IF EXISTS note_embedding_profile;
