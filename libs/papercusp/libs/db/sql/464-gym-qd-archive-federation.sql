-- 464-gym-qd-archive-federation.sql — F1-2 of federated-scout-gym-learning-2026-07-02.
-- QD ELITES federate provenance-partitioned (peer-review D-005, owner-ratified):
-- best-per-SOURCE-per-niche storage, read-time max in the map lane, NEVER a
-- destructive cross-source merge (fitness scales are incomparable across hives;
-- keep-higher on untrusted input = data loss + spam reward).
--
-- Sender gate: only rows the writer stamps `federatable` capture (D-002
-- eligibility: outcome=won OR grade>=4 — federatableElite(); the gym accept /
-- champion path stamps it). Wire key = niche_key (within ONE sender's log the
-- latest elite per niche wins = best-per-source-per-niche on the wire).
-- Idempotent; psql + schema_migrations row in one txn.

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE harness_shared.gym_qd_archive
  ADD COLUMN IF NOT EXISTS author_pubkey text,
  ADD COLUMN IF NOT EXISTS origin        text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS fed_ts        bigint,
  ADD COLUMN IF NOT EXISTS source_hive   text,                       -- receiver-stamped; NULL = local
  ADD COLUMN IF NOT EXISTS novelty_gift  boolean NOT NULL DEFAULT false, -- foreign elite landing in a locally-empty niche
  ADD COLUMN IF NOT EXISTS federatable   boolean NOT NULL DEFAULT false; -- sender eligibility stamp (won / grade>=4)

-- Foreign-partition upsert identity: ONE row per (niche, source) for foreign
-- rows. Local rows (source_hive NULL) keep their existing semantics untouched.
CREATE UNIQUE INDEX IF NOT EXISTS gym_qd_archive_foreign_identity
  ON harness_shared.gym_qd_archive (workspace_id, harness_slug, niche_key, source_hive)
  WHERE source_hive IS NOT NULL;

-- Revocation cleanup read (D-005): find a revoked source's rows fast.
CREATE INDEX IF NOT EXISTS gym_qd_archive_by_source
  ON harness_shared.gym_qd_archive (source_hive) WHERE source_hive IS NOT NULL;

-- Federation capture: FEDERATABLE rows only.
CREATE OR REPLACE TRIGGER capture_gym_qd_outbox_ins_trg
  AFTER INSERT ON harness_shared.gym_qd_archive
  FOR EACH ROW WHEN (NEW.federatable = true)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('niche_key');

CREATE OR REPLACE TRIGGER capture_gym_qd_outbox_upd_trg
  AFTER UPDATE ON harness_shared.gym_qd_archive
  FOR EACH ROW
  WHEN ((NEW.federatable = true OR OLD.federatable = true)
    AND (OLD.fitness IS DISTINCT FROM NEW.fitness
      OR OLD.candidate_id IS DISTINCT FROM NEW.candidate_id
      OR OLD.federatable IS DISTINCT FROM NEW.federatable))
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('niche_key');

COMMIT;
