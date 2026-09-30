-- 761-attention-notifications-audit.sql — WI-36644
--
-- WHAT IS WRONG
--
--   notifyAttention() (packages/operator-core/lib/attention-notify.ts) is the single "ping the
--   human now" delivery path — ~35 call sites across watchdogs/guards/routines. It fires two
--   fire-and-forget pushes (mobile APNs/FCM, desktop SSE) and persists NOTHING: no intent
--   record, no per-channel outcome, no delivery receipt. Both channels are also silently
--   no-op-safe by design (no paired mobile device, no open desktop webview), so "the call
--   happened" is not evidence "the human was told".
--
--   Concretely: when stalled-loops-guard permanently disarms a live agent's loop, it calls
--   notifyAttention as the OWNER-facing rail (the fleet-wide broadcast is a DIFFERENT, agent-only
--   audience). On 2026-08-08 that rail fired into a push-target set that was 3+ weeks stale
--   (newest mobile_devices.last_seen '07-19', newest token '07-17') and nobody — including the
--   agent that raised it — could determine after the fact whether the owner was ever notified.
--   ~55 minutes later the owner discovered the disarm by hand.
--
-- THE FIX (this migration is the durable-record half; see attention-notify.ts for the write path)
--
--   One row per notifyAttention() call, written UNCONDITIONALLY before either channel is
--   attempted, then updated with each channel's outcome. Turns "was the human ever told?" from
--   unanswerable into a query: `SELECT * FROM attention_notifications WHERE created_at > ...`.
--
--   Workspace-owned (not slug-shared): this is operator-instance telemetry about THIS box's own
--   delivery attempts, never federated — see table-registry.ts WORKSPACE_OWNED_EXPLICIT.
--
-- FORWARD-COMPAT: purely additive (new table, no DROP/RENAME/SET NOT NULL on existing objects) —
-- safe under the two-port model regardless of which release checkout is currently serving :3070.

CREATE TABLE IF NOT EXISTS harness_shared.attention_notifications (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id text NOT NULL DEFAULT '',
    harness_slug text,
    kind text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    importance text,
    data jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    mobile_attempted boolean NOT NULL DEFAULT false,
    mobile_succeeded boolean,
    mobile_error text,
    mobile_completed_at timestamptz,
    desktop_attempted boolean NOT NULL DEFAULT false,
    desktop_succeeded boolean,
    desktop_error text,
    desktop_completed_at timestamptz
);

ALTER TABLE harness_shared.attention_notifications ADD COLUMN IF NOT EXISTS workspace_id text DEFAULT '';
ALTER TABLE harness_shared.attention_notifications ADD COLUMN IF NOT EXISTS harness_slug text;
ALTER TABLE harness_shared.attention_notifications ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE harness_shared.attention_notifications ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE harness_shared.attention_notifications ADD COLUMN IF NOT EXISTS body text;
ALTER TABLE harness_shared.attention_notifications ADD COLUMN IF NOT EXISTS importance text;
ALTER TABLE harness_shared.attention_notifications ADD COLUMN IF NOT EXISTS data jsonb;
ALTER TABLE harness_shared.attention_notifications ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE harness_shared.attention_notifications ADD COLUMN IF NOT EXISTS mobile_attempted boolean DEFAULT false;
ALTER TABLE harness_shared.attention_notifications ADD COLUMN IF NOT EXISTS mobile_succeeded boolean;
ALTER TABLE harness_shared.attention_notifications ADD COLUMN IF NOT EXISTS mobile_error text;
ALTER TABLE harness_shared.attention_notifications ADD COLUMN IF NOT EXISTS mobile_completed_at timestamptz;
ALTER TABLE harness_shared.attention_notifications ADD COLUMN IF NOT EXISTS desktop_attempted boolean DEFAULT false;
ALTER TABLE harness_shared.attention_notifications ADD COLUMN IF NOT EXISTS desktop_succeeded boolean;
ALTER TABLE harness_shared.attention_notifications ADD COLUMN IF NOT EXISTS desktop_error text;
ALTER TABLE harness_shared.attention_notifications ADD COLUMN IF NOT EXISTS desktop_completed_at timestamptz;

CREATE INDEX IF NOT EXISTS attention_notifications_workspace_created_idx
    ON harness_shared.attention_notifications (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS attention_notifications_kind_idx
    ON harness_shared.attention_notifications (kind, created_at DESC);
