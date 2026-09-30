-- 362-backfill-engineer-issues-harness-workspace.sql
--
-- workspace-data-isolation-leaks-2026-06-17 D-009 (ISSUE plane) — the engineer_issues
-- analog of migration 360 (harness_docs) / migration 295 (plans/features). Owner-directed
-- (ownerhandle, 2026-06-22): scope issues PER-WORKSPACE, not the shared 'default' bus.
--
-- LOCKSTEP with the papercusp-issues-per-workspace flip (issuesScopeWorkspace() returns
-- activeWorkspaceId() when ON, else the legacy 'default'). The data move + the flag flip
-- MUST land together: the move WITHOUT the flip sends papercusp issue reads (still pinned
-- to 'default') to a now-empty set; the flip WITHOUT the move strands the rows under
-- 'default'. Operations apply this migration then flip the flag back-to-back (seconds),
-- reversibly (flip OFF + re-run the inverse to roll back).
--
-- WHAT: re-stamp the papercusp HARNESS's engineer_issues 'default' -> 'papercusp-workspace'
-- (scope 'harness:papercusp' and the legacy bare 'papercusp'). Operator-scope issues
-- (scope 'operator') INTENTIONALLY STAY in 'default' (that IS the operator/platform's own
-- workspace -- projects census 2026-06-22: default=5 projects / papercusp-workspace=1 /
-- lane7=1). Other harnesses' few stray issues are left untouched (ephemeral/test).
--
-- SAFE BY CONSTRUCTION:
--   * SCOPED to papercusp-harness issue scopes only ('harness:papercusp', 'papercusp').
--   * IDEMPOTENT: moves a row only while it is still under 'default'; a re-run / boot-apply
--     after a prior apply is a no-op (the rows are no longer 'default').
--   * In-txn GUARD: RAISE (-> rollback) if any papercusp-scoped issue is left under
--     'default' after the move (lockstep safety, mirrors migration 360's guard).
-- The migration runner wraps this file in ONE transaction (no BEGIN/COMMIT here). The
-- engineer_issues CDC/notify/updated_at triggers fire normally -- a legitimate local
-- workspace correction that may propagate; engineer_issues are the local engineering
-- backlog (not cross-hive-federated customer content), so this is harmless.

UPDATE harness_shared.engineer_issues
   SET workspace_id = 'papercusp-workspace'
 WHERE workspace_id = 'default'
   AND scope IN ('harness:papercusp', 'papercusp');

DO $$
DECLARE leftover int;
BEGIN
  SELECT count(*) INTO leftover
    FROM harness_shared.engineer_issues
   WHERE workspace_id = 'default'
     AND scope IN ('harness:papercusp', 'papercusp');
  IF leftover > 0 THEN
    RAISE EXCEPTION 'mig 362: % papercusp-scoped engineer_issues still under workspace_id=default after restamp', leftover;
  END IF;
END $$;
