-- 778: field-semantics comments for the work-item relations (P-018 / P-025,
-- plan fleet-lead-instrumentation-audit-2026-08-09).
--
-- WHY: the same three schema surprises cost repeated failed queries across the
-- fleet, and every one of them fails in the SAME direction — a plausible,
-- well-formed, CONFIDENT ZERO rather than an error:
--   * there is no top-level `id` (it is `feature_id`) and no `scope` column on
--     the TABLE, so a query modelled on the view dead-ends,
--   * severity lives at payload->'_ei'->>'severity' on the TABLE but is a real
--     COLUMN on the engineer_issues VIEW, which strips the '_ei' blob — so the
--     wrong accessor for the relation returns NULL for EVERY row without erroring.
--
-- MEASURED 2026-08-09 (this migration's own justification):
--   work_items    payload->'_ei'->>'severity' IS NOT NULL -> 34559   (correct)
--   work_items    payload ? 'severity'                    ->     2   (the trap)
--   engineer_issues severity IS NOT NULL                  -> 34566   (correct)
--   engineer_issues payload->'_ei'->>'severity'           ->     0   (the trap)
--
-- dev:pg_query already warns at QUERY time (WI-6674). These comments are the
-- other half: they surface through `dev:pg_query { describe }` at INSPECTION
-- time — before the wrong query is written — which is where P-025 asked for them.
--
-- Metadata-only (COMMENT ON), no data or structural change, so no FORWARD-COMPAT
-- acknowledgment is required: nothing in the deployed release reads these.

COMMENT ON COLUMN harness_shared.work_items.feature_id IS
  'The work-item PRIMARY id (WI-/EI-/F-…). There is NO top-level `id` column — this IS the id, kept under its legacy name through the feature→work-item unification, so `SELECT id` fails and a join written against `id` silently finds nothing. There is also NO `scope` column here: this TABLE scopes by harness_slug + workspace_id (multi-tenant — always predicate BOTH), while the harness_shared.engineer_issues VIEW exposes `scope` as ''harness:<slug>'' instead. Match the accessor to the relation. P-018.';

COMMENT ON COLUMN harness_shared.work_items.payload IS
  'Kind-specific work-item payload (jsonb). NULL for features (typed columns hold their data). ⚠ SEVERITY LIVES HERE, at payload->''_ei''->>''severity'' (migration 374 folded the _ei blob in) — there is no top-level severity column, so `payload ? ''severity''` matches ~nothing (measured 2026-08-09: 2 rows, versus 34559 via the _ei path) and reads exactly like "no criticals". The harness_shared.engineer_issues VIEW is the MIRROR IMAGE: it explodes every _ei sub-field into a real column and then subtracts the blob (payload - ''_ei''), so payload->''_ei''->>''severity'' is NULL for EVERY row there — use its `severity` COLUMN. Neither wrong form errors. Prefer work_items:list { severity } / work_items:claimable over either raw path. P-018 / WI-6674.';

COMMENT ON COLUMN harness_shared.engineer_issues.severity IS
  'Issue severity as a REAL COLUMN on this view (critical|major|minor|nit). Read it directly. Do NOT reach for payload->''_ei''->>''severity'' here — this view subtracts the _ei blob after exploding it into columns, so that path is NULL for every row and yields a confident wrong answer instead of an error (measured 2026-08-09: 0 via the _ei path vs 34566 via this column). That accessor is correct ONLY against the underlying harness_shared.work_items TABLE, which has no severity column. P-018 / WI-6674.';

COMMENT ON COLUMN harness_shared.engineer_issues.payload IS
  'Work-item payload with the ''_ei'' blob REMOVED (payload - ''_ei''): every _ei sub-field is exposed as a real column on this view instead — severity · source · found_during · linked_feature_id · created_by · assigned_by · signal_origin. So any payload->''_ei''->>''…'' read against this view resolves to NULL for EVERY row, silently. Use the columns; the _ei path is correct only against harness_shared.work_items. P-018 / WI-6674.';

COMMENT ON COLUMN harness_shared.engineer_issues.scope IS
  'Tenancy/rollup scope for this view, of the form ''harness:<slug>'' — this is the view''s harness predicate, and it has no counterpart on the underlying harness_shared.work_items TABLE (which scopes by harness_slug + workspace_id). A query moved between the two without swapping the predicate matches zero rows rather than erroring. P-018.';
