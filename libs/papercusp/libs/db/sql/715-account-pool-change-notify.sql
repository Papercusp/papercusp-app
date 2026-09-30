-- 715-account-pool-change-notify.sql — WI-6796.
--
-- Attach the generic harness_shared.emit_change_notify trigger to
-- harness_shared.operator_account_pool, closing the last leg of the "Accounts
-- tab stopped updating" fix.
--
-- WHY. `accounts.pool` (sync-resolver/index.ts) resolves accountStatus() straight
-- off this table, and the AccountsTab + the /adv Overview Spend tile subscribe to
-- it. The table is rewritten continuously by the inference gateway's window
-- projector (inference-gateway/launch.ts makeWindowProjector -> recordAccountWindow)
-- as it observes each upstream response's anthropic-ratelimit-unified-* headers —
-- the gateway is the ONLY process that sees those headers, so that stream IS the
-- tab's live data. Yet the table was mapped nowhere: not in OPERATOR_STATE_SYNC_NAMES,
-- not in TABLE_TO_QUERY_NAMES, and with no row trigger. So every usage write landed
-- in PG silently and a left-open tab never learned the numbers had moved; it
-- refreshed only on the handful of explicit notifySyncInvalidate('accounts.pool')
-- action callsites (register / remove / reset-rate / session-override /
-- probe-capacity) or on remount. Its SIBLING operator_account_override (mig-297) has
-- had both the mapping and the trigger since mig-636 — only the pool was missed.
--
-- WHY A TRIGGER AS WELL AS THE APP-CODE MAP. The app-code path added in the same
-- change (OPERATOR_STATE_SYNC_NAMES -> notifyOperatorStateSync -> notifySyncInvalidate
-- -> pg_notify) already crosses the process boundary, which is what the out-of-process
-- gateway writer needs. This trigger is the same defence-in-depth mig-636 applied to
-- the other mapped tables: it also covers a RAW-SQL or FEDERATED write that never runs
-- through writeOperatorState (D-005). TABLE_TO_QUERY_NAMES bridges the emitted
-- `harness_shared.operator_account_pool.changed` onto the camelCase `accounts.pool`
-- the client subscribes to.
--
-- NOT A NOTIFY-STORM RISK (the mig-636 / mig-373 judgment, per-table):
--   * Single-row-per-WORKSPACE state table, not an append log — 3 live rows total,
--     and the row count is bounded by workspace count forever.
--   * The dominant writer is already self-throttled: the window projector writes at
--     most once per 30s per account AND only on a meaningful move (>=0.03 utilization
--     or a window-reset roll).
--   * The invalidation bus dedupes identical (name, args) within its 90s window, and
--     this is a bare-string (full-bust, no-args) mapping, so a burst collapses to one
--     client-visible invalidation.
-- This is the opposite profile from the COVERAGE_EXEMPT append-heavy logs
-- (audit_log, agent_usage_samples, ...), which is why it gets the trigger rather
-- than an exemption.
--
-- Idempotent (CREATE OR REPLACE TRIGGER; existence-guarded); additive; re-runnable;
-- fresh-migrate-safe. Mirrors mig-636's shape exactly.

DO $$
BEGIN
  -- Only attach where the table actually exists AND is a real table (relkind 'r') —
  -- defensive, exactly as mig-636: a fresh/partial DB may not have every satellite
  -- table yet, and a view cannot carry a row trigger.
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'harness_shared'
      AND c.relname = 'operator_account_pool'
      AND c.relkind = 'r'
  ) THEN
    CREATE OR REPLACE TRIGGER emit_change_notify_trg
      AFTER INSERT OR UPDATE OR DELETE ON harness_shared.operator_account_pool
      FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
  END IF;
END $$;
