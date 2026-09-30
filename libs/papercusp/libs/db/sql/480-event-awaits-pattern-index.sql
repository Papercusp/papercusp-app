-- 480-event-awaits-pattern-index.sql
-- Pattern/wildcard awaits (event-await-discoverability-and-coverage-2026-07-03 P-201).
--
-- `events:await` can now register a PATTERN key (a glob like `work-item:done:*`,
-- or a macro `@plan:<slug>` / `@fleet:<slug>` that expands to a glob). Pattern
-- keys store a literal `*` in event_key; store.fireAwaitsForKey fetches the
-- ACTIVE pattern rows on every emit and matches them in JS (via the @papercusp/rules
-- mingo matcher). Without an index that candidate fetch is a full seq scan of
-- event_awaits on EVERY emit — and the common case (no patterns registered) still
-- pays it. This partial index holds only the tiny set of active pattern rows, so
-- the fetch is an index scan that returns instantly when no patterns exist.
--
-- Predicate MUST stay byte-identical to the candidate query's WHERE prefix
-- (event_key LIKE '%*%' AND fired_at IS NULL AND cancelled_at IS NULL) for the
-- planner to use it. `*` is a literal here (SQL LIKE wildcards are % and _).

CREATE INDEX IF NOT EXISTS event_awaits_pattern_active
  ON harness_shared.event_awaits (workspace_id)
  WHERE event_key LIKE '%*%' AND fired_at IS NULL AND cancelled_at IS NULL;
