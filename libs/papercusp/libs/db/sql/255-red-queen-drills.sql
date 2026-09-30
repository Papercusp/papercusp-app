-- 255-red-queen-drills.sql
--
-- self-learning-frontier-2026-06-12 (P-031 / FB-20): Red Queen vaccination —
-- one row per DRILL: a synthetic friction planted in the sandbox workspace
-- ('red-queen-sandbox', never the live one) with known ground truth, then
-- measured end-to-end through the REAL loop machinery: the watchdog tick saw
-- it (detected_at), triage routed it (triaged_at), something fixed it
-- (resolved_at). MTTSH = those deltas; the row also records what the system
-- CONCLUDED (detected key / triage decision / idea type) against the planted
-- known answer, so FB-23 can judge the learning system's own roles on drill
-- ground truth (resolve rate, MTTSH, triage accuracy).
--
-- Every signal a drill produces is origin='drill' (migration 241 provenance,
-- D-002): the captured engineer_issues row rides the drill lane and is
-- invisible to organic learners by the read-items allowlist. leak_check
-- records the per-run zero-leak assertion (organic read seam excluded the
-- drill row; live-workspace collectors saw none of the planted artifacts).
--
-- Volume: a handful of rows per cadence tick. No RLS (mirrors 251-fleet-ekg):
-- the drill harness and the learning.redQueen resolver scope by workspace_id
-- explicitly. Status updates in place (planted → detected → triaged →
-- resolved | failed | expired) — a lifecycle row, not an append-only ledger.

CREATE TABLE IF NOT EXISTS harness_shared.red_queen_drills (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id          text NOT NULL,
    drill_class           text NOT NULL,
    collector_family      text NOT NULL,
    status                text NOT NULL DEFAULT 'planted',
    planted_at            timestamptz NOT NULL DEFAULT now(),
    detected_at           timestamptz,
    triaged_at            timestamptz,
    resolved_at           timestamptz,
    -- ground truth (the known answer the drill planted):
    expected_watchdog_key text NOT NULL,
    expected_kind         text NOT NULL,
    expected_severity     text NOT NULL,
    expected_decision     text,
    -- what the system concluded:
    detected_watchdog_key text,
    detected_kind         text,
    triaged_decision      text,
    triaged_idea_type     text,
    resolved_with_evidence boolean NOT NULL DEFAULT false,
    issue_id              text,
    -- measurement + safety:
    mttsh_detect_ms       bigint,
    mttsh_triage_ms       bigint,
    mttsh_fix_ms          bigint,
    mttsh_total_ms        bigint,
    leak_check_passed     boolean,
    leak_check            jsonb,
    -- planted-artifact manifest (what cleanup must remove) + class payload
    -- (e.g. the engine-death class's synthetic routines snapshot):
    planted_artifacts     jsonb,
    payload               jsonb,
    error                 text,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT red_queen_drills_status_check
      CHECK (status IN ('planted', 'detected', 'triaged', 'resolved', 'failed', 'expired')),
    CONSTRAINT red_queen_drills_expected_kind_check
      CHECK (expected_kind IN ('bug', 'change'))
);

CREATE INDEX IF NOT EXISTS red_queen_drills_recent_idx
  ON harness_shared.red_queen_drills (workspace_id, planted_at DESC);
CREATE INDEX IF NOT EXISTS red_queen_drills_class_idx
  ON harness_shared.red_queen_drills (workspace_id, drill_class, planted_at DESC);
-- One OPEN drill per class per workspace: a drill still in flight must finish
-- (or fail/expire) before the same class plants again — re-planting over an
-- undetected friction would corrupt its MTTSH ground truth.
CREATE UNIQUE INDEX IF NOT EXISTS red_queen_drills_open_class_uq
  ON harness_shared.red_queen_drills (workspace_id, drill_class)
  WHERE status IN ('planted', 'detected', 'triaged');

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.red_queen_drills TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.red_queen_drills TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;
