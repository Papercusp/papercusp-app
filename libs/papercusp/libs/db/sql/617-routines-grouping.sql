-- 617 — routines grouping: group_slug + a routine_groups registry (WI-5018).
--
-- OWNER DIRECTIVE [owner 2026-07-15]: "unlike plans which are one offs so
-- are bounded by the amount the user can handle in their head at a time, the
-- routines can grow infinitely large so I think grouping functionality would
-- be very beneficial there."
--
-- The routines table is genuinely unbounded — this workspace alone carries 788
-- rows today: 655 ephemeral per-agent `loop-<id>` rows from loop:arm, ~62
-- per-hive fanout instances of git-sync/green-checkpoint/release-trigger/
-- cross-hive-outbox-drain, and 49 distinct curated system-routine names with
-- only 'tier' (durable/ephemeral) as an axis. schedule:inventory renders a flat
-- list; managedSetInterval's 'category' exists only at the timer layer.
--
-- THIS is metadata + management ONLY — group_slug never fires anything and
-- routine_groups carries no execution config. The two-mechanism scheduling
-- model (DBOS/routinesTick durable + ephemeral-executor) is unchanged; see
-- CLAUDE.md's "Scheduling: no bare setInterval, no new scheduler" — a group is
-- a filter/rollup/pause-control axis on TOP of that model, not a third one.
--
-- Idempotent: safe to re-run (IF NOT EXISTS / ON CONFLICT DO NOTHING guards;
-- the backfill UPDATE only touches rows still at group_slug IS NULL).

CREATE TABLE IF NOT EXISTS harness_shared.routine_groups (
    workspace_id text NOT NULL,
    slug text NOT NULL,
    description text,
    steward text,
    review_cadence text,
    last_reviewed_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (workspace_id, slug),
    CONSTRAINT routine_groups_workspace_nonempty CHECK (workspace_id <> ''),
    CONSTRAINT routine_groups_slug_nonempty CHECK (slug <> '')
);

ALTER TABLE harness_shared.routines
  ADD COLUMN IF NOT EXISTS group_slug text;

-- Composite FK, MATCH SIMPLE (default): only enforced when BOTH columns are
-- non-null, so the (majority) ungrouped rows are never blocked by it.
DO $fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'routines_group_slug_fkey'
  ) THEN
    ALTER TABLE harness_shared.routines
      ADD CONSTRAINT routines_group_slug_fkey
      FOREIGN KEY (workspace_id, group_slug)
      REFERENCES harness_shared.routine_groups (workspace_id, slug)
      ON DELETE SET NULL;
  END IF;
END
$fk$;

CREATE INDEX IF NOT EXISTS routines_group_slug_idx
  ON harness_shared.routines (workspace_id, group_slug)
  WHERE group_slug IS NOT NULL;

-- Seed the 6 canonical groups (5 owner-named + 'agent-loops', see below) for
-- every workspace that already has routines. Descriptions are the retrofit
-- rationale, not execution semantics — steward/review_cadence are left NULL
-- (an owner/steward fills them in via the new routines:group-set tool).
INSERT INTO harness_shared.routine_groups (workspace_id, slug, description, review_cadence)
SELECT DISTINCT workspace_id, g.slug, g.description, '90d'
  FROM harness_shared.routines,
       LATERAL (VALUES
         ('release',          'Deploy/checkpoint pipeline: green-checkpoint, release-trigger, pr-poll.'),
         ('git-sync',         'Shared-tree commit/gc: git-sync, hive-git-gc.'),
         ('health',           'Cleanup + integrity sweeps: gc/reaper routines, telemetry retention, usage ingest, watchdogs.'),
         ('supervision',      'Coordination/wake/federation: coord invariants, autonomy trust, hive/pot wake, cross-hive outbox drain.'),
         ('self-improvement', 'Gym/scout/blueprint-singleton learning loops + the improvement pipeline.'),
         ('agent-loops',      'Ephemeral per-agent loop:arm registrations (loop-<id>) — not curated system routines; grouped separately so they never masquerade as ungrouped orphans in a rollup.')
       ) AS g(slug, description)
