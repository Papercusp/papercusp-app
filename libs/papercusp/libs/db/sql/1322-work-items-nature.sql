-- 1322-work-items-nature.sql — enterprise-data-sources-2026-10-01 P-010 (WI-10005046)
--
-- D-011: non-work instances (records, documents, events) stay in work_items and
-- are TAGGED by a `nature` column; there is no records table and no row move.
-- D-008: the work predicate (P-009) reads only work_items columns, so nature is
-- stamped onto the row at mint, copied from datatype_registry (the source of
-- truth, P-008 / migration 1318). Work also carries an AUDIENCE (agent | human),
-- because human-decision work such as email-draft-proposal is nature=work but
-- must never be agent-claimable; P-009's predicate needs both on the row.
--
-- WHY A TRIGGER, NOT PER-WRITER STAMPING (D-017): the rows are minted by at
-- least four TS writers (plan-to-work-item promotion, plan-item
-- convert-at-pickup, condition-bridge mint, work_items:create and the packs that
-- call it, e.g. fundraise's pipeline-deal) plus raw SQL inserts in routines and
-- federation receive. A BEFORE trigger is the one mint seam every writer passes
-- through, so no writer can forget nature or stamp a value that disagrees with
-- the registry. The trigger always derives — a caller-supplied nature/audience
-- is overwritten — which makes "row nature == registry nature" an invariant
-- rather than a convention. A registry-side AFTER trigger re-stamps existing
-- rows when a datatype is (re)classified, so the invariant survives
-- reclassification too.
--
-- FALLBACK when no registry row matches (workspace_id, item_kind): work/agent.
-- That covers built-in kinds in workspaces other than papercusp-workspace (1318
-- registers the built-ins there only; D-013 §1 makes them work/agent) and the
-- D-013 §5 legacy rule for unregistered generic kinds (preserves today's claim
-- behaviour). New datatype declarations cannot omit nature (meta:define-datatype
-- refuses), so every registered kind resolves through the registry.
--
-- COST: ADD COLUMN with a constant DEFAULT is metadata-only in PG >= 11, so the
-- ~250k existing rows are NOT rewritten and none of work_items' ~25 row triggers
-- fire for them; they read 'work'/'agent', which equals the derived fallback.
-- Only rows whose registry row says otherwise (today: email-draft-proposal ->
-- work/human, bet -> record) are UPDATEd. The DEFAULT is then dropped so the
-- trigger, not the default, decides every new row.
--
-- FORWARD-COMPAT: SET NOT NULL on work_items.nature does not break the currently
-- deployed release, whose writers never name nature or audience: the BEFORE
-- INSERT trigger below fills both for every insert before the NOT NULL check
-- runs, and the deployed release never UPDATEs these columns.

ALTER TABLE harness_shared.work_items
  ADD COLUMN IF NOT EXISTS nature   text DEFAULT 'work',
  ADD COLUMN IF NOT EXISTS audience text DEFAULT 'agent';

ALTER TABLE harness_shared.work_items
  ALTER COLUMN nature   DROP DEFAULT,
  ALTER COLUMN audience DROP DEFAULT;

COMMENT ON COLUMN harness_shared.work_items.nature IS
  'D-011: work | record | document | event, derived from datatype_registry at mint by nature_stamp_from_registry_trg (never hand-set). Read by the P-009 work predicate.';
COMMENT ON COLUMN harness_shared.work_items.audience IS
  'agent | human; set exactly when nature = work. human = never agent-claimable. Derived with nature.';

-- ── The single derivation: registry row for (workspace, kind), else work/agent.
CREATE OR REPLACE FUNCTION harness_shared.work_item_kind_nature(
  p_workspace_id text,
  p_item_kind    text,
  OUT nature     text,
  OUT audience   text
)
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(r.nature, 'work'),
         CASE WHEN r.nature IS NULL THEN 'agent' ELSE r.audience END
    FROM (SELECT 1) AS one
    LEFT JOIN harness_shared.datatype_registry r
      ON r.workspace_id   = p_workspace_id
     AND r.work_item_kind = p_item_kind
$$;

COMMENT ON FUNCTION harness_shared.work_item_kind_nature(text, text) IS
  'P-010 / D-008: the nature + audience a work_items row of this kind carries. Registry row wins; no row = work/agent (D-013 §1, §5).';

-- ── Mint-time stamp. Fires on INSERT and whenever an UPDATE names a column the
-- derivation depends on (or tries to hand-set nature/audience), and always
-- re-derives. Named so it sorts AFTER fill_ws_features_trg (which fills
-- workspace_id) and BEFORE the stamp_* federation triggers (which detect a
-- content change), so both see the final value.
CREATE OR REPLACE FUNCTION harness_shared.stamp_work_item_nature()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d record;
BEGIN
  SELECT k.nature, k.audience INTO d
    FROM harness_shared.work_item_kind_nature(NEW.workspace_id, NEW.item_kind) k;
  NEW.nature   := d.nature;
  NEW.audience := d.audience;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nature_stamp_from_registry_trg ON harness_shared.work_items;
CREATE TRIGGER nature_stamp_from_registry_trg
  BEFORE INSERT OR UPDATE OF item_kind, workspace_id, nature, audience
  ON harness_shared.work_items
  FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_work_item_nature();

-- ── Backfill: only rows whose registry nature/audience differs from the
-- fast-default work/agent. Setting nature routes through the trigger above, so
-- the backfill and the mint path share one derivation.
UPDATE harness_shared.work_items wi
   SET nature = NULL
  FROM harness_shared.datatype_registry r
 WHERE r.workspace_id   = wi.workspace_id
   AND r.work_item_kind = wi.item_kind
   AND (wi.nature, wi.audience) IS DISTINCT FROM (r.nature, r.audience);

-- ── Registry reclassification keeps existing rows in step (R-4: every row's
-- nature equals its datatype's registry nature).
CREATE OR REPLACE FUNCTION harness_shared.restamp_work_items_on_registry_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_pairs    text[][];
  v_ws       text;
  v_kind     text;
  v_nature   text;
  v_audience text;
  i          int;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_pairs := ARRAY[ARRAY[NEW.workspace_id, NEW.work_item_kind]];
  ELSIF TG_OP = 'DELETE' THEN
    v_pairs := ARRAY[ARRAY[OLD.workspace_id, OLD.work_item_kind]];
  ELSE
    v_pairs := ARRAY[ARRAY[OLD.workspace_id, OLD.work_item_kind],
                     ARRAY[NEW.workspace_id, NEW.work_item_kind]];
  END IF;

  FOR i IN 1 .. array_length(v_pairs, 1) LOOP
    v_ws   := v_pairs[i][1];
    v_kind := v_pairs[i][2];
    CONTINUE WHEN v_ws IS NULL OR v_kind IS NULL;
    SELECT k.nature, k.audience INTO v_nature, v_audience
      FROM harness_shared.work_item_kind_nature(v_ws, v_kind) k;
    UPDATE harness_shared.work_items wi
       SET nature = NULL
     WHERE wi.workspace_id = v_ws
       AND wi.item_kind    = v_kind
       AND (wi.nature, wi.audience) IS DISTINCT FROM (v_nature, v_audience);
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS restamp_work_items_nature_trg ON harness_shared.datatype_registry;
CREATE TRIGGER restamp_work_items_nature_trg
  AFTER INSERT OR DELETE OR UPDATE OF nature, audience, work_item_kind, workspace_id
  ON harness_shared.datatype_registry
  FOR EACH ROW EXECUTE FUNCTION harness_shared.restamp_work_items_on_registry_change();

-- ── Constraints, in ONE statement so the table is verified in a single scan.
ALTER TABLE harness_shared.work_items
  DROP CONSTRAINT IF EXISTS work_items_nature_check,
  DROP CONSTRAINT IF EXISTS work_items_audience_check;

ALTER TABLE harness_shared.work_items
  ALTER COLUMN nature SET NOT NULL,
  ADD CONSTRAINT work_items_nature_check
    CHECK (nature IN ('work', 'record', 'document', 'event')),
  ADD CONSTRAINT work_items_audience_check
    CHECK (
      (audience IS NULL OR audience IN ('agent', 'human'))
      AND ((nature = 'work') = (audience IS NOT NULL))
    );
