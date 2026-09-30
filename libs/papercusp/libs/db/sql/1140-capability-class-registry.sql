-- 1140-capability-class-registry.sql — identities-v1 P-016 / D-004
--
-- Capability CLASSES are versioned interface contracts. Providers prove that their
-- live projected tools implement a class through an immutable conformance run; a
-- pot then selects one proven provider binding. These are separate truths:
-- publisher authenticity, provider conformance, and runtime authorization must never
-- collapse into one hand-set "approved" flag (D-028/D-031).
--
-- The shape deliberately mirrors datatype_registry's resolution/discovery surface
-- instead of creating a parallel marketplace. Cupboard distribution is P-027+;
-- this migration owns only the local registry, attestations and bindings.

CREATE TABLE IF NOT EXISTS harness_shared.capability_class_registry (
  workspace_id          TEXT NOT NULL,
  id                    TEXT NOT NULL,
  version               TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL,
  interface_verbs       JSONB NOT NULL,
  behavioral_suite_ref  TEXT,
  status                TEXT NOT NULL DEFAULT 'active',
  published             BOOLEAN NOT NULL DEFAULT FALSE,
  review_status         TEXT NOT NULL DEFAULT 'none',
  tags                  TEXT[] NOT NULL DEFAULT '{}',
  embedding             VECTOR(768),
  title_tsv             TSVECTOR GENERATED ALWAYS AS (
                          to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(description, ''))
                        ) STORED,
  created_by            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id, version),
  CONSTRAINT capability_class_registry_verbs_ck
    CHECK (jsonb_typeof(interface_verbs) = 'object' AND interface_verbs <> '{}'::jsonb),
  CONSTRAINT capability_class_registry_status_ck
    CHECK (status IN ('active', 'retired', 'superseded')),
  CONSTRAINT capability_class_registry_review_ck
    CHECK (review_status IN ('none', 'pending', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS capability_class_registry_title_tsv_idx
  ON harness_shared.capability_class_registry USING gin (title_tsv);
CREATE INDEX IF NOT EXISTS capability_class_registry_tags_idx
  ON harness_shared.capability_class_registry USING gin (tags);
CREATE INDEX IF NOT EXISTS capability_class_registry_embedding_hnsw_idx
  ON harness_shared.capability_class_registry USING hnsw (embedding public.vector_cosine_ops);
CREATE INDEX IF NOT EXISTS capability_class_registry_review_pending_idx
  ON harness_shared.capability_class_registry (review_status)
  WHERE review_status = 'pending';

-- Append-only evidence. structural_passed is an outcome WRITTEN by the validator
-- after reading the live projected-tool registry, never a provider assertion.
-- behavioral_status is reserved for the later suite runner; P-016 records the hook
-- without pretending an unrun suite passed.
CREATE TABLE IF NOT EXISTS harness_shared.capability_class_conformance_runs (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  class_id              TEXT NOT NULL,
  class_version         TEXT NOT NULL,
  provider_package      TEXT NOT NULL,
  provider_version      TEXT NOT NULL,
  registry_revision     TEXT NOT NULL,
  verb_bindings         JSONB NOT NULL,
  structural_passed     BOOLEAN NOT NULL,
  behavioral_status     TEXT NOT NULL DEFAULT 'not-required',
  behavioral_run_ref    TEXT,
  report                JSONB NOT NULL,
  performed_by          TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT capability_class_conformance_class_fk
    FOREIGN KEY (workspace_id, class_id, class_version)
    REFERENCES harness_shared.capability_class_registry (workspace_id, id, version),
  CONSTRAINT capability_class_conformance_behavior_ck
    CHECK (behavioral_status IN ('not-required', 'not-run', 'passed', 'failed')),
  CONSTRAINT capability_class_conformance_verbs_ck
    CHECK (jsonb_typeof(verb_bindings) = 'object'),
  CONSTRAINT capability_class_conformance_report_ck
    CHECK (jsonb_typeof(report) = 'object')
);

CREATE INDEX IF NOT EXISTS capability_class_conformance_lookup_idx
  ON harness_shared.capability_class_conformance_runs
    (workspace_id, class_id, class_version, provider_package, provider_version, created_at DESC);

-- Only a PASSING conformance run is installed here. The provider's conformance
-- status is DERIVED by joining conformance_run_id back to the append-only run —
-- there is intentionally no mutable conformance_status column to drift.
CREATE TABLE IF NOT EXISTS harness_shared.capability_class_provider_bindings (
  workspace_id          TEXT NOT NULL,
  class_id              TEXT NOT NULL,
  class_version         TEXT NOT NULL,
  provider_package      TEXT NOT NULL,
  provider_version      TEXT NOT NULL,
  verb_bindings         JSONB NOT NULL,
  conformance_run_id    TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, class_id, class_version, provider_package, provider_version),
  CONSTRAINT capability_class_provider_class_fk
    FOREIGN KEY (workspace_id, class_id, class_version)
    REFERENCES harness_shared.capability_class_registry (workspace_id, id, version),
  CONSTRAINT capability_class_provider_run_fk
    FOREIGN KEY (conformance_run_id)
    REFERENCES harness_shared.capability_class_conformance_runs (id),
  CONSTRAINT capability_class_provider_verbs_ck
    CHECK (jsonb_typeof(verb_bindings) = 'object'),
  CONSTRAINT capability_class_provider_status_ck
    CHECK (status IN ('active', 'retired'))
);

CREATE INDEX IF NOT EXISTS capability_class_provider_discovery_idx
  ON harness_shared.capability_class_provider_bindings
    (workspace_id, class_id, class_version, status);

-- The remembered one-provider-per-class choice is pot-scoped. P-017 owns the
-- picker/resolution policy; P-016 supplies the referentially-safe storage seam.
CREATE TABLE IF NOT EXISTS harness_shared.pot_capability_class_bindings (
  workspace_id          TEXT NOT NULL,
  pot_slug              TEXT NOT NULL,
  class_id              TEXT NOT NULL,
  class_version         TEXT NOT NULL,
  provider_package      TEXT NOT NULL,
  provider_version      TEXT NOT NULL,
  bound_by              TEXT,
  bound_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, pot_slug, class_id, class_version),
  CONSTRAINT pot_capability_class_provider_fk
    FOREIGN KEY (workspace_id, class_id, class_version, provider_package, provider_version)
    REFERENCES harness_shared.capability_class_provider_bindings
      (workspace_id, class_id, class_version, provider_package, provider_version)
);

