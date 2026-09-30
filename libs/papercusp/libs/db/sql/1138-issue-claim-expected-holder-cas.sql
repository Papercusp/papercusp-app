-- EI-22536788145490710: an authorized holder transfer passed claimIssue's
-- expected-assignee predicate but the installed INSTEAD OF UPDATE trigger
-- refused it. Historical migration 655 and the test fixture were amended,
-- leaving databases that had already applied 655 on the previous predicate.
-- A new migration is required to upgrade those databases.
--
-- The outer claim writer authorizes OLD.assignee; this inner CAS rechecks that
-- exact holder after acquiring the base-row lock. A different intervening holder
-- still loses the race. Force authorization, admission and remote-origin guards
-- remain in their existing writers. Patch the installed function in place so
-- later payload, lifecycle and stored-row RETURNING fixes are preserved.

DO $mig1138$
DECLARE
  def text;
  anchor CONSTANT text := 'OR taken_by = NEW.assignee';
  holder_leg CONSTANT text := 'OR taken_by = OLD.assignee';
  hits integer;
BEGIN
  SELECT pg_get_functiondef('harness_shared.engineer_issues_view_dml()'::regprocedure)
    INTO def;

  hits := (length(def) - length(replace(def, anchor, ''))) / length(anchor);
  IF hits <> 1 THEN
    RAISE EXCEPTION
      '1138: expected exactly one current-assignee claim guard, found %; re-derive the patch', hits;
  END IF;

  hits := (length(def) - length(replace(def, holder_leg, ''))) / length(holder_leg);
  IF hits = 0 THEN
    EXECUTE replace(def, anchor, anchor || E'\n        ' || holder_leg);
  ELSIF hits <> 1 THEN
    RAISE EXCEPTION
      '1138: expected at most one expected-holder claim guard, found %; re-derive the patch', hits;
  END IF;

  -- Read back the installed function, including on an idempotent replay.
  SELECT pg_get_functiondef('harness_shared.engineer_issues_view_dml()'::regprocedure)
    INTO def;
  IF (length(def) - length(replace(def, anchor, ''))) / length(anchor) <> 1
     OR (length(def) - length(replace(def, holder_leg, ''))) / length(holder_leg) <> 1
  THEN
    RAISE EXCEPTION '1138: installed claim guard failed its post-condition';
  END IF;
END
$mig1138$;
