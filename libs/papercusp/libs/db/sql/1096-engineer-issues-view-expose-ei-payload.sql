-- 1096 — stop the engineer_issues view subtracting `_ei` from payload.
--
-- P-003 of plan silent-wrong-answers-2026-08-01 · WI-6688 · parent WI-6674
--
-- THE FOOTGUN
-- Severity has TWO access paths across two relations, and the wrong one is
-- silent. On the base table `harness_shared.work_items`, severity lives at
-- `payload->'_ei'->>'severity'` (measured 2026-09-02: non-NULL for 155,160 of
-- 155,160 issue-family rows). On the `harness_shared.engineer_issues`
-- compatibility VIEW, `_ei` is exploded into real columns and then the blob is
-- SUBTRACTED (`payload - '_ei' AS payload`), so that same accessor resolves to
-- NULL for EVERY row.
--
-- Both queries are syntactically valid. Both succeed. Neither warns. So
--
--   SELECT count(*) FROM harness_shared.engineer_issues
--    WHERE payload->'_ei'->>'severity' = 'critical';
--
-- returns 0 — which reads exactly like "there are no criticals" when there
-- were 27. That is the class this plan exists to remove: a well-formed,
-- plausible, WRONG answer with no signal that it is wrong.
--
-- WHY THIS FIX AND NOT A DOC
-- WI-6674 shipped two of its three remedies already: the CLAUDE.md accessor
-- table now binds accessor->relation explicitly, and dev:pg_query grew an
-- `always-NULL accessor` advisory (SILENT_NULL_PATH_TRAPS in
-- packages/operator-core/lib/pg-read-query.ts) that fires on this exact path.
-- Both are DOCUMENTATION — they warn a reader who is already at the door.
-- Neither makes the wrong answer impossible, and only one of the doors that
-- can ask this question is dev:pg_query; raw psql and code-embedded SQL are
-- unguarded. This migration removes the divergence itself: after it, the two
-- accessors AGREE, so the query that used to return a confident zero returns
-- the right answer instead of a warning about being wrong.
--
-- WHY EXPOSING THE WHOLE BLOB, NOT JUST severity
-- WI-6674's wording was "expose _ei.severity in payload". Re-adding a PARTIAL
-- `_ei` (severity only) would leave `payload->'_ei'->>'source'`,
-- `->>'found_during'`, `->>'created_by'`, `->>'assigned_by'`,
-- `->>'signal_origin'` still silently NULL — a half-populated blob is a WORSE
-- footgun than an absent one, because the first probe someone runs now
-- succeeds and teaches them the path is trustworthy. All of `_ei` or none.
--
-- BLAST RADIUS (measured 2026-09-02, before writing this)
--   * Dependent views on engineer_issues: ZERO (pg_depend/pg_rewrite walk,
--     run with a positive control — the same query returns 5 dependents for
--     work_items, so the instrument was verified before its zero was trusted).
--     CREATE OR REPLACE VIEW therefore cannot cascade-break a dependent.
--   * The INSTEAD OF DML trigger (engineer_issues_view_dml) already strips the
--     caller's `_ei` before rebuilding it:
--       payload = COALESCE(payload,'{}') || (v_payload - '_ei')
--                 || jsonb_build_object('_ei', v_ei)     -- migration 875
--     so a SELECT-then-write round trip through the view stays correct; the
--     restored blob cannot double-nest or overwrite the rebuilt one.
--   * Federation is untouched: the outbox capture functions read the BASE row
--     and project `(v_rec.payload - '_ei')` in PL/pgSQL (migrations 382, 423,
--     452, 559, 688, 965), never through this view.
--   * Remaining effect is additive only — readers of engineer_issues.payload
--     now see the `_ei` key they would have seen on the base table.
--
-- BONUS: `jsonb - text` raises 22023 on a scalar payload (see migration 725's
-- note). Removing the operator removes that error path from the view.
--
-- SURGICAL, NOT RESTATED. The view has accreted columns from migrations 646,
-- 790, 815, 946, 965 and others. Restating a full body here would silently
-- revert whatever landed most recently (the lesson of EI-21051688117859966),
-- so this patches the INSTALLED definition by string replacement and fails
-- loudly if the expected text is not present.
--
-- Idempotent: a second application sees the patched definition and does
-- nothing.

