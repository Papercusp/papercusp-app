-- Project-scoped curated context (Phase B+ — Project Manager role).
--
-- Each row in `harness_shared.projects` gains a `spec` text column that the
-- Project Manager role maintains as features in that project pass. The spec
-- is the project's living operating context — architectural decisions,
-- breaking changes, invariants, project-specific conventions, gotchas. It
-- is INJECTED into agent prompts (worker / validator / scoper) when those
-- agents work on a feature with `project_id` set.
--
-- The spec is NOT the harness-level SPEC.md (which the architect role amends
-- and the scoper translates into validation-contract.md). It is curated
-- context above and beyond that — different shape, different audience.
--
-- Idempotent — safe to re-run.

ALTER TABLE harness_shared.projects
  ADD COLUMN IF NOT EXISTS spec TEXT,
  ADD COLUMN IF NOT EXISTS spec_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS spec_manually_edited_at TIMESTAMPTZ;

-- Append-only audit of every spec revision. Each PM run produces one row;
-- manual user edits also produce one row. `include_decisions` records what
-- features the PM included or excluded with their reasoning — the most
-- important transparency mechanism for a curator role.
CREATE TABLE IF NOT EXISTS harness_shared.project_spec_revisions (
  id                BIGSERIAL PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES harness_shared.projects(id) ON DELETE CASCADE,
  spec              TEXT NOT NULL,
  summary           TEXT,                     -- one-line "what changed in this revision"
  author_role       TEXT NOT NULL,            -- 'project_manager' | 'user' | 'architect' (rare)
  author            TEXT,                     -- the operator's identity if author_role='user'
  ts                TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- For PM-emitted revisions: which features were considered and what was decided.
  -- Schema: [{feature_id, action: 'include'|'exclude', reason}]
  include_decisions JSONB,
  -- Token + cost accounting for the PM run that produced this revision.
  tokens_in         BIGINT NOT NULL DEFAULT 0,
  tokens_out        BIGINT NOT NULL DEFAULT 0,
  cost_usd_cents    BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS psr_project_idx     ON harness_shared.project_spec_revisions(project_id, ts DESC);
CREATE INDEX IF NOT EXISTS psr_author_role_idx ON harness_shared.project_spec_revisions(author_role);
CREATE INDEX IF NOT EXISTS psr_ts_idx          ON harness_shared.project_spec_revisions(ts DESC);

GRANT USAGE ON SCHEMA harness_shared TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.project_spec_revisions TO harness_app, harness_admin;
GRANT USAGE, SELECT ON SEQUENCE harness_shared.project_spec_revisions_id_seq TO harness_app, harness_admin;
