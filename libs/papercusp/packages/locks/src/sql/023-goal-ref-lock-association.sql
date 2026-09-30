-- 023: associate file-lock rows and queued waiters with their active goal.
--
-- goal_ref is intentionally nullable: rows written before this migration are
-- legacy and can only be reclaimed safely by their declared path touch-set.
ALTER TABLE agent_file_locks
  ADD COLUMN IF NOT EXISTS goal_ref text;

ALTER TABLE agent_lock_waiters
  ADD COLUMN IF NOT EXISTS goal_ref text;

CREATE INDEX IF NOT EXISTS idx_locks_owner_goal_ref
  ON agent_file_locks (owner, goal_ref)
  WHERE goal_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_waiters_owner_goal_ref
  ON agent_lock_waiters (owner, goal_ref)
  WHERE status = 'waiting' AND goal_ref IS NOT NULL;

-- Preserve the path-scoped advisory locking and row-count protections from 022,
-- while copying the queued goal association onto every granted lock row.
CREATE OR REPLACE FUNCTION grant_cascade(
  p_coordination_domain text,
  p_now                 timestamptz
)
RETURNS void
LANGUAGE plpgsql AS $func$
DECLARE
  v_waiter      record;
  v_path        text;
  v_new_lock    uuid;
  v_expires     timestamptz;
  v_held_paths  text[];
  v_path_count  int;
  v_row_count   int;
BEGIN
  FOR v_path IN
    SELECT DISTINCT paths.path
      FROM agent_lock_waiters w
      CROSS JOIN LATERAL unnest(w.paths) AS paths(path)
     WHERE w.coordination_domain = p_coordination_domain
       AND w.status = 'waiting'
       AND w.wait_until > p_now
     ORDER BY paths.path
  LOOP
    PERFORM pg_advisory_xact_lock(
      101,
      hashtext('su:' || p_coordination_domain || ':' || v_path)
    );
  END LOOP;

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
      IF v_held_paths && v_waiter.paths THEN
        PERFORM 1
          FROM agent_file_locks
         WHERE coordination_domain = p_coordination_domain
           AND expires_ts > p_now
           AND path = ANY(v_waiter.paths)
           AND owner <> v_waiter.owner
         LIMIT 1;
        IF FOUND THEN
          CONTINUE;
        END IF;
      END IF;

      v_new_lock   := gen_random_uuid();
      v_expires    := p_now + (v_waiter.ttl_sec || ' seconds')::interval;
      v_path_count := COALESCE(array_length(v_waiter.paths, 1), 0);

      INSERT INTO agent_file_locks
        (coordination_domain, path, owner, owner_label, intent, goal_ref,
         lock_id, acquired_ts, expires_ts)
      SELECT
        p_coordination_domain, p, v_waiter.owner, v_waiter.owner_label,
        v_waiter.intent, v_waiter.goal_ref, v_new_lock, p_now, v_expires
        FROM unnest(v_waiter.paths) AS p
        ON CONFLICT (coordination_domain, path) DO UPDATE
          SET owner       = EXCLUDED.owner,
              owner_label = EXCLUDED.owner_label,
              intent      = EXCLUDED.intent,
              goal_ref    = EXCLUDED.goal_ref,
              lock_id     = EXCLUDED.lock_id,
              acquired_ts = EXCLUDED.acquired_ts,
              expires_ts  = EXCLUDED.expires_ts
          WHERE agent_file_locks.expires_ts <= p_now
             OR agent_file_locks.owner = EXCLUDED.owner;

      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      IF v_row_count < v_path_count THEN
        RAISE EXCEPTION 'grant_cascade: ticket % covered only % of % paths',
          v_waiter.ticket_id, v_row_count, v_path_count
          USING ERRCODE = 'PSU09';
      END IF;

      UPDATE agent_lock_waiters
         SET status = 'granted',
             granted_lock_id = v_new_lock,
             granted_expires_ts = v_expires
       WHERE ticket_id = v_waiter.ticket_id;

      v_held_paths := v_held_paths || v_waiter.paths;

      PERFORM pg_notify(
        coord_notify_channel(p_coordination_domain),
        v_waiter.ticket_id::text
      );
      PERFORM pg_notify(
        coord_notify_channel_legacy(p_coordination_domain),
        v_waiter.ticket_id::text
      );
    EXCEPTION
      WHEN no_data_found THEN CONTINUE;
      WHEN unique_violation THEN CONTINUE;
      WHEN SQLSTATE 'PSU09' THEN CONTINUE;
    END;
  END LOOP;
END;
$func$;
