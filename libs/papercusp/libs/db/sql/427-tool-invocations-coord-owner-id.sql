-- 427: link agent coordination owner id ↔ session — tool_invocations.coord_owner_id
--
-- WI-1279. The dev:sessions list rolls up harness_shared.tool_invocations
-- GROUP BY spawn_id, but the table carried no coordination owner id, so a
-- session's agent — resolveAgentIdentity(ctx).ownerId: su-… for an interactive
-- SU, the bee's s-… spawn id for a fleet child, pus-… for a power-user — was
-- unrecoverable from the list (you could not map a `su-…` from plan-events /
-- coord:presence back to a session). Stamp it at the single telemetry sink
-- (projected-tool-deps.ts buildTelemetryRow) and expose MAX(coord_owner_id) in
-- the rollup + a dev:resolve_owner resolver.
--
-- NOTE on the two id spaces: the owner ↔ *native resume* session id link
-- (session_id / omp_thread_id — what `claude --resume` takes) already lives in
-- harness_shared.adv_sessions (coord_owner_id ↔ session_id) for interactive SU
-- and in spawned_agents for bees; dev:resolve_owner reads those. THIS column
-- adds the owner ↔ *spawn_id* (per-turn telemetry) link for the list/activity view.

ALTER TABLE harness_shared.tool_invocations
  ADD COLUMN IF NOT EXISTS coord_owner_id text;

COMMENT ON COLUMN harness_shared.tool_invocations.coord_owner_id IS
  'Coordination owner id of the calling agent (resolveAgentIdentity(ctx).ownerId): su-… interactive SU, the bee''s s-… spawn id for fleet children, pus-… power-user. Lets dev:sessions attribute/group a session by its agent. NULL on legacy rows the backfill could not attribute (interactive-SU history is resolved live from adv_sessions instead).';

-- Owner lookup / grouping. Partial — most legacy rows stay NULL until the
-- going-forward stamp fills them, so the index stays small. (coord_owner_id,
-- invoked_at DESC) serves "this owner's recent spawns" directly.
CREATE INDEX IF NOT EXISTS tool_invocations_coord_owner_idx
  ON harness_shared.tool_invocations (coord_owner_id, invoked_at DESC)
  WHERE coord_owner_id IS NOT NULL;

-- ── Historical backfill: DELIBERATELY NOT RUN HERE ──────────────────────────
-- This migration is DDL-only so it stays boot-safe (ADD COLUMN + partial INDEX
-- are instant; no data rewrite). The backfill below is NOT executed by boot-apply
-- on purpose:
--   * tool_invocations retains only ~14 days (≈7.2M rows / 5.8GB), and there is
--     no index on spawn_id, so the UPDATE is one FULL-TABLE hash-join pass —
--     running it inside a boot-applied migration would stall operator startup
--     and bloat this high-churn table (cf. migration 320 autovacuum tuning).
--   * Because retention is ~14 days, the going-forward stamp
--     (projected-tool-deps.ts buildTelemetryRow → coord_owner_id) FULLY populates
--     the column on its own within 14 days — the backfill only accelerates that
--     to "now", and only for FLEET BEES (interactive-SU history has no spawn_id↔
--     owner key here; it is resolved live from adv_sessions by dev:resolve_owner).
--
-- To run it immediately, apply this block off-boot, supervised, with
-- PAPERCUSP_ALLOW_DB_MIGRATE=1 (e.g. via db:migrate on a one-off copy). It is
-- idempotent (coord_owner_id IS NULL guard) and a fresh DB matches nothing:
--
--   UPDATE harness_shared.tool_invocations ti
--      SET coord_owner_id = sa.session_owner
--     FROM harness_shared.spawned_agents sa
--    WHERE ti.spawn_id = sa.spawn_id
--      AND ti.coord_owner_id IS NULL
--      AND sa.session_owner IS NOT NULL;
