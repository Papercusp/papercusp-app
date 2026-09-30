-- 641-engineer-issues-view-dml-payload-scalar-guard.sql
--
-- WI-5493: harness_shared.engineer_issues_view_dml() (the INSTEAD OF INSERT/UPDATE
-- trigger backing the engineer_issues compat view) merges NEW.payload with the
-- derived `_ei` envelope via:
--
--   COALESCE(NEW.payload, '{}'::jsonb) || jsonb_build_object('_ei', v_ei)
--
-- Postgres jsonb `||` semantics: when the left operand is NOT itself a jsonb
-- OBJECT (e.g. it is a jsonb STRING SCALAR — the documented
-- "postgres-js-jsonb-binding" quirk where a client binds a JS object as a
-- jsonb-cast parameter and it lands as a double-encoded string scalar instead
-- of an object; see convert.integration.test.ts), `||` treats BOTH sides as
-- single-element arrays and concatenates them, producing
-- `["<original-json-string>", {"_ei": {...}}]` instead of a merged object —
-- silently destroying every named key on that issue's payload (severity,
-- source, plan_item stamp, any caller-set key), not just `_ei`.
--
-- FIX: normalize NEW.payload before the `||` merge, in a new v_payload local:
--   1. jsonb_typeof = 'string' → unwrap the postgres-js double-encoding via
--      `#>>'{}'` + re-cast to jsonb (mirrors the existing
--      normalizedPayloadExpr helper in plan-item-coverage.ts /
--      reconcile-linked-work-items.ts — same quirk, same fix shape).
--   2. Anything still not a jsonb object after that (array/number/boolean/
--      an unparsable string) is treated as empty ('{}'::jsonb) rather than
--      being allowed to array-corrupt the merge — wrapped in a BEGIN/EXCEPTION
--      so a malformed string scalar can't raise and abort the write either.
--
-- Idempotent: CREATE OR REPLACE FUNCTION. Only the payload-normalization step
-- changes (both the INSERT and UPDATE `||` merges now read from v_payload
-- instead of re-deriving COALESCE(NEW.payload, '{}'::jsonb) inline); the rest
-- of the function is reproduced verbatim from 521.

