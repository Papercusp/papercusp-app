-- 1185-session-gate-decide-by-and-asker-gone.sql — WI-10002067.
--
-- THE DEFECT THIS CLOSES. session_pending_gates (619) admitted exactly two
-- terminal reasons — 'tool_result_observed' and 'hook_cleared' — and BOTH are
-- written only by machinery that requires the ASKING SESSION to still be alive
-- to observe something:
--     closeGate            (hook ingest / inbox bulk resolver)
--     closeGateByToolUseId (transcript watcher)
-- Neither has a session-independent caller. So when the asking session dies,
-- nothing ever calls either one with that session_id, closed_at stays NULL
-- forever, and the row is unreachable BY CONSTRUCTION rather than by a missed
-- edge case. Measured 2026-09-20: 241 open gates, >=226 (>=93.8%) whose asker
-- is gone for good, the oldest open since 2026-07-17. Every one of them renders
-- to the human as "a session is blocked waiting on you", so the owner's Inbox
-- is ~94% entries that no agent and no code path can discharge.
--
-- WHY NOT JUST REVIVE THE WATCHER (measured, not assumed — do not re-litigate):
-- reviving gate-watcher-tick retires ZERO of the 241. Three independent
-- structural reasons, each sufficient alone: (1) it tails ~/.claude/projects
-- (300 files) while psu sessions write under ~/.papercusp (22,014 files) — of
-- the 10 open gates whose transcript demonstrably holds the closing
-- tool_result, 0 are under the watcher root; (2) its close path seeds from
-- listPendingGates(limit 200), hard-clamped at 200 oldest-first, so with 241
-- open the 41 NEWEST are structurally invisible to it; (3) all 624
-- permission_wait rows carry ref_id = 'notify:'||session_id, which
-- closeGateByToolUseId (matching ref_id = toolUseId) can never match. Those are
-- tracked separately as WI-10002079; they are NOT an alternative to this
-- migration.
--
-- WHAT THIS ADDS.
--   decide_by             — an explicit deadline the ASKER declares at ask time.
--                           Rides the exact route `question`/`options` already
--                           prove: an observer (hook ingest or watcher) extracts
--                           it from the agent's ask and persists it on the row.
--                           No new seam, no new transport.
--   default_if_unanswered — the disposition to apply when that deadline passes,
--                           so a gate self-resolves instead of depending on its
--                           author surviving.
--   closed_reason         — widened with two SESSION-INDEPENDENT terminal
--                           reasons, which is the actual root-cause fix:
--                             'asker_gone'      the asking session is no longer
--                                               live (retires the existing 241)
--                             'default_applied' decide_by passed and the
--                                               declared default was applied
--                                               (stops new ones accumulating)
--
-- FORWARD-COMPAT: this drops and re-adds session_pending_gates_closed_reason_check
-- to WIDEN it, which is safe against the older release :3070 keeps serving. The
-- widened CHECK is a strict superset of the old one — it still admits NULL,
-- 'tool_result_observed' and 'hook_cleared', which are the only values the
-- deployed code can write (GateClosedReason had exactly those two members).
-- Live code therefore cannot violate the new constraint, and no deployed reader
-- branches on the constraint definition itself. The two new values are written
-- only by code that ships with this migration. Both added columns are NULLable
-- with no default, so the deployed INSERT — which does not name them — keeps
-- working unchanged. This is pure EXPAND; there is no CONTRACT half to sequence.
--
-- Idempotent: IF NOT EXISTS / guarded DO blocks throughout; re-runnable. No
-- top-level BEGIN/COMMIT — the migration runner wraps each file in its own
-- transaction.

ALTER TABLE harness_shared.session_pending_gates
  ADD COLUMN IF NOT EXISTS decide_by TIMESTAMPTZ;

ALTER TABLE harness_shared.session_pending_gates
  ADD COLUMN IF NOT EXISTS default_if_unanswered JSONB;

COMMENT ON COLUMN harness_shared.session_pending_gates.decide_by IS
  'Deadline the ASKER declares at ask time; past it the gate self-resolves to default_if_unanswered and closes as ''default_applied'' instead of waiting on the asking session to survive. NULL = no deadline (the pre-WI-10002067 behaviour).';

COMMENT ON COLUMN harness_shared.session_pending_gates.default_if_unanswered IS
  'Disposition applied when decide_by passes with no answer — shape mirrors an entry of the options array when the gate is an ask. NULL with a non-NULL decide_by means "expire it, no default to apply".';

-- Widen the terminal-reason CHECK. The two new members are the
-- session-INDEPENDENT reasons whose absence was the root cause: every
-- pre-existing member required the asking session to observe something.
DO $widen$
BEGIN
  ALTER TABLE harness_shared.session_pending_gates
    DROP CONSTRAINT IF EXISTS session_pending_gates_closed_reason_check;
  ALTER TABLE harness_shared.session_pending_gates
    ADD CONSTRAINT session_pending_gates_closed_reason_check
    CHECK (
      closed_reason IS NULL
      OR closed_reason IN (
        'tool_result_observed',  -- watcher saw the tool_result   (needs a live asker)
        'hook_cleared',          -- hook/bulk resolver cleared it (needs a live asker)
        'asker_gone',            -- asking session is no longer live       (WI-10002067)
        'default_applied'        -- decide_by passed, default applied      (WI-10002067)
      )
    );
END
$widen$;

-- The reaper's driving read: open gates whose deadline has passed. Partial so
-- it stays small forever — closed rows and deadline-less gates fall out of the
-- index entirely, matching session_pending_gates_open_idx's shape.
CREATE INDEX IF NOT EXISTS session_pending_gates_decide_by_idx
  ON harness_shared.session_pending_gates (workspace_id, decide_by)
  WHERE closed_at IS NULL AND decide_by IS NOT NULL;
