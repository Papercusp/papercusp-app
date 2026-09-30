-- 166: voice-realtime-tui-2026-06-05 P-002/D-004 — third voice-lease owner
-- kind 'tui' (the pui's realtime EL Conv-AI session participates in the
-- single-live-listener election alongside desktop + mobile).
--
-- The table predates the migration baseline discipline (created lazily by
-- voice-lease.ts ensureLeaseTable with an inline CHECK), so the constraint
-- name is PG's auto-generated voice_lease_owner_kind_check. Idempotent:
-- guards on table existence and re-creates the CHECK with the widened set.
DO $body$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'harness_shared' AND table_name = 'voice_lease'
  ) THEN
    ALTER TABLE harness_shared.voice_lease
      DROP CONSTRAINT IF EXISTS voice_lease_owner_kind_check;
    ALTER TABLE harness_shared.voice_lease
      ADD CONSTRAINT voice_lease_owner_kind_check
      CHECK (owner_kind IN ('desktop', 'mobile', 'tui'));
  END IF;
END
$body$;
