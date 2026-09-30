-- 1241-engineer-issue-wire-row-preserve-payload-nulls.sql
--
-- EI-24552921468661465 — an explicit JSON null inside an issue-family row's payload
-- (processLifecycleVerdict.recheckAt:null on every gone/kill verdict) was silently
-- DELETED the first time the row made a federation round-trip.
--
-- ROOT CAUSE
--   harness_shared.engineer_issue_wire_row() (mig 1208) wrapped the WHOLE wire object
--   in jsonb_strip_nulls. That call is RECURSIVE: besides dropping the absent top-level
--   columns it was meant for, it reached into the opaque 'payload' (and 'tags') value and
--   removed every null-valued key at any depth. The shipped op therefore carried a
--   payload that differed from the stored one, and the engineer-issues projection applies
--   `payload = EXCLUDED.payload` (a whole-value replace) — so when a peer's copy of the op
--   replayed back onto this host (origin='remote'), the stored payload was overwritten
--   with the stripped one. Measured: every gone/kill verdict whose recheckAt survived has
--   updated_ts == its completion instant; every one that lost it was rewritten afterwards
--   (26 rows by one origin='remote' replay at 2026-09-28 07:56). The tool call, the
--   tool_invocations ledger, and the local merge (mergeIssuePayload) all preserve the
--   null — the loss is on the WIRE, which is why re-sending never repaired it.
--
--   Same defect class as WI-42437 / WI-1409142 (recursive jsonb_strip_nulls over
--   evidence in the terminal UPDATEs). feature_wire_row() already keeps nulls, and
--   engineer_issues_view_dml strips only the flat _ei object, so this function was the
--   last recursive strip over caller-owned JSON.
--
-- FIX
--   Strip nulls at the TOP LEVEL only (absent columns stay off the wire, exactly as
--   before) and carry 'payload' (minus the projected _ei) and 'tags' VERBATIM. An SQL
--   NULL or JSON-null payload/tags is still omitted, so the wire row is byte-identical to
--   the old one for every row whose payload/tags hold no nested null.
--
-- REPAIR
--   Restore recheckAt:null on the gone/kill verdicts that lost it — the process-lifecycle
--   judge contract specifies exactly that value for those decisions, so the repair
--   reconstructs, it does not invent. The UPDATE is a content change, so it re-federates
--   under the fixed wire row and heals peers too. Other nested nulls lost the same way
--   cannot be reconstructed (their original value is gone) and are not touched.

CREATE OR REPLACE FUNCTION harness_shared.engineer_issue_wire_row(
  r harness_shared.work_items,
  p_ws text,
  p_scope text,
  p_slug text
)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'workspace_id',      p_ws,
    'issue_id',          r.feature_id,
    'scope',             p_scope,
    'title',             r.title,
    'body',              COALESCE(r.summary, ''),
    'severity',          COALESCE(r.payload->'_ei'->>'severity', 'minor'),
    'source',            COALESCE(r.payload->'_ei'->>'source', 'engineer'),
    'state',             r.status,
    'terminal_reason',   r.terminal_reason,
    'terminal_owner',           r.terminal_owner,
    'terminal_completion_ref',  r.terminal_completion_ref,
    'authority',         r.authority,
    'closed_ts',         r.closed_ts,
    'created_ts',        r.created_ts,
    'assignee',          r.taken_by,
    'assigned_by',       r.payload->'_ei'->>'assigned_by',
    'assigned_at',       r.taken_at,
    'found_during',      r.payload->'_ei'->>'found_during',
    'linked_feature_id', r.payload->'_ei'->>'linked_feature_id',
    'created_by',        r.payload->'_ei'->>'created_by',
    'kind',              r.item_kind,
    'origin',            r.origin,
    'author_pubkey',     r.author_pubkey,
    'fed_ts',            r.fed_ts,
    'fed_hlc',           r.fed_hlc,
    'signal_origin',     COALESCE(r.payload->'_ei'->>'signal_origin', 'local'),
    'admission',            r.admission,
    'admitted_at',          r.admitted_at,
    'admitted_by',          r.admitted_by,
    'state_changed_at',     r.state_changed_at,
    'parent_id',            r.parent_id,
    'source_plan_slug',     r.source_plan_slug,
    'source_plan_item_ids', r.source_plan_item_ids,
    'expected_cost_cents',  r.expected_cost_cents,
    'harness_slug',      p_slug,
    'storage_harness_slug', r.harness_slug))
  -- Caller-owned JSON rides VERBATIM: jsonb_strip_nulls is recursive and must never
  -- reach inside it (EI-24552921468661465).
  || CASE WHEN r.payload IS NULL OR jsonb_typeof(r.payload) = 'null'
          THEN '{}'::jsonb
          ELSE jsonb_build_object('payload', r.payload - '_ei')
     END
  || CASE WHEN r.tags IS NULL OR jsonb_typeof(r.tags) = 'null'
          THEN '{}'::jsonb
          ELSE jsonb_build_object('tags', r.tags)
     END
$function$;

COMMENT ON FUNCTION harness_shared.engineer_issue_wire_row(harness_shared.work_items, text, text, text) IS
  'WI-10002875: the ONE engineer-issues wire projection of an issue-family work_items row. '
  'capture_work_items_outbox ships it; stamp_local_federated_write moves the clock only when it changes. '
  'EI-24552921468661465: nulls are stripped at the top level only; payload and tags ride verbatim.';

-- Repair: gone/kill verdicts whose contract-mandated recheckAt:null was stripped.
UPDATE harness_shared.work_items
   SET payload = jsonb_set(payload, '{out,processLifecycleVerdict,recheckAt}', 'null'::jsonb, true)
 WHERE jsonb_typeof(payload #> '{out,processLifecycleVerdict}') = 'object'
   AND payload #>> '{out,processLifecycleVerdict,decision}' IN ('gone', 'kill')
   AND NOT ((payload #> '{out,processLifecycleVerdict}') ? 'recheckAt');
