-- Migration 178 — the per-assignee work-item RANK (local-hive-orchestration-2026-06-06
-- Phase 2, the keystone — P-020 / D-004 / D-008).
--
-- THE GROUNDING: no per-assignee rank exists today. The only work-item ordering is
-- harness_features_consolidated.feature_order — a per-HARNESS WAVE order, NOT a
-- per-AGENT queue. The Queen places ranked work onto a bee's slot, and a bee owns the
-- sequencing of its own list (propose/dispose, D-008). That ordered backlog is the
-- data EVERY placement decision reads (load + head-of-line for warm-inject, the ordered
-- plan for evict judgment). It lives as a per-assignee `rank` on the assigned work-item
-- (D-004: simplest — one item → one assignee → one rank).
--
-- The work_items surface is a UNION over TWO base tables (migration 159):
-- harness_features_consolidated (feature|research-task|chunk) + engineer_issues
-- (bug|change|task). An assignee can hold items of EITHER family, so the rank columns
-- must live on BOTH base tables and the unified view must expose them.
--
-- Columns added to each base table:
--   • assignee_rank   integer        — the item's position within its assignee's queue
--                                       (lower = nearer head-of-line; NULL = unranked).
--                                       Sparse-allowed; the reorder fn renumbers densely.
--   • rank_writer     text           — 'bee' | 'queen' — the propose/dispose audit
--                                       (D-008): who last set this rank. Default 'bee'
--                                       (bee-authored is the default; the Queen overrides).
--   • rank_updated_at timestamptz     — when the rank was last written (tiebreak + audit).
--
-- The rank is scoped to (assignee, workspace): it only means anything relative to the
-- OTHER items the same assignee holds. Two different bees' lists are independent — bee A
-- can have a rank-0 item while bee B also has a rank-0 item.
--
-- The reorder op (harness_shared.reorder_work_item) is the atomic write path: it places
-- one item at a target rank within its assignee's queue, shifting peers down to make
-- room, all under one statement so two concurrent reorders can't corrupt the ordering.
-- The MCP tool (work_items:reorder) carries the `writer` ('bee'|'queen') through to
-- rank_writer for the audit; the Queen-vs-bee write balance is gated by the EXISTING
-- automation/commit tier (P-022 — no new dial), NOT by this migration.
--
-- Composes onto 000-baseline + 131 (engineer_issues) + 142 (work_item_seq) + 159
-- (work_items union view + INSTEAD OF DML). Idempotent: ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS, CREATE OR REPLACE VIEW/FUNCTION/TRIGGER. Runs as
-- harness_admin.

\set ON_ERROR_STOP on
BEGIN;

-- ── 1) the columns on both base tables ───────────────────────────────────────────
ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS assignee_rank   integer,
  ADD COLUMN IF NOT EXISTS rank_writer     text,
  ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz;

ALTER TABLE harness_shared.engineer_issues
  ADD COLUMN IF NOT EXISTS assignee_rank   integer,
  ADD COLUMN IF NOT EXISTS rank_writer     text,
  ADD COLUMN IF NOT EXISTS rank_updated_at timestamptz;

-- A rank_writer, when set, must name the propose/dispose author. NULL = unranked.
DO $ck$ BEGIN
  ALTER TABLE harness_shared.harness_features_consolidated
    ADD CONSTRAINT hfc_rank_writer_chk
    CHECK (rank_writer IS NULL OR rank_writer IN ('bee', 'queen'));
EXCEPTION WHEN duplicate_object THEN NULL; END $ck$;
DO $ck$ BEGIN
  ALTER TABLE harness_shared.engineer_issues
    ADD CONSTRAINT engineer_issues_rank_writer_chk
    CHECK (rank_writer IS NULL OR rank_writer IN ('bee', 'queen'));
EXCEPTION WHEN duplicate_object THEN NULL; END $ck$;

-- Per-assignee ordered scans (the P-021 projection reads queued items in rank order).
CREATE INDEX IF NOT EXISTS hfc_assignee_rank_idx
  ON harness_shared.harness_features_consolidated USING btree (workspace_id, taken_by, assignee_rank)
  WHERE taken_by IS NOT NULL AND assignee_rank IS NOT NULL;