ON CONFLICT (workspace_id, slug) DO NOTHING;

-- Backfill: assign the curated/known routine NAMES to their group, across
-- every install_slug (a name match is deliberately install_slug-agnostic — the
-- same routine repeated per hive belongs to the same group everywhere).
-- Anything unmatched (e.g. owner plan-authored `plan-schedule-*` rows) stays
-- NULL/ungrouped by design — those aren't part of the curated system set.
UPDATE harness_shared.routines r
   SET group_slug = CASE
     WHEN r.name LIKE 'loop-%' THEN 'agent-loops'
     WHEN r.name IN ('git-sync', 'hive-git-gc') THEN 'git-sync'
     WHEN r.name IN ('green-checkpoint', 'release-trigger', 'pr-poll') THEN 'release'
     WHEN r.name IN (
       'cargo-test', 'hive-canary', 'idle-session-reaper', 'hetzner-orphan-frame-reaper',
       'session-dir-gc', 'telemetry-retention', 'token-weekly-report',
       'interactive-usage-ingest', 'p2p-perf-tier1', 'p2p-perf-tier2',
       'improvement-watchdog', 'claim-integrity-sweep'
     ) THEN 'health'
     WHEN r.name IN (
       'coord-invariant-monitor', 'coord-probe-canary', 'claim-discipline-watch',
       'autonomy-trust-scan', 'hive-wake', 'pot-wake', 'wake-brain', 'overwatch-wake',
       'unclaimed-work-digest', 'cross-hive-outbox-drain'
     ) THEN 'supervision'
     WHEN r.name LIKE 'bp-singleton-%' OR r.name IN (
       'gym-cycle', 'scout-cycle', 'template-gym', 'pot-eval-battery',
       'improvement-implement', 'improvement-triage', 'improvement-human-digest',
       'oddsmith-ingest-cadence', 'oddsmith-prospector-cadence', 'scan'
     ) THEN 'self-improvement'
     ELSE NULL
   END
 WHERE r.group_slug IS NULL
   AND EXISTS (
     SELECT 1 FROM harness_shared.routine_groups g
      WHERE g.workspace_id = r.workspace_id
        AND g.slug = CASE
          WHEN r.name LIKE 'loop-%' THEN 'agent-loops'
          WHEN r.name IN ('git-sync', 'hive-git-gc') THEN 'git-sync'
          WHEN r.name IN ('green-checkpoint', 'release-trigger', 'pr-poll') THEN 'release'
          WHEN r.name IN (
            'cargo-test', 'hive-canary', 'idle-session-reaper', 'hetzner-orphan-frame-reaper',
            'session-dir-gc', 'telemetry-retention', 'token-weekly-report',
            'interactive-usage-ingest', 'p2p-perf-tier1', 'p2p-perf-tier2',
            'improvement-watchdog', 'claim-integrity-sweep'
          ) THEN 'health'
          WHEN r.name IN (
            'coord-invariant-monitor', 'coord-probe-canary', 'claim-discipline-watch',
            'autonomy-trust-scan', 'hive-wake', 'pot-wake', 'wake-brain', 'overwatch-wake',
            'unclaimed-work-digest', 'cross-hive-outbox-drain'
          ) THEN 'supervision'
          WHEN r.name LIKE 'bp-singleton-%' OR r.name IN (
            'gym-cycle', 'scout-cycle', 'template-gym', 'pot-eval-battery',
            'improvement-implement', 'improvement-triage', 'improvement-human-digest',
            'oddsmith-ingest-cadence', 'oddsmith-prospector-cadence', 'scan'
          ) THEN 'self-improvement'
          ELSE NULL
        END
   );
