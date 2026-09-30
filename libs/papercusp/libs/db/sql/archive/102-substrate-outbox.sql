-- 102-substrate-outbox.sql
--
-- Feature-content + issue federation, Stage 1 (the "send side").
-- Plan: papercusp-feature-content-federation-2026-06-01.
--
-- Today only queue-membership / working-set / claims / contributor rows reach
-- the per-peer Hypercore log, so feature CONTENT and issues never federate to
-- peers. This migration adds a transactional-outbox CDC seam: an AFTER trigger on
-- each consolidated table (the single funnel every feature/issue write passes
-- through, post-migration 032) enqueues LOCAL-origin changes into
-- harness_shared.substrate_outbox + NOTIFY. A later drain task (Stage 3) reads
-- undrained rows and appends them to this device's own log.
--
-- ECHO-LOOP GUARD (D-2, the one thing that must be right): the read-side
-- projections (apps/operator/lib/sync/hyperbee/projections/harness-features.ts,
-- issues.ts) ALSO write the *_consolidated tables when applying a REMOTE peer's
-- op — stamping origin='remote' (migration 097). If the capture trigger enqueued
-- those, a remote op would be re-appended to the local log and federated back
-- forever. So the trigger enqueues ONLY rows where origin='local' (or NULL,
-- pre-097). On DELETE it reads OLD.origin.
--
-- workspace_id: harness_features_consolidated carries workspace_id (migration
-- 009). harness_issues_consolidated (migration 030, created AFTER 009) does NOT.
-- The per-(workspace, harness) drain query needs it for issues too, so this
-- migration ALTERs it in to MATCH features — the right fix now (no users yet).
--
-- Named dollar-quote ($body$, NOT $$) per the repo PG-migration convention —
-- bash heredocs collapse doubled $. Idempotent: CREATE TABLE IF NOT EXISTS,
-- CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE TRIGGER (mirror
-- migration 050).
--
-- No \set / BEGIN / COMMIT here: the embedded-pg migration runner
-- (migration-runner.js) strips psql metacommands and wraps each file in its own
-- BEGIN…COMMIT (and records the tracker row in that same txn), so the file must
-- be plain transaction-control-free SQL.

-- ── workspace_id parity on issues_consolidated ────────────────────────────────
-- features_consolidated already has it (009); issues_consolidated does not.
ALTER TABLE harness_shared.harness_issues_consolidated
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS hic_workspace_idx
  ON harness_shared.harness_issues_consolidated (workspace_id);

-- ── the outbox table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.substrate_outbox (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id TEXT   NOT NULL,
  harness_slug TEXT   NOT NULL,
  table_name   TEXT   NOT NULL,
  op           TEXT   NOT NULL CHECK (op IN ('put', 'del')),
  key          TEXT   NOT NULL,
  row          JSONB,
  ts           BIGINT NOT NULL,
  drained_at   BIGINT
);

-- Drain query: undrained rows for one (workspace, harness) in id order.
CREATE INDEX IF NOT EXISTS substrate_outbox_drain_idx
  ON harness_shared.substrate_outbox (workspace_id, harness_slug, drained_at, id);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.substrate_outbox TO harness_app, harness_admin;
GRANT USAGE, SELECT ON SEQUENCE harness_shared.substrate_outbox_id_seq TO harness_app, harness_admin;

-- ── the capture function ──────────────────────────────────────────────────────
-- TG_ARGV[0] is the key column name ('feature_id' / 'issue_id'), so one function
-- serves both tables without branching on TG_TABLE_NAME.
CREATE OR REPLACE FUNCTION harness_shared.capture_substrate_outbox()
RETURNS TRIGGER AS $body$
DECLARE
  v_op      TEXT;
  v_rec     RECORD;
  v_origin  TEXT;
  v_key     TEXT;
  v_row     JSONB;
  v_ws      TEXT;
  v_slug    TEXT;
  v_keycol  TEXT := TG_ARGV[0];
BEGIN
  IF (TG_OP = 'DELETE') THEN
    v_op := 'del';
    v_rec := OLD;
  ELSE
    v_op := 'put';
    v_rec := NEW;
  END IF;

  v_row := to_jsonb(v_rec);
  v_origin := v_row ->> 'origin';

  -- Echo-loop guard: skip remote-origin writes (the projection's own writes).
  IF COALESCE(v_origin, 'local') <> 'local' THEN
    RETURN v_rec;
  END IF;

  v_key  := v_row ->> v_keycol;
  v_ws   := COALESCE(v_row ->> 'workspace_id', '');
  v_slug := v_row ->> 'harness_slug';

  INSERT INTO harness_shared.substrate_outbox
    (workspace_id, harness_slug, table_name, op, key, row, ts)
  VALUES
    (v_ws, v_slug, TG_TABLE_NAME, v_op, v_key, v_row,
     (extract(epoch from now()) * 1000)::bigint);

  PERFORM pg_notify('substrate_outbox', v_ws || '::' || v_slug);

  RETURN v_rec;
END;
$body$ LANGUAGE plpgsql;

-- ── triggers ──────────────────────────────────────────────────────────────────
-- INSERT/DELETE fire unconditionally. UPDATE fires ONLY when the row actually
-- CHANGED (`OLD.* IS DISTINCT FROM NEW.*`). The guard is load-bearing for loop
-- termination: the substrate's read-merge re-applies the OWN log's ops every
-- pass (mergeAdmittedLogs reads each log from index 0), re-UPSERTing every local
-- feature/issue with origin='local' and IDENTICAL values. Without the guard each
-- such no-op re-upsert re-fires this AFTER-UPDATE trigger and re-enqueues the row
-- → the drain re-appends it to the own log → unbounded intra-peer self-
-- amplification of a peer's OWN already-federated rows (Stage-6 finding). With
-- the guard, an identical re-upsert is not a "change", so nothing is enqueued; a
-- genuine local edit (different values) still fires and federates. This is the
-- intra-peer analogue of the origin='local' echo guard inside the function (which
-- handles the cross-peer direction).
DROP TRIGGER IF EXISTS capture_substrate_outbox_trg
  ON harness_shared.harness_features_consolidated;
CREATE TRIGGER capture_substrate_outbox_trg
  AFTER INSERT OR DELETE ON harness_shared.harness_features_consolidated
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('feature_id');
DROP TRIGGER IF EXISTS capture_substrate_outbox_upd_trg
  ON harness_shared.harness_features_consolidated;
CREATE TRIGGER capture_substrate_outbox_upd_trg
  AFTER UPDATE ON harness_shared.harness_features_consolidated
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('feature_id');

DROP TRIGGER IF EXISTS capture_substrate_outbox_trg
  ON harness_shared.harness_issues_consolidated;
CREATE TRIGGER capture_substrate_outbox_trg
  AFTER INSERT OR DELETE ON harness_shared.harness_issues_consolidated
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('issue_id');
DROP TRIGGER IF EXISTS capture_substrate_outbox_upd_trg
  ON harness_shared.harness_issues_consolidated;
CREATE TRIGGER capture_substrate_outbox_upd_trg
  AFTER UPDATE ON harness_shared.harness_issues_consolidated
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('issue_id');
