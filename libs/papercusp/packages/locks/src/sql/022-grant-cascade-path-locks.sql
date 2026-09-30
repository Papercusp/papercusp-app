-- 022: make grant_cascade safe with path-scoped advisory transactions.
--
-- File-lock transactions now take the shared workspace gate plus one
-- exclusive advisory key per canonical path. The old grant_cascade relied on
-- an exclusive workspace lock for its held-paths probe; without this update a
-- cascade could scan before a path-scoped acquire committed and make a stale
-- grant decision. Lock every path currently covered by a waiting ticket,
-- sorted by path, before taking the probe snapshot. The transaction wrapper
-- uses the identical key expression, so direct acquires/releases and the
-- cascade serialize on overlapping paths while unrelated paths remain free.
--
-- The 014 owner-aware expired-steal and row-count protections are preserved.

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
  -- Match inWorkspaceTxn's path key: hashtext('su:' || domain || ':' || path).
  -- Every cascade takes the complete waiting-path set in sorted order, which
  -- avoids deadlocks between concurrent cascades with different first rows.
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
        -- The overlap may be the waiter's OWN live rows (re-acquire
        -- through the queue). Only a row held by ANOTHER owner is a conflict
        -- — same contract as tryAcquire, whose upsert refreshes same-owner
        -- rows. The table probe runs only on overlap, so the common
        -- no-contention iteration stays a pure in-memory check.
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
        (coordination_domain, path, owner, owner_label, intent,
         lock_id, acquired_ts, expires_ts)
      SELECT
        p_coordination_domain, p, v_waiter.owner, v_waiter.owner_label,
        v_waiter.intent, v_new_lock, p_now, v_expires
        FROM unnest(v_waiter.paths) AS p
        ON CONFLICT (coordination_domain, path) DO UPDATE
          SET owner       = EXCLUDED.owner,
              owner_label = EXCLUDED.owner_label,
              intent      = EXCLUDED.intent,
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
      -- Legacy raw-name channel for pre-013 listeners.
      PERFORM pg_notify(
        coord_notify_channel_legacy(p_coordination_domain),
        v_waiter.ticket_id::text
      );
    EXCEPTION
      -- Waiter row vanished between SELECT and UPDATE (force-deleted,
      -- cancelled concurrently).
      WHEN no_data_found THEN CONTINUE;
      -- Another grant beat us to a path. The path locks plus row constraints
      -- make this defensive branch sufficient for mixed-version callers.
      WHEN unique_violation THEN CONTINUE;
      -- Grant shortfall: the subtransaction rolled back; leave the waiter
      -- waiting for the next cascade.
      WHEN SQLSTATE 'PSU09' THEN CONTINUE;
      -- Do not swallow syntax, assertion, or permission failures.
    END;
  END LOOP;
END;
$func$;