DO $mig1096$
DECLARE
  def          text;
  patched      text;
  old_proj     CONSTANT text := 'payload - ''_ei''::text AS payload';
  n_old        integer;
  n_base       bigint;
  n_view       bigint;
BEGIN
  SELECT pg_get_viewdef('harness_shared.engineer_issues'::regclass, true) INTO def;

  IF def IS NULL THEN
    RAISE EXCEPTION '1096: harness_shared.engineer_issues view not found';
  END IF;

  n_old := (length(def) - length(replace(def, old_proj, ''))) / length(old_proj);

  IF n_old > 1 THEN
    RAISE EXCEPTION
      '1096: expected exactly 1 occurrence of (%) in the engineer_issues view definition, found % — refusing to patch ambiguously',
      old_proj, n_old;
  END IF;

  IF n_old = 1 THEN
    patched := replace(def, old_proj, 'payload');
    EXECUTE 'CREATE OR REPLACE VIEW harness_shared.engineer_issues AS ' || patched;
    RAISE NOTICE '1096: patched engineer_issues.payload to project the full payload (was payload - ''_ei'')';

  -- ALREADY PATCHED. Postgres does NOT render a redundant column alias, so the
  -- patched projection comes back from pg_get_viewdef as a bare `payload,` —
  -- never as `payload AS payload`. Detecting the patched state by searching for
  -- the aliased form therefore never matches, and a re-run raised "refusing to
  -- guess" on a perfectly healthy view (caught in the rollback test, 2026-09-02).
  ELSIF def ~ '(^|\n)\s*payload\s*[,\n]' THEN
    RAISE NOTICE '1096: engineer_issues.payload already projects the full payload — verifying only';

  ELSE
    RAISE EXCEPTION
      '1096: engineer_issues view definition contains neither the expected projection (%) nor a bare `payload` projection — refusing to guess. Inspect pg_get_viewdef(''harness_shared.engineer_issues'') and update this migration.',
      old_proj;
  END IF;

  -- POST-CONDITION — assert the thing that actually changed.
  --
  -- The obvious check is "severity agrees with payload->'_ei'->>'severity'".
  -- It was written that way first, then MEASURED against a deliberately
  -- unpatched view (transaction, rolled back, 2026-09-02): it flagged 122,196
  -- of 166,626 rows. So it is falsifiable — but only PARTIALLY, and the blind
  -- spot is structural rather than incidental. The view defines severity as
  -- COALESCE(payload->'_ei'->>'severity','minor'), so for any row whose true
  -- severity IS the default, both sides collapse to 'minor' and the row passes
  -- on a fully broken view. That was 44,430 rows (27%) here, and on a corpus
  -- that happened to be all-'minor' the assertion would report a clean pass
  -- against a view that exposes nothing — a guard with the same failure mode as
  -- the bug it guards.
  --
  -- Assert the presence of the blob instead. Measured against the same
  -- unpatched control: base_with_ei 166,626 vs view_with_ei 0 — it separates
  -- the two states completely and has no default to hide behind.
  SELECT count(*) INTO n_base
    FROM harness_shared.work_items
   WHERE item_kind = ANY (ARRAY['bug','change','task']) AND payload ? '_ei';

  SELECT count(*) INTO n_view
    FROM harness_shared.engineer_issues
   WHERE payload ? '_ei';

  IF n_base <> n_view THEN
    RAISE EXCEPTION
      '1096: post-condition failed — % base issue-family rows carry `_ei` but only % surface it through the engineer_issues view; the payload projection is still subtracting the blob',
      n_base, n_view;
  END IF;

  RAISE NOTICE '1096: verified — % rows expose `_ei` through both the base table and the view; both severity accessors now agree', n_view;
END
$mig1096$;