CREATE INDEX IF NOT EXISTS engineer_issues_assignee_rank_idx
  ON harness_shared.engineer_issues USING btree (workspace_id, assignee, assignee_rank)
  WHERE assignee IS NOT NULL AND assignee_rank IS NOT NULL;

-- ── 2) extend the work_items union view to expose the rank columns ────────────────
-- The view keeps the migration-159 column space + adds the three rank columns at the
-- tail (consumers select by name; the DBOS frontier + export-state are unaffected by a
-- tail append). The issue-family branch maps engineer_issues' own rank columns in; the
-- feature branch maps hfc's.
--
-- CREATE OR REPLACE (not DROP) so the dependent fleet_assignment view (migration 165)
-- survives — Postgres permits OR REPLACE when the new definition keeps every existing
-- output column's name + type + position and only APPENDS new columns (which is exactly
-- this change: the three rank columns at the tail). A DROP would CASCADE into
-- fleet_assignment.
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
    assignee_rank, rank_writer, rank_updated_at
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
    ei.rank_updated_at                             -- rank_updated_at
  FROM harness_shared.engineer_issues ei;

COMMENT ON VIEW harness_shared.work_items IS
  'The canonical cross-kind work-item surface (unify-work-items D-010=(b)): UNION ALL of the per-kind tables — harness_features_consolidated (feature|research-task|chunk) + engineer_issues (bug|change|task) — in the feature column space. Discriminator = item_kind; kind-specific data = payload. Per-assignee ordered queue = assignee_rank (+ rank_writer bee|queen for the propose/dispose audit, local-hive P-020/D-008). Writes route by kind via INSTEAD OF triggers (work_items_view_dml); the engine (work-items.ts) writes the base tables directly.';

