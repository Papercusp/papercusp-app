-- 1339-session-gate-suppressed-ask-kind.sql
--
-- WI-10005039 (follow-up to EI-23783029010995961): admit agent-SUPPRESSED owner
-- asks into the existing owner-gate tracker instead of a new table.
--
-- THE GAP. An agent that decides privately not to re-send an owner ask (loop-
-- checkpoint text like 'DO NOT ask a 4th time') leaves no durable row, so
-- plans:attention cannot answer 'what is waiting on the owner right now' for it.
-- session_pending_gates already carries decide_by + default_if_unanswered
-- (migration 1185), a reaper (attention/gate-reaper.ts) and a plans:attention
-- source (#14) -- what it cannot do is ADMIT this population, because two CHECKs
-- only name the observed producers:
--
--   kind   IN ('ask', 'permission_wait')   -> + 'suppressed_ask'
--   source IN ('watcher', 'hook')          -> + 'agent'
--
-- A suppressed ask is not a tool_use a watcher saw or a prompt a hook mirrored: it
-- is the AGENT's own declaration of a decision it owes the owner, with the default
-- it will proceed under and the deadline for it. Hence a new source, and a kind
-- the reaper can treat differently (it must NOT be closed merely because the
-- declaring session ended -- the decision is the owner's, not the session's).
--
-- FORWARD-COMPAT: this drops and re-adds session_pending_gates_kind_check and
-- session_pending_gates_source_check to WIDEN them, which is safe against the
-- older release :3070 keeps serving. Each widened CHECK is a strict superset of
-- the old one: it still admits 'ask' / 'permission_wait' and 'watcher' / 'hook',
-- which are the only values the deployed code can write (GateKind and GateSource
-- had exactly those members). Live code therefore cannot violate the new
-- constraints, and no deployed reader branches on a constraint definition. The two
-- new values are written only by code that ships with this migration. No column
-- is added, dropped or re-typed. This is pure EXPAND; there is no CONTRACT half.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + ADD inside one guarded DO block per
-- constraint; re-runnable. No top-level BEGIN/COMMIT -- the migration runner
-- wraps each file in its own transaction.

DO $widen_kind$
BEGIN
  ALTER TABLE harness_shared.session_pending_gates
    DROP CONSTRAINT IF EXISTS session_pending_gates_kind_check;
  ALTER TABLE harness_shared.session_pending_gates
    ADD CONSTRAINT session_pending_gates_kind_check
    CHECK (kind IN (
      'ask',             -- a structured question the session is blocked on
      'permission_wait', -- a tool-permission prompt the session is blocked on
      'suppressed_ask'   -- an owner ask the AGENT chose not to re-send (WI-10005039)
    ));
END
$widen_kind$;

DO $widen_source$
BEGIN
  ALTER TABLE harness_shared.session_pending_gates
    DROP CONSTRAINT IF EXISTS session_pending_gates_source_check;
  ALTER TABLE harness_shared.session_pending_gates
    ADD CONSTRAINT session_pending_gates_source_check
    CHECK (source IN (
      'watcher', -- the transcript watcher saw it   (gate-watch.ts)
      'hook',    -- a per-CLI hook mirrored it       (sessions:ingest-gate-event)
      'agent'    -- the agent declared it itself    (WI-10005039)
    ));
END
$widen_source$;
