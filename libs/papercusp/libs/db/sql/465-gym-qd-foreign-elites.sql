-- 465-gym-qd-foreign-elites.sql — F1-2 REDESIGN (supersedes 464's provenance
-- columns; federated-scout-gym-learning-2026-07-02, D-005).
--
-- WHY: gym_qd_archive's PK is (workspace_id, harness_slug, niche_key) — ONE row
-- per niche (classic MAP-Elites). 464 tried to store foreign elites as extra
-- per-source rows IN the archive, but the PK forbids a second row for a niche
-- that already holds a local elite — the foreign-identity index was unreachable.
--
-- FIX: foreign elites live in their OWN table, provenance in the PK. This makes
-- D-005 structural: local archive stays canonical-local (writers untouched);
-- best-per-source-per-niche is the PK; read-time max = UNION at query time;
-- revocation cleanup = DELETE ... WHERE source_hive = revoked; a peer's op can
-- NEVER touch a local row because peers only ever write THIS table.
--
-- 464's SENDER side stays: `federatable` stamp + capture triggers on the archive.
-- No capture triggers HERE — foreign rows are never re-federated (gossip
-- amplification; each hive shares only its OWN elites).
-- Idempotent; psql + schema_migrations row in one txn.

\set ON_ERROR_STOP on
BEGIN;

-- Undo 464's misfit receiver-side columns (unreachable under the archive PK).
DROP INDEX IF EXISTS harness_shared.gym_qd_archive_foreign_identity;
DROP INDEX IF EXISTS harness_shared.gym_qd_archive_by_source;
ALTER TABLE harness_shared.gym_qd_archive
  DROP COLUMN IF EXISTS author_pubkey,
  DROP COLUMN IF EXISTS origin,
  DROP COLUMN IF EXISTS fed_ts,
  DROP COLUMN IF EXISTS source_hive,
  DROP COLUMN IF EXISTS novelty_gift;
-- KEEP gym_qd_archive.federatable — the sender eligibility stamp the capture
-- triggers gate on (D-002: outcome=won OR grade>=4).

CREATE TABLE IF NOT EXISTS harness_shared.gym_qd_foreign_elites (
  workspace_id  text NOT NULL,
  harness_slug  text NOT NULL,             -- the Hive home_slug (projection demux)
  niche_key     text NOT NULL,             -- NicheDescriptorV1 key (v1:surface/shape/rN/size)
  source_hive   text NOT NULL,             -- RECEIVER-stamped source log key (never sender-claimed)
  candidate_id  text NOT NULL,
  scope         text NOT NULL,
  domain        text NOT NULL,
  risk          text NOT NULL,
  fitness       double precision NOT NULL, -- comparable only WITHIN source_hive (D-005)
  descriptor    jsonb NOT NULL,
  rationale     text,
  novelty_gift  boolean NOT NULL DEFAULT false, -- landed in a locally-empty niche at apply time
  author_pubkey text,
  fed_ts        bigint,
  created_at    bigint NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint,
  updated_at    bigint NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint,
  PRIMARY KEY (workspace_id, harness_slug, niche_key, source_hive)
);

CREATE INDEX IF NOT EXISTS gym_qd_foreign_elites_by_source
  ON harness_shared.gym_qd_foreign_elites (source_hive);
CREATE INDEX IF NOT EXISTS gym_qd_foreign_elites_fitness_idx
  ON harness_shared.gym_qd_foreign_elites (workspace_id, harness_slug, fitness DESC);

ALTER TABLE harness_shared.gym_qd_foreign_elites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gym_qd_foreign_elites_workspace_isolation ON harness_shared.gym_qd_foreign_elites;
CREATE POLICY gym_qd_foreign_elites_workspace_isolation ON harness_shared.gym_qd_foreign_elites
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.gym_qd_foreign_elites TO harness_app;
GRANT SELECT ON harness_shared.gym_qd_foreign_elites TO harness_zero;

COMMIT;
