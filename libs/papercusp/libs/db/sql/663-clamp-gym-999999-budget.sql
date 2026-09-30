-- Migration 663 — clamp legacy gym_autoloop_config.budget_usd = 999999 rows to NULL.
--
-- Work-item: WI-5785 (public-release cost safety audit, 2026-07-25).
--
-- WHAT WAS WRONG ----------------------------------------------------------------------
-- ~35 gym_autoloop_config rows (all currently enabled:false — dark/dormant hives, mostly
-- test/dev fixtures like hello-world-hive, xbench-su-*, quartermaster-*) carry a literal
-- budget_usd = 999999 left over from an earlier provisioning path. The CURRENT
-- provisioning code (packages/operator-core/lib/pot/provision-learning-loop.ts,
-- agent-tools/pot/_create.ts) already lays down a DARK row with budget_usd: NULL, which
-- is the SAFE state under the learning-governor rule (core.ts checkLoopVerdict): a NULL
-- budget is 'unbudgeted' and REFUSES to fire until an operator sets an explicit cap.
--
-- The 999999 legacy rows do not carry that protection. gym_autoloop's own control-plane
-- PATCH endpoint (endpoint-route/routes/gym/control.ts) only touches budget_usd when the
-- caller explicitly supplies it — so flipping one of these stale rows `enabled: true`
-- WITHOUT also setting a budget leaves the pre-existing 999999 lifetime cap in place,
-- i.e. an effectively-unlimited spend the moment the loop is armed. That is the class of
-- bug WI-5785 flagged: not live-dangerous today (enabled:false), but one un-paired toggle
-- away from it.
--
-- THE FIX -------------------------------------------------------------------------------
-- Clamp any budget_usd >= 100000 (a value no legitimate gym budget would ever carry —
-- the largest real caps in this codebase top out at DEFAULT_SCOUT_WORKSPACE_CEILING_USD
-- = $10 and the gym-loop CLI's own default of $50) back to NULL, restoring the same
-- 'unbudgeted ⇒ refuse until an operator sets a real cap' safety the current
-- provisioning path already gives every NEW hive. Idempotent (a fresh install has no
-- such rows; re-running matches zero rows the second time).

\set ON_ERROR_STOP on

UPDATE harness_shared.gym_autoloop_config
   SET budget_usd = NULL,
       updated_at = (extract(epoch FROM now()) * 1000)::bigint
 WHERE budget_usd >= 100000;
