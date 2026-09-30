-- 358-work-items-stalled-activity-views.sql
-- agent-activity-liveness-truth-2026-06-21 · P-002 (D-001/D-002/D-004).
--
-- SURFACE THE THIRD SIGNAL. Migration 357 added harness_features_consolidated.
-- last_progress_at (the REAL item-scoped progress signal — set ONLY by a state
-- transition / checkpoint, never a bare heartbeat). But no READER could see it:
-- the work_items VIEW (mig 178) projected an explicit column list that stopped at
-- rank_updated_at, and the fleet_assignment VIEW (mig 257) only computed
-- `orphaned` (live lease, DEAD holder). A live-but-not-progressing holder — the
-- second half of the incident (a CLAIM is not PROGRESS, D-001) — read as
-- "covered". This migration projects last_progress_at through both views and adds
-- a `stalled` column to fleet_assignment ALONGSIDE `orphaned`, so every reader of
-- "who's doing what" sees reserved/progressing/stalled/orphaned, not just claimed.
--
--   orphaned = live lease, holder DEAD (no fresh presence/nursery heartbeat).
--   stalled  = live lease, holder ALIVE, but no item-scoped progress within the
--              10-min window (= COALESCE(last_progress_at, taken_at) is stale).
--              "Claimed by a live agent" is NOT "the work is advancing."
-- They are mutually exclusive (stalled requires holder_alive; orphaned requires
-- NOT holder_alive). Both are RECLAIMABLE (P-003 reconciler reads the same rule).
--
-- The 10-minute window MIRRORS the existing fleet_assignment liveness interval
-- and STALE_MS (packages/operator-core/lib/liveness.ts) + classifyItemActivity()
-- (packages/operator-core/lib/item-activity.ts) — the SQL `stalled` leg and the
-- TS classifier are the SAME definition expressed on both sides of the wire, so
-- the presence UI / TS resolver (P-005) and the SQL reconciler can't drift.
--
-- A freshly-claimed row (last_progress_at NULL) falls back to taken_at, so it
-- gets the full grace window before it can read as stalled — never robbed mid
-- first unit of work. improvement-runner (a parked routine lane, EI-395) is
-- exempt from BOTH orphaned and stalled, exactly as it already is from orphaned.
--
-- Idempotent: CREATE OR REPLACE VIEW only APPENDS columns at the tail (Postgres
-- permits OR REPLACE when every existing output column keeps its name/type/
-- position), so the INSTEAD OF DML trigger on work_items (mig 178) and the
-- fleet_assignment change-feed survive untouched. work_items is replaced FIRST so
-- fleet_assignment can reference the newly-exposed w.last_progress_at.

\set ON_ERROR_STOP on
BEGIN;

