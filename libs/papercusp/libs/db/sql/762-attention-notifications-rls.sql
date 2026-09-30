-- 762-attention-notifications-rls.sql — WI-36644 follow-up
--
-- Migration 761 created harness_shared.attention_notifications but omitted the RLS policy that
-- every other workspace-owned table in this repo carries (harness_escalations, harness_registry,
-- etc.) — table-registry.ts classifies it WORKSPACE_OWNED_EXPLICIT, and attention-notify-store.ts
-- writes to it via `withWorkspace()`, but without RLS enabled that GUC is inert: the app-role
-- connection can see/write every workspace's rows, not just the one it set app.workspace_id to.
-- This is purely additive (ENABLE + CREATE POLICY, no data change, no narrowing of an existing
-- grant) — safe under the two-port model regardless of which release checkout is serving :3070.

ALTER TABLE harness_shared.attention_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attention_notifications_workspace_isolation ON harness_shared.attention_notifications;

CREATE POLICY attention_notifications_workspace_isolation ON harness_shared.attention_notifications
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
