-- 012_ui_control.sql
--
-- Two tables behind the agent → UI control surface.
--
-- `ui_clients` is presence: one row per open browser tab. Mirrors the
-- nuqs/URL state of that tab so agents can ask "what is the user
-- looking at right now?" without per-feature wiring. Pruned by query
-- layer using last_seen_at (rows older than 60s = stale).
--
-- `ui_intents` is the command channel. An agent inserts a row; the
-- browser tab's intent dispatcher (SSE-subscribed) picks it up, runs
-- the named handler, posts back the result. The id+status pair is a
-- one-shot queue.
--
-- See: apps/operator/docs/ui-control-plan.md

CREATE TABLE IF NOT EXISTS harness_shared.ui_clients (
  client_id     text PRIMARY KEY,
  workspace_id  text,
  url           text NOT NULL,
  title         text,
  viewport      jsonb,
  opened_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ui_clients_last_seen_idx
  ON harness_shared.ui_clients (last_seen_at DESC);

CREATE TABLE IF NOT EXISTS harness_shared.ui_intents (
  id              bigserial PRIMARY KEY,
  client_id       text NOT NULL,
  intent          text NOT NULL,
  args            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'pending',
  result          jsonb,
  error_message   text,
  requested_by    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS ui_intents_pending_idx
  ON harness_shared.ui_intents (client_id, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS ui_intents_completed_idx
  ON harness_shared.ui_intents (completed_at)
  WHERE completed_at IS NOT NULL;