CREATE INDEX IF NOT EXISTS pot_capability_class_provider_reverse_idx
  ON harness_shared.pot_capability_class_bindings
    (workspace_id, provider_package, provider_version);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.capability_class_registry TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.capability_class_conformance_runs TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.capability_class_provider_bindings TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.pot_capability_class_bindings TO harness_app;

DO $$ BEGIN
  GRANT SELECT ON harness_shared.capability_class_registry TO harness_zero;
  GRANT SELECT ON harness_shared.capability_class_conformance_runs TO harness_zero;
  GRANT SELECT ON harness_shared.capability_class_provider_bindings TO harness_zero;
  GRANT SELECT ON harness_shared.pot_capability_class_bindings TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

ALTER TABLE harness_shared.capability_class_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.capability_class_conformance_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.capability_class_provider_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.pot_capability_class_bindings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS capability_class_registry_workspace_isolation
  ON harness_shared.capability_class_registry;
CREATE POLICY capability_class_registry_workspace_isolation
  ON harness_shared.capability_class_registry
  FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

DROP POLICY IF EXISTS capability_class_registry_approved_global_read
  ON harness_shared.capability_class_registry;
CREATE POLICY capability_class_registry_approved_global_read
  ON harness_shared.capability_class_registry
  FOR SELECT
  USING (review_status = 'approved');

DROP POLICY IF EXISTS capability_class_conformance_workspace_isolation
  ON harness_shared.capability_class_conformance_runs;
CREATE POLICY capability_class_conformance_workspace_isolation
  ON harness_shared.capability_class_conformance_runs
  FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

DROP POLICY IF EXISTS capability_class_provider_workspace_isolation
  ON harness_shared.capability_class_provider_bindings;
CREATE POLICY capability_class_provider_workspace_isolation
  ON harness_shared.capability_class_provider_bindings
  FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

DROP POLICY IF EXISTS pot_capability_class_bindings_workspace_isolation
  ON harness_shared.pot_capability_class_bindings;
CREATE POLICY pot_capability_class_bindings_workspace_isolation
  ON harness_shared.pot_capability_class_bindings
  FOR ALL
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

