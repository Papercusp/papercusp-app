-- 541-predicate-watches.sql
-- fleet-deltas-leader-primitives-2026-07-10 P-008: engine-side PREDICATE WATCHES.
--
-- "Wake me when <tool result crosses a threshold>" without an emitter: the
-- await engine polls a READ-ONLY tool every interval_sec UNDER THE REGISTRANT'S
-- ROLE ENVELOPE (role gate enforced at every poll; audited via the normal
-- dispatch pipeline), extracts `path` from the result, compares with `op`
-- against `value`, and on a false→true edge fires the paired one-shot/standing
-- await row (event_awaits, key = event_key 'predicate:<id>') through
-- emitAwaitedEvent — floors, coalescing, once semantics and timeouts all reuse
-- the existing wake machinery. Kills the polling-vigil pattern (a leader
-- burning wake turns re-reading a watermark).
--
-- Rows self-garbage-collect: the poller deactivates any row whose event_key no
-- longer has an active event_awaits registration (cancelled / timed out /
-- consumed), so events:cancel needs no coupling to this table.
--
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS harness_shared.predicate_watches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text NOT NULL DEFAULT 'default',
  owner_id text NOT NULL,
  -- The registrant's role — every poll dispatches with THIS role and the role
  -- gate enforced (the "caller role envelope"); never a system bypass.
  role text NOT NULL DEFAULT 'su',
  harness_slug text,
  -- The synthetic await key the paired event_awaits row(s) watch: 'predicate:<id>'.
  event_key text NOT NULL,
  tool text NOT NULL,
  args jsonb NOT NULL DEFAULT '{}'::jsonb,
  path text NOT NULL,
  op text NOT NULL CHECK (op IN ('eq','ne','gt','gte','lt','lte','exists','contains')),
  value jsonb,
  interval_sec integer NOT NULL DEFAULT 60 CHECK (interval_sec >= 5),
  -- once=true: deactivate after the first fire (a readiness grant).
  -- once=false: standing, edge-triggered — re-fires on each false→true cross.
  once boolean NOT NULL DEFAULT true,
  last_eval boolean,
  last_value jsonb,
  last_polled_at timestamptz,
  last_error text,
  consecutive_errors integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS predicate_watches_due
  ON harness_shared.predicate_watches (workspace_id, last_polled_at)
  WHERE active;

CREATE INDEX IF NOT EXISTS predicate_watches_event_key
  ON harness_shared.predicate_watches (event_key)
  WHERE active;
