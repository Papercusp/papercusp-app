-- 799-guard-797-message-self-diagnosis.sql
--
-- EI-20202062074776959 / WI-38056 (plan luna-audit-fixes-2026-08-12, D-002) —
-- migration 797's terminal-transition guard refuses a write and then names
-- `work_items:set_state` / `work_items:complete` as the fix. On a host whose
-- operator process PREDATES the base-table lifecycle writer those two tools are
-- exactly what hit the refusal, so the message is a CLOSED LOOP: the documented
-- fix is the thing that just failed. One filed item put it plainly — "both are
-- refused by the migration-797 guard whose message names those exact two tools
-- as the fix — WI-38013 cannot be closed by any documented path".
--
-- Measured 2026-08-11/12: the luna bug-drain fleet filed at least four separate
-- work-items against this one message (EI-20202062074776959,
-- EI-20201829661911170, EI-20202539982390282, EI-20201153654747547), and it left
-- WI-38045 unable to close through any documented route.
--
-- THE GUARD ITSELF IS CORRECT AND IS NOT TOUCHED. Its predicate, its scope and
-- its refusal all stay exactly as 797 armed them (gui-chat-e2e-actions-2026-08-11
-- D-011/D-014: the refusal is PER-HOST — do not revert the guard, and do not
-- force-deploy on the premise that it is fleet-wide). Only the DIAGNOSIS the
-- exception carries changes.
--
-- WHY THE MESSAGE IS THE RIGHT LAYER, and code is not: a stale host runs stale
-- CODE. No code-side improvement can ever reach it — that is the definition of
-- the failure. This trigger lives in the SHARED database, so a better message
-- reaches every host, current or stale, with no deploy at all.
--
-- WHY IT CAN TELL THE TWO CAUSES APART instead of listing both and hoping: the
-- operator tags every connection `pcusp:<pool>:p<pid>` through application_name,
-- and a CURRENT operator never reaches this trigger for a terminal transition at
-- all (issues-engineer.ts writes terminal state straight to
-- harness_shared.work_items). So a `pcusp:%` client arriving HERE is, necessarily,
-- a stale operator — and the message can name the pid to restart. Anything else
-- is a raw/legacy UPDATE and keeps the original instruction verbatim.
--
-- The non-operator branch preserves migration 797's message TEXT byte-for-byte,
-- because two tests assert on it (libs/papercusp/libs/db/src/
-- engineer-issues-view-dml.integration.test.ts) and the substring
-- "terminal transition refused" is load-bearing in both branches.
--
-- SURGERY, NOT A FULL FUNCTION RESTATEMENT — the same discipline 797 used, for
-- the same reason: this function has accumulated the federated-row guard, payload
-- normalization, the claim-race guard, authority passthrough and the stored-row
-- RETURNING fix in separate migrations. Patch the installed definition and assert
-- the post-condition so this migration cannot silently revert a sibling fix.

-- ORDERING HAZARD, HANDLED EXPLICITLY. Migration 798
-- (EI-20202629116790410, currently parked PENDING-CODE-DEPLOY) rewrites the SAME
-- RAISE statement this migration patches, toward the same goal by a simpler
-- route: one unconditional "this release still uses the compatibility-view
-- writer" message, with no way to tell an operator from a raw caller.
--
-- If 798 is ever armed it sorts FIRST, so a single-anchor 799 would find nothing,
-- raise, and fail the whole migration run — breaking every fresh database
-- provision (including the integration suite, which asserts
-- appliedCount === totalKnown). So this migration accepts EITHER predecessor's
-- text as its anchor and converges both to the same self-diagnosing pair. 798
-- then no-ops or is harmlessly superseded, in any order, with no coordination.

