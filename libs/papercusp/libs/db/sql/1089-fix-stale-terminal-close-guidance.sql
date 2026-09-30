-- 1089-fix-stale-terminal-close-guidance.sql
--
-- EI-22057755567641150 — the live database has an already-applied 804 body
-- whose stale-operator refusal points callers at the staging MCP URL but gives
-- no ptool invocation. The supported ptool route is `--url=...`; `--port` is
-- not a ptool flag, and clearing PAPERCUSP_OPERATOR_URL still leaves ptool on
-- its default :3070. A new migration is required because editing applied 804
-- cannot change the function installed on existing databases.
--
-- This is message-only surgery. The terminal guard, its predicate, the
-- non-operator branch, and all other accumulated trigger fixes remain intact.
-- The migration is idempotent so it can be applied both to the live older 804
-- body and to fresh databases where 804 is already current.

DO $mig1089$
DECLARE
  def          text;
  patched      text;
  n_old_raise  integer;
  n_old_hint   integer;
  n_new_raise  integer;
  n_new_hint   integer;

  old_raise CONSTANT text := $old1089$RAISE EXCEPTION 'engineer_issues terminal transition refused for issue % — and RE-CALLING work_items:complete / work_items:set_state CANNOT FIX IT. This UPDATE arrived on operator connection "%", which still routes terminal state through the engineer_issues compatibility view; a CURRENT operator writes harness_shared.work_items directly and never reaches this trigger. So that process is running code older than issues-engineer.ts EI-20092514168581881, the REQUIRES-DEPLOYED half of migration 797. FIX: re-post the same unmodified work_items:complete / work_items:set_state payload to the staging operator at http://127.0.0.1:3170/api/mcp?superuser=1; it writes harness_shared.work_items directly. Redeploying or restarting the release operator is not required. Any completion record you already submitted is stored — only the state flip is outstanding.', NEW.issue_id, COALESCE(current_setting('application_name', true), '?')$old1089$;
  old_hint  CONSTANT text := $old1089hint$Re-post the same payload to the staging operator at http://127.0.0.1:3170/api/mcp?superuser=1 on this host; it writes harness_shared.work_items directly. Do not keep retrying this release connection. Redeploying or restarting the release operator is optional, not required.$old1089hint$;

  new_raise CONSTANT text := $new1089$RAISE EXCEPTION 'engineer_issues terminal transition refused for issue % — and RE-CALLING work_items:complete / work_items:set_state CANNOT FIX IT. This UPDATE arrived on operator connection "%", which still routes terminal state through the engineer_issues compatibility view; a CURRENT operator writes harness_shared.work_items directly and never reaches this trigger. So that process is running code older than issues-engineer.ts EI-20092514168581881, the REQUIRES-DEPLOYED half of migration 797. FIX: re-post the same unmodified work_items:complete / work_items:set_state payload to the staging operator. With ptool, pass --url=http://127.0.0.1:3170 explicitly — unsetting PAPERCUSP_OPERATOR_URL leaves ptool on its default :3070. Direct MCP clients may use the staging operator at http://127.0.0.1:3170/api/mcp?superuser=1. The staging writer updates harness_shared.work_items directly. Redeploying or restarting the release operator is not required. Any completion record you already submitted is stored — only the state flip is outstanding.', NEW.issue_id, COALESCE(current_setting('application_name', true), '?')$new1089$;
  new_hint  CONSTANT text := $new1089hint$Re-post the same payload to the staging operator on this host. For ptool, pass --url=http://127.0.0.1:3170 explicitly; unsetting PAPERCUSP_OPERATOR_URL still leaves ptool''s default at :3070. Direct MCP clients may use the staging operator at http://127.0.0.1:3170/api/mcp?superuser=1. Do not keep retrying this release connection. Redeploying or restarting the release operator is optional, not required.$new1089hint$;
  new_hint_marker CONSTANT text := 'For ptool, pass --url=http://127.0.0.1:3170 explicitly';
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'harness_shared'
     AND p.proname = 'engineer_issues_view_dml';

  IF def IS NULL THEN
    RAISE EXCEPTION '1089: harness_shared.engineer_issues_view_dml() not found — expected migration 799/804 to have installed the terminal refusal first';
  END IF;

  n_new_raise := (length(def) - length(replace(def, new_raise, ''))) / length(new_raise);
  -- The hint is a SQL string literal inside the stored PL/pgSQL source, so
  -- pg_get_functiondef may choose a different quote spelling for apostrophes.
  -- Count a quote-free semantic marker instead of treating that serialization
  -- detail as a different behavior.
  n_new_hint := (length(def) - length(replace(def, new_hint_marker, ''))) / length(new_hint_marker);
  IF n_new_raise = 1 AND n_new_hint = 1 THEN
    RAISE NOTICE '1089: engineer_issues_view_dml already carries ptool --url staging guidance — no-op';
    RETURN;
  ELSIF n_new_raise <> 0 OR n_new_hint <> 0 THEN
    RAISE EXCEPTION '1089: engineer_issues_view_dml has a partial corrected guidance pair (raise %, hint %) — re-derive the surgery anchor instead of forcing this migration', n_new_raise, n_new_hint;
  END IF;

  -- Migration 797 is intentionally parked on disk while its deployed writer
  -- prerequisite is controlled. Match 804's no-op behavior on fresh databases
  -- that do not yet have the terminal guard.
  IF position('EI-20092514168581881: refuse ungated terminal transitions' IN def) = 0 THEN
    RAISE NOTICE '1089: migration 797 terminal guard is not installed — no stale guidance needs repair; no-op';
    RETURN;
  END IF;

  IF position('EI-20202062074776959: self-diagnosing refusal' IN def) = 0 THEN
    RAISE EXCEPTION '1089: migration 799''s self-diagnosing refusal was not found — re-derive the surgery anchor instead of forcing this migration';
  END IF;

  n_old_raise := (length(def) - length(replace(def, old_raise, ''))) / length(old_raise);
  n_old_hint := (length(def) - length(replace(def, old_hint, ''))) / length(old_hint);
  IF n_old_raise <> 1 THEN
    RAISE EXCEPTION '1089: expected exactly one stale 804 exception statement, found % — the installed trigger was restructured', n_old_raise;
  END IF;
  IF n_old_hint <> 1 THEN
    RAISE EXCEPTION '1089: expected exactly one stale 804 hint statement, found % — the installed trigger was restructured', n_old_hint;
  END IF;

  patched := replace(
    def,
    old_raise,
    '-- EI-22057755567641150: ptool requires --url; --port is not a supported ptool flag.' || E'\n    ' || new_raise
  );
  patched := replace(patched, old_hint, new_hint);

  EXECUTE patched;

  SELECT pg_get_functiondef(p.oid)
    INTO def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'harness_shared'
     AND p.proname = 'engineer_issues_view_dml';

  n_new_raise := (length(def) - length(replace(def, new_raise, ''))) / length(new_raise);
  n_new_hint := (length(def) - length(replace(def, new_hint_marker, ''))) / length(new_hint_marker);
  n_old_raise := (length(def) - length(replace(def, old_raise, ''))) / length(old_raise);
  n_old_hint := (length(def) - length(replace(def, old_hint, ''))) / length(old_hint);

  -- The post-conditions deliberately re-check the original lifecycle boundary:
  -- a message fix must never weaken the trigger it is explaining.
  IF n_new_raise <> 1
     OR n_new_hint <> 1
     OR n_old_raise <> 0
     OR n_old_hint <> 0
     OR position('ptool, pass --url=http://127.0.0.1:3170 explicitly' IN def) = 0
     OR position('127.0.0.1:3170/api/mcp?superuser=1' IN def) = 0
     OR position('--port 3170' IN def) > 0
     OR position('RE-CALLING work_items:complete' IN def) = 0
     OR position('so completion integrity is enforced (issue %)' IN def) = 0
     OR position('EI-20092514168581881: refuse ungated terminal transitions' IN def) = 0
     OR position('NEW.state IN (''resolved'', ''closed'', ''done'', ''dropped'')' IN def) = 0
  THEN
    RAISE EXCEPTION '1089: post-condition failed — new raise %, new hint %, old raise %, old hint %, url %, direct MCP %, unsupported --port %, recall %, raw branch %, guard %, predicate %',
      n_new_raise,
      n_new_hint,
      n_old_raise,
      n_old_hint,
      position('ptool, pass --url=http://127.0.0.1:3170 explicitly' IN def) > 0,
      position('127.0.0.1:3170/api/mcp?superuser=1' IN def) > 0,
      position('--port 3170' IN def) > 0,
      position('RE-CALLING work_items:complete' IN def) > 0,
      position('so completion integrity is enforced (issue %)' IN def) > 0,
      position('EI-20092514168581881: refuse ungated terminal transitions' IN def) > 0,
      position('NEW.state IN (''resolved'', ''closed'', ''done'', ''dropped'')' IN def) > 0;
  END IF;

  RAISE NOTICE '1089: engineer_issues_view_dml now gives a ptool --url staging recovery without unsupported --port guidance';
END
$mig1089$;