-- ── 1) project last_progress_at through the work_items union view ──────────────
-- Reproduces mig 178's column space verbatim, appending last_progress_at at the
-- tail (feature leg = the real column; issue leg = NULL — engineer_issues has no
-- item-scoped progress signal, and issues are not the incident class).
CREATE OR REPLACE VIEW harness_shared.work_items AS
  SELECT
    harness_slug, feature_id, title, summary, status, attempts, claims, notes,
    metadata, kind, project_id, expected_cost_cents, tags, needs_human_review,
    ts, created_ts, updated_ts, parent_id, goal_id, taken_by, taken_at,
    expires_at, workspace_id, _search, deprecation_reason, see_also,
    needs_design, design_status, design_spec_id, discarded_design_work,
    completion_ref, created_by_github_user_id, working_users, worked_by_history,
    wave, verified_done_at_remote_ts, verifier_last_error,
    verifier_last_checked_at, source_plan_slug, source_plan_item_ids,
    feature_order, author_pubkey, origin, audit_verdict, audit_reasons,
    audited_at, item_kind, payload,
    assignee_rank, rank_writer, rank_updated_at,
    last_progress_at                              -- P-002: the item-scoped progress signal
  FROM harness_shared.harness_features_consolidated
  UNION ALL
  SELECT
    CASE WHEN ei.scope LIKE 'harness:%' THEN substr(ei.scope, 9) ELSE NULL END, -- harness_slug
    ei.issue_id,                                   -- feature_id (the work-item id)
    ei.title,
    ei.body,                                       -- summary
    ei.state,                                      -- status (open|resolved|closed)
    NULL::bigint,                                  -- attempts
    NULL::text,                                    -- claims
    NULL::text,                                    -- notes
    NULL::jsonb,                                   -- metadata
    NULL::text,                                    -- kind (legacy feature SUB-CATEGORY — not the discriminator)
    NULL::text,                                    -- project_id
    NULL::bigint,                                  -- expected_cost_cents
    NULL::jsonb,                                   -- tags
    FALSE,                                         -- needs_human_review
    (extract(epoch FROM ei.updated_at) * 1000)::bigint, -- ts
    (extract(epoch FROM ei.created_at) * 1000)::bigint, -- created_ts
    (extract(epoch FROM ei.updated_at) * 1000)::bigint, -- updated_ts
    NULL::text,                                    -- parent_id
    NULL::text,                                    -- goal_id
    ei.assignee,                                   -- taken_by
    ei.assigned_at,                                -- taken_at
    NULL::timestamptz,                             -- expires_at
    ei.workspace_id,
    ei._search,
    NULL::text,                                    -- deprecation_reason
    NULL::text[],                                  -- see_also
    FALSE,                                         -- needs_design
    NULL::text,                                    -- design_status
    NULL::text,                                    -- design_spec_id
    FALSE,                                         -- discarded_design_work
    NULL::jsonb,                                   -- completion_ref
    NULL::bigint,                                  -- created_by_github_user_id
    NULL::bigint[],                                -- working_users
    NULL::jsonb,                                   -- worked_by_history
    NULL::text,                                    -- wave
    NULL::timestamptz,                             -- verified_done_at_remote_ts
    NULL::text,                                    -- verifier_last_error
    NULL::timestamptz,                             -- verifier_last_checked_at
    NULL::text,                                    -- source_plan_slug
    NULL::text[],                                  -- source_plan_item_ids
    NULL::integer,                                 -- feature_order
    ei.author_pubkey,
    ei.origin,
    NULL::text,                                    -- audit_verdict
    NULL::text,                                    -- audit_reasons
    NULL::timestamptz,                             -- audited_at
    COALESCE(ei.kind, 'bug'),                      -- item_kind (the discriminator)
    ei.payload,
    ei.assignee_rank,                              -- assignee_rank
    ei.rank_writer,                                -- rank_writer
    ei.rank_updated_at,                            -- rank_updated_at
    NULL::timestamptz                              -- last_progress_at (issues have none)
  FROM harness_shared.engineer_issues ei;

COMMENT ON VIEW harness_shared.work_items IS
  'The canonical cross-kind work-item surface (unify-work-items D-010=(b)): UNION ALL of the per-kind tables — harness_features_consolidated (feature|research-task|chunk) + engineer_issues (bug|change|task) — in the feature column space. Discriminator = item_kind; kind-specific data = payload. Per-assignee ordered queue = assignee_rank (+ rank_writer bee|queen, local-hive P-020/D-008). last_progress_at = item-scoped progress signal (agent-activity-liveness-truth P-001/P-002; feature rows only). Writes route by kind via INSTEAD OF triggers (work_items_view_dml); the engine (work-items.ts) writes the base tables directly.';

