-- 1359: data_sources.status gains 'reconnect_required'.
--
-- generalized-integrations-google-migration-cupboard-workflows-2026-10-05,
-- P-003 (WI-10006067). When a stored OAuth grant is revoked or its refresh
-- token is gone, the connection lifecycle moves every source on that
-- credential to 'reconnect_required': sync stops, source ids, cursors and
-- synced data are kept, and only the owner can restore it by reconnecting
-- (which upserts the rows back to 'connected'). 'error' was not reused because
-- the sync selector retries some 'error' rows; a revoked grant must not retry.
--
-- Expand-only: the allowed set is a strict superset of the previous one.
-- FORWARD-COMPAT: the deployed release never writes 'reconnect_required' and every value it does write stays allowed, so dropping and re-adding the CHECK with a wider set cannot break it.

ALTER TABLE harness_shared.data_sources
  DROP CONSTRAINT IF EXISTS data_sources_status_check;

ALTER TABLE harness_shared.data_sources
  ADD CONSTRAINT data_sources_status_check CHECK (
    status = ANY (ARRAY[
      'unconfigured'::text,
      'ready'::text,
      'connecting'::text,
      'connected'::text,
      'degraded'::text,
      'error'::text,
      'disabled'::text,
      'reconnect_required'::text
    ])
  );
