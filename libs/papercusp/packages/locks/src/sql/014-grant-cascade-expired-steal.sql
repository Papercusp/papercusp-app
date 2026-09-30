-- 014: grant_cascade must never grant a waiter it didn't fully lock
-- (full-app-audit-2026-06-09 P-009 — EI-129/EI-130 root cause).
--
-- The path-row INSERT used ON CONFLICT DO NOTHING. A row left behind by
-- an EXPIRED lock is invisible to the live held-paths probe (it filters
-- `expires_ts > p_now`) but still occupies the (coordination_domain, path)
-- unique key — so the insert silently skipped it while the waiter was
-- still flipped to 'granted'. The waiter then believed it held paths
-- whose rows still carried the old owner + old lock_id: the path was
-- never protected, and release(granted_lock_id) couldn't free it.
-- Blocking-wait callers (locks:acquire { wake_on_grant }) woke "granted"
-- without a real lock — the EI-129/EI-130 signature.
--
-- Fix mirrors tryAcquire's upsert (su-lock-store.ts): steal rows that are
-- expired or already the waiter's own, then verify the statement covered
-- EVERY path — on shortfall, roll back this waiter's subtransaction and
-- leave it 'waiting' for the next cascade instead of marking it granted.
--
-- Re-created verbatim from 013 (bounded NOTIFY channels) apart from:
--   1. the owner-aware conflict probe (a waiter's OWN live rows no longer
--      block its grant — they're refreshed onto the new lock_id);
--   2. ON CONFLICT (coordination_domain, path) DO UPDATE with the
--      expired-or-own steal condition;
--   3. the GET DIAGNOSTICS row-count check + ERRCODE 'PSU09' bailout.

CREATE OR REPLACE FUNCTION grant_cascade(
  p_coordination_domain text,
  p_now                 timestamptz
)
RETURNS void
LANGUAGE plpgsql AS $func$
DECLARE
  v_waiter      record;
  v_new_lock    uuid;
  v_expires     timestamptz;
  v_held_paths  text[];
  v_path_count  int;
  v_row_count   int;
BEGIN
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
        -- through the queue). Only a row held by ANOTHER owner is a
        -- conflict — same contract as tryAcquire, whose upsert
        -- refreshes same-owner rows. The table probe runs only on
        -- overlap, so the common no-contention iteration stays a pure
        -- in-memory check (audit 3 #1). In-cascade grants are visible
        -- here too: their rows are uncommitted writes of this same
        -- transaction.
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
          -- Steal on two conditions (same contract as tryAcquire):
          --   1. the existing row is expired (janitor hasn't swept it);
          --   2. it's the waiter's own row (refresh onto the new
          --      lock_id so the whole grant releases as ONE unit).
          WHERE agent_file_locks.expires_ts <= p_now
             OR agent_file_locks.owner = EXCLUDED.owner;

      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      IF v_row_count < v_path_count THEN
        -- A live row owned by someone else survived the probe. Grant
        -- NOTHING: the RAISE rolls back this BEGIN block's
        -- subtransaction (including any partial path rows), the
        -- handler below CONTINUEs, and the waiter stays 'waiting'.
        RAISE EXCEPTION 'grant_cascade: ticket % covered only % of % paths',
          v_waiter.ticket_id, v_row_count, v_path_count
          USING ERRCODE = 'PSU09';
      END IF;

      UPDATE agent_lock_waiters
         SET status              = 'granted',
             granted_lock_id     = v_new_lock,
             granted_expires_ts  = v_expires
       WHERE ticket_id = v_waiter.ticket_id;

      v_held_paths := v_held_paths || v_waiter.paths;

      -- NOTIFY fires at commit time, atomic with the grant. Payload
      -- is ticket_id only (36 bytes); waiters re-SELECT to read their
      -- granted_lock_id. DO NOT expand the payload — PG's 8KB NOTIFY
      -- limit will eventually bite if anyone tries to pack more.
      PERFORM pg_notify(
        coord_notify_channel(p_coordination_domain),
        v_waiter.ticket_id::text
      );
      -- Legacy raw-name channel for pre-013 listeners (see 013 header).
      PERFORM pg_notify(
        coord_notify_channel_legacy(p_coordination_domain),
        v_waiter.ticket_id::text
      );
    EXCEPTION
      -- Waiter row vanished between SELECT and UPDATE (force-deleted,
      -- cancelled concurrently). Defense-in-depth — under the domain
      -- advisory lock this should not happen.
      WHEN no_data_found THEN CONTINUE;
      -- Another grant in this same cascade beat us to a path.
      -- Defense-in-depth — the in-memory v_held_paths probe should
      -- prevent it.
      WHEN unique_violation THEN CONTINUE;
      -- Grant shortfall (the row-count check above): this waiter's
      -- subtransaction rolled back; it stays 'waiting'.
      WHEN SQLSTATE 'PSU09' THEN CONTINUE;
      -- Intentionally NOT catching WHEN OTHERS: real errors (syntax,
      -- assertion, permission) MUST abort the cascade.
    END;
  END LOOP;
END;
$func$;