CREATE OR REPLACE FUNCTION harness_shared.engineer_issues_view_dml()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE v_slug text; v_ei jsonb; v_payload jsonb;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND EXISTS (
    SELECT 1
      FROM harness_shared.work_items cur
     WHERE cur.workspace_id = OLD.workspace_id
       AND cur.harness_slug = OLD.base_harness_slug
       AND cur.feature_id = OLD.issue_id
       AND cur.item_kind = OLD.kind
       AND cur.origin = 'remote'
  ) THEN
    -- EI-7833: a federated (origin='remote') row is owned by its authoring peer's
    -- core; the operator's LOCAL view writes must NOT clobber it. RETURN NULL so
    -- the INSTEAD OF trigger reports 0 rows affected + empty RETURNING.
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    DELETE FROM harness_shared.work_items
     WHERE workspace_id = OLD.workspace_id
       AND harness_slug = OLD.base_harness_slug
       AND feature_id = OLD.issue_id
       AND item_kind = OLD.kind;
    RETURN OLD;
  END IF;

  -- WI-5493: normalize NEW.payload to a real jsonb OBJECT before it is ever
  -- merged with `||` below — an un-normalized non-object payload silently
  -- array-corrupts the merge and destroys every named key.
  v_payload := COALESCE(NEW.payload, '{}'::jsonb);
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    BEGIN
      IF jsonb_typeof(v_payload) = 'string' THEN
        -- postgres-js-jsonb-binding quirk: a JS object bound as ::jsonb sometimes
        -- double-encodes to a jsonb string scalar holding the JSON text — unwrap it.
        v_payload := (v_payload #>> '{}')::jsonb;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_payload := '{}'::jsonb;
    END;
    IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
      -- Any other non-object shape (array/number/boolean, or a string that
      -- didn't unwrap to an object) would still corrupt the `||` merge — treat
      -- as empty rather than silently destroying the caller's named keys.
      v_payload := '{}'::jsonb;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.scope IS NOT DISTINCT FROM OLD.scope THEN
    v_slug := OLD.base_harness_slug;
  ELSE
    v_slug := CASE WHEN COALESCE(NEW.scope, 'operator') LIKE 'harness:%'
                   THEN substr(NEW.scope, 9)
                   ELSE 'operator:' || COALESCE(NULLIF(NEW.workspace_id, ''), 'default') END;
  END IF;

  v_ei := jsonb_strip_nulls(jsonb_build_object(
     'scope', NEW.scope, 'severity', NEW.severity, 'source', NEW.source,
     'found_during', NEW.found_during, 'linked_feature_id', NEW.linked_feature_id,
     'created_by', NEW.created_by, 'assigned_by', NEW.assigned_by, 'signal_origin', NEW.signal_origin));
  IF TG_OP = 'INSERT' THEN
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, taken_by, taken_at,
       expires_at, item_kind, origin, author_pubkey, assignee_rank, rank_writer,
       rank_updated_at, fed_ts, fed_hlc, ts, created_ts, updated_ts, payload,
       terminal_owner, terminal_completion_ref, last_progress_at)
    VALUES
      (COALESCE(NEW.workspace_id, 'default'), v_slug, NEW.issue_id, NEW.title,
       COALESCE(NEW.body, ''), COALESCE(NEW.state, 'open'), NEW.assignee, NEW.assigned_at,
       CASE WHEN NEW.assigned_at IS NOT NULL THEN NEW.assigned_at + INTERVAL '7 days' ELSE NULL END,
       COALESCE(NEW.kind, 'bug'), COALESCE(NEW.origin, 'local'), NEW.author_pubkey,
       NEW.assignee_rank, NEW.rank_writer, NEW.rank_updated_at, NEW.fed_ts, NEW.fed_hlc,
       (extract(epoch FROM COALESCE(NEW.updated_at, now())) * 1000)::bigint,
       (extract(epoch FROM COALESCE(NEW.created_at, now())) * 1000)::bigint,
       (extract(epoch FROM COALESCE(NEW.updated_at, now())) * 1000)::bigint,
       v_payload || jsonb_build_object('_ei', v_ei),
       NEW.terminal_owner, NEW.terminal_completion_ref, NEW.last_progress_at);
    RETURN NEW;
  ELSE
    UPDATE harness_shared.work_items SET
      harness_slug = v_slug, title = NEW.title, summary = COALESCE(NEW.body, ''),
      status = NEW.state, taken_by = NEW.assignee, taken_at = NEW.assigned_at,
      last_released_by = CASE WHEN NEW.assignee IS NULL AND OLD.assignee IS NOT NULL
                               THEN OLD.assignee ELSE last_released_by END,
      last_released_at = CASE WHEN NEW.assignee IS NULL AND OLD.assignee IS NOT NULL
                               THEN now() ELSE last_released_at END,
      last_progress_at = NEW.last_progress_at,
      item_kind = COALESCE(NEW.kind, 'bug'),
      origin = COALESCE(NEW.origin, 'local'),
      author_pubkey = NEW.author_pubkey, assignee_rank = NEW.assignee_rank,
      rank_writer = NEW.rank_writer, rank_updated_at = NEW.rank_updated_at,
      fed_ts = NEW.fed_ts, fed_hlc = NEW.fed_hlc,
      created_ts = (extract(epoch FROM COALESCE(NEW.created_at, now())) * 1000)::bigint,
      updated_ts = (extract(epoch FROM COALESCE(NEW.updated_at, now())) * 1000)::bigint,
      payload = (v_payload - '_ei') || jsonb_build_object('_ei', v_ei),
      terminal_owner = NEW.terminal_owner, terminal_completion_ref = NEW.terminal_completion_ref
    WHERE workspace_id = OLD.workspace_id
      AND harness_slug = OLD.base_harness_slug
      AND feature_id = OLD.issue_id
      AND item_kind = OLD.kind;
    RETURN NEW;
  END IF;
END;
$function$;
