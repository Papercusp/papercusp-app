-- WI-10001739 link 3b: let the hosted-lifecycle reconciler read DBOS workflow liveness.
--
-- `reconcileHostedLifecycleJobs` runs through `withWorkspace`, i.e. as plain `harness_app`.
-- It decided whether a lifecycle operation was abandoned using ONLY row recency
-- (`recovery_attempts` + `heartbeat_at || updated_at` age), so a workflow DBOS was still
-- actively executing could be reaped and marked failed purely for looking old -- and the
-- reaper then wrote its own verdict over the operation's real terminal cause (link 3a).
--
-- The authoritative liveness signal is `dbos.workflow_status.status`, but `harness_app`
-- could not see it at all:
--     has_schema_privilege('harness_app','dbos','USAGE')                  = false
--     has_table_privilege('harness_app','dbos.workflow_status','SELECT')  = false
-- so the probe would have thrown on every sweep: silently inert at best, and -- if the read
-- were placed inside the sweep's own `FOR UPDATE` transaction -- an abort of the entire
-- workspace reconciliation on every run.
--
-- WHY THIS IS CONDITIONAL RATHER THAN A BARE GRANT
-- ------------------------------------------------
-- The `dbos` schema is NOT created by any migration; the DBOS SDK creates it at runtime on
-- first boot. So it is absent from a freshly-migrated baseline schema, and an unconditional
-- `GRANT USAGE ON SCHEMA dbos` fails there with SQLSTATE 3F000. Measured 2026-09-17: that
-- aborted `baseline-schema-global-setup` outright, i.e. it broke EVERY integration test in
-- the repo, not just this feature's. A migration must therefore tolerate the schema being
-- absent and grant only what is actually there.
--
-- This is a fast path for databases where DBOS has already booted (dev, staging, prod). It is
-- deliberately NOT the only path: `grantDbosWorkflowStatusRead()` re-applies the same grants
-- from the DBOS bootstrap after the SDK creates its schema, so a database that first sees
-- `dbos` only at runtime still converges. Both are idempotent and may run in either order.
--
-- The grant is READ-ONLY and as narrow as the question: USAGE on the schema plus SELECT on
-- the single status relation. No write, no DDL, no other dbos relation. `harness_admin` owns
-- both the schema and the table and migrations run as `harness_admin`, so this is within the
-- migration runner's own authority.
--
-- Not destructive and not expand/contract: a grant no deployed code exercises yet is inert
-- for the currently-serving release, so no FORWARD-COMPAT acknowledgment is required.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'dbos') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA dbos TO harness_app';

    IF EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'dbos' AND c.relname = 'workflow_status'
    ) THEN
      EXECUTE 'GRANT SELECT ON dbos.workflow_status TO harness_app';
    END IF;
  END IF;
END
$$;
