-- 226-papercup-directives-baseline-gap.sql
--
-- Backfill papercup_shared.directives — a baseline GAP found by the WI-102
-- P-012 drizzle regen (self-contained-migration-baseline-2026-06-02).
--
-- The squash that produced 000-baseline.sql created the directives table's
-- three siblings (briefings, directive_summaries, messages) but DROPPED
-- `directives` itself — it had been created by the now-deleted ensure-schema
-- runtime DDL (ensure-schema.ts, removed in P-008), so when ensure-schema went
-- away nothing recreated it. The live dev DB still carries it (pre-existing),
-- but a FRESH install built from 000-baseline + migrations lacks it, while
-- harness-state/table-registry.ts still routes papercup_shared.directives as a
-- known harness-state table — so a clean install would 42P01 on any directives
-- write.
--
-- Fully idempotent: a no-op on the live DB (table + PK + indexes already
-- present) and the table-creating step on a fresh install. DDL matches the
-- live table exactly (pg_dump of papercup_shared.directives, 2026-06-11).

CREATE TABLE IF NOT EXISTS papercup_shared.directives (
    id text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    status text NOT NULL,
    created_by text NOT NULL,
    created_ts bigint NOT NULL,
    deadline_ts bigint,
    budget_cents bigint,
    priority text,
    assigned_departments jsonb DEFAULT '[]'::jsonb NOT NULL,
    linked_project_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_ts bigint NOT NULL
);

-- ADD CONSTRAINT is not IF-NOT-EXISTS-able; guard it so this is a no-op on the
-- live DB (which already has directives_pkey).
DO $pg$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'directives_pkey'
      AND connamespace = 'papercup_shared'::regnamespace
  ) THEN
    ALTER TABLE ONLY papercup_shared.directives
      ADD CONSTRAINT directives_pkey PRIMARY KEY (id);
  END IF;
END $pg$;

CREATE INDEX IF NOT EXISTS directives_created_idx
  ON papercup_shared.directives USING btree (created_ts DESC);
CREATE INDEX IF NOT EXISTS directives_status_idx
  ON papercup_shared.directives USING btree (status);

-- Runtime-role grants (mirrors the live table + the schema-wide grants in
-- migration 109; explicit here so a fresh table is reachable immediately).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE papercup_shared.directives TO harness_app;
GRANT SELECT ON TABLE papercup_shared.directives TO harness_zero;
