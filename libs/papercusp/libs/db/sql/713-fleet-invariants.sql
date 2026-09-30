-- 713-fleet-invariants.sql
--
-- fleet-leadership-continuity-and-actuation-2026-08-01 P-014. The registry for
-- leader-registered CUSTOM invariants, evaluated on every `fleet:leader-brief`.
--
-- WHY THIS EXISTS: leader-brief already computes a family of built-in
-- invariants (stranded-fleet, spec-starved, idle-with-claimable, floor-starved,
-- dormant). Each is a good check that someone thought to build IN ADVANCE. The
-- motivating incident for P-014 was the opposite shape: during the 2026-07-26
-- push-not-poll run a leader wrote a ~6-line ad-hoc check cross-referencing each
-- member's parked event keys against the ASSIGNEE of the work-items named in
-- those keys. It caught a real problem no built-in counter surfaced — and then
-- died with the turn that wrote it, because there was nowhere to put it. The
-- next leader had to notice the same thing from scratch.
--
-- WHY SQL RATHER THAN A PREDICATE DSL: the motivating check is a JOIN across two
-- collections (parked keys live in event_awaits, assignees in work_items). A
-- field/op/value DSL over the brief's member rows cannot express that without
-- growing into a query language, and arbitrary JS eval is an execution surface
-- nobody should hand a registry. Both sides are already PG-canonical, so SQL
-- states the check in about the six lines the incident report described.
--
-- WHY THIS IS SAFE: nothing here executes SQL. Evaluation goes through the
-- existing `pgReadQuery()` envelope, which wraps every statement in a READ ONLY
-- transaction (PG itself rejects INSERT/UPDATE/DDL — the real enforcement, not a
-- regex), applies a statement_timeout so a runaway check cannot wedge the pool,
-- LIMIT-wraps with a row cap so a fat result cannot flood the leader's context,
-- and asserts a single read statement. Storing text here inherits that entire
-- audited envelope instead of standing up a second one.
--
-- CONTRACT: rows returned == the invariant is VIOLATED, and the returned rows
-- ARE the evidence shown to the leader. An invariant that returns zero rows is
-- satisfied. This direction is deliberate: it makes the empty result the quiet
-- case, so a check that silently stops matching reads as "healthy" only when it
-- genuinely selected nothing — and the leader still sees the invariant listed as
-- evaluated, never silently dropped.
--
-- Tenancy: keyed on (workspace_id, fleet_slug, name) per the repo's
-- multi-tenant convention — a bare fleet_slug filter can otherwise match another
-- tenant's row and read as diverged state.

-- FORWARD-COMPAT: the detector's narrowing-unique-index rule fired on
-- `fleet_invariants_scope_name_idx` below, but that index carries NO `WHERE` clause at
-- all — it is a plain, fully non-partial unique index on (workspace_id, fleet_slug,
-- name), exactly matching the deployed writer's own (checked against sha 1e0ddc5864)
-- ON CONFLICT (workspace_id, fleet_slug, name) DO UPDATE (agent-tools/fleet/invariants.ts).
-- The detector's regex is a lazy, non-anchored `CREATE UNIQUE INDEX ... WHERE` scan
-- across the WHOLE file, so it matched forward past this statement to the unrelated,
-- later `WHERE active;` on the plain (non-unique) `fleet_invariants_active_idx` — a
-- false positive of the file-wide-span kind, not a real narrowing. Independently:
-- `fleet_invariants` is also a table this SAME migration creates, so even a genuine
-- partial index here would have nothing pre-existing to narrow. (WI-6842)
CREATE TABLE IF NOT EXISTS harness_shared.fleet_invariants (
  id            text        PRIMARY KEY,
  workspace_id  text        NOT NULL,
  harness_slug  text,
  fleet_slug    text        NOT NULL,
  name          text        NOT NULL,
  description   text,
  -- The check itself. Named `query_sql` rather than `sql` so the column never
  -- reads as a keyword at a call site.
  query_sql     text        NOT NULL,
  -- 'warn' surfaces in the brief; 'critical' additionally sets the summary flag
  -- a leader's monitor loop keys on.
  severity      text        NOT NULL DEFAULT 'warn',
  active        boolean     NOT NULL DEFAULT true,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fleet_invariants_severity_valid CHECK (severity IN ('warn', 'critical'))
);

-- Upsert target: re-registering the same name for the same fleet REPLACES it,
-- so a leader refining a check does not accumulate near-duplicate invariants.
CREATE UNIQUE INDEX IF NOT EXISTS fleet_invariants_scope_name_idx
  ON harness_shared.fleet_invariants (workspace_id, fleet_slug, name);

-- The read path: every active invariant for one fleet, on each brief.
CREATE INDEX IF NOT EXISTS fleet_invariants_active_idx
  ON harness_shared.fleet_invariants (workspace_id, fleet_slug)
  WHERE active;
