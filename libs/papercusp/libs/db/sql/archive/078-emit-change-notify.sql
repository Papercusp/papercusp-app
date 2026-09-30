-- 078: emit_change_notify — generic trigger function that emits a
-- pg_notify on every INSERT / UPDATE / DELETE of an attached table,
-- using the established `sync_invalidate` channel + payload shape.
--
-- Per papercusp-dogfood-v5 Phase 3 P-018, REVISED 2026-05-24 to
-- consolidate onto the existing notify channel rather than building
-- a parallel one:
--
--   PG (this trigger) → pg_notify('sync_invalidate', json)
--                    → LISTEN in apps/operator/lib/sync-sse.ts (existing)
--                    → /api/zero-harness/sse SSE endpoint (existing)
--                    → libs/sync SSEAdapter → useSyncQuery invalidation
--
-- Original P-018 design emitted on a new `papercusp_changes` channel
-- and proposed a new SSE endpoint /api/sync/stream. That was discovered
-- to be parallel infrastructure to `notifySyncInvalidate()` —
-- already used by 20+ writers via `apps/operator/lib/sync-sse.ts`.
-- The application-code notifier and this PG-trigger notifier serve
-- complementary purposes:
--
--   - notifySyncInvalidate() — fine-grained, intentional, called from
--     app code after a meaningful write.
--   - emit_change_notify() — coarse, automatic, fires on EVERY write
--     including raw SQL, MCP-tool direct writes, agent-direct edits.
--
-- Both emit on the SAME channel with the SAME payload shape so the
-- existing single SSE consumer serves both. The dedupe window in
-- notifySyncInvalidate handles the overlap (writes from app code
-- that ALSO fire the trigger will be dedupe'd).
--
-- Payload shape (matches sync-sse.ts SyncEvent contract):
--   {
--     "name": "<schema>.<table>.changed",   -- e.g. "harness_shared.feature_queue.changed"
--     "args": {
--       "workspace_id": "<ws_id|null>",
--       "op": "INSERT|UPDATE|DELETE"
--     }
--   }
--
-- The client subscribes to queryName patterns like "feature_queue.*"
-- and the SSE adapter invalidates queries whose name matches.
--
-- Why the `true` flag on current_setting: the GUC `papercusp.workspace_id`
-- may not be set on every write path (system-level inserts, migrations,
-- backfills). `current_setting(name, missing_ok)` with missing_ok=true
-- returns NULL instead of raising. Listeners handle a NULL workspace_id
-- by either ignoring (system inserts that don't need to invalidate
-- anything in a workspace) or fanning out (rare; broadcast to all
-- workspaces).
--
-- Idempotent (CREATE OR REPLACE FUNCTION). Named dollar-quote per
-- `feedback_named_dollar_quote_in_sql` memory rule.

CREATE OR REPLACE FUNCTION harness_shared.emit_change_notify()
RETURNS TRIGGER AS $body$
DECLARE
  payload jsonb;
  ws_id   text;
  q_name  text;
BEGIN
  ws_id := current_setting('papercusp.workspace_id', true);
  q_name := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || '.changed';

  payload := jsonb_build_object(
    'name', q_name,
    'args', jsonb_build_object(
      'workspace_id', ws_id,
      'op',           TG_OP
    )
  );

  PERFORM pg_notify('sync_invalidate', payload::text);

  -- For DELETE triggers, the legal return is OLD. For INSERT/UPDATE,
  -- return NEW. The trigger is declared AFTER so the value is unused,
  -- but PostgreSQL still requires a structurally-valid return.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$body$ LANGUAGE plpgsql;

-- Note: this migration deliberately does NOT attach the trigger to any
-- table. Attachment is per-table and lives in apps/operator/lib/
-- ensure-schema-dogfood.ts (wireDogfoodTriggers). This split makes it
-- easy to:
--   1. Add new reactive tables later (just one CREATE TRIGGER each)
--   2. Detach a noisy table without dropping the function
--   3. Review the producer surface as a list of trigger attachments
