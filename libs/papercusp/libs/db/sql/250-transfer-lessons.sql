-- 250-transfer-lessons.sql
--
-- self-learning-frontier-2026-06-12 (P-022 / FB-08, D-001/D-002/D-006): the
-- TRANSFER HARNESS lesson store — one row per candidate lesson distilled from
-- the day's transcripts (or matched to a learning-pack candidate), carrying
-- the D-006 two-tier memory lifecycle:
--
--   tier — 'probationary' (admitted free; D-006: admission is never gated) →
--     'validated' (promoted by a PASSING student-transfer test: a fresh
--     student with the lesson beat one without it on the source historical
--     task, replayed via lib/replay + the frozen eval-battery judge) →
--     'retired' (the RETENTION decision: repeated failures with no pass —
--     removed from recall).
--
--   status — the last transfer-test disposition ('candidate' = never tested;
--     'error' = the battery failed to score, distinct from a scored 'failed').
--
--   signal_origin defaults to 'replay' (migration 241's provenance
--   vocabulary, P-002/D-002): everything this harness emits is born tagged so
--   no organic learner ever consumes it un-opted-in.
--
-- Vocabulary OWNED by packages/operator-core/lib/transfer/ (columns stay
-- plain text so the seam can evolve, mirroring replay_runs/247).
--
-- Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.transfer_lessons (
    workspace_id   text NOT NULL,
    id             uuid NOT NULL DEFAULT gen_random_uuid(),
    -- Structural dedup key: sha-256 of the normalized lesson text — the same
    -- key learning_pack_candidates rows are matched on (the D-006 "candidates
    -- inherit the bar" join).
    signature      text NOT NULL,
    title          text,
    lesson_text    text NOT NULL,
    -- Where the lesson came from.
    source_kind    text NOT NULL DEFAULT 'transcript'
                   CHECK (source_kind IN ('transcript', 'memory', 'pack-candidate')),
    -- Transcript ref (a lib/replay TranscriptSource ref) for 'transcript';
    -- memory id / candidate id for the other kinds.
    source_ref     text,
    tier           text NOT NULL DEFAULT 'probationary'
                   CHECK (tier IN ('probationary', 'validated', 'retired')),
    status         text NOT NULL DEFAULT 'candidate'
                   CHECK (status IN ('candidate', 'passed', 'failed', 'error')),
    test_count     integer NOT NULL DEFAULT 0,
    pass_count     integer NOT NULL DEFAULT 0,
    fail_count     integer NOT NULL DEFAULT 0,
    last_tested_at timestamptz,
    -- The replay battery (replay_runs.battery_id) of the last test.
    last_battery_id text,
    -- with-lesson composite minus baseline composite from that battery.
    last_delta     numeric,
    -- memory_canonical id while the lesson is admitted to memory; NULL when
    -- not (or no longer) in the store.
    memory_id      uuid,
    -- learning_pack_candidates.id when the lesson maps to a staged candidate.
    pack_candidate_id uuid,
    -- Provenance vocabulary shared with migration 241 (P-002/D-002).
    signal_origin  text NOT NULL DEFAULT 'replay'
                   CHECK (signal_origin IN ('organic', 'drill', 'replay', 'shadow')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT transfer_lessons_signature_uniq UNIQUE (workspace_id, signature)
);

-- The nightly tick's read: least-recently-tested probationary lessons first.
CREATE INDEX IF NOT EXISTS transfer_lessons_ws_tier_tested_idx
    ON harness_shared.transfer_lessons (workspace_id, tier, last_tested_at NULLS FIRST);

CREATE INDEX IF NOT EXISTS transfer_lessons_ws_created_idx
    ON harness_shared.transfer_lessons (workspace_id, created_at DESC);

-- Workspace isolation, mirroring replay_runs (247). The operator connects as
-- harness_admin (superuser, bypasses RLS); the policy keeps any non-superuser
-- path workspace-scoped + consistent with harness_shared.
ALTER TABLE harness_shared.transfer_lessons ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transfer_lessons_workspace_isolation ON harness_shared.transfer_lessons;
CREATE POLICY transfer_lessons_workspace_isolation ON harness_shared.transfer_lessons
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- Runtime-role grants (lesson rows are updated in place as tests accumulate —
-- not an append-only ledger; spend ledgering stays on learning_spend_events).
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.transfer_lessons TO harness_app;
GRANT SELECT ON harness_shared.transfer_lessons TO harness_zero;
