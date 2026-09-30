-- 624-gateway-stall-events.sql
--
-- gateway-rate-limit-stall-autowake durability follow-up (EI-2431): the
-- inference-gateway's rate-limit STALL ring buffer (`recentStalls` in
-- gateway.ts) is GATEWAY-PROCESS memory only. If the gateway restarts in the
-- ~20s window between recordStall() and the stall-waker's next
-- GET /admin/stalls poll, the stall candidate is silently lost and the
-- stalled bee is never auto-woken. This table gives recordStall() a durable
-- write-through target (best-effort, fire-and-forget — a DB outage must
-- never slow/break the gateway's request-serving hot path) so the
-- stall-waker can recover a just-recorded stall directly from PG even
-- across a gateway restart, independent of the in-memory HTTP contract.
--
-- ONE ROW PER RECORDED STALL (append-only, short-lived) — not an upsert
-- ledger. `recorded_at_ms` mirrors the in-memory StallEvent.at (epoch ms) so
-- the two sources compare/merge directly. Global (no workspace filter on
-- read) mirroring the existing unscoped GET /admin/stalls contract — the
-- gateway is one process serving bees across every workspace; `workspace_id`
-- is stored for observability only. Pruned opportunistically on insert
-- (mirrors the in-memory ring's own age-based prune) — no separate reaper.
--
-- Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.gateway_stall_events (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id      text NOT NULL,
    owner_id          text NOT NULL,
    account_id        text NOT NULL,
    soonest_reset_at  bigint NOT NULL,
    recorded_at_ms    bigint NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);

-- Primary read path: "everything since watermark X" (the stall-waker's
-- fetchStalls), globally across workspaces — no workspace_id predicate.
CREATE INDEX IF NOT EXISTS gateway_stall_events_recorded_at_idx
    ON harness_shared.gateway_stall_events (recorded_at_ms);

DO $$ BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class
           WHERE oid = 'harness_shared.gateway_stall_events'::regclass) THEN
    ALTER TABLE harness_shared.gateway_stall_events ENABLE ROW LEVEL SECURITY;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'harness_shared'
                  AND tablename = 'gateway_stall_events'
                  AND policyname = 'gateway_stall_events_workspace_isolation') THEN
    CREATE POLICY gateway_stall_events_workspace_isolation
        ON harness_shared.gateway_stall_events
        USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
        WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
  END IF;
  IF NOT has_table_privilege('harness_app', 'harness_shared.gateway_stall_events', 'INSERT') THEN
    GRANT SELECT, INSERT, DELETE ON harness_shared.gateway_stall_events TO harness_app;
  END IF;
  IF NOT has_table_privilege('harness_zero', 'harness_shared.gateway_stall_events', 'SELECT') THEN
    GRANT SELECT ON harness_shared.gateway_stall_events TO harness_zero;
  END IF;
END $$;