-- ── 2) add `stalled` + last_progress_at to the fleet_assignment view ──────────
-- Reproduces mig 257's body verbatim (the alias-aware `holder` CTE + the EI-395
-- improvement-runner exemptions), appending last_progress_at + stalled at the
-- tail of EVERY leg. stalled is meaningful only on the work_item_claim leg (the
-- only claim kind carrying a progress signal); the other legs are NULL.
CREATE OR REPLACE VIEW harness_shared.fleet_assignment AS
WITH presence AS (
  SELECT
    owner_id, owner_label, workspace_id, source, intent, current_plan_slug,
    heartbeat_at,
    (now() - heartbeat_at) < interval '10 minutes' AS alive
  FROM harness_shared.coord_presence
),
-- EI-311: holder-liveness resolution across identity aliases. Presence rows
-- first (they carry intent/plan); then every alias of a RUNNING nursery row
-- that lacks its own presence row, carrying the nursery process heartbeat.
holder AS (
  SELECT
    owner_id AS alias, owner_label, intent, current_plan_slug, heartbeat_at, alive
  FROM presence
  UNION ALL
  SELECT DISTINCT ON (a.alias)
    a.alias,
    ('bee · ' || left(n.spawn_id, 10)) AS owner_label,
    NULL::text                          AS intent,
    NULL::text                          AS current_plan_slug,
    n.heartbeat_at,
    (n.heartbeat_at IS NOT NULL
      AND (now() - n.heartbeat_at) < interval '10 minutes') AS alive
  FROM harness_shared.spawned_agents n
  CROSS JOIN LATERAL (VALUES (n.spawn_id), (n.session_owner), (n.run_id)) AS a(alias)
  WHERE n.status = 'running'
    AND a.alias IS NOT NULL AND a.alias <> ''
    AND NOT EXISTS (SELECT 1 FROM presence p WHERE p.owner_id = a.alias)
)
SELECT
  'plan_item_claim'::text                          AS source,
  c.workspace_id,
  c.owner                                          AS agent_id,
  COALESCE(NULLIF(c.owner_label, ''), p.owner_label) AS agent_label,
  c.owner_name                                     AS agent_name,
  c.harness_slug,
  c.plan_slug,
  c.item_id,
  NULL::text                                       AS work_item_id,
  NULL::text                                       AS item_kind,
  c.intent                                         AS detail,
  NULL::text                                       AS status,
  c.acquired_ts                                    AS claim_acquired_ts,
  c.expires_ts                                     AS claim_expires_ts,
  (c.expires_ts > now())                           AS claim_active,
  c.liveness_mode,
  c.last_activity_ts,
  (p.alias IS NOT NULL)                            AS holder_present,
  COALESCE(p.alive, false)                         AS holder_alive,
  p.heartbeat_at                                   AS holder_heartbeat_at,
  p.intent                                         AS holder_intent,
  p.current_plan_slug                              AS holder_plan_slug,
  -- EI-395: a routine principal (improvement-runner) never heartbeats; its
  -- parked claim is not abandoned work, so it is never orphaned.
  (c.expires_ts > now() AND NOT COALESCE(p.alive, false) AND c.owner NOT IN ('improvement-runner')) AS orphaned,
  (p.current_plan_slug IS NOT DISTINCT FROM c.plan_slug)  AS declared_plan_matches,
  NULL::integer                                    AS assignee_rank,
  NULL::text                                       AS rank_writer,
  NULL::timestamptz                                AS last_progress_at,
  NULL::boolean                                    AS stalled  -- plan-item claims carry no progress signal
FROM harness_shared.plan_item_claims c
LEFT JOIN holder p ON p.alias = c.owner

UNION ALL
SELECT
  'plan_item_assignment'::text,
  a.workspace_id,
  a.assignee_name,
  NULL::text,
  a.assignee_name,
  a.harness_slug,
  a.plan_slug,
  a.item_id,
  NULL::text,
  NULL::text,
  COALESCE(a.note, ''),
  NULL::text,
  a.assigned_ts,
  NULL::timestamptz,
  true,
  NULL::text,
  a.updated_at,
  false,
  false,
  NULL::timestamptz,
  NULL::text,
  NULL::text,
  false,
  NULL::boolean,
  NULL::integer,
  NULL::text,
  NULL::timestamptz,                               -- last_progress_at
  NULL::boolean                                    -- stalled
FROM harness_shared.plan_item_assignments a
WHERE a.assignee_name IS NOT NULL AND a.released_ts IS NULL

