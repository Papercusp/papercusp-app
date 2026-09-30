-- EI-19457370414604336: make the prior-work worker attribution live.
--
-- `worked_by_history` is deliberately local state (it is not federated), so the
-- writer belongs on the shared work_items base table rather than in one of the
-- feature/issue compatibility views. Every claim/release path already mutates
-- taken_by on this table, including view-triggered issue writes, stale reaping,
-- and terminal clears.

CREATE OR REPLACE FUNCTION harness_shared.record_work_item_worked_by_history()
RETURNS trigger
LANGUAGE plpgsql
AS $worked_history$
DECLARE
  worker text;
BEGIN
  -- Remote rows are owned by their authoring peer. Their projected claim churn
  -- must not become local prior-worker attribution on this node.
  IF NEW.fed_ts IS DISTINCT FROM OLD.fed_ts
     OR COALESCE(NEW.origin, 'local') = 'remote' THEN
    RETURN NEW;
  END IF;

  -- UPDATE OF taken_by also fires for an idempotent same-holder claim; only a
  -- real holder transition is a new piece of work history.
  IF NEW.taken_by IS NOT DISTINCT FROM OLD.taken_by THEN
    RETURN NEW;
  END IF;

  -- On claim use NEW.taken_by; on release NEW is NULL, so use OLD.taken_by.
  -- Ignore the legacy unassigned sentinel rather than attributing work to it.
  worker := NULLIF(btrim(COALESCE(NEW.taken_by, OLD.taken_by)), '');
  IF worker IS NULL OR lower(worker) = 'unassigned' THEN
    RETURN NEW;
  END IF;

  -- Keep the parser's durable shape small and stable. Existing malformed/null
  -- values degrade to a fresh array rather than making the claim fail.
  NEW.worked_by_history :=
    CASE WHEN jsonb_typeof(NEW.worked_by_history) = 'array'
      THEN NEW.worked_by_history
      ELSE '[]'::jsonb
    END
    || jsonb_build_array(jsonb_build_object('owner', worker, 'at', clock_timestamp()));

  RETURN NEW;
END;
$worked_history$;

-- Trigger names are execution order for same-kind PostgreSQL triggers. Run
-- before stamp_local_federated_write_trg so a local claim's fed_ts stamp does
-- not look like a remote projection to this writer.
DROP TRIGGER IF EXISTS work_items_worked_by_history_trg ON harness_shared.work_items;
DROP TRIGGER IF EXISTS record_work_item_worked_by_history_trg ON harness_shared.work_items;
CREATE TRIGGER record_work_item_worked_by_history_trg
  BEFORE UPDATE OF taken_by ON harness_shared.work_items
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.record_work_item_worked_by_history();
