-- 1363: record which operator worker process owns a PUI SU-session engine.
-- WI-10003879 (pui-chat-first-ux-2026-09-28 D-001 / P-023).
--
-- The operator runs several node:cluster request workers behind SO_REUSEPORT.
-- A PUI launch attaches the SU-session engine to whichever worker served it, and
-- that engine (a live child process plus its in-memory event channel) cannot be
-- shared with the other workers. PUI's follow-up snapshot, command and event
-- requests are spread over every worker, so most of them met a descriptor-only
-- host and the first message was refused "Session is not ready".
--
-- The owning worker now writes { pid, hostId, nonce, recordedAt } here when it
-- attaches an engine. Another worker on the same operator service forwards the
-- session's requests to that pid through cluster-owner-rpc. `hostId` keeps a
-- worker of a DIFFERENT operator service sharing this database (:3070 vs :3170)
-- from treating the row as its own, and `nonce` stops a recycled pid from being
-- mistaken for the original owner.
--
-- Additive and nullable: a release that does not know the column ignores it,
-- and a NULL means "owner unknown", which keeps the pre-existing local
-- (rehydrate) behaviour.

ALTER TABLE harness_shared.adv_sessions
  ADD COLUMN IF NOT EXISTS su_host_owner jsonb;

COMMENT ON COLUMN harness_shared.adv_sessions.su_host_owner IS
  'The operator worker that holds this SU session''s live engine: {pid, hostId, nonce, recordedAt}. Written when an engine attaches (launch or resume); sibling workers of the same hostId forward per-session requests to that pid. NULL = unknown, served locally.';
