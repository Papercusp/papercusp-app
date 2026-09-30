-- 673-known-timer-registrations.sql
--
-- P-010 (stop-discarded-dedup-and-audit-server-polling-2026-07-26): extend the
-- poll-suspect-alarm (EI-7428) beyond agent-tool-call rates to cover server-side
-- timers. This is the durable "have we ever seen this timer name before" set —
-- the first-run seed prevents a mass-alarm on deploy (the 104-timer audit this
-- plan already performed is the seed, not a surprise), and any name that shows
-- up AFTER that seed is a genuinely NEW timer that has never been classified
-- per D-004 (must-sample / timeout-reaper / violation) — exactly the class of
-- "new poll-shaped thing nobody looked at" the sibling agent-tool-call detector
-- already catches for agents.
--
-- Deliberately GLOBAL (no workspace_id): 'in-process' / 'managed' /
-- 'external-process' schedule-inventory rows are `scope: 'operator'` — one
-- process-wide registry, not a per-workspace concept (unlike 'routines', which
-- IS per-workspace and stays out of scope here per C4's recommendation to
-- exclude the durable-routines tier from this audit).
CREATE TABLE IF NOT EXISTS harness_shared.known_timer_registrations (
  name text PRIMARY KEY,
  source text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE harness_shared.known_timer_registrations IS
  'P-010: durable set of server-side timer/managedSetInterval names ever observed via collectScheduleInventory(). Seeded once (empty table => bootstrap, no alarm); any name appearing afterward is NEW and unclassified, and the poll-suspect-alarm timer-registration scan toasts it.';
