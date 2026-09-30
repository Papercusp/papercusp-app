-- 326: rubrics — the rubrics store (rubric-driven-observations-2026-06-20 P-002 / brief B2).
-- Number reserved via db:next-migration (harness_shared.migration_reservations).
--
-- WHY (plan D-001/D-002): a RUBRIC is the reusable, shared STANDARD for a system
-- characteristic — (a) the MODEL (how it's supposed to work), (b) the METHOD (how to
-- investigate it; may REFERENCE an agent-insights runbook for the long-form rather
-- than duplicating prose), (c) the RATING scale + DRIFT markers. Agents grade
-- STRUCTURED OBSERVATIONS against an active rubric, so Scout/Queen/Overwatch get
-- MEASUREMENTS, not just free-text anecdotes. The first live rubric is the 13-criteria
-- 'hive-coordination-health' scorecard the Overwatch always emits (D-002, OWNER #1).
--
-- SHAPE (Model A — one rubric row, criteria as a jsonb array; the interface contract
-- locked with su-f8ee5 [obs-schema consumer] + su-5695e [P-003 seed author]):
--   a rubric_id slug names ONE rubric; its `criteria` jsonb holds the per-characteristic
--   gradeable items (13 for hive-coordination-health). A structured observation's
--   rubricRef = rubrics.rubric_id and ratings[].criterion = a criteria[].key. The
--   `characteristic` column is the umbrella domain Scout's digest groups by.
--
-- AUTHORSHIP (D-001): any agent may PROPOSE (status='proposed'); the Queen/owner
-- RATIFIES (proposed → active). `status` carries that lifecycle. Writers are the
-- rubrics:propose / rubrics:ratify tools (+ this table is seedable by an idempotent
-- INSERT ... ON CONFLICT in a follow-up migration — that's P-003's job, su-5695e;
-- THIS migration is pure DDL and seeds NO content).
--
-- SCOPE: v1 is workspace-LOCAL (like engineer_issues v1) — NOT a federated peer-log
-- table, so it is intentionally absent from PEER_LOG_TABLES / the projection registry
-- (the federation drift guards bind only that set). Harness-scoped federation is the
-- deferred v2 upgrade (a capture trigger + peer-log projection), alongside the rest of
-- the plan's deferred v2 (auto-crystallization, trend dashboard, versioning). Reads +
-- writes run in the single coordination workspace (DEFAULT_COORD_WORKSPACE='default'),
-- the same constant the coordination layer uses, so a ratified rubric is visible to
-- Overwatch/Scout wherever they run.
--
-- The migration runner wraps each file in its own transaction (and strips psql
-- metacommands), so this file carries NO top-level BEGIN;/COMMIT;/\set
-- (migration-runner.js contract; lint:migrations). ADDITIVE + idempotent.

CREATE TABLE IF NOT EXISTS harness_shared.rubrics (
  workspace_id   text        NOT NULL DEFAULT 'default',
  rubric_id      text        NOT NULL,                  -- slug, e.g. 'hive-coordination-health'
  characteristic text        NOT NULL DEFAULT '',       -- umbrella domain, e.g. 'hive-coordination'
  title          text        NOT NULL,
  description    text        NOT NULL DEFAULT '',
  -- Array<{ key:string; title:string; model:string; method:string; ratingScale?:string[]; driftMarkers:string }>
  -- key = stable kebab criterion id; method = how-to-investigate (per-criterion).
  criteria       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- The default rating vocabulary shared by criteria that don't override it.
  rating_scale   jsonb       NOT NULL DEFAULT '["healthy","degraded","broken","unknown"]'::jsonb,
  method_ref     text,                                  -- agent-insights runbook slug (the long-form METHOD)
  status         text        NOT NULL DEFAULT 'proposed',
  created_by     text,
  proposed_by    text,
  ratified_by    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, rubric_id),
  CONSTRAINT rubrics_status_chk CHECK (status IN ('proposed', 'active', 'retired')),
  CONSTRAINT rubrics_criteria_is_array CHECK (jsonb_typeof(criteria) = 'array'),
  CONSTRAINT rubrics_rating_scale_is_array CHECK (jsonb_typeof(rating_scale) = 'array')
);

-- Full-text search for rubrics:search (mirrors engineer_issues._search:
-- websearch_to_tsquery + ts_rank). Generated over the plain TEXT columns only
-- (rubric_id/characteristic/title/description) — all immutable, so the STORED
-- generated column is safe; criteria jsonb is deliberately excluded to avoid a
-- non-immutable cast in the generation expression.
ALTER TABLE harness_shared.rubrics
  ADD COLUMN IF NOT EXISTS _search tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(rubric_id, '') || ' ' ||
      coalesce(characteristic, '') || ' ' ||
      coalesce(title, '') || ' ' ||
      coalesce(description, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS rubrics_search_idx
  ON harness_shared.rubrics USING gin (_search);

-- The common reads: "active rubrics" (the seeded/ratified set agents grade against)
-- and "rubrics for a characteristic" (Scout digest grouping).
CREATE INDEX IF NOT EXISTS rubrics_status_idx
  ON harness_shared.rubrics (workspace_id, status);

CREATE INDEX IF NOT EXISTS rubrics_characteristic_idx
  ON harness_shared.rubrics (workspace_id, characteristic);

COMMENT ON TABLE harness_shared.rubrics IS
  'Rubrics store (rubric-driven-observations P-002). A rubric = the shared STANDARD for a system characteristic: model + method (+ method_ref runbook) + rating scale + drift markers, with criteria as a jsonb array of per-characteristic gradeable items. Agents grade STRUCTURED OBSERVATIONS against an active rubric (observation.rubricRef = rubric_id, ratings[].criterion = criteria[].key). Authorship D-001: any agent PROPOSEs (status=proposed), the Queen/owner RATIFIES (status=active). v1 workspace-local (not federated); reads/writes use the single coordination workspace.';
