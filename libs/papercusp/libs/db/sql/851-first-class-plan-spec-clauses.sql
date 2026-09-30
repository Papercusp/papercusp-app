-- 851 — first-class, revisioned plan spec clauses.
--
-- Plan first-class-spec-clauses-and-prior-attempt-briefs-2026-08-20 P-002,
-- decisions D-001..D-003. This is an additive normalization of the existing
-- VAL assertion model: plan_spec_clauses owns stable identity/VAL aliasing and
-- plan_spec_clause_revisions owns immutable behavioral snapshots. The legacy
-- harness_plan_assertions table remains the compatibility projection used by
-- existing test gates; plans:set-specs refreshes that projection without
-- overwriting its independently-owned test verdict.

CREATE TABLE IF NOT EXISTS harness_shared.plan_spec_clauses (
  workspace_id    text        NOT NULL,
  harness_slug    text        NOT NULL,
  plan_slug       text        NOT NULL,
  spec_id         text        NOT NULL,
  source_val_id   text,
  current_revision integer    NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  created_by      text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, harness_slug, plan_slug, spec_id),
  CHECK (length(btrim(spec_id)) > 0),
  CHECK (source_val_id IS NULL OR source_val_id LIKE 'VAL-%')
);

-- A legacy VAL id is already unique per harness in harness_plan_assertions.
-- Preserve that invariant in the canonical identity map as well.
-- FORWARD-COMPAT: The currently deployed release cannot infer or depend on this partial index because plan_spec_clauses is created for the first time by this same migration.
CREATE UNIQUE INDEX IF NOT EXISTS plan_spec_clauses_source_val_identity
  ON harness_shared.plan_spec_clauses (workspace_id, harness_slug, source_val_id)
  WHERE source_val_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS plan_spec_clauses_by_plan
  ON harness_shared.plan_spec_clauses (workspace_id, harness_slug, plan_slug, spec_id);

CREATE TABLE IF NOT EXISTS harness_shared.plan_spec_clause_revisions (
  workspace_id         text        NOT NULL,
  harness_slug         text        NOT NULL,
  plan_slug            text        NOT NULL,
  spec_id               text        NOT NULL,
  revision              integer     NOT NULL CHECK (revision > 0),
  plan_item_id          text        NOT NULL CHECK (plan_item_id ~ '^P-[0-9]{3,}$'),
  behavior              text        NOT NULL CHECK (length(btrim(behavior)) > 0),
  behavior_class        text        NOT NULL CHECK (behavior_class IN (
    'happy-path', 'boundary', 'failure', 'authorization', 'concurrency',
    'lifecycle', 'observability', 'migration-data-integrity', 'non-automated'
  )),
  required_evidence     text[]      NOT NULL DEFAULT ARRAY[]::text[],
  required_test_layers  text[]      NOT NULL DEFAULT ARRAY[]::text[],
  mutation_required     boolean     NOT NULL DEFAULT false,
  lifecycle_status      text        NOT NULL CHECK (lifecycle_status IN (
    'draft', 'accepted', 'active', 'superseded', 'exempt', 'retired'
  )),
  supersedes_spec_id    text,
  supersedes_revision   integer,
  exemption             jsonb,
  content_hash          text        NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_by            text        NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  accepted_by           text,
  accepted_at           timestamptz,
  acceptance_ref        text,
  PRIMARY KEY (workspace_id, harness_slug, plan_slug, spec_id, revision),
  FOREIGN KEY (workspace_id, harness_slug, plan_slug, spec_id)
    REFERENCES harness_shared.plan_spec_clauses
      (workspace_id, harness_slug, plan_slug, spec_id) ON DELETE RESTRICT,
  CHECK ((supersedes_spec_id IS NULL) = (supersedes_revision IS NULL)),
  CHECK (supersedes_revision IS NULL OR supersedes_revision > 0),
  CHECK ((accepted_by IS NULL) = (accepted_at IS NULL)),
  CHECK (lifecycle_status NOT IN ('accepted', 'active') OR accepted_by IS NOT NULL),
  CHECK (lifecycle_status <> 'exempt' OR exemption IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS plan_spec_clause_revisions_by_item
  ON harness_shared.plan_spec_clause_revisions
    (workspace_id, harness_slug, plan_slug, plan_item_id, spec_id, revision DESC);

CREATE INDEX IF NOT EXISTS plan_spec_clause_revisions_by_status
  ON harness_shared.plan_spec_clause_revisions
    (workspace_id, harness_slug, plan_slug, lifecycle_status, spec_id);

-- Revisions are evidence-bearing history. Enforce append-only at the database
-- boundary so no alternate writer can silently weaken the API guarantee.
CREATE OR REPLACE FUNCTION harness_shared.reject_plan_spec_revision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'plan_spec_clause_revisions are immutable; append a new revision'
    USING ERRCODE = '55000';
END;
$fn$;

DROP TRIGGER IF EXISTS plan_spec_clause_revisions_immutable
  ON harness_shared.plan_spec_clause_revisions;
CREATE TRIGGER plan_spec_clause_revisions_immutable
  BEFORE UPDATE OR DELETE ON harness_shared.plan_spec_clause_revisions
  FOR EACH ROW EXECUTE FUNCTION harness_shared.reject_plan_spec_revision_mutation();

ALTER TABLE harness_shared.plan_spec_clauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.plan_spec_clause_revisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plan_spec_clauses_workspace_isolation
  ON harness_shared.plan_spec_clauses;
CREATE POLICY plan_spec_clauses_workspace_isolation
  ON harness_shared.plan_spec_clauses
  FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

DROP POLICY IF EXISTS plan_spec_clause_revisions_workspace_isolation
  ON harness_shared.plan_spec_clause_revisions;
CREATE POLICY plan_spec_clause_revisions_workspace_isolation
  ON harness_shared.plan_spec_clause_revisions
  FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT, UPDATE ON harness_shared.plan_spec_clauses TO harness_app;
GRANT SELECT, INSERT, UPDATE ON harness_shared.plan_spec_clauses TO harness_admin;
GRANT SELECT, INSERT ON harness_shared.plan_spec_clause_revisions TO harness_app;
GRANT SELECT, INSERT ON harness_shared.plan_spec_clause_revisions TO harness_admin;

COMMENT ON TABLE harness_shared.plan_spec_clauses IS
  'Stable plan spec identities and optional source VAL aliases. current_revision is the only mutable pointer; behavioral content lives append-only in plan_spec_clause_revisions.';
COMMENT ON TABLE harness_shared.plan_spec_clause_revisions IS
  'Immutable behavioral spec snapshots with ownership, proof requirements, lifecycle, supersession, and acceptance provenance.';
