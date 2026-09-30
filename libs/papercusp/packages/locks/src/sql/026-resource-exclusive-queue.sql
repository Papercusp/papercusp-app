-- 026-resource-exclusive-queue.sql — durable FIFO for named-resource exclusives.
--
-- `agent_resource_waiters` is intentionally NOT this queue: it is an owner-keyed
-- notification ledger used by the resource back-up broadcast.  A repeated
-- exclusive acquire can therefore race every other retry unless its request has
-- its own durable ticket and the grant path admits only the ticket at the head.
--
-- Queue rows are requests, not leases.  `expires_ts` is the abandonment TTL for
-- the request; `ttl_sec` is the lease TTL to use once the request is granted.
-- Granting deletes the request row and emits its ticket on the same bounded
-- coordination channel used by the existing resource drain cascade.

CREATE TABLE IF NOT EXISTS agent_resource_exclusive_queue (
  ticket_id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  coordination_domain text       NOT NULL,
  resource            text       NOT NULL,
  owner               text       NOT NULL,
  owner_label         text,
  reason              text       NOT NULL DEFAULT '',
  ttl_sec             integer    NOT NULL CHECK (ttl_sec > 0),
  queued_ts           timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_ts          timestamptz NOT NULL,
  UNIQUE (coordination_domain, resource, owner)
);

CREATE INDEX IF NOT EXISTS agent_resource_exclusive_queue_active_idx
  ON agent_resource_exclusive_queue
     (coordination_domain, resource, queued_ts, ticket_id);

CREATE INDEX IF NOT EXISTS agent_resource_exclusive_queue_owner_idx
  ON agent_resource_exclusive_queue (owner);

ALTER TABLE agent_resource_exclusive_queue SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);

-- Re-create the resource cascade with FIFO queue admission.  Existing draining
-- leases still complete first.  When a resource has no live exclusive, exactly
-- one queue head is admitted: it becomes `held` when shared holders are absent,
-- otherwise `draining` so writer-priority starts immediately.  The next queued
-- request remains pending until that lease is released.
CREATE OR REPLACE FUNCTION resource_grant_cascade(
  p_coordination_domain text,
  p_now                  timestamptz
)
RETURNS void
LANGUAGE plpgsql AS $func$
DECLARE
  v_excl         record;
  v_head         record;
  v_shared_count int;
  v_new_lock     uuid;
  v_expires      timestamptz;
  v_status       text;
  v_row_count    int;
BEGIN
  -- Finish an already-admitted drain before looking at queued requests.
  FOR v_excl IN
    SELECT * FROM agent_resource_locks
     WHERE coordination_domain = p_coordination_domain
       AND mode = 'exclusive'
       AND status = 'draining'
       AND expires_ts > p_now
     ORDER BY resource, acquired_ts, owner
  LOOP
    SELECT count(*) INTO v_shared_count
      FROM agent_resource_locks
     WHERE coordination_domain = p_coordination_domain
       AND resource = v_excl.resource
       AND mode = 'shared'
       AND expires_ts > p_now;

    IF v_shared_count = 0 THEN
      UPDATE agent_resource_locks
         SET status      = 'held',
             acquired_ts = p_now,
             fence_seq   = resource_assign_fence(p_coordination_domain, v_excl.resource)
       WHERE coordination_domain = p_coordination_domain
         AND resource = v_excl.resource
         AND owner = v_excl.owner
         AND mode = 'exclusive';

      PERFORM pg_notify(coord_notify_channel(p_coordination_domain), v_excl.lock_id::text);
      -- Legacy raw-name channel for pre-013 listeners.
      PERFORM pg_notify(coord_notify_channel_legacy(p_coordination_domain), v_excl.lock_id::text);
    END IF;
  END LOOP;

  -- Pick at most one request per resource before entering the loop.  The
  -- DISTINCT ON is important: inserts below are visible to this transaction,
  -- but selecting every row up front would otherwise make later rows race the
  -- partial unique exclusive index.
  FOR v_head IN
    SELECT q.*
      FROM (
        SELECT DISTINCT ON (q.resource) q.*
          FROM agent_resource_exclusive_queue q
         WHERE q.coordination_domain = p_coordination_domain
           AND q.expires_ts > p_now
         ORDER BY q.resource, q.queued_ts ASC, q.ticket_id ASC
      ) AS q
     WHERE NOT EXISTS (
       SELECT 1
         FROM agent_resource_locks l
        WHERE l.coordination_domain = p_coordination_domain
          AND l.resource = q.resource
          AND l.mode = 'exclusive'
          AND l.expires_ts > p_now
     )
     ORDER BY q.resource
  LOOP
    -- No-upgrade is a store invariant.  A stale queue row from a caller that
    -- acquired a shared lease after queuing must not wedge every later ticket.
    IF EXISTS (
      SELECT 1
        FROM agent_resource_locks
       WHERE coordination_domain = p_coordination_domain
         AND resource = v_head.resource
         AND owner = v_head.owner
         AND mode = 'shared'
         AND expires_ts > p_now
    ) THEN
      DELETE FROM agent_resource_exclusive_queue
       WHERE ticket_id = v_head.ticket_id;
      CONTINUE;
    END IF;

    SELECT count(*) INTO v_shared_count
      FROM agent_resource_locks
     WHERE coordination_domain = p_coordination_domain
       AND resource = v_head.resource
       AND mode = 'shared'
       AND expires_ts > p_now;

    v_status  := CASE WHEN v_shared_count = 0 THEN 'held' ELSE 'draining' END;
    v_new_lock := gen_random_uuid();
    v_expires := p_now + (v_head.ttl_sec || ' seconds')::interval;

    INSERT INTO agent_resource_locks
      (coordination_domain, resource, owner, owner_label, mode, status,
       reason, lock_id, acquired_ts, expires_ts)
    VALUES
      (p_coordination_domain, v_head.resource, v_head.owner, v_head.owner_label,
       'exclusive', v_status, v_head.reason, v_new_lock, p_now, v_expires)
    ON CONFLICT DO NOTHING;

    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    IF v_row_count = 1 THEN
      DELETE FROM agent_resource_exclusive_queue
       WHERE ticket_id = v_head.ticket_id;

      -- The payload is deliberately only the ticket: listeners re-read the
      -- lock row, and the bounded NOTIFY channel cannot overflow on metadata.
      PERFORM pg_notify(coord_notify_channel(p_coordination_domain), v_head.ticket_id::text);
      -- Legacy raw-name channel for pre-013 listeners.
      PERFORM pg_notify(coord_notify_channel_legacy(p_coordination_domain), v_head.ticket_id::text);
    END IF;
  END LOOP;
END;
$func$;
