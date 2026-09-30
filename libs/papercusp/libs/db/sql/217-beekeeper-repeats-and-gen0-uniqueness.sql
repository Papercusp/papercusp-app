-- 217: beekeeper repeats + gen-0 uniqueness (audit P-013 / EI-164).
--
-- 1. beekeeper_runs UNIQUE(instance_id, case_id) made repeats>1 silently broken:
--    the 2nd repeat of a case collides on the constraint, records `errored`, and
--    never scores — so --repeats=N produced one scored run per case, not N.
--    run_id (PK) already guarantees row uniqueness (gen0 run ids encode the
--    repeat: gen0-<sha>-<case>-r<repeat>), so the constraint is simply wrong.
--    A plain index replaces it for the (instance_id, case_id) lookups.
--
-- 2. beekeeper_instances UNIQUE(workspace_id, code_sha, genome_id) never applied
--    to gen-0 rows: SQL UNIQUE treats NULLs as distinct, so baseline instances
--    (genome_id IS NULL) could duplicate freely. The partial unique index closes
--    that hole. (Live DB verified dupe-free before this migration: 22 gen-0
--    rows, 0 duplicate (workspace_id, code_sha) groups.)

ALTER TABLE harness_shared.beekeeper_runs
  DROP CONSTRAINT IF EXISTS beekeeper_runs_instance_id_case_id_key;

CREATE INDEX IF NOT EXISTS beekeeper_runs_instance_case_idx
  ON harness_shared.beekeeper_runs (instance_id, case_id);

CREATE UNIQUE INDEX IF NOT EXISTS beekeeper_instances_gen0_unique
  ON harness_shared.beekeeper_instances (workspace_id, code_sha)
  WHERE genome_id IS NULL;
