-- 438-bee-claim-specs-federation.sql
-- cross-machine-coord-parity-and-trust-2026-07-01 P-016: federate the Queen's
-- per-bee claim SPECS (hybrid-bee-scheduler mig 372) over the hive peer-log, so
-- a queen's spec authoring/versioning reaches bees pulling via get_next on
-- OTHER machines of the shared hive.
--
-- Pattern = mig 150/186: federation columns + WHEN-gated CDC capture triggers.
-- harness_slug is the demux (D-006): NULL = operator-scope spec, stays LOCAL
-- (today's behavior, unchanged); set = the hive HOME slug, rides the hive
-- topic. The writer (scheduler:set_claim_spec) stamps it via the same
-- federation-scope resolution coord:send uses (P-001).

BEGIN;

ALTER TABLE harness_shared.bee_claim_specs
  ADD COLUMN IF NOT EXISTS harness_slug text,
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS author_pubkey text,
  ADD COLUMN IF NOT EXISTS fed_ts bigint,
  ADD COLUMN IF NOT EXISTS fed_hlc text;

COMMENT ON COLUMN harness_shared.bee_claim_specs.harness_slug IS
  'Federation scope (P-016): NULL = operator-scope (local-only); set = the hive HOME slug — the spec federates over that hive''s peer-log so remote bees'' get_next sees the queen''s spec.';

-- INSERT/DELETE capture (echo-guard for origin<>'local' lives inside
-- capture_substrate_outbox); UPDATE adds the no-op distinct guard (mig-102
-- pattern) so read-merge re-upserts don't re-enqueue.
CREATE OR REPLACE TRIGGER capture_bee_claim_specs_outbox_trg
  AFTER INSERT ON harness_shared.bee_claim_specs
  FOR EACH ROW WHEN (NEW.harness_slug IS NOT NULL)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('bee_id');

CREATE OR REPLACE TRIGGER capture_bee_claim_specs_outbox_upd_trg
  AFTER UPDATE ON harness_shared.bee_claim_specs
  FOR EACH ROW WHEN (NEW.harness_slug IS NOT NULL
        AND (OLD.spec IS DISTINCT FROM NEW.spec
             OR OLD.revision IS DISTINCT FROM NEW.revision
             OR OLD.updated_by IS DISTINCT FROM NEW.updated_by
             OR OLD.harness_slug IS DISTINCT FROM NEW.harness_slug))
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('bee_id');

CREATE OR REPLACE TRIGGER capture_bee_claim_specs_outbox_del_trg
  AFTER DELETE ON harness_shared.bee_claim_specs
  FOR EACH ROW WHEN (OLD.harness_slug IS NOT NULL)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('bee_id');

COMMIT;
