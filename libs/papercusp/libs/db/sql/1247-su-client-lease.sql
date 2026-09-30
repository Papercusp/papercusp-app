-- pui-chat-first-ux-2026-09-28 P-009 (WI-10004114): a PUI chat's engine must
-- not outlive its client unattended.
--
-- The lease is DURABLE because an attached engine lives in ONE operator worker
-- while its client's event stream can be served by ANY worker of a clustered
-- host (WI-10003879). Every worker holding an open su-session event stream
-- renews su_client_lease_until; the worker that owns the engine ends it once the
-- lease lapses, unless the owner detached the session on purpose.
--
-- Expand-only: two nullable columns, no rewrite, nothing the deployed release
-- reads.

ALTER TABLE harness_shared.adv_sessions
  ADD COLUMN IF NOT EXISTS su_client_lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS su_client_detached_at timestamptz;

COMMENT ON COLUMN harness_shared.adv_sessions.su_client_lease_until IS
  'PUI attached engines only: the time until which a client is known to be watching this session. Renewed by every operator worker serving an open su-session event stream; the owning worker ends the engine when it lapses (P-009). NULL = no lease has been granted yet.';
COMMENT ON COLUMN harness_shared.adv_sessions.su_client_detached_at IS
  'Set when the owner detached the session (pui /detach) so it keeps running with no client attached; cleared when a client attaches again. While set, an expired su_client_lease_until does not end the engine.';
