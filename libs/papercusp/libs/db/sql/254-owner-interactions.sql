-- 254-owner-interactions.sql
--
-- self-learning-frontier-2026-06-12 (P-043 / FB-15): the owner-interaction
-- event stream — the implicit telemetry the owner preference model learns
-- from. One append-only row per observed owner interaction:
--
--   kind 'grade' | 'regrade'  — an OWNER grade on a routed idea (the
--        gradeRoutedIdea seam; Queen grades are deliberately NOT captured —
--        this stream models the owner's attention, nobody else's).
--   kind 'queue-view'         — the human queue was rendered to the owner
--        (captured server-side at the learning.improvements sync resolver,
--        throttled; payload.ids = the EI ids that were visible). This is the
--        EXPOSURE denominator that makes "ignored despite being shown" a
--        measurable signal instead of a guess.
--
-- The kind vocabulary is owned by the write seam
-- (packages/operator-core/lib/owner-preference/interactions.ts) — plain text
-- by design, same call as scout grading's graded_by (mig 234): future kinds
-- ('resolve', 'dismiss', 'decide') land as new rows, not schema changes.
--
-- Rows are history (an interaction happened or it didn't) — append-only is
-- enforced at the GRANT level from day one, applying 246's lesson: the
-- baseline's ALTER DEFAULT PRIVILEGES hands harness_app ALL on every new
-- table at CREATE time, so the REVOKE must ride the same migration.
--
-- Idempotent; additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.owner_interactions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    text NOT NULL DEFAULT 'default',
    ts              timestamptz NOT NULL DEFAULT now(),
    -- Seam-owned vocabulary: 'grade' | 'regrade' | 'queue-view' (v0).
    kind            text NOT NULL,
    -- What the interaction touched: 'routed-idea' | 'learning-tab' |
    -- 'improvement' (reserved for future resolve/dismiss capture).
    subject_kind    text NOT NULL,
    -- The routed idea id, EI id, or the Learning sub-view for 'queue-view'.
    subject_id      text NOT NULL DEFAULT '',
    -- grade/regrade: { grade, prevGrade?, lens?, rail?, routedRef?, title? }
    -- queue-view:   { ids: string[], total: number }
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS owner_interactions_ws_ts_idx
    ON harness_shared.owner_interactions (workspace_id, ts DESC);

CREATE INDEX IF NOT EXISTS owner_interactions_ws_kind_ts_idx
    ON harness_shared.owner_interactions (workspace_id, kind, ts DESC);

GRANT SELECT, INSERT ON harness_shared.owner_interactions TO harness_app;
GRANT SELECT, INSERT ON harness_shared.owner_interactions TO harness_zero;
REVOKE UPDATE, DELETE, TRUNCATE ON harness_shared.owner_interactions FROM harness_app;
REVOKE UPDATE, DELETE, TRUNCATE ON harness_shared.owner_interactions FROM harness_zero;
