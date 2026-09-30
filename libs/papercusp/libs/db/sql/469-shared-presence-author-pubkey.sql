-- 469-shared-presence-author-pubkey.sql — federation-release-hardening-relaunch-2026-07-01 P-015.
--
-- D-013 author-scope fix for presence leave-tombstones (EI-469).
--
-- shared_presence.deleteFromPg author-scopes a tombstone so a member can only
-- tombstone its OWN presence rows (never evict a peer's — the de-presence DoS
-- that breaks lock-authority election). The guard previously compared the del's
-- provenance author against `device_pubkey`. That only holds on the GOSSIP
-- transport, where the caller passes the SIGNER device pubkey as the provenance
-- author. On the HYPERBEE LOG transport (today's live path — the PRESENCE_GOSSIP
-- writer is still dark) resolveOpProvenance supplies the LOG-SOURCE key
-- (sourceLogKeyHex, hex) as the author — a categorically different identifier
-- from device_pubkey (base64 Ed25519 device key) — so the guard NEVER matched
-- and legit leave-tombstones silently failed to delete the leaver's row.
--
-- Fix (mirrors the proven coord_event_log author_pubkey pattern): store the
-- writer's provenance author on each presence row and scope the tombstone delete
-- by THAT column. Each transport writes AND deletes with its own consistent
-- author identity (gossip → device key on both put+del; log → source-log key on
-- both), so a legit self-tombstone matches and a peer's forged del never does —
-- the D-013 security property now holds on BOTH transports.
--
-- Additive + nullable: pre-migration rows carry NULL author_pubkey and are
-- re-stamped on their next ~30s presence re-announce (D-007 keep-alive); the TTL
-- reaper removes stale rows regardless. Idempotent. NO top-level BEGIN/COMMIT —
-- the migration-runner wraps every file in its own transaction + ledger INSERT
-- (an inner COMMIT would break that atomicity; lint:migrations enforces this).

ALTER TABLE harness_shared.shared_presence
    ADD COLUMN IF NOT EXISTS author_pubkey text;

COMMENT ON COLUMN harness_shared.shared_presence.author_pubkey IS
    'D-013 author-scope: the row writer''s unforgeable provenance author — the log-source key (sourceLogKeyHex) on the hyperbee-log transport, or the signer device pubkey on the presence-gossip transport. deleteFromPg scopes a leave-tombstone to this column so a member can only tombstone its own presence rows.';
