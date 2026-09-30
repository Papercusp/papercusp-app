-- SU agent file-lock coordination — apply-on-grant queued edits (EI-9033).
--
-- A blocked agent can attach the CONCRETE edit it was going to make to its
-- wake_on_grant waiter ticket (file + old_string + new_string — the Edit-tool
-- contract). On lock grant the bridge applies it mechanically IFF old_string
-- matches exactly once, then notifies the agent passively instead of waking it
-- to retry. On any mismatch it degrades to today's wake-on-grant behaviour.
--
-- Idempotent.

ALTER TABLE agent_lock_waiters
  ADD COLUMN IF NOT EXISTS pending_edit jsonb;

-- Claim/outcome latch for the pending edit — makes application EXACTLY-ONCE
-- across the two reconcile paths (the NOTIFY fast-path + the sweep backstop
-- both observe the grant). NULL = unclaimed; 'claiming' = a reconcile won the
-- latch and is applying; 'applied' = landed (agent notified, lock released);
-- 'fallback' = mismatch/guardrail, the normal grant wake fired instead.
ALTER TABLE agent_lock_waiters
  ADD COLUMN IF NOT EXISTS pending_edit_status text;