UNION ALL
SELECT
  'work_item_claim'::text,
  w.workspace_id,
  w.taken_by,
  p.owner_label,
  NULL::text,
  w.harness_slug,
  w.source_plan_slug,
  NULL::text,
  w.feature_id,
  w.item_kind,
  COALESCE(w.title, ''),
  w.status,
  w.taken_at,
  NULL::timestamptz,
  true,
  NULL::text,
  w.taken_at,
  (p.alias IS NOT NULL),
  COALESCE(p.alive, false),
  p.heartbeat_at,
  p.intent,
  p.current_plan_slug,
  -- EI-395: see the plan_item_claim leg above — routine principals are exempt.
  (NOT COALESCE(p.alive, false) AND w.taken_by NOT IN ('improvement-runner')),
  CASE WHEN w.source_plan_slug IS NULL THEN NULL::boolean
       ELSE (p.current_plan_slug IS NOT DISTINCT FROM w.source_plan_slug) END,
  w.assignee_rank,                                 -- the per-assignee rank (P-021)
  w.rank_writer,                                   -- propose/dispose audit (D-008)
  w.last_progress_at,                              -- P-002: item-scoped progress signal
  -- stalled (agent-activity-liveness-truth P-002, D-001): the holder is ALIVE
  -- but the work is NOT advancing — no item-scoped progress in the 10-min window
  -- (a freshly-claimed row falls back to taken_at for the grace window). Mutually
  -- exclusive with orphaned (which requires NOT holder_alive). improvement-runner
  -- (parked routine lane, EI-395) is exempt, as it is from orphaned.
  (COALESCE(p.alive, false)
    AND w.taken_by NOT IN ('improvement-runner')
    AND (now() - COALESCE(w.last_progress_at, w.taken_at)) > interval '10 minutes') AS stalled
FROM harness_shared.work_items w
LEFT JOIN holder p ON p.alias = w.taken_by
WHERE w.taken_by IS NOT NULL AND w.taken_by <> ''
  AND COALESCE(w.status, '') NOT IN ('done', 'passed', 'deprecated', 'resolved', 'closed', 'dropped')

UNION ALL
SELECT
  'presence'::text,
  p.workspace_id,
  p.owner_id,
  p.owner_label,
  NULL::text,
  NULL::text,
  p.current_plan_slug,
  NULL::text,
  NULL::text,
  NULL::text,
  p.intent,
  NULL::text,
  NULL::timestamptz,
  NULL::timestamptz,
  NULL::boolean,
  NULL::text,
  p.heartbeat_at,
  true,
  p.alive,
  p.heartbeat_at,
  p.intent,
  p.current_plan_slug,
  false,
  NULL::boolean,
  NULL::integer,
  NULL::text,
  NULL::timestamptz,                               -- last_progress_at
  NULL::boolean                                    -- stalled
FROM presence p;

COMMENT ON VIEW harness_shared.fleet_assignment IS
  'Canonical "who''s on what" (state-not-chat-fleet-state D-002): claim-primary union of plan_item_claims + plan_item_assignments + work-item claims (work_items.taken_by) + coord_presence, each claim LEFT-joined to its holder''s liveness. EI-311: holder liveness resolves through coord_presence AND the nursery''s identity aliases (spawned_agents spawn_id/session_owner/run_id, status=running, process heartbeat). orphaned = live lease, DEAD holder; stalled = live lease, ALIVE holder, no item-scoped progress in the 10-min window (agent-activity-liveness-truth P-002, D-001 — a claim is not progress) — both reclaimable, mutually exclusive, both EXCEPT routine principals (improvement-runner, EI-395). last_progress_at surfaces the raw progress signal. work-item rows carry assignee_rank + rank_writer (local-hive P-021/D-008). Read via fleet:assignments; change-feed on channel fleet_assignment.';

GRANT SELECT ON harness_shared.fleet_assignment TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.fleet_assignment TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;

GRANT SELECT ON harness_shared.work_items TO harness_app;
DO $z$ BEGIN GRANT SELECT ON harness_shared.work_items TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL; END $z$;

COMMIT;
