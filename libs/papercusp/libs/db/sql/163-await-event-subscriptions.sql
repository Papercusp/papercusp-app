-- 163-await-event-subscriptions.sql — await-event-primitive-2026-06-05 (P-001, D-009).
--
-- The universal subscription primitive's durable store. Two tables:
--
--   event_awaits — one row per registered await: "wake (or notify) me when
--   event_key fires". Wake awaits are ONE-SHOT by construction (fired_at set
--   atomically on fire — an await can never wake-loop, D-002). The caller's
--   session wake-handle (adv_sessions join / plan-run id) is STAMPED at
--   registration (wake_handle jsonb) because it cannot be fetched at fire time —
--   the agent is asleep (D-003). `timeout_behavior='wake'` turns expiry into a
--   synthesized `await:timeout` fire instead of a silent lapse.
--
--   event_wake_deliveries — the durable per-recipient delivery queue (D-004:
--   guaranteed-once-ish = at-least-once + idempotent wake). A delivery row is
--   created when a wake await fires and advances pending → parked (recipient
--   alive but uninjectable — wait for process exit) → delivered, or → dropped
--   (dead waiter, visibly) / dead (attempts exhausted). This table IS the wake
--   meter (D-007): per-agent attribution via subscriber_id + channel + counts.
--
-- The notify path needs no new table — it rides coord_event_log (the existing
-- durable inbox + PostToolUse injection).

CREATE TABLE IF NOT EXISTS harness_shared.event_awaits (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id     TEXT        NOT NULL DEFAULT 'default',
  subscriber_id    TEXT        NOT NULL,
  event_key        TEXT        NOT NULL,
  policy           TEXT        NOT NULL DEFAULT 'wake' CHECK (policy IN ('wake', 'notify')),
  note             TEXT,
  wake_handle      JSONB,
  timeout_behavior TEXT        NOT NULL DEFAULT 'expire' CHECK (timeout_behavior IN ('expire', 'wake')),
  expires_ts       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  fired_at         TIMESTAMPTZ,
  fired_reason     TEXT,        -- 'event' | 'timeout' (set with fired_at)
  cancelled_at     TIMESTAMPTZ
);

-- Fire-path lookup: active awaits for an event key.
CREATE INDEX IF NOT EXISTS idx_event_awaits_active_key
  ON harness_shared.event_awaits (workspace_id, event_key)
  WHERE fired_at IS NULL AND cancelled_at IS NULL;

-- events:status / cancel-by-owner lookup.
CREATE INDEX IF NOT EXISTS idx_event_awaits_subscriber
  ON harness_shared.event_awaits (subscriber_id)
  WHERE fired_at IS NULL AND cancelled_at IS NULL;

-- Timeout sweep: active awaits with a deadline.
CREATE INDEX IF NOT EXISTS idx_event_awaits_expiry
  ON harness_shared.event_awaits (expires_ts)
  WHERE fired_at IS NULL AND cancelled_at IS NULL AND expires_ts IS NOT NULL;

CREATE TABLE IF NOT EXISTS harness_shared.event_wake_deliveries (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id     TEXT        NOT NULL DEFAULT 'default',
  await_id         BIGINT      NOT NULL,
  subscriber_id    TEXT        NOT NULL,
  event_key        TEXT        NOT NULL,
  payload          JSONB,
  summary          TEXT,        -- the human wake-reason line injected as the turn
  status           TEXT        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'parked', 'delivering', 'delivered', 'dropped', 'dead')),
  channel          TEXT,        -- 'pty-inject' | 'resume' | 'resume-headless' | 'plan-run-resume' | 'inbox' (set on delivery)
  attempts         INTEGER     NOT NULL DEFAULT 0,
  last_error       TEXT,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at     TIMESTAMPTZ
);

-- Pump lookup: due deliveries.
CREATE INDEX IF NOT EXISTS idx_event_wake_deliveries_due
  ON harness_shared.event_wake_deliveries (workspace_id, next_attempt_at)
  WHERE status IN ('pending', 'parked', 'delivering');

-- Meter / events:status lookup.
CREATE INDEX IF NOT EXISTS idx_event_wake_deliveries_subscriber
  ON harness_shared.event_wake_deliveries (subscriber_id, created_at DESC);

-- The runtime app role does CRUD (curator-operator D-009 lesson: owner-only
-- grants pass every test but fail the live harness_app connection).
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.event_awaits TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.event_wake_deliveries TO harness_app;

-- harness_zero may not exist on every substrate (fresh embedded-pg) — guarded.
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.event_awaits TO harness_zero;
  GRANT SELECT ON harness_shared.event_wake_deliveries TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

-- Workspace isolation, matching the operator-state table idiom (mig 158/162).
ALTER TABLE harness_shared.event_awaits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS event_awaits_workspace_isolation ON harness_shared.event_awaits;
CREATE POLICY event_awaits_workspace_isolation ON harness_shared.event_awaits
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

ALTER TABLE harness_shared.event_wake_deliveries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS event_wake_deliveries_workspace_isolation ON harness_shared.event_wake_deliveries;
CREATE POLICY event_wake_deliveries_workspace_isolation ON harness_shared.event_wake_deliveries
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
