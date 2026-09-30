-- 212-hive-watchdog-fires.sql
--
-- start-hive-wake-orchestration-2026-06-09 (P-012 / D-003 / D-004): the
-- append-only record of HIVE LIVENESS-WATCHDOG fallback fires.
--
-- The watchdog (packages/operator-core/lib/hive/watchdog.ts) is a deterministic
-- dead-man's switch: when a started hive has demand queued but NO wake armed
-- (the Queen forgot to declare before ending her turn, or the host died
-- mid-turn), it arms a FALLBACK sleep wake. Every such fire is recorded here
-- with its reason + source seam, because frequent fires are a Queen
-- prompt-loop BUG to fix, not a mechanism to lean on (D-004) — the
-- "watchdog fired N times" signal needs a queryable home.
--
-- NOTE: this is deliberately NOT harness_shared.watchdog_ticks (mig 202) —
-- that table's schema is specific to the self-improvement COLLECTOR watchdog
-- (signals/captured/collectors). The plan's P-012 named it as the home on the
-- assumption it was generic; it is not, so the hive liveness watchdog gets its
-- own lean table rather than stuffing reasons into a collectors jsonb.
--
-- Append-only, very low volume (a fire indicates a bug; the healthy rate is
-- zero). Control-plane state → harness_shared, workspace-scoped, mirroring
-- watchdog_ticks (202).
--
-- Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.hive_watchdog_fires (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id  text NOT NULL,
    -- The hive's home-harness slug the fallback wake was armed for.
    install_slug  text NOT NULL,
    fired_at      timestamptz NOT NULL DEFAULT now(),
    -- Which seam fired: 'turn-end' (the Queen's turn ended with no wake armed),
    -- 'boot' (crash recovery — a started hive woke up unarmed), or
    -- 'tick' (the routinesTick sweep found started+demand+unarmed+stale).
    source        text NOT NULL,
    -- Human-readable why (the self-announcing kickoff's first line).
    reason        text NOT NULL DEFAULT '',
    -- When the armed fallback wake fires (null when arming itself failed).
    wake_at       timestamptz,
    -- The demand snapshot that justified the fire (e.g. {"todoItems":3,"startedPlans":1}).
    demand        jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Primary read path: recent fires per workspace/hive, newest first (the
-- "fired N times lately" signal in hive:status).
CREATE INDEX IF NOT EXISTS hive_watchdog_fires_ws_install_fired_idx
    ON harness_shared.hive_watchdog_fires (workspace_id, install_slug, fired_at DESC);

-- Workspace isolation, mirroring watchdog_ticks (202). The operator connects as
-- a superuser role (harness_admin) which bypasses RLS; the policy keeps any
-- non-superuser path workspace-scoped.
ALTER TABLE harness_shared.hive_watchdog_fires ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hive_watchdog_fires_workspace_isolation ON harness_shared.hive_watchdog_fires;
CREATE POLICY hive_watchdog_fires_workspace_isolation ON harness_shared.hive_watchdog_fires
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.hive_watchdog_fires TO harness_app;
GRANT SELECT ON harness_shared.hive_watchdog_fires TO harness_zero;
