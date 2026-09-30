-- 232-steering-churn.sql
--
-- Steering-churn telemetry (hive-network-surface-2026-06-11 P-010 / Brief B-12;
-- D-004). The TRIPWIRE for multi-Queen LWW steering thrash.
--
-- Concurrent steering today is unarbitrated last-write-wins on
-- harness_features_consolidated.feature_order (the Queen's steer-don't-dispatch
-- lever; see work-items.ts setWorkItemPriority). It is safe at N=1 (one Queen
-- trivially "wins" every write) but open to ping-pong/thrash the day a 2nd Swarm
-- deploys — two Queens re-steering the same backlog item against each other.
-- D-004 ratified the FIX as a single-steerer lease (P-011), hardware-gated on a
-- 2nd Swarm existing; THIS is the EVIDENCE that gates that build: it ships now so
-- "zero churn at N=1" is proven from data, not assumed, and a real 2-Swarm churn
-- signal triggers the lease build (D-004 revisit condition a) — or a sustained
-- zero closes P-011 unbuilt (condition b).
--
-- WRITE-PATH INSTRUMENTATION (this migration): an AFTER INSERT/UPDATE row trigger
-- on harness_features_consolidated appends one ledger row per actual feature_order
-- change, deriving the WRITER IDENTITY — the unit of "a different Queen" — from
-- the federation provenance columns the row already carries:
--   • origin='local'  → writer '__local__'  — a local steer (setWorkItemPriority).
--                       Migration 214's BEFORE trigger guarantees origin is reset
--                       to 'local' on any local CONTENT write, so a local steer is
--                       always tagged local even when the row was last federated.
--   • origin='remote' → writer = author_pubkey — a federated steer from another
--                       Swarm's Queen, applied via the harness-features projection
--                       (which stamps origin='remote' + the remote author_pubkey).
-- One DB chokepoint therefore captures BOTH steer paths (local + federated) — and
-- any direct SQL — without threading a device identity through the app layer.
--
-- The detector + debounced coord:escalate live in TS (steering-churn.ts): the
-- ledger is the COUNTER; "the same item re-steered by DIFFERENT writers within a
-- window" is a writer-flip count over the recent window; escalation above a
-- threshold is gated by steering_churn_escalations (one alert per item per
-- cooldown) so a thrashing item alerts once, not on every flip.
--
-- Append-only ledger; ~0 rows at N=1 (every steer is local → one writer → no
-- churn). Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe.

-- ── The steer ledger ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.steering_churn_events (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id   text NOT NULL,
    harness_slug   text NOT NULL,
    feature_id     text NOT NULL,
    -- The steering writer == the unit of "a different Queen": '__local__' for a
    -- local steer, else the remote author_pubkey (raw-32-byte base64).
    writer         text NOT NULL,
    -- The feature_order this steer wrote (NULL = a clear / de-prioritize).
    feature_order  bigint,
    -- epoch-ms of the steer — the federation LWW clock (fed_ts) when present, else
    -- the wall clock at trigger time. Same unit as the federation op wire ts.
    ts             bigint NOT NULL
);

-- Primary read path: the recent window for one (workspace, harness, feature),
-- newest first (the detector's per-item scan).
CREATE INDEX IF NOT EXISTS steering_churn_events_item_idx
    ON harness_shared.steering_churn_events (workspace_id, harness_slug, feature_id, ts DESC);
-- The periodic sweep's cross-item scan: every steer in a recent window.
CREATE INDEX IF NOT EXISTS steering_churn_events_ws_ts_idx
    ON harness_shared.steering_churn_events (workspace_id, ts DESC);

-- ── Escalation debounce (one alert per item per cooldown) ────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.steering_churn_escalations (
    workspace_id      text NOT NULL,
    harness_slug      text NOT NULL,
    feature_id        text NOT NULL,
    last_escalated_ts bigint NOT NULL,
    -- The writer-flip count carried in the most-recent escalation (telemetry/debug).
    churn_count       integer NOT NULL DEFAULT 0,
    CONSTRAINT steering_churn_escalations_pkey PRIMARY KEY (workspace_id, harness_slug, feature_id)
);

-- ── The write-path instrumentation ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION harness_shared.record_steering_churn() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
DECLARE
  v_writer text;
  v_ts bigint;
BEGIN
  -- Only an actual feature_order CHANGE is a steer. UPDATE: the column moved
  -- (set / re-order / clear). INSERT: a non-NULL initial priority (a null-order
  -- insert is an un-prioritized item, not a steer).
  IF TG_OP = 'UPDATE' THEN
    IF NEW.feature_order IS NOT DISTINCT FROM OLD.feature_order THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.feature_order IS NULL THEN
    RETURN NEW;
  END IF;

  -- Writer identity from the federation provenance (migration 214 keeps these
  -- honest): a local content write carries origin='local'; a projection apply
  -- carries origin='remote' + the remote author_pubkey.
  IF COALESCE(NEW.origin, 'local') = 'local' THEN
    v_writer := '__local__';
  ELSE
    v_writer := COALESCE(NEW.author_pubkey, '__remote_unknown__');
  END IF;

  v_ts := COALESCE(NEW.fed_ts, (extract(epoch FROM clock_timestamp()) * 1000)::bigint);

  INSERT INTO harness_shared.steering_churn_events
    (workspace_id, harness_slug, feature_id, writer, feature_order, ts)
  VALUES
    (COALESCE(NEW.workspace_id, 'default'), NEW.harness_slug, NEW.feature_id,
     v_writer, NEW.feature_order, v_ts);

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS record_steering_churn_trg ON harness_shared.harness_features_consolidated;
CREATE TRIGGER record_steering_churn_trg
    AFTER INSERT OR UPDATE ON harness_shared.harness_features_consolidated
    FOR EACH ROW EXECUTE FUNCTION harness_shared.record_steering_churn();

-- ── Workspace isolation (mirrors watchdog_ticks, mig 202) ────────────────────
-- The operator connects as a superuser role (harness_admin) which BYPASSES RLS;
-- the policy keeps any non-superuser app path workspace-scoped and consistent
-- with the rest of harness_shared. The trigger above runs SECURITY INVOKER, so
-- in production the bypassing operator role does the ledger INSERT.
ALTER TABLE harness_shared.steering_churn_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steering_churn_events_workspace_isolation ON harness_shared.steering_churn_events;
CREATE POLICY steering_churn_events_workspace_isolation ON harness_shared.steering_churn_events
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

ALTER TABLE harness_shared.steering_churn_escalations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS steering_churn_escalations_workspace_isolation ON harness_shared.steering_churn_escalations;
CREATE POLICY steering_churn_escalations_workspace_isolation ON harness_shared.steering_churn_escalations
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- Runtime-role grants (the app/read paths run under harness_app / harness_zero).
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.steering_churn_events TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.steering_churn_escalations TO harness_app;
GRANT SELECT ON harness_shared.steering_churn_events TO harness_zero;
GRANT SELECT ON harness_shared.steering_churn_escalations TO harness_zero;
