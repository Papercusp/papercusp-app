-- 804-fix-terminal-close-staging-remedy.sql
--
-- EI-20219410123616014 — migration 799 correctly identifies a stale operator
-- process, but its remedy still prescribes redeploying or restarting the
-- release operator. The verified recovery is cheaper and immediate: re-post
-- the same completion payload to the staging operator on :3170, whose current
-- writer updates harness_shared.work_items directly.
--
-- ptool has its own operator-origin default of :3070. Clearing
-- PAPERCUSP_OPERATOR_URL does not select staging; callers using ptool must pass
-- --url=http://127.0.0.1:3170 explicitly. The trigger message below names that
-- flag so a recovery is not silently sent back to the stale release operator.
--
-- This is a message-only surgery. The terminal guard, its predicate, and the
-- completion-integrity boundary remain unchanged. A new migration is required
-- because 799 is already applied on live databases; editing 799 would not
-- change those databases.

DO $mig804$
DECLARE
  def       text;
  patched   text;
  -- pg_get_functiondef may normalize away comments, so use the durable URL
  -- literal as the idempotence marker rather than the migration comment.
  marker    CONSTANT text := '127.0.0.1:3170/api/mcp?superuser=1';
  old_raise CONSTANT text := $old804$RAISE EXCEPTION 'engineer_issues terminal transition refused for issue % — and RE-CALLING work_items:complete / work_items:set_state CANNOT FIX IT. This UPDATE arrived on operator connection "%", which still routes terminal state through the engineer_issues compatibility view; a CURRENT operator writes harness_shared.work_items directly and never reaches this trigger. So that process is running code older than issues-engineer.ts EI-20092514168581881, the REQUIRES-DEPLOYED half of migration 797. FIX: redeploy or restart THAT operator process, then retry the close once. Any completion record you already submitted is stored — only the state flip is outstanding.', NEW.issue_id, COALESCE(current_setting('application_name', true), '?')$old804$;
  old_hint  CONSTANT text := $hint804$Dev box, force it now: PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --execute — then re-run the close. Do NOT revert the guard and do NOT force-deploy on a fleet-wide premise: this refusal is PER-HOST (plan gui-chat-e2e-actions-2026-08-11, D-014).$hint804$;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'harness_shared'
     AND p.proname = 'engineer_issues_view_dml';

  IF def IS NULL THEN
    RAISE EXCEPTION '804: harness_shared.engineer_issues_view_dml() not found — expected migration 799 to have installed the stale-operator diagnosis first';
  END IF;

  IF position(marker IN def) > 0 THEN
    RAISE NOTICE '804: engineer_issues_view_dml already names the staging recovery — no-op';
    RETURN;
  END IF;

  -- Migration 797 is intentionally parked on fresh databases. Migration 799
  -- therefore no-ops when the terminal guard is absent; this follow-up must do
  -- the same instead of requiring a marker that 799 deliberately did not add.
  IF position('EI-20092514168581881: refuse ungated terminal transitions' IN def) = 0 THEN
    RAISE NOTICE '804: migration 797''s terminal guard is not installed on this database (797 is parked) — no staging remedy is needed; no-op';
    RETURN;
  END IF;

  IF position('EI-20202062074776959: self-diagnosing refusal' IN def) = 0 THEN
    RAISE EXCEPTION '804: migration 799''s self-diagnosing refusal was not found — re-derive the surgery anchor instead of forcing this migration';
  END IF;
  IF position(old_raise IN def) = 0 THEN
    RAISE EXCEPTION '804: migration 799''s stale redeploy message was not found verbatim — the guard was restructured; re-derive the surgery anchor instead of forcing this migration';
  END IF;
  IF position(old_hint IN def) = 0 THEN
    RAISE EXCEPTION '804: migration 799''s stale redeploy hint was not found verbatim — the guard was restructured; re-derive the surgery anchor instead of forcing this migration';
  END IF;

  patched := replace(
    def,
    old_raise,
    $patch804$-- EI-20219410123616014: staging recovery is the immediate remedy for a stale release operator.
    RAISE EXCEPTION 'engineer_issues terminal transition refused for issue % — and RE-CALLING work_items:complete / work_items:set_state CANNOT FIX IT. This UPDATE arrived on operator connection "%", which still routes terminal state through the engineer_issues compatibility view; a CURRENT operator writes harness_shared.work_items directly and never reaches this trigger. So that process is running code older than issues-engineer.ts EI-20092514168581881, the REQUIRES-DEPLOYED half of migration 797. FIX: re-post the same unmodified work_items:complete / work_items:set_state payload to the staging operator. With ptool, pass --url=http://127.0.0.1:3170 explicitly — unsetting PAPERCUSP_OPERATOR_URL leaves ptool on its default :3070. Direct MCP clients may use the staging operator at http://127.0.0.1:3170/api/mcp?superuser=1. The staging writer updates harness_shared.work_items directly. Redeploying or restarting the release operator is not required. Any completion record you already submitted is stored — only the state flip is outstanding.', NEW.issue_id, COALESCE(current_setting('application_name', true), '?')$patch804$
  );
  patched := replace(
    patched,
    old_hint,
  $patch804hint$Re-post the same payload to the staging operator on this host. For ptool, pass --url=http://127.0.0.1:3170 explicitly; unsetting PAPERCUSP_OPERATOR_URL still leaves ptool''s default at :3070. Direct MCP clients may use the staging operator at http://127.0.0.1:3170/api/mcp?superuser=1. The staging writer updates harness_shared.work_items directly. Do not keep retrying this release connection. Redeploying or restarting the release operator is optional, not required.$patch804hint$
  );

  EXECUTE patched;

  SELECT pg_get_functiondef(p.oid)
    INTO def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'harness_shared'
     AND p.proname = 'engineer_issues_view_dml';

  -- Post-conditions: the new recovery is installed, the stale-process
  -- discriminator remains, and the original terminal guard is still present.
  IF position(marker IN def) = 0
     OR position('127.0.0.1:3170/api/mcp?superuser=1' IN def) = 0
     OR position('RE-CALLING work_items:complete' IN def) = 0
     OR position('EI-20092514168581881: refuse ungated terminal transitions' IN def) = 0
     OR position('NEW.state IN (''resolved'', ''closed'', ''done'', ''dropped'')' IN def) = 0
  THEN
    RAISE EXCEPTION '804: post-condition failed — marker=%, url=%, recall=%, guard=%, predicate=%',
      position(marker IN def) > 0,
      position('127.0.0.1:3170/api/mcp?superuser=1' IN def) > 0,
      position('RE-CALLING work_items:complete' IN def) > 0,
      position('EI-20092514168581881: refuse ungated terminal transitions' IN def) > 0,
      position('NEW.state IN (''resolved'', ''closed'', ''done'', ''dropped'')' IN def) > 0;
  END IF;

  RAISE NOTICE '804: engineer_issues_view_dml refusal now names staging :3170 as the immediate recovery';
END
$mig804$;
