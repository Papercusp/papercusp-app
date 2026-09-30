-- 1190 — psu-pty host events: the Postgres tier for session -> agent-TUI delivery telemetry.
--
-- WHY THIS EXISTS (psu-pty-turn-boundary-generalization-2026-09-22, P-007 / D-006).
--
-- The psu-pty host records its own delivery outcomes with appendHostEvent(). Every one of
-- the 51 distinct event kinds in that host (enumerated from source 2026-09-22) is a failure,
-- drop, expiry, refusal, retry or lifecycle marker; none was a delivery SUCCESS. So the
-- failure side of wake delivery was fully instrumented while the denominator was absent, and
-- a delivery success RATE was not computable at all -- which in turn meant no fix to the wake
-- path could be shown to work rather than merely asserted. P-007 adds the `turn-delivered`
-- success row; this table is what makes the resulting rate queryable across sessions instead
-- of only greppable inside one file.
--
-- WHY THE HOST STILL WRITES A FILE, NOT THIS TABLE (D-006). appendHostEvent is SYNCHRONOUS and
-- fail-soft by contract ("an event-log write must never break the session"), and it is called
-- from teardown, orphan-teardown, shutdown and crash paths. A network write there needs a pool,
-- can block, and is least available exactly when the host is dying -- i.e. precisely when the
-- diagnostic row matters most. The JSONL file therefore remains the local write-ahead log and a
-- routine ingests it here. This table is the QUERYABLE tier, not the write path.
--
-- WHY NOT harness_shared.event_wake_deliveries (the reuse check, recorded so it is not redone).
-- That table exists and is live (368,338 rows when this was written) but records a DIFFERENT
-- HOP: operator -> session dispatch. This one records the NEXT hop: session -> agent TUI
-- injection. A wake can read status='delivered' there and still never reach the agent -- that
-- gap is the whole failure this plan addresses -- so the two are complementary and meant to be
-- correlated (subscriber_id = owner_id), never merged.
--
-- Purely additive DDL: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS, no destructive
-- statement, so no FORWARD-COMPAT acknowledgement is required. The currently-deployed release
-- simply does not read this relation yet.

CREATE TABLE IF NOT EXISTS harness_shared.psu_pty_host_events (
  id           bigserial PRIMARY KEY,
  workspace_id text        NOT NULL,
  owner_id     text        NOT NULL,
  ts           timestamptz NOT NULL,
  kind         text        NOT NULL,
  payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ingested_at  timestamptz NOT NULL DEFAULT now(),

  -- Ingest is re-runnable and MUST be idempotent. The source file is front-truncated in place
  -- when it exceeds EVENT_LOG_MAX_BYTES (256 KB), which rewrites the file and invalidates any
  -- byte-offset watermark, so offsets cannot be the dedupe key. A digest over the identifying
  -- tuple can be, and lets the ingester use ON CONFLICT DO NOTHING to re-read a whole file
  -- safely. Two byte-identical rows in the same millisecond collapse to one; that is accepted
  -- deliberately -- they are indistinguishable telemetry, and losing the duplicate is cheaper
  -- than the double-counting that would otherwise silently inflate the delivery rate this
  -- table exists to measure.
  row_digest   text        NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS psu_pty_host_events_digest_uk
  ON harness_shared.psu_pty_host_events (row_digest);

-- The delivery-rate read: count by kind over a time window.
CREATE INDEX IF NOT EXISTS psu_pty_host_events_kind_ts_idx
  ON harness_shared.psu_pty_host_events (kind, ts DESC);

-- The per-session forensic read ("what happened to THIS agent's wakes").
CREATE INDEX IF NOT EXISTS psu_pty_host_events_owner_ts_idx
  ON harness_shared.psu_pty_host_events (owner_id, ts DESC);

-- Retention sweeps delete by age; keep that from degrading into a seq scan as the table grows.
CREATE INDEX IF NOT EXISTS psu_pty_host_events_ts_idx
  ON harness_shared.psu_pty_host_events (ts);

COMMENT ON TABLE harness_shared.psu_pty_host_events IS
  'psu-pty host delivery telemetry (session -> agent TUI hop), ingested from the per-owner JSONL '
  'write-ahead logs by system:psu-pty-host-events-ingest. Complementary to event_wake_deliveries '
  '(operator -> session hop), not a replacement: correlate on subscriber_id = owner_id. '
  'See plan psu-pty-turn-boundary-generalization-2026-09-22 D-006.';

COMMENT ON COLUMN harness_shared.psu_pty_host_events.row_digest IS
  'sha256 over (owner_id, ts, kind, canonical payload). Dedupe key for idempotent re-ingest; a '
  'byte-offset watermark is unusable because the source file is front-truncated in place.';
