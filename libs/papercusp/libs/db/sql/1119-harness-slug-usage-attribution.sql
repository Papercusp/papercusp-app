-- 1119: resolve harness_slug at usage-sample INSERT time (WI-2144763).
--
-- MEASURED PROBLEM (papercusp-workspace, 2026-09-05): of 78,739 agent_usage_samples
-- rows, 70,012 (88.9%) carry harness_slug IS NULL and render as '(unattributed)':
--
--   source        rows     with_harness
--   interactive  51,784              0   (0.0%)
--   headers      18,228              0   (0.0%)
--   jsonl         8,727          8,726   (100.0%)
--
-- The jsonl writer (usage-sample-pg.ts) is the working control: the column and the
-- read path are fine, so this is a WRITER gap, not a schema gap. The two blind
-- writers need DIFFERENT fixes and this migration serves the first of them:
--   * interactive (ingest-claude-transcripts.ts) omits harness_slug from its INSERT
--     column list entirely -> this function supplies the value.
--   * headers (agent-usage-telemetry.ts) already HAS the column wired and passes
--     sample.harnessSlug; its gap is upstream callers never setting it, which is a
--     TypeScript-side fix and needs nothing from this migration.
--
-- WHY OWNER-FIRST. adv_sessions has no harness_slug column at all, so the obvious
-- "join the session" route cannot answer this question. The interactive ingester
-- sweeps per-session isolation roots shaped
-- ~/.papercusp/session-claude/<coord-owner-id>/projects/**, so the coord owner id is
-- already in the adapter's own root path and needs no join. Measured resolver
-- coverage: session_briefs holds 10,108 of 12,114 distinct owners (83.4%) with a
-- non-null harness_slug, versus 7.8% for the session_id route the sample already
-- carries. Owner is therefore the primary key and the session route is the fallback
-- for adapters whose root carries no owner (the global, non-isolation roots).
--
-- Like 881, this keeps the precedence in ONE database-side primitive so the usage
-- sample producers cannot drift apart, and deliberately does NOT workspace-filter
-- adv_sessions: native session ids and coord owner ids are global, and a
-- carry-respawn chain can retain rows under more than one workspace label.
--
-- Additive only (CREATE OR REPLACE + a partial index): no destructive DDL, so the
-- currently-deployed release keeps working unchanged and no FORWARD-COMPAT
-- acknowledgment is required.

CREATE OR REPLACE FUNCTION harness_shared.harness_slug_for_usage_attribution(
  p_workspace_id text,
  p_owner_id text,
  p_session_id text
) RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    -- 1. The coord owner id lifted straight from the isolation transcript path.
    --    No join to adv_sessions, which is what makes this the high-yield route.
    (
      SELECT b.harness_slug
        FROM harness_shared.session_briefs b
       WHERE b.owner_id = p_owner_id
         AND b.workspace_id = p_workspace_id
         AND b.harness_slug IS NOT NULL
       ORDER BY b.updated_at DESC
       LIMIT 1
    ),
    -- 2. Fallback for adapters whose root carries no owner (global roots): go
    --    through the native session to its coord owner, then the same brief.
    (
      SELECT b.harness_slug
        FROM harness_shared.adv_sessions a
        JOIN harness_shared.session_briefs b
          ON b.owner_id = a.coord_owner_id
         AND b.workspace_id = p_workspace_id
       WHERE a.session_id = p_session_id
         AND b.harness_slug IS NOT NULL
       ORDER BY b.updated_at DESC
       LIMIT 1
    )
  )
$$;

COMMENT ON FUNCTION harness_shared.harness_slug_for_usage_attribution(text, text, text) IS
  'Resolve write-time harness provenance for a usage sample, preferring the coord owner id carried by the isolation transcript path (83.4% owner coverage) over the adv_sessions session route (7.8%); NULL when neither resolves (WI-2144763).';

-- NO INDEX HERE, DELIBERATELY -- but NOT for the reason first assumed, and the
-- correction matters for whoever reads this next.
--
-- 881 paired its resolver with a matching partial index and mirroring that was
-- the first thing tried. The apply failed (five lock_timeout retries exhausted,
-- 2026-09-05) and the obvious reading was "CREATE INDEX wants ACCESS EXCLUSIVE on
-- a table ~100 agents write continuously". That reading was WRONG. Removing the
-- index did not help: the very next apply failed identically. pg_locks then showed
-- the real mechanism -- ZERO relation locks on agent_usage_samples, and twelve
-- backends queued on the migration runner's own ADVISORY lock
-- (pg_advisory_lock(hashtext($1))), the oldest waiting 997s. The contention is
-- fleet-wide migration serialization, entirely unrelated to this file's contents,
-- so no rewrite of this migration could have fixed it.
--
-- The index stays out anyway, on its own independent merit: a plain CREATE INDEX
-- on a continuously-written table is a real hazard even when it is not today's
-- blocker, and it is an optimization rather than part of the correctness fix. If
-- the spend rollup later needs it, it belongs in its own migration using CREATE
-- INDEX CONCURRENTLY (which cannot run inside a transaction block, hence a
-- separate file rather than an edit here).
