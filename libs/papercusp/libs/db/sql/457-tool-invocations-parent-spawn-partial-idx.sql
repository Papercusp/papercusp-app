-- 457-tool-invocations-parent-spawn-partial-idx.sql
--
-- EI-6801 (fleet-wide PG lock stampede — a wedged 27-min read against
-- harness_shared.tool_invocations_spawn_tree blocked ~119 sessions' coord_presence
-- upserts). Investigation found the ORIGINAL diagnosis ("missing index on
-- (harness_slug, invoked_at)") does not explain the wedge: that composite index
-- ALREADY EXISTS (tool_invocations_telemetry_idx) but tool_invocations_spawn_tree
-- is a `WITH RECURSIVE` view whose non-recursive term has NO filter at all —
-- Postgres cannot push a caller's WHERE (harness_slug/workspace_id/invoked_at)
-- into a recursive CTE, so EVERY query against the view unconditionally
-- evaluates the base case over the WHOLE table (7.4M rows as of 2026-07-02,
-- 99.73% of which satisfy `parent_spawn_id IS NULL OR ''` and thus qualify as
-- roots), then sorts the result to satisfy ORDER BY invoked_at DESC LIMIT N —
-- hence the observed disk-spilled sort (wait_event=BuffileWrite) on a query
-- whose LIMIT should make it near-instant.
--
-- This migration is the SAFE, zero-behavior-change half of the fix: a partial
-- index on the rare "real child" rows (~20k of 7.4M as of this writing) so the
-- recursive term's JOIN (t.parent_spawn_id = chain.spawn_id) is fast WHEN it
-- runs. It does NOT fix the base case's unconditional full-table scan — that
-- needs an actual redesign of the view (converting it to a parameterized SQL
-- function so the harness_slug/workspace_id/invoked_at filter can be pushed
-- into the recursive term itself), which is filed separately as a follow-up
-- (see the EI-6801 completion comment) rather than rushed into this migration:
-- `tool_invocations.spawn_id` was found to be NON-unique (e.g. many unrelated
-- rows share the literal spawn_id 'event-reaction'), so a safe rewrite needs
-- deliberate design + review, not a same-wake guess.
--
-- A full-table index on parent_spawn_id would be useless (it would just be
-- another near-100%-selective index, same problem as the base case) — WHERE
-- clause below keeps this index small (~20k entries) and targeted at exactly
-- the predicate the recursive term's JOIN needs.

CREATE INDEX IF NOT EXISTS tool_invocations_parent_spawn_partial_idx
  ON harness_shared.tool_invocations USING btree (parent_spawn_id)
  WHERE parent_spawn_id IS NOT NULL AND parent_spawn_id <> '';
