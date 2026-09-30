-- 698-work-items-closed-ts.sql
--
-- EI-18820653360383242 — work_items has no close-timestamp column, so every
-- burn-down / velocity read is built on `updated_ts`, which moves on ANY write.
--
-- THE BUG ---------------------------------------------------------------------
-- `harness_shared.work_items` records WHAT state an item settled in
-- (status / terminal_owner / terminal_completion_ref / authority) but never WHEN
-- it settled. The only time signal is `updated_ts`, and that advances on every
-- subsequent write — a re-tag, a payload merge, a sweep, a bulk backfill.
--
-- So "what closed in the last N hours" is a proxy that any unrelated write
-- corrupts wholesale, and the corruption is INDISTINGUISHABLE from the real
-- event. Observed 2026-07-27: a routine burn-down reported 3,833 issue-family
-- items closed within one hour, all with terminal_owner NULL — the exact
-- signature of a fleet-scale mass unattributed close. It was nothing of the
-- kind: a bulk write had touched updated_ts on rows closed weeks earlier
-- (3,663 of 3,779 created more than a week before; oldest 2026-06-04). A drain
-- leader acting on that reading escalates a non-event; one dismissing it misses
-- a real one. Two investigation cycles went into telling those apart, and from
-- the timestamp alone they cannot be.
--
-- WHY THIS IS A TRIGGER AND NOT A COLUMN THE WRITERS REMEMBER TO SET ----------
-- The obvious shape is "stamp closed_ts in the same UPDATE that stamps
-- terminal_owner". That shape is wrong here, for a reason this repo has already
-- paid for twice.
--
-- There is no single terminal-write chokepoint. `terminal_owner` is stamped at
-- TWO sites, one per family — issues-engineer.ts (bug/change/task, through the
-- engineer_issues view) and work-items.ts (feature family, through
-- harness_features_consolidated). A column maintained by convention at N call
-- sites is only as good as the Nth site, and the half somebody forgets does not
-- fail loudly: it keeps returning a plausible number forever. That is the same
-- failure mode as the bug this file is fixing, reintroduced in a column that now
-- LOOKS authoritative — strictly worse than the honest `updated_ts` proxy,
-- because nobody second-guesses a column named `closed_ts`.
--
-- Worse, the issue-family write goes through an INSTEAD OF trigger whose column
-- enumeration must be edited by hand, and forgetting THAT is silent too: an
-- `UPDATE ... SET closed_ts = ...` through the view does not error, does not
-- warn, and does not write. Migration 677 shipped `authority` that way and the
-- entire issue family could not record one; 679 had to repair it.
--
-- Maintaining the column in a BEFORE trigger on the BASE TABLE removes every one
-- of those failure modes at once. It fires for both families, for the view DML
-- path, for federation, for a sweep, and for a hand-written backfill — there is
-- no writer that can bypass it and no enumeration to forget. The set-once rule
-- stops being a discipline repeated in N places and becomes a property of the
-- table.
--
-- THE SEMANTICS ---------------------------------------------------------------
-- closed_ts answers exactly one question: when did this item enter the terminal
-- state it is in NOW. It is derived from the state machine, not from the caller:
--
--   non-terminal -> terminal   the close. Stamp it (honouring a supplied value,
--                              see federation below).
--   terminal     -> terminal   NOT a close. This is the sweep / reconciler /
--                              re-close path, and freezing it here is the entire
--                              point of the column. Frozen from OLD, so a caller
--                              cannot move it — deliberately or by accident.
--   terminal     -> non-term.  a genuine reopen. The stored close is no longer
--                              true, so it is CLEARED. A reopened item must stop
--                              counting as closed.
--
-- That yields an exact invariant, asserted at the bottom of this file:
--   closed_ts IS NOT NULL  =>  status is terminal
-- (The converse does not hold, and must not: a terminal row with a NULL
-- closed_ts is the honest legacy shape — "closed, time unknown".)
--
-- WHY NOTHING IS BACKFILLED ---------------------------------------------------
-- Checked before writing this: the only candidate evidence source,
-- harness_shared.feature_audit_consolidated, holds ZERO rows recording a
-- transition INTO a terminal status (0 rows against 15,016 terminal items), so
-- there is no honest source for a historical close time. The alternative —
-- copying updated_ts into closed_ts — would launder precisely the corruption
-- this migration exists to remove into the column that is supposed to be
-- trustworthy. Existing terminal rows therefore keep closed_ts NULL. An honest
-- NULL beats a confident wrong answer, and a NULL is visibly "unknown" to every
-- consumer, which a wrong timestamp is not.
--
-- WHY THE VIEW EDITS ARE SURGERY ----------------------------------------------
-- Same reasoning as 679: this tree is edited concurrently by a whole fleet, so a
-- CREATE OR REPLACE VIEW authored from a definition that is even minutes stale
-- silently reverts whatever landed in between. So the view work anchors on the
-- STRUCTURAL end of the select list (the sole `FROM harness_shared.work_items`)
-- rather than on any particular trailing column name — that anchor survives a
-- peer appending a column of their own, and its uniqueness is asserted before
-- use. Every step fails loudly or works; none can half-apply.
--
-- Idempotent throughout: re-running against an already-patched schema is a no-op.