DO $mig799$
DECLARE
  def         text;
  patched     text;
  anchor      text;
  marker      CONSTANT text := 'EI-20202062074776959: self-diagnosing refusal';
  anchor_797  CONSTANT text := 'RAISE EXCEPTION ''engineer_issues terminal transition refused — use setIssueState/work_items:set_state or work_items:complete so completion integrity is enforced (issue %) '', NEW.issue_id;';
  anchor_798  CONSTANT text := 'RAISE EXCEPTION ''engineer_issues terminal transition refused — this release still uses the compatibility-view writer; deploy the base-table setIssueState/work_items companion before retrying (issue %) '', NEW.issue_id;';
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'harness_shared'
     AND p.proname = 'engineer_issues_view_dml';

  IF def IS NULL THEN
    RAISE EXCEPTION '799: harness_shared.engineer_issues_view_dml() not found — expected migration 797 to have installed the terminal guard first';
  END IF;

  IF position(marker IN def) > 0 THEN
    RAISE NOTICE '799: engineer_issues_view_dml refusal is already self-diagnosing — no-op';
    RETURN;
  END IF;

  -- 797 IS PARKED ON DISK (.PENDING-CODE-DEPLOY) THOUGH IT IS RECORDED APPLIED ON
  -- THE LIVE DB — it was armed, applied, then re-parked. The migration runner
  -- filters to *.sql, so a FRESH database never installs the guard, and a hard
  -- failure here would abort the whole provision for every new install and every
  -- integration run. There is nothing to improve when there is no refusal to
  -- improve: no-op, and let 797 install the pair whenever it is finally armed.
  --
  -- Deliberately NOT installing the guard ourselves: parking 797 is what keeps
  -- the refusal off hosts whose writer is not deployed, and arming it from here
  -- would defeat exactly that.
  IF position('EI-20092514168581881: refuse ungated terminal transitions' IN def) = 0 THEN
    RAISE NOTICE '799: migration 797''s terminal guard is not installed on this database (797 is parked) — nothing to diagnose; no-op';
    RETURN;
  END IF;

  -- Accept either predecessor's refusal statement (see the ORDERING HAZARD note).
  IF position(anchor_797 IN def) > 0 THEN
    anchor := anchor_797;
  ELSIF position(anchor_798 IN def) > 0 THEN
    anchor := anchor_798;
    RAISE NOTICE '799: migration 798 already rewrote the refusal — converging its message to the self-diagnosing pair';
  ELSE
    RAISE EXCEPTION '799: neither migration 797''s nor migration 798''s refusal statement was found verbatim in engineer_issues_view_dml — the guard was restructured; re-derive the surgery anchor instead of forcing this migration';
  END IF;

  patched := replace(
    def,
    anchor,
    $patch799$-- EI-20202062074776959: self-diagnosing refusal. A `pcusp:%` client that
    -- reaches this branch is necessarily a STALE operator (a current one writes
    -- the base table and never gets here), so say that instead of naming the two
    -- tools that are themselves being refused.
    IF COALESCE(current_setting('application_name', true), '') LIKE 'pcusp:%' THEN
      RAISE EXCEPTION 'engineer_issues terminal transition refused for issue % — and RE-CALLING work_items:complete / work_items:set_state CANNOT FIX IT. This UPDATE arrived on operator connection "%", which still routes terminal state through the engineer_issues compatibility view; a CURRENT operator writes harness_shared.work_items directly and never reaches this trigger. So that process is running code older than issues-engineer.ts EI-20092514168581881, the REQUIRES-DEPLOYED half of migration 797. FIX: redeploy or restart THAT operator process, then retry the close once. Any completion record you already submitted is stored — only the state flip is outstanding.', NEW.issue_id, COALESCE(current_setting('application_name', true), '?')
        USING HINT = 'Dev box, force it now: PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --execute — then re-run the close. Do NOT revert the guard and do NOT force-deploy on a fleet-wide premise: this refusal is PER-HOST (plan gui-chat-e2e-actions-2026-08-11, D-014).';
    ELSE
      RAISE EXCEPTION 'engineer_issues terminal transition refused — use setIssueState/work_items:set_state or work_items:complete so completion integrity is enforced (issue %) ', NEW.issue_id
        USING HINT = 'The issue compatibility view is a read/field-edit surface, not a lifecycle writer. If you ARE an operator process and reached this, your build predates issues-engineer.ts EI-20092514168581881 — redeploy that process rather than retrying the tools (EI-20202062074776959).';
    END IF;$patch799$
  );

  EXECUTE patched;

  SELECT pg_get_functiondef(p.oid)
    INTO def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'harness_shared'
     AND p.proname = 'engineer_issues_view_dml';

  -- Post-conditions: the new diagnosis is installed, BOTH branches survived, and
  -- 797's own guard predicate is still in place (this migration must never be a
  -- back-door that relaxes the terminal-transition refusal).
  IF position(marker IN def) = 0
     OR position('LIKE ''pcusp:%''' IN def) = 0
     OR position('RE-CALLING work_items:complete' IN def) = 0
     OR position('so completion integrity is enforced (issue %)' IN def) = 0
     OR position('EI-20092514168581881: refuse ungated terminal transitions' IN def) = 0
     OR position('NEW.state IN (''resolved'', ''closed'', ''done'', ''dropped'')' IN def) = 0
  THEN
    RAISE EXCEPTION '799: post-condition failed — engineer_issues_view_dml is missing the self-diagnosing refusal, one of its two branches, or migration 797''s guard predicate';
  END IF;

  RAISE NOTICE '799: engineer_issues_view_dml refusal now diagnoses a stale operator process instead of naming the refused tools';
END
$mig799$;
