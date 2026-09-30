-- SU agent file-lock coordination — grant cascade.
--
-- Called from `locks:release` inside its inWorkspaceTxn. The advisory
-- lock for the workspace is already held by the calling transaction, so
-- this function doesn't need to re-take it.
--
-- Iterates FIFO over active waiters; grants each whose full path set is
-- currently free. NOTIFY fires inside the function (atomic with the
-- grant at COMMIT time). Returns nothing — the caller doesn't need to
-- loop the result set.

CREATE OR REPLACE FUNCTION grant_cascade(
  p_coordination_domain text,
  p_now          timestamptz
)
RETURNS void
LANGUAGE plpgsql AS $func$
DECLARE
  v_waiter      record;
  v_new_lock    uuid;
  v_expires     timestamptz;
  v_held_paths  text[];
BEGIN
  -- Pull the live held-paths set once; probe in-memory per waiter.
  -- Saves N table reads inside the loop (audit 3 #1).
  SELECT COALESCE(array_agg(path), ARRAY[]::text[])
    INTO v_held_paths
    FROM agent_file_locks
   WHERE coordination_domain = p_coordination_domain
     AND expires_ts > p_now;

  FOR v_waiter IN
    SELECT w.*
      FROM agent_lock_waiters w
     WHERE w.coordination_domain = p_coordination_domain
       AND w.status = 'waiting'
       AND w.wait_until > p_now
     ORDER BY w.queued_ts ASC, w.ticket_id ASC
  LOOP
    BEGIN
      -- Conflict check via in-memory overlap.
      IF v_held_paths && v_waiter.paths THEN
        CONTINUE;
      END IF;

      v_new_lock := gen_random_uuid();
      v_expires  := p_now + (v_waiter.ttl_sec || ' seconds')::interval;

      INSERT INTO agent_file_locks
        (coordination_domain, path, owner, owner_label, intent,
         lock_id, acquired_ts, expires_ts)
      SELECT
        p_coordination_domain, p, v_waiter.owner, v_waiter.owner_label, v_waiter.intent,
        v_new_lock, p_now, v_expires
        FROM unnest(v_waiter.paths) AS p
        ON CONFLICT DO NOTHING;

      UPDATE agent_lock_waiters
         SET status              = 'granted',
             granted_lock_id     = v_new_lock,
             granted_expires_ts  = v_expires
       WHERE ticket_id = v_waiter.ticket_id;

      -- Add this waiter's now-held paths to the in-memory set so the
      -- next iteration sees them as conflicting.
      v_held_paths := v_held_paths || v_waiter.paths;

      -- NOTIFY fires at commit time, atomic with the grant. Payload is
      -- ticket_id only (36 bytes); waiters re-SELECT to read their
      -- granted_lock_id. DO NOT expand the payload — PG's 8KB NOTIFY
      -- limit will eventually bite if anyone tries to pack more.
      PERFORM pg_notify(
        'ch_coord_' || p_coordination_domain,
        v_waiter.ticket_id::text
      );
    EXCEPTION
      -- Waiter row vanished between SELECT and UPDATE (force-deleted,
      -- cancelled concurrently). Defense-in-depth — under the workspace
      -- advisory lock this should not happen.
      WHEN no_data_found THEN CONTINUE;
      -- Another grant in this same cascade beat us to a path. Defense-
      -- in-depth — the in-memory v_held_paths probe should prevent it.
      WHEN unique_violation THEN CONTINUE;
      -- Intentionally NOT catching WHEN OTHERS: real errors (syntax,
      -- assertion, permission) MUST abort the cascade.
    END;
  END LOOP;
END;
$func$;
