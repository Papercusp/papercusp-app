-- 205-tool-invocations-error-code.sql
--
-- watchdog-robustness-2026-06-09 (P-007 / D-009): persist the dispatcher's error
-- CLASS on each tool invocation. (Renumbered from 203 — collided with a peer's
-- 203-spawned-agents-session-id via a git-sync timing race; two same-numbered files
-- make one silently go dark on boot-apply — see db-boot-migrate.ts.)
--
-- recordTelemetry (libs/generic/tooldef/src/dispatch-stack.ts) already computes a
-- rich error `code` — unauthorized / handler_error / harness_required /
-- role_not_allowed / missing_capability / quota_exceeded / timeout / invalid_input /
-- invalid_args — then COLLAPSES it into the coarse `status` column and DISCARDS the
-- code. That made a deterministic config bug (e.g. memory:search `unauthorized` =
-- workspace_required) indistinguishable from a transient crash (both status='error'),
-- forcing the improvement-watchdog into fragile error_message LIKE matching, and is a
-- root cause of the low-frequency STRUCTURAL failures it missed.
--
-- This column persists the code as a first-class, low-cardinality value so the
-- watchdog can classify STRUCTURAL (recurs identically -> a real bug, fire on few)
-- vs TRANSIENT (timeout/load -> volume-gated) failures. NULL on success rows and on
-- legacy rows written before this migration.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS); additive;
-- fresh-migrate-safe (the baseline creates the table; this runs after).

ALTER TABLE harness_shared.tool_invocations
    ADD COLUMN IF NOT EXISTS error_code text;

-- The watchdog scans only FAILING rows, grouped by tool + code, in a recent window.
-- A partial index on non-null codes keeps it cheap and small (success rows — the
-- vast majority — carry NULL and are excluded from the index).
CREATE INDEX IF NOT EXISTS tool_invocations_error_code_idx
    ON harness_shared.tool_invocations (error_code, invoked_at)
    WHERE error_code IS NOT NULL;