-- ---------------------------------------------------------------------------
-- 1. The column.  work_items is the BASE TABLE (verified 2026-07-27 via
--    pg_class.relkind = 'r'; both family relations are views over it), so this
--    is a plain ALTER TABLE. bigint epoch-ms matches the *_ts family convention
--    (ts / created_ts / updated_ts / fed_ts), NOT the timestamptz *_at family.
-- ---------------------------------------------------------------------------
ALTER TABLE harness_shared.work_items ADD COLUMN IF NOT EXISTS closed_ts bigint;

COMMENT ON COLUMN harness_shared.work_items.closed_ts IS
  'Epoch-ms when the item entered its CURRENT terminal status. Maintained solely by '
  'harness_shared.stamp_work_item_closed_ts() (EI-18820653360383242) — never write it '
  'directly; a write is ignored on any path except a first close carrying a federated '
  'origin time. Frozen across terminal->terminal re-closes, cleared on reopen. NULL on a '
  'terminal row means "closed, time unknown" (the pre-698 legacy shape) — it is NOT zero '
  'and must never be coalesced to updated_ts without labelling the read approximate.';

-- ---------------------------------------------------------------------------
-- 2. The canonical terminal-status predicate.
--
--    This word list already existed in SQL, inline in the WHEN clause of
--    wir_status_sync_dependents_trg, and in TypeScript as
--    SETTLED_WORK_ITEM_STATES (work-items.ts). Rather than paste it a third
--    time, name it once here so future SQL can share one definition. The
--    accompanying test asserts this function agrees with the TypeScript
--    constant, so the two cannot drift silently.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION harness_shared.work_item_status_is_terminal(s text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT s = ANY (ARRAY['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped'])
$fn$;

COMMENT ON FUNCTION harness_shared.work_item_status_is_terminal(text) IS
  'Canonical SQL-side terminal work-item status set. Mirrors SETTLED_WORK_ITEM_STATES in '
  'packages/operator-core/lib/work-items.ts; a test asserts the two agree.';

-- ---------------------------------------------------------------------------
-- 3. The maintainer.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION harness_shared.stamp_work_item_closed_ts()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Never INVENT a close time on insert. A row arriving already-terminal is a
    -- federated replica or a restore, and stamping now() would record its ARRIVAL
    -- time as its close time — exactly the wrong-timestamp class this column
    -- exists to eliminate. A supplied value (the origin's real close time, carried
    -- across by federation) is honoured; absent one the answer is an honest NULL.
    IF NOT harness_shared.work_item_status_is_terminal(NEW.status) THEN
      NEW.closed_ts := NULL;  -- uphold the invariant: only terminal rows carry a close time
    END IF;
    RETURN NEW;
  END IF;

  IF harness_shared.work_item_status_is_terminal(NEW.status) THEN
    IF harness_shared.work_item_status_is_terminal(OLD.status) THEN
      -- Terminal -> terminal: NOT a close, whatever the caller passed. Freeze.
      NEW.closed_ts := OLD.closed_ts;
    ELSE
      -- The boundary crossing: THE close. COALESCE so a federated write carrying
      -- the origin's real close time wins over local now().
      NEW.closed_ts := COALESCE(NEW.closed_ts, (extract(epoch FROM now()) * 1000)::bigint);
    END IF;
  ELSE
    -- Now non-terminal. If it was terminal this is a genuine reopen and the stored
    -- close is false; if it was never terminal there is nothing to hold. Either way
    -- the honest value is NULL.
    NEW.closed_ts := NULL;
  END IF;

  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS stamp_work_item_closed_ts_trg ON harness_shared.work_items;
CREATE TRIGGER stamp_work_item_closed_ts_trg
  BEFORE INSERT OR UPDATE ON harness_shared.work_items
  FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_work_item_closed_ts();

-- Burn-down reads are "terminal rows closed since T", always workspace-scoped.
-- Partial, because only terminal rows carry the column and they are the minority.
CREATE INDEX IF NOT EXISTS work_items_closed_ts_idx
  ON harness_shared.work_items (workspace_id, closed_ts)
  WHERE closed_ts IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Expose it on BOTH family views.
--
--    Both, in the same pass, deliberately: a column present on one family face
--    and absent from the other is how "the half you forget keeps lying" happens.
--    Exposed under the SAME NAME on both (closed_ts, not a closed_at timestamptz
--    face) so no consumer has to remember a per-family mapping. This is a READ
--    projection only — writes are the base-table trigger's job — so unlike 679
--    the engineer_issues INSTEAD OF trigger enumeration deliberately does NOT
--    change: a write through the view is ignored, which is the correct and
--    intended behaviour for a derived column.
-- ---------------------------------------------------------------------------
DO $mig698$
DECLARE
  v            text;
  def          text;
  patched      text;
  anchor       CONSTANT text := E'\n   FROM harness_shared.work_items';
  replacement  CONSTANT text := E',\n    closed_ts\n   FROM harness_shared.work_items';
  hits         int;
BEGIN
  FOREACH v IN ARRAY ARRAY['engineer_issues', 'harness_features_consolidated'] LOOP
    SELECT pg_get_viewdef(c.oid)
      INTO def
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared' AND c.relname = v;

    IF def IS NULL THEN
      RAISE EXCEPTION '698: harness_shared.% not found — expected it to exist before this migration runs', v;
    END IF;

    -- Already carries the column (a re-run, or a future migration got there first).
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'harness_shared' AND table_name = v AND column_name = 'closed_ts'
    ) THEN
      RAISE NOTICE '698: % already exposes closed_ts — no-op', v;
      CONTINUE;
    END IF;

    -- The anchor must be UNIQUE, or the replace() below could rewrite a subquery's
    -- FROM instead of the top-level select list. Verified as 1 for both views when
    -- this was written; asserted rather than assumed because a later restructuring
    -- would make a silent mis-patch possible.
    hits := (length(def) - length(replace(def, anchor, ''))) / length(anchor);
    IF hits <> 1 THEN
      RAISE EXCEPTION '698: expected exactly ONE "%" anchor in harness_shared.%, found % — the view has been restructured; re-derive the anchor instead of forcing this migration',
        anchor, v, hits;
    END IF;

    patched := replace(def, anchor, replacement);
    EXECUTE format('CREATE OR REPLACE VIEW harness_shared.%I AS %s', v, patched);

    -- Re-read from the catalog. That `patched` was right is not evidence that the
    -- installed view is right, and a silent miss is this migration's whole failure
    -- mode, so the post-condition is checked against information_schema.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'harness_shared' AND table_name = v AND column_name = 'closed_ts'
    ) THEN
      RAISE EXCEPTION '698: post-condition failed — harness_shared.% still does not expose closed_ts after CREATE OR REPLACE', v;
    END IF;

    RAISE NOTICE '698: % now exposes closed_ts', v;
  END LOOP;
END
$mig698$;

-- ---------------------------------------------------------------------------
-- 5. Post-conditions on the machinery itself.
-- ---------------------------------------------------------------------------
DO $mig698_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared'
       AND c.relname = 'work_items'
       AND t.tgname = 'stamp_work_item_closed_ts_trg'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION '698: post-condition failed — stamp_work_item_closed_ts_trg is not installed on harness_shared.work_items';
  END IF;

  -- The invariant. Nothing should violate it at install time (the column was just
  -- added, so every row is NULL), but assert it anyway: if a future change lets a
  -- non-terminal row carry a close time, this migration re-run says so out loud.
  IF EXISTS (
    SELECT 1 FROM harness_shared.work_items
     WHERE closed_ts IS NOT NULL
       AND NOT harness_shared.work_item_status_is_terminal(status)
  ) THEN
    RAISE EXCEPTION '698: invariant violated — non-terminal work_items rows carry a closed_ts';
  END IF;

  RAISE NOTICE '698: closed_ts installed (column + set-once trigger + both family views)';
END
$mig698_check$;
