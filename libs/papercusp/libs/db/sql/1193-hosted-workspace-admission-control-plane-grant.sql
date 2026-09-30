-- Migration 1193 — control-plane admission grant for harness_shared.customer_workspaces.
-- (byoc-cloud-workspaces-gcp-aws-azure-2026-08-22 P-319 / WI-10002240; decision D-383.)
--
-- WHY. A hosted organization can never obtain its FIRST workspace. The gap is a
-- four-layer composition in which every individual layer is correct and defensible:
--   1. every hosted-browser route resolves through selectedHostedPrincipal, which
--      returns workspace_not_selected (403) without an already-selected workspace;
--   2. customer_workspaces_app_scope (hosted_app) has WITH CHECK requiring
--      id = current_setting('app.workspace_id') — unsatisfiable before one exists;
--   3. customer_workspaces.workspace_host_id is NOT NULL and FKs workspace_hosts;
--   4. and the control plane cannot step in on the customer's behalf, because
--      harness_app holds NO GRANT on this table at all.
--
-- Stated in one line: customer_workspaces is reachable only by a principal that
-- already holds the workspace it is trying to create. That is why no single-layer
-- review ever caught it — the defect exists only in the composition.
--
-- Measured 2026-09-22, as harness_app with app.workspace_id='papercusp-workspace',
-- inside BEGIN/ROLLBACK:
--   POSITIVE CONTROL  harness_shared.workspace_hosts             -> 25 rows visible
--   POSITIVE CONTROL  harness_shared.workspace_host_connections  ->  3 rows visible
--   SUBJECT           harness_shared.customer_workspaces         -> ERROR:
--                     permission denied for table customer_workspaces
--                     (on BOTH the SELECT and the INSERT)
-- The controls prove the role and the tenant setting work; only the subject fails.
-- Note the error CLASS: a missing table privilege, one level BELOW row-level security.
-- It is not the RLS row refusal ('new row violates row-level security policy') that
-- layer 2 produces for hosted_app, and it is not fixed by editing any policy.
--
-- WHAT. Give the control-plane role the same workspace-scoped reach on
-- customer_workspaces that migration 979 already granted it on the two sibling tables
-- of this same graph (workspace_hosts, workspace_host_connections). The USING/WITH
-- CHECK expression below is character-for-character the 979 local_workspace_isolation
-- predicate. This is an existing privilege SHAPE extended to the third table in the
-- subsystem, not a new privilege class.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. It does not touch customer_workspaces_app_scope.
-- The hosted_app customer-facing predicate is left byte-identical, so the organization
-- boundary closed by D-368 / WI-10002396 is not re-opened. Admission is performed BY
-- the operator; it is never bought by relaxing what a signed-up customer may see.
-- The rejected alternative was widening that hosted_app WITH CHECK to tolerate a
-- bootstrap INSERT with app.workspace_id unset — which would have edited the exact
-- tenant predicate that must not move.
--
-- DELETE is withheld on purpose. Admission INSERTs, and every lifecycle transition is
-- an UPDATE (state='deleted' together with deleted_at is an UPDATE, per
-- customer_workspaces_deleted_at_ck), so the control plane never needs to remove a
-- binding row. This is strictly less than the sibling tables grant.
--
-- Not destructive DDL: this migration only ADDS a grant and ADDS a PERMISSIVE policy.
-- Permissive policies OR together, so no currently-serving release loses any access,
-- and the older release checkout on :3070 is unaffected while this applies.

GRANT SELECT, INSERT, UPDATE ON TABLE harness_shared.customer_workspaces TO harness_app;

DROP POLICY IF EXISTS customer_workspaces_local_workspace_isolation
  ON harness_shared.customer_workspaces;

CREATE POLICY customer_workspaces_local_workspace_isolation
  ON harness_shared.customer_workspaces
  FOR ALL TO harness_app
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), ''))
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), ''));
