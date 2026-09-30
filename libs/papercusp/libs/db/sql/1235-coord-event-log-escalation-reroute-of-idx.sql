-- 1235-coord-event-log-escalation-reroute-of-idx.sql
--
-- host-memory-reduction-2026-09-27 P-005 / D-012 — an access path for the reroute-marker
-- leg of readEscalationResponseMarkers (packages/operator-core/lib/attention/
-- reconcile-escalations.ts).
--
-- WHY IT NEVER NEEDED ONE BEFORE, AND WHY IT DOES NOW. That query wrote the marker key as
-- `'${ESCALATION_REROUTE_MARKER_FIELD}'` inside SQL quotes in a postgres.js tagged template.
-- postgres.js turns every interpolation into a `$n` placeholder, so the SQL carried the
-- literal key '$1' and the bound values went unreferenced — and Postgres refused the
-- prepare outright: `could not determine data type of parameter $1` (observed 2026-09-27
-- with postgres.js describe(), no rows touched). Every call therefore threw into a bare
-- catch that loaded the WHOLE messages surface into Node (536k rows, ~2 GB of V8 heap,
-- cached for the process lifetime). The fix makes the query actually run, and then
-- EXPLAIN shows the next problem: the OR's reroute leg has no index, so the whole
-- statement plans a Parallel Seq Scan of the table (~1.1 GB of JSON) on every reconcile
-- pass.
--
-- The code change splits the OR into a UNION of two legs. The related_msg_id leg already
-- has coord_event_log_related_msg_id_idx (migration 691); this index is the same shape for
-- the reroute marker, which is rare — 706 of 353,429 messages in the last 30 days — so
-- the partial index is tiny.
--
-- THE PARTIAL PREDICATE MUST MATCH THE QUERY TEXTUALLY (see 691 and 1053): the call site
-- carries the literal `body ? 'escalationRerouteOf'` key-presence clause. It reads as
-- redundant beside the equality and is load-bearing for the plan; do not remove it there.

CREATE INDEX IF NOT EXISTS coord_event_log_escalation_reroute_of_idx
  ON harness_shared.coord_event_log ((body ->> 'escalationRerouteOf'))
  WHERE (body ? 'escalationRerouteOf');

COMMENT ON INDEX harness_shared.coord_event_log_escalation_reroute_of_idx IS
  'P-005/D-012 (host-memory-reduction-2026-09-27): access path for the reroute-marker leg of '
  'readEscalationResponseMarkers. Partial on the literal key-presence predicate the call site '
  'carries; if that clause is removed the planner cannot use this index.';
