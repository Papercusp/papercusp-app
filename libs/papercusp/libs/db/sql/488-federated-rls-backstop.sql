-- 488-federated-rls-backstop.sql
--
-- Workspace-isolation RLS backstop for five federated (CDC-captured) tables that
-- shipped without it — the exact gap rls-coverage.integration.test.ts
-- (packages/operator-core/lib/sync/hyperbee/__tests__/) guards against:
--
--   bee_claim_specs  (mig 372, scheduler claim-spec store)
--   gate_verdicts    (mig 442)
--   agent_facts      (mig 444)
--   p2p_peer_grants  (mig 463)
--   p2p_receipts     (mig 468)
--
-- Each is workspace_id-scoped + CDC-captured (TABLE_NAME_TO_TABLE_TAG in
-- feature-issue-op-keys.ts), so a federated row for workspace A would be readable
-- by workspace B's harness_app without this policy. VERIFIED zero behavioral
-- impact before landing: every live read/write path for all five goes through
-- getOrgPg() (harness_admin, BYPASSRLS) — claim-spec-store.ts, agent-facts/store.ts,
-- p2p/grant-store.ts, p2p/receipts.ts, all sync/hyperbee/projections/*, and the
-- sync-resolver (whose EI-1763 note records that getOrgPg bypasses RLS). RLS here
-- is defense-in-depth for harness_app connections only, exactly like mig-317
-- (hive_policy) / mig-186 (hive_settings), whose canonical policy shape this
-- mirrors verbatim.
--
-- Idempotent (DROP POLICY IF EXISTS + CREATE). No top-level BEGIN/COMMIT — the
-- migration runner wraps each file in its own transaction (lint:migrations).

ALTER TABLE harness_shared.bee_claim_specs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bee_claim_specs_workspace_isolation ON harness_shared.bee_claim_specs;
CREATE POLICY bee_claim_specs_workspace_isolation ON harness_shared.bee_claim_specs
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

ALTER TABLE harness_shared.gate_verdicts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gate_verdicts_workspace_isolation ON harness_shared.gate_verdicts;
CREATE POLICY gate_verdicts_workspace_isolation ON harness_shared.gate_verdicts
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

ALTER TABLE harness_shared.agent_facts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_facts_workspace_isolation ON harness_shared.agent_facts;
CREATE POLICY agent_facts_workspace_isolation ON harness_shared.agent_facts
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

ALTER TABLE harness_shared.p2p_peer_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p2p_peer_grants_workspace_isolation ON harness_shared.p2p_peer_grants;
CREATE POLICY p2p_peer_grants_workspace_isolation ON harness_shared.p2p_peer_grants
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

ALTER TABLE harness_shared.p2p_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS p2p_receipts_workspace_isolation ON harness_shared.p2p_receipts;
CREATE POLICY p2p_receipts_workspace_isolation ON harness_shared.p2p_receipts
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