-- ── 3) INSTEAD OF DML routing — carry the rank columns through (mirrors mig 159) ───
CREATE OR REPLACE FUNCTION harness_shared.work_items_view_dml()
RETURNS trigger
LANGUAGE plpgsql
AS $work_items_dml$
DECLARE
  v_is_issue boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_is_issue := NEW.item_kind IN ('bug', 'change', 'task');
    IF v_is_issue THEN
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, scope, title, body, state, assignee, assigned_at,
         kind, payload, origin, author_pubkey, created_at, updated_at,
         assignee_rank, rank_writer, rank_updated_at)
      VALUES
        (COALESCE(NEW.workspace_id, 'default'),
         NEW.feature_id,
         CASE WHEN NEW.harness_slug IS NULL OR NEW.harness_slug = ''
              THEN 'operator' ELSE 'harness:' || NEW.harness_slug END,
         NEW.title,
         COALESCE(NEW.summary, ''),
         COALESCE(NEW.status, 'open'),
         NEW.taken_by,
         NEW.taken_at,
         NEW.item_kind,
         NEW.payload,
         COALESCE(NEW.origin, 'local'),
         NEW.author_pubkey,
         COALESCE(to_timestamp(NEW.created_ts / 1000.0), now()),
         COALESCE(to_timestamp(NEW.updated_ts / 1000.0), now()),
         NEW.assignee_rank, NEW.rank_writer, NEW.rank_updated_at);
    ELSE
      INSERT INTO harness_shared.harness_features_consolidated
        (harness_slug, feature_id, title, summary, status, attempts, claims, notes,
         metadata, kind, parent_id, goal_id, taken_by, taken_at,
         needs_design, needs_human_review, item_kind, payload,
         ts, created_ts, updated_ts, origin, author_pubkey,
         source_plan_slug, source_plan_item_ids, feature_order, wave,
         assignee_rank, rank_writer, rank_updated_at)
      VALUES
        (NEW.harness_slug, NEW.feature_id, NEW.title, NEW.summary,
         COALESCE(NEW.status, 'todo'), COALESCE(NEW.attempts, 0), NEW.claims, NEW.notes,
         NEW.metadata, NEW.kind, NEW.parent_id, NEW.goal_id, NEW.taken_by, NEW.taken_at,
         COALESCE(NEW.needs_design, FALSE), COALESCE(NEW.needs_human_review, FALSE),
         COALESCE(NEW.item_kind, 'feature'), NEW.payload,
         COALESCE(NEW.ts, (extract(epoch FROM now()) * 1000)::bigint),
         COALESCE(NEW.created_ts, (extract(epoch FROM now()) * 1000)::bigint),
         COALESCE(NEW.updated_ts, (extract(epoch FROM now()) * 1000)::bigint),
         COALESCE(NEW.origin, 'local'), NEW.author_pubkey,
         NEW.source_plan_slug, NEW.source_plan_item_ids, NEW.feature_order, NEW.wave,
         NEW.assignee_rank, NEW.rank_writer, NEW.rank_updated_at);
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'UPDATE' THEN
    v_is_issue := OLD.item_kind IN ('bug', 'change', 'task');
    IF v_is_issue AND NEW.item_kind NOT IN ('bug', 'change', 'task') THEN
      RAISE EXCEPTION 'work_items: cross-family reclassification (% -> %) is a cross-table move — use the work-items engine', OLD.item_kind, NEW.item_kind;
    ELSIF NOT v_is_issue AND NEW.item_kind IN ('bug', 'change', 'task') THEN
      RAISE EXCEPTION 'work_items: cross-family reclassification (% -> %) is a cross-table move — use the work-items engine', OLD.item_kind, NEW.item_kind;
    END IF;
    IF v_is_issue THEN
      UPDATE harness_shared.engineer_issues SET
        title      = NEW.title,
        body       = COALESCE(NEW.summary, ''),
        state      = NEW.status,
        assignee   = NEW.taken_by,
        assigned_at = NEW.taken_at,
        kind       = NEW.item_kind,
        payload    = NEW.payload,
        assignee_rank   = NEW.assignee_rank,
        rank_writer     = NEW.rank_writer,
        rank_updated_at = NEW.rank_updated_at,
        updated_at = COALESCE(to_timestamp(NEW.updated_ts / 1000.0), now())
      WHERE workspace_id = OLD.workspace_id AND issue_id = OLD.feature_id;
    ELSE
      UPDATE harness_shared.harness_features_consolidated SET
        title = NEW.title, summary = NEW.summary, status = NEW.status,
        attempts = NEW.attempts, claims = NEW.claims, notes = NEW.notes,
        metadata = NEW.metadata, kind = NEW.kind, parent_id = NEW.parent_id,
        goal_id = NEW.goal_id, taken_by = NEW.taken_by, taken_at = NEW.taken_at,
        expires_at = NEW.expires_at, needs_design = NEW.needs_design,
        needs_human_review = NEW.needs_human_review, item_kind = NEW.item_kind,
        payload = NEW.payload, wave = NEW.wave, feature_order = NEW.feature_order,
        source_plan_slug = NEW.source_plan_slug,
        source_plan_item_ids = NEW.source_plan_item_ids,
        assignee_rank = NEW.assignee_rank, rank_writer = NEW.rank_writer,
        rank_updated_at = NEW.rank_updated_at,
        ts = COALESCE(NEW.ts, (extract(epoch FROM now()) * 1000)::bigint),
        updated_ts = COALESCE(NEW.updated_ts, (extract(epoch FROM now()) * 1000)::bigint)
      WHERE harness_slug = OLD.harness_slug AND feature_id = OLD.feature_id;
    END IF;
    RETURN NEW;

  ELSE -- DELETE
    v_is_issue := OLD.item_kind IN ('bug', 'change', 'task');
    IF v_is_issue THEN
      DELETE FROM harness_shared.engineer_issues
       WHERE workspace_id = OLD.workspace_id AND issue_id = OLD.feature_id;
    ELSE
      DELETE FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = OLD.harness_slug AND feature_id = OLD.feature_id;
    END IF;
    RETURN OLD;
  END IF;
END;
$work_items_dml$;

DROP TRIGGER IF EXISTS work_items_dml_trg ON harness_shared.work_items;
CREATE TRIGGER work_items_dml_trg
  INSTEAD OF INSERT OR UPDATE OR DELETE ON harness_shared.work_items
  FOR EACH ROW EXECUTE FUNCTION harness_shared.work_items_view_dml();

