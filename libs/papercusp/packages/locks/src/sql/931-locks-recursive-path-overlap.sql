-- 931: make file-lock paths recursive with boundary-safe overlap semantics.
--
-- A lock on `packages` protects every descendant path, while `packages-old`
-- remains independent.  Keep the predicate in the side database so the
-- application, queue diagnostics, and grant cascade use exactly one rule.

CREATE OR REPLACE FUNCTION lock_path_overlaps(
  p_left  text,
  p_right text
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT AS $func$
  SELECT p_left = p_right
      OR left(p_left, length(p_right) + 1) = p_right || '/'
      OR left(p_right, length(p_left) + 1) = p_left || '/'
$func$;

CREATE OR REPLACE FUNCTION lock_paths_overlap(
  p_left_paths  text[],
  p_right_paths text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT AS $func$
  SELECT EXISTS (
    SELECT 1
      FROM unnest(p_left_paths) AS left_path(path)
      CROSS JOIN unnest(p_right_paths) AS right_path(path)
     WHERE lock_path_overlaps(left_path.path, right_path.path)
  )
$func$;

CREATE OR REPLACE FUNCTION lock_path_prefixes(p_path text)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
STRICT AS $func$
DECLARE
  v_parts     text[] := string_to_array(p_path, '/');
  v_prefixes  text[] := ARRAY[]::text[];
  v_index     integer;
BEGIN
  FOR v_index IN 1..COALESCE(array_length(v_parts, 1), 0) LOOP
    v_prefixes := array_append(
      v_prefixes,
      array_to_string(v_parts[1:v_index], '/')
    );
  END LOOP;
  RETURN v_prefixes;
END;
$func$;

-- Copy the current grant function so waiter conflicts use recursive overlap
-- and the cascade serializes on every requested path prefix in sorted order.
-- The expired-steal, goal association, row-count guard, and notifications
-- intentionally remain unchanged from migration 023.
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
    SELECT DISTINCT prefixes.path
      FROM agent_lock_waiters w
      CROSS JOIN LATERAL unnest(w.paths) AS requested(path)
      CROSS JOIN LATERAL unnest(lock_path_prefixes(requested.path)) AS prefixes(path)
     WHERE w.coordination_domain = p_coordination_domain
       AND w.status = 'waiting'
       AND w.wait_until > p_now
     ORDER BY prefixes.path
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
      IF lock_paths_overlap(v_held_paths, v_waiter.paths) THEN
        PERFORM 1
          FROM agent_file_locks held
          CROSS JOIN LATERAL unnest(v_waiter.paths) AS requested(path)
         WHERE held.coordination_domain = p_coordination_domain
           AND held.expires_ts > p_now
           AND held.owner <> v_waiter.owner
           AND lock_path_overlaps(held.path, requested.path)
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
