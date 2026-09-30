-- 550-event-awaits-announce-scope.sql
-- Announced gate events (fleet-member-native-guidance-2026-07-10 P-010, EI-9270).
--
-- An ANNOUNCEMENT is an emitter-side declaration — "this gate event WILL fire;
-- await this key" — stored as a policy='announce' row in the EXISTING
-- event_awaits table (no new table: event_key/note/expires_ts/fired_at/
-- cancelled_at already carry the shape; owner directive 2026-07-10 — extend,
-- don't mint a parallel surface). Announce rows never wake anyone themselves
-- (the delivery paths exclude policy='announce'); `fired_at` on an announce row
-- is the LATCH stamped by the real emit, so a late joiner registering an await
-- AFTER the gate fired is told immediately instead of sleeping forever.
--
-- scope_kind/scope_ref are the DISCOVERY scope only (who SEES the declaration in
-- events:catalog / coord:orient): 'fleet'|'plan'|'harness' + slug, or 'global'
-- (ref NULL). The rendezvous plane (await/fire key matching) stays a single flat
-- namespace on purpose — WI-3575 is load-bearing; do NOT re-scope it. Collision
-- safety comes from key auto-prefixing (fleet:<slug>:<gate>) at announce time.

ALTER TABLE harness_shared.event_awaits ADD COLUMN IF NOT EXISTS scope_kind text;
ALTER TABLE harness_shared.event_awaits ADD COLUMN IF NOT EXISTS scope_ref text;

-- The discovery read ("announcements visible to me + global, still active") and
-- the emit-time latch stamp both filter policy='announce' first — keep that tiny
-- set index-backed so neither read pays a seq scan of the whole awaits table.
CREATE INDEX IF NOT EXISTS event_awaits_announce_active
  ON harness_shared.event_awaits (workspace_id, event_key)
  WHERE policy = 'announce' AND cancelled_at IS NULL;