GRANT SELECT ON harness_shared.work_items TO harness_app;
DO $z$ BEGIN GRANT SELECT ON harness_shared.work_items TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL; END $z$;
GRANT INSERT, UPDATE, DELETE ON harness_shared.work_items TO harness_app;

-- ── 4) the atomic reorder op (the P-020 write path) ───────────────────────────────
-- Place ONE work-item at a target rank within its assignee's queue, shifting the
-- peers at/after that rank down by one to make room (insert-at-rank semantics — what
-- the Queen's "inject at a rank" + a bee's "move this up" both need). All under one
-- transaction so two concurrent reorders can't interleave into a corrupt ordering.
--
-- p_assignee scopes the queue: only items the SAME assignee holds shift. The function
-- operates ACROSS both base tables (an assignee's queue can mix features + issues),
-- writing through the work_items view (so the INSTEAD OF router places each update on
-- the right base table). p_writer ('bee'|'queen') stamps rank_writer for the audit.
--
-- Returns the new dense rank actually assigned (0-based; clamped to the queue length).
CREATE OR REPLACE FUNCTION harness_shared.reorder_work_item(
  p_workspace text,
  p_assignee  text,
  p_item_id   text,
  p_target    integer,
  p_writer    text DEFAULT 'bee'
) RETURNS integer
LANGUAGE plpgsql
AS $reorder$
DECLARE
  v_old_rank integer;
  v_count    integer;
  v_new_rank integer;
  v_now      timestamptz := now();
BEGIN
  IF p_writer IS NULL OR p_writer NOT IN ('bee', 'queen') THEN
    RAISE EXCEPTION 'reorder_work_item: writer must be bee|queen (got %)', p_writer;
  END IF;

  -- The current rank of the moving item (NULL if it was unranked / newly appended).
  SELECT assignee_rank INTO v_old_rank
    FROM harness_shared.work_items
   WHERE workspace_id = p_workspace AND taken_by = p_assignee AND feature_id = p_item_id;

  -- Queue length EXCLUDING the moving item — the target clamps to [0, len].
  SELECT count(*) INTO v_count
    FROM harness_shared.work_items
   WHERE workspace_id = p_workspace AND taken_by = p_assignee
     AND feature_id <> p_item_id;

  v_new_rank := GREATEST(0, LEAST(p_target, v_count));

  -- Pull the moving item out (so the renumber below sees a contiguous peer set), then
  -- compact the survivors into a dense 0..n-1 ordering by their current rank
  -- (NULLs last, then created order), then re-open a gap at v_new_rank and slot it in.
  --
  -- Done as: (a) park the moving item at rank NULL; (b) densely renumber peers
  -- counting up, skipping the target slot; (c) place the moving item at the target.
  UPDATE harness_shared.work_items
     SET assignee_rank = NULL, rank_writer = p_writer, rank_updated_at = v_now
   WHERE workspace_id = p_workspace AND taken_by = p_assignee AND feature_id = p_item_id;

  WITH ordered AS (
    SELECT feature_id,
           row_number() OVER (
             ORDER BY assignee_rank ASC NULLS LAST, rank_updated_at ASC NULLS LAST, created_ts ASC
           ) - 1 AS seq
      FROM harness_shared.work_items
     WHERE workspace_id = p_workspace AND taken_by = p_assignee
       AND feature_id <> p_item_id
  ), shifted AS (
    -- Slots [0..v_new_rank-1] keep their seq; [v_new_rank..] bump up by 1 to leave a hole.
    SELECT feature_id,
           CASE WHEN seq < v_new_rank THEN seq ELSE seq + 1 END AS new_rank
      FROM ordered
  )
  UPDATE harness_shared.work_items w
     SET assignee_rank = s.new_rank, rank_updated_at = v_now
    FROM shifted s
   WHERE w.workspace_id = p_workspace AND w.taken_by = p_assignee
     AND w.feature_id = s.feature_id
     AND w.assignee_rank IS DISTINCT FROM s.new_rank;

  -- Slot the moving item into the freed hole.
  UPDATE harness_shared.work_items
     SET assignee_rank = v_new_rank, rank_writer = p_writer, rank_updated_at = v_now
   WHERE workspace_id = p_workspace AND taken_by = p_assignee AND feature_id = p_item_id;

  RETURN v_new_rank;
END;
$reorder$;

COMMENT ON FUNCTION harness_shared.reorder_work_item(text, text, text, integer, text) IS
  'Atomic per-assignee work-item reorder (local-hive P-020). Places one item at p_target rank within p_assignee''s queue (insert-at-rank; peers shift down), renumbering the queue densely. Writes through the work_items view so it spans both base tables. p_writer (bee|queen) stamps the propose/dispose audit (D-008); the Queen-vs-bee balance is gated by the existing automation tier, not here. Returns the assigned rank.';

GRANT EXECUTE ON FUNCTION harness_shared.reorder_work_item(text, text, text, integer, text) TO harness_app;

-- ── 5) surface the rank on the fleet_assignment view (the P-021 projection source) ──
-- fleet_assignment (migration 165) is the canonical "who's on what". The P-021 per-bee
-- ordered work-list (doing/queued/load) derives from the per-assignee rank, so the
-- work-item-claim branch carries assignee_rank + rank_writer; the other three branches
-- (plan-item claim/assignment, presence) have no work-item rank → NULL. Appended at the
-- tail so existing readers (fleet/assignments.ts) are unaffected. CREATE OR REPLACE keeps
-- the change-feed triggers (they target the base tables, not this view).
CREATE OR REPLACE VIEW harness_shared.fleet_assignment AS
WITH presence AS (
  SELECT
    owner_id, owner_label, workspace_id, source, intent, current_plan_slug,
    heartbeat_at,
    (now() - heartbeat_at) < interval '10 minutes' AS alive
  FROM harness_shared.coord_presence
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
  (p.owner_id IS NOT NULL)                         AS holder_present,
  COALESCE(p.alive, false)                         AS holder_alive,
  p.heartbeat_at                                   AS holder_heartbeat_at,
  p.intent                                         AS holder_intent,
  p.current_plan_slug                              AS holder_plan_slug,
  (c.expires_ts > now() AND NOT COALESCE(p.alive, false)) AS orphaned,
  (p.current_plan_slug IS NOT DISTINCT FROM c.plan_slug)  AS declared_plan_matches,
  NULL::integer                                    AS assignee_rank,
  NULL::text                                       AS rank_writer
FROM harness_shared.plan_item_claims c
LEFT JOIN presence p ON p.owner_id = c.owner

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
  NULL::text
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
  (p.owner_id IS NOT NULL),
  COALESCE(p.alive, false),
  p.heartbeat_at,
  p.intent,
  p.current_plan_slug,
  (NOT COALESCE(p.alive, false)),
  CASE WHEN w.source_plan_slug IS NULL THEN NULL::boolean
       ELSE (p.current_plan_slug IS NOT DISTINCT FROM w.source_plan_slug) END,
  w.assignee_rank,                                 -- the per-assignee rank (P-021)
  w.rank_writer                                    -- propose/dispose audit (D-008)
FROM harness_shared.work_items w
LEFT JOIN presence p ON p.owner_id = w.taken_by
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
  NULL::text
FROM presence p;

COMMENT ON VIEW harness_shared.fleet_assignment IS
  'Canonical "who''s on what" (state-not-chat-fleet-state D-002): claim-primary union of plan_item_claims + plan_item_assignments + work-item claims (work_items.taken_by) + coord_presence, each claim LEFT-joined to its holder''s presence. orphaned = live lease, dead holder. work-item rows carry assignee_rank + rank_writer (local-hive P-021/D-008) so the per-bee ordered work-list (doing/queued/load) derives from one read. Read via fleet:assignments; change-feed on channel fleet_assignment.';

GRANT SELECT ON harness_shared.fleet_assignment TO harness_app;
DO $z$ BEGIN GRANT SELECT ON harness_shared.fleet_assignment TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL; END $z$;

COMMIT;
