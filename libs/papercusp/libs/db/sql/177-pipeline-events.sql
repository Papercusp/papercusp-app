-- Migration 177 — harness_shared.pipeline_events: append-only log of the
-- git-sync → green-checkpoint → release pipeline, for the /admin Git tab stats.
--
-- The pipeline persisted NO history before this: only the LATEST git-sync status
-- + LAST resolver outcome lived in harness_shared.routines.metadata (JSONB,
-- overwritten every tick), green-checkpoint wrote nothing back, and the open
-- conflict lived in harness_escalations (UNIQUE per harness+phase, also
-- overwritten). So "how many merge conflicts / how often is main green" had no
-- queryable answer. This table is the append-only event log those stats read.
--
--   kind    = git_sync | merge_resolver | green_checkpoint   (+ future: deploy)
--   status  = per-kind outcome string:
--               git_sync         → synced | nothing | conflict | error
--               merge_resolver   → ok | failed | error        (one row per SETTLE)
--               green_checkpoint → advanced | up-to-date | not-green
--                                  | not-fast-forward | create-failed
--   detail  = kind-specific jsonb (conflicted scopes/files, resolver exitCode/
--             httpStatus/timedOut, candidate/from shas, pushed/merged scopes, …)
--
-- Append-only (no updated_at / no trigger): each row is one pipeline event at a
-- point in time. Written by the operator as harness_admin (git-sync-action.ts +
-- release-actions.ts, both already on getOrgPg). Classification: workspace-owned,
-- mirrors the RLS + grant shape of harness_docs (mig 172). Idempotent (CREATE ...
-- IF NOT EXISTS + guarded constraints/grants); composes onto 000-baseline.sql for
-- fresh / embedded-pg boots.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.pipeline_events (
    id bigserial NOT NULL,
    workspace_id text NOT NULL,
    install_slug text NOT NULL,                    -- harness slug (e.g. 'papercup')

    kind text NOT NULL,                            -- git_sync | merge_resolver | green_checkpoint
    status text NOT NULL,                          -- per-kind outcome (see header)
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,     -- kind-specific payload

    created_at timestamp with time zone DEFAULT now() NOT NULL,

    CONSTRAINT pipeline_events_kind_check
      CHECK (kind = ANY (ARRAY['git_sync'::text, 'merge_resolver'::text, 'green_checkpoint'::text, 'deploy'::text])),
    CONSTRAINT pipeline_events_workspace_nonempty CHECK ((workspace_id <> ''::text)),
    CONSTRAINT pipeline_events_slug_nonempty CHECK ((install_slug <> ''::text))
);

DO $baseline_guard$ BEGIN
  ALTER TABLE ONLY harness_shared.pipeline_events
    ADD CONSTRAINT pipeline_events_pkey PRIMARY KEY (id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL;
  WHEN invalid_table_definition THEN NULL;
END $baseline_guard$;

COMMENT ON TABLE harness_shared.pipeline_events IS
  'Append-only log of the git-sync → green-checkpoint → release pipeline (mig 177). One row per pipeline event (git-sync tick, merge-resolver settle, green-checkpoint run); the source of the /admin Git tab stats. Latest-only state still lives in routines.metadata + harness_escalations — this is the history those overwrite.';

-- Window summaries + recent timeline both filter by (slug, kind) and order by time.
CREATE INDEX IF NOT EXISTS pipeline_events_slug_kind_created_idx
  ON harness_shared.pipeline_events USING btree (install_slug, kind, created_at DESC);

-- The flat recent-timeline read (all kinds for a harness, newest first).
CREATE INDEX IF NOT EXISTS pipeline_events_slug_created_idx
  ON harness_shared.pipeline_events USING btree (install_slug, created_at DESC);

-- RLS: workspace isolation (mirrors harness_docs, mig 172). harness_admin has
-- BYPASSRLS (mig 016) — the operator writes/reads this as admin; the policy
-- scopes any harness_app access to its own workspace.
ALTER TABLE harness_shared.pipeline_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pipeline_events_workspace_isolation ON harness_shared.pipeline_events;
CREATE POLICY pipeline_events_workspace_isolation ON harness_shared.pipeline_events
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

GRANT SELECT, INSERT ON harness_shared.pipeline_events TO harness_app;
GRANT USAGE, SELECT ON SEQUENCE harness_shared.pipeline_events_id_seq TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.pipeline_events TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;

COMMIT;
