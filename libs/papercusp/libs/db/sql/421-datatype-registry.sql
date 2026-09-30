-- 421-datatype-registry.sql — the DATATYPE REGISTRY
-- (reflexive-platform-extensibility-datatypes-2026-06-24 P-013).
--
-- A DATATYPE is a reusable, named entity TYPE declared from inside Papercusp via
-- meta:define-datatype (P-001): the shared shape (bet, wager, forecast, position, …)
-- that blueprints reference by name through dependencies.datatypes (P-012, D-009).
--
-- Authority is DEDUP-ONLY (D-010 — the npm/crates marketplace model): anyone may
-- declare; the registry's ONLY job is preventing DUPLICATE datatypes (namespace
-- arbitration, not governance). Two-level dedup — a hard unique id (the PRIMARY
-- KEY) + a soft semantic-similarity surface at declaration (title_tsv BM25 +
-- embedding cosine, mirroring code_recipes / migration 349). GRADUATED
-- (D-002/D-010): local generic-kind datatypes are WORKSPACE-LOCAL (the workspace_id
-- scope + RLS below, no marketplace gate — a duplicate local kind hurts no one);
-- published/shared ones additionally ride the Comb listing + PENDING moderation
-- (the `published` flag; the Comb leg is layered on later, not in this migration).
--
-- THREE orthogonal authority layers stay separate (D-010) — this table governs ONLY
-- layer 1 (DECLARATION / namespace). Implementation (a first-class datatype's
-- migration) = the dogfood PR rail; instance-write (who writes instances vs reads
-- projections) = the capability model + the projection flavor (D-007/D-008). The
-- registry must NOT absorb layers 2 or 3.
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe (runs after the
-- 000-baseline `vector` extension + harness_app/harness_zero roles exist).

CREATE TABLE IF NOT EXISTS harness_shared.datatype_registry (
  id                    TEXT NOT NULL,                         -- the datatype slug (e.g. 'bet'); PK with workspace_id
  workspace_id          TEXT NOT NULL,                         -- workspace-local scope (D-010 local tier)
  hive_slug             TEXT,                                  -- owning/producing hive; NULL ⇒ workspace-global
  title                 TEXT NOT NULL,
  description           TEXT NOT NULL,                         -- what this datatype represents (semantic dedup leg)
  tier                  TEXT NOT NULL DEFAULT 'generic-kind',  -- generic-kind | first-class | projection (D-002/D-008)
  work_item_kind        TEXT,                                  -- the registered work_item kind (generic-kind tier; P-001)
  payload_schema        JSONB,                                 -- the validated payload shape (JSON Schema) for the kind
  authoritative_writer  TEXT NOT NULL DEFAULT 'papercusp',     -- 'papercusp' | 'engine:<name>' (projection tier = external; D-008)
  self_improvement      JSONB,                                 -- REQUIRED surface (P-010): { improvements, scorecard, gym }
  status                TEXT NOT NULL DEFAULT 'active',        -- active | retired | superseded
  published             BOOLEAN NOT NULL DEFAULT FALSE,        -- local (workspace) vs Comb-published (D-010 graduated)
  tags                  TEXT[] NOT NULL DEFAULT '{}',
  embedding             VECTOR(384),                           -- title+description embedding (cosine dedup leg); NULL until embedded
  title_tsv             TSVECTOR GENERATED ALWAYS AS (
                          to_tsvector('english', COALESCE(title,'') || ' ' || COALESCE(description,''))
                        ) STORED,
  created_by            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

-- A generic-kind datatype's work_item_kind becomes an ACCEPTED work_items:create
-- kind (P-001), so it must be unique within the workspace — two datatypes can't
-- claim the same kind.
CREATE UNIQUE INDEX IF NOT EXISTS datatype_registry_ws_kind_idx
  ON harness_shared.datatype_registry (workspace_id, work_item_kind)
  WHERE work_item_kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS datatype_registry_ws_hive_idx
  ON harness_shared.datatype_registry (workspace_id, hive_slug);
CREATE INDEX IF NOT EXISTS datatype_registry_title_tsv_idx
  ON harness_shared.datatype_registry USING gin (title_tsv);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.datatype_registry TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.datatype_registry TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.datatype_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS datatype_registry_workspace_isolation ON harness_shared.datatype_registry;
CREATE POLICY datatype_registry_workspace_isolation ON harness_shared.datatype_registry
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
