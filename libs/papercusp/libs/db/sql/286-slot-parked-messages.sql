-- Migration 286 — slot-parked coord messages (park-for-slot addressing, B2).
--
-- Plan: directed-wake-honesty-and-spawn-handoff-2026-06-14 (Phase 2 / P-025; D-005).
--
-- B2 lets a coord message be addressed to a SLOT that has no agent yet — a role,
-- a wave-lane, or a feature — via `@role:`/`@wave:`/`@feature:` selectors on
-- coord:send's `to[]`. Unlike the @plan/@topic/@object audience selectors
-- (migration 123 / audience.ts) which resolve to LIVE ownerIds and deliver now, a
-- slot target is PARKED here durably and DRAINED into the handoff brief of
-- whichever agent later spawns into that slot (deliver-on-spawn, P-023). This is
-- the first-class answer to "address an agent that doesn't exist yet" (D-005).
--
-- A parked row is claimed EXACTLY ONCE (delivered_ts is flipped under the drain
-- UPDATE … RETURNING) or dropped VISIBLY on TTL expiry (dropped_ts +
-- dropped_reason) — never silently lost, mirroring the await-event delivery
-- ladder.
CREATE TABLE IF NOT EXISTS harness_shared.slot_parked_messages (
  id              TEXT NOT NULL,               -- coord msg_id (newMsgId)
  workspace_id    TEXT NOT NULL,
  -- The slot the message is addressed to. (slot_kind, slot_ref) is the drain key.
  slot_kind       TEXT NOT NULL,               -- 'role' | 'wave' | 'feature'
  slot_ref        TEXT NOT NULL,               -- role name / wave id / feature id
  -- Harness scope; a role/wave/feature slot is per-harness. NULL = workspace-level.
  harness_slug    TEXT,
  from_owner      TEXT NOT NULL,               -- authoring ownerId
  -- The full coord envelope (summary/body/files/plan_slug/…), stored verbatim so
  -- drain reconstructs a normal inbox message with `to` rewritten to the spawnee.
  envelope        JSONB NOT NULL,
  created_ts      BIGINT NOT NULL,             -- epoch ms
  ttl_ms          BIGINT,                      -- NULL = never expires
  -- Terminal markers — at most one set once the row is consumed.
  delivered_ts    BIGINT,                      -- epoch ms; NULL until drained
  delivered_to    TEXT,                        -- spawnee ownerId it was drained to
  dropped_ts      BIGINT,                      -- epoch ms; NULL unless expired/cancelled
  dropped_reason  TEXT,                        -- e.g. 'ttl-expired'
  PRIMARY KEY (workspace_id, id)
);

-- Drain hot-path: "pending messages for this (workspace, harness, slot)". Partial
-- — only un-consumed rows — so the index stays small as delivered/dropped history
-- accumulates.
CREATE INDEX IF NOT EXISTS slot_parked_messages_pending_idx
  ON harness_shared.slot_parked_messages (workspace_id, harness_slug, slot_kind, slot_ref)
  WHERE delivered_ts IS NULL AND dropped_ts IS NULL;

GRANT SELECT, INSERT, UPDATE ON harness_shared.slot_parked_messages TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.slot_parked_messages TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.slot_parked_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS slot_parked_messages_workspace_isolation ON harness_shared.slot_parked_messages;
CREATE POLICY slot_parked_messages_workspace_isolation ON harness_shared.slot_parked_messages
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
