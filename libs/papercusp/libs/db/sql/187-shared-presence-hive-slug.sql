-- 187: shared_presence.hive_slug — Hive-scoped lock authority
-- (shared-hive-federation-2026-06-08 P-009, D-011).
--
-- Lock authority (Track B) elects the lowest live device_pubkey among a scope's
-- presence rows. Pre-Hive that scope was the harness; post-Hive (D-001) presence +
-- authority are per-Swarm/per-Hive — a Swarm announces ONE presence for the Hive,
-- so the authority that serializes a Hive's file-claim locks is the lowest pubkey
-- across the Hive's live Swarms. This denorm column lets the authority query scope
-- by Hive (`WHERE hive_slug = ?`) without a registry join on the hot path; the
-- presence WRITE path populates it (harness's home Hive slug) — wired by the
-- presence-federation work (P-008). Nullable: a non-Hive harness's presence keeps
-- hive_slug NULL and stays harness-scoped (back-compat, lockAuthorityFor unchanged).
-- Idempotent.

ALTER TABLE harness_shared.shared_presence ADD COLUMN IF NOT EXISTS hive_slug text;

CREATE INDEX IF NOT EXISTS shared_presence_hive_recent_idx
  ON harness_shared.shared_presence USING btree (workspace_id, hive_slug, last_seen_at DESC);
