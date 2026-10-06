-- 030-resource-scoped-shared-ops.sql — one-round-trip shared-semaphore operations.
--
-- papercusp-log-performance-remediation-2026-09-23 P-014(e), WI-10004964.
--
-- Measured 2026-10-01 (pg_stat_statements since 2026-09-29): the domain key
-- pg_advisory_xact_lock(101, hashtext('su:' || domain)) took 543k calls at a
-- 35 ms mean wait, while every statement inside the transactions it guards
-- averaged under 1 ms.  Each named-resource acquire / heartbeat / release held
-- that exclusive key across roughly ten client round trips.  So the hold time
-- was set by event-loop latency in busy operator workers, not by SQL.  Sampled
-- waiters and holders were all the host-wide optional-memory admission
-- semaphore contending with itself.
--
-- The functions below run a SHARED-mode acquire / heartbeat / release as ONE
-- autocommit statement.  Transaction-scoped advisory locks taken inside it are
-- released when the statement ends, so a lock is held only for server time.
-- They take the SHARED domain gate (it conflicts with every domain-global
-- operation that still holds the exclusive domain key, older processes
-- included) plus an EXCLUSIVE per-resource key.  Holding only the per-resource
-- key, they may touch rows of the resource they were called for and nothing
-- else, which is why resource_grant_cascade gains a resource-scoped form.  The
-- two-argument cascade keeps its domain-wide behaviour by delegating with a
-- NULL resource.
--
-- TypeScript's tryAcquireResource delegates its shared branch to
-- resource_acquire_shared(..., p_take_scope_locks => false) inside the caller's
-- domain transaction, so the shared-admission rules have one implementation.

-- Canonical cascade.  p_resource NULL = every resource in the domain (the
-- historical behaviour); otherwise only that resource's rows are read/written.
-- Body is 026's, with the resource filter added to both loops.
CREATE OR REPLACE FUNCTION resource_grant_cascade(
  p_coordination_domain text,
  p_now                  timestamptz,
  p_resource             text
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
       AND (p_resource IS NULL OR resource = p_resource)
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

  -- Pick at most one request per resource before entering the loop (see 026).
  FOR v_head IN
    SELECT q.*
      FROM (
        SELECT DISTINCT ON (q.resource) q.*
          FROM agent_resource_exclusive_queue q
         WHERE q.coordination_domain = p_coordination_domain
           AND (p_resource IS NULL OR q.resource = p_resource)
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

      PERFORM pg_notify(coord_notify_channel(p_coordination_domain), v_head.ticket_id::text);
      -- Legacy raw-name channel for pre-013 listeners.
      PERFORM pg_notify(coord_notify_channel_legacy(p_coordination_domain), v_head.ticket_id::text);
    END IF;
  END LOOP;
END;
$func$;

-- The historical two-argument form: the domain-wide cascade.  No DEFAULT on
-- the three-argument form's p_resource, so this call is never ambiguous.
CREATE OR REPLACE FUNCTION resource_grant_cascade(
  p_coordination_domain text,
  p_now                  timestamptz
)
RETURNS void
LANGUAGE plpgsql AS $func$
BEGIN
  PERFORM resource_grant_cascade(p_coordination_domain, p_now, NULL::text);
END;
$func$;

-- Take the resource-scoped lock set.  p_feature_key is the caller's
-- SU_LOCKS_FEATURE_KEY (advisory-lock-keys.md), passed in so the key registry
-- stays single-sourced.  The shared gate is the same key inWorkspaceTxn takes
-- for path-scoped work; the per-resource key uses a 'su-resource:' prefix so it
-- can never textually equal a domain ('su:<domain>') or path
-- ('su:<domain>:<path>') key.  lock_timeout is set for the rest of the
-- (single-statement) transaction before either wait can begin.
CREATE OR REPLACE FUNCTION resource_scope_lock(
  p_feature_key          integer,
  p_coordination_domain  text,
  p_resource             text,
  p_lock_timeout_ms      integer
)
RETURNS void
LANGUAGE plpgsql AS $func$
BEGIN
  IF p_lock_timeout_ms IS NOT NULL AND p_lock_timeout_ms > 0 THEN
    PERFORM set_config('lock_timeout', p_lock_timeout_ms || 'ms', true);
  END IF;
  PERFORM pg_advisory_xact_lock_shared(
    p_feature_key, hashtext('su:' || p_coordination_domain));
  PERFORM pg_advisory_xact_lock(
    p_feature_key, hashtext('su-resource:' || p_coordination_domain || ':' || p_resource));
END;
$func$;

-- Resource-scoped expiry sweep (agent_resource_locks + exclusive queue).
-- Waiters stay with the background janitor, as in sweepResourceExpired.
CREATE OR REPLACE FUNCTION resource_sweep_expired_scoped(
  p_coordination_domain text,
  p_resource            text
)
RETURNS integer
LANGUAGE plpgsql AS $func$
DECLARE
  v_locks int;
  v_queue int;
BEGIN
  DELETE FROM agent_resource_locks
   WHERE coordination_domain = p_coordination_domain
     AND resource = p_resource
     AND expires_ts <= clock_timestamp();
  GET DIAGNOSTICS v_locks = ROW_COUNT;
  DELETE FROM agent_resource_exclusive_queue
   WHERE coordination_domain = p_coordination_domain
     AND resource = p_resource
     AND expires_ts <= clock_timestamp();
  GET DIAGNOSTICS v_queue = ROW_COUNT;
  RETURN v_locks + v_queue;
END;
$func$;

-- Shared-mode admission: the single implementation of the rules that used to
-- live in tryAcquireResource's shared branch (writer priority with incumbent
-- renewal, EI-23229103052811419; D-008 capacity; no downgrade of a held
-- exclusive).  Returns jsonb: {ok:true, lock_id, expires_ts} or
-- {ok:false, reason} with reason in unknown_resource | exclusive_pending |
-- at_capacity | held_exclusive.  p_take_scope_locks=false means the caller
-- already holds the exclusive domain key (TypeScript inWorkspaceTxn).
CREATE OR REPLACE FUNCTION resource_acquire_shared(
  p_feature_key          integer,
  p_coordination_domain  text,
  p_resource             text,
  p_owner                text,
  p_owner_label          text,
  p_reason               text,
  p_ttl_sec              integer,
  p_waiter_ttl_sec       integer,
  p_take_scope_locks     boolean,
  p_lock_timeout_ms      integer
)
RETURNS jsonb
LANGUAGE plpgsql AS $func$
DECLARE
  v_max_holders         integer;
  v_caller_holds_shared boolean;
  v_excl_owner          text;
  v_queue_len           integer;
  v_other_shared        integer;
  v_lock_id             uuid;
  v_expires             timestamptz;
  v_refusal             text;
BEGIN
  IF p_take_scope_locks THEN
    PERFORM resource_scope_lock(p_feature_key, p_coordination_domain, p_resource, p_lock_timeout_ms);
  END IF;

  SELECT r.max_holders INTO v_max_holders
    FROM agent_resource_registry r
   WHERE r.resource = p_resource
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_resource');
  END IF;

  PERFORM resource_sweep_expired_scoped(p_coordination_domain, p_resource);
  PERFORM resource_grant_cascade(p_coordination_domain, clock_timestamp(), p_resource);

  SELECT EXISTS (
    SELECT 1 FROM agent_resource_locks l
     WHERE l.coordination_domain = p_coordination_domain
       AND l.resource = p_resource
       AND l.owner = p_owner
       AND l.mode = 'shared'
       AND l.expires_ts > clock_timestamp()
  ) INTO v_caller_holds_shared;

  SELECT l.owner INTO v_excl_owner
    FROM agent_resource_locks l
   WHERE l.coordination_domain = p_coordination_domain
     AND l.resource = p_resource
     AND l.mode = 'exclusive'
     AND l.expires_ts > clock_timestamp()
   ORDER BY l.acquired_ts ASC
   LIMIT 1;

  SELECT count(*) INTO v_queue_len
    FROM agent_resource_exclusive_queue q
   WHERE q.coordination_domain = p_coordination_domain
     AND q.resource = p_resource
     AND q.expires_ts > clock_timestamp();

  -- Writer priority: another owner's held/draining or queued exclusive refuses
  -- a NEW shared holder; an incumbent shared holder may still renew.
  IF (v_excl_owner IS NOT NULL AND v_excl_owner <> p_owner AND NOT v_caller_holds_shared)
     OR (v_queue_len > 0 AND NOT v_caller_holds_shared AND v_excl_owner IS DISTINCT FROM p_owner) THEN
    v_refusal := 'exclusive_pending';
  ELSIF v_max_holders IS NOT NULL AND NOT v_caller_holds_shared THEN
    -- D-008 counting semaphore: a refresh never consumes a fresh slot.
    SELECT count(*) INTO v_other_shared
      FROM agent_resource_locks l
     WHERE l.coordination_domain = p_coordination_domain
       AND l.resource = p_resource
       AND l.mode = 'shared'
       AND l.owner <> p_owner
       AND l.expires_ts > clock_timestamp();
    IF v_other_shared >= v_max_holders THEN
      v_refusal := 'at_capacity';
    END IF;
  END IF;

  IF v_refusal IS NOT NULL THEN
    -- Recorded so a targeted back-up broadcast can reach this owner (A4).
    INSERT INTO agent_resource_waiters
      (coordination_domain, resource, owner, owner_label, expires_ts)
    VALUES
      (p_coordination_domain, p_resource, p_owner, p_owner_label,
       clock_timestamp() + (p_waiter_ttl_sec || ' seconds')::interval)
    ON CONFLICT (coordination_domain, resource, owner) DO UPDATE
      SET owner_label = EXCLUDED.owner_label,
          queued_ts   = clock_timestamp(),
          expires_ts  = EXCLUDED.expires_ts;
    RETURN jsonb_build_object('ok', false, 'reason', v_refusal);
  END IF;

  INSERT INTO agent_resource_locks AS l
    (coordination_domain, resource, owner, owner_label, mode, status, reason, expires_ts)
  VALUES
    (p_coordination_domain, p_resource, p_owner, p_owner_label, 'shared', 'held', p_reason,
     clock_timestamp() + (p_ttl_sec || ' seconds')::interval)
  ON CONFLICT (coordination_domain, resource, owner) DO UPDATE
    SET owner_label = EXCLUDED.owner_label,
        reason      = EXCLUDED.reason,
        mode        = 'shared',
        status      = 'held',
        acquired_ts = clock_timestamp(),
        expires_ts  = EXCLUDED.expires_ts
    WHERE l.mode = 'shared'
  RETURNING l.lock_id, l.expires_ts INTO v_lock_id, v_expires;

  IF v_lock_id IS NULL THEN
    -- ON CONFLICT updated nothing: the caller holds an EXCLUSIVE row here and
    -- the mode='shared' guard refused to downgrade it.
    RETURN jsonb_build_object('ok', false, 'reason', 'held_exclusive');
  END IF;

  DELETE FROM agent_resource_waiters
   WHERE coordination_domain = p_coordination_domain
     AND resource = p_resource
     AND owner = p_owner;

  RETURN jsonb_build_object('ok', true, 'lock_id', v_lock_id::text, 'expires_ts', v_expires);
END;
$func$;

-- Renew one shared lease in one statement.  NULL = not extended (expired,
-- swept, or not this owner's).
CREATE OR REPLACE FUNCTION resource_heartbeat_shared(
  p_feature_key          integer,
  p_coordination_domain  text,
  p_resource             text,
  p_owner                text,
  p_lock_id              uuid,
  p_ttl_sec              integer,
  p_lock_timeout_ms      integer
)
RETURNS timestamptz
LANGUAGE plpgsql AS $func$
DECLARE
  v_expires timestamptz;
BEGIN
  PERFORM resource_scope_lock(p_feature_key, p_coordination_domain, p_resource, p_lock_timeout_ms);
  PERFORM resource_sweep_expired_scoped(p_coordination_domain, p_resource);
  PERFORM resource_grant_cascade(p_coordination_domain, clock_timestamp(), p_resource);

  UPDATE agent_resource_locks l
     SET expires_ts = clock_timestamp() + (p_ttl_sec || ' seconds')::interval
   WHERE l.coordination_domain = p_coordination_domain
     AND l.resource = p_resource
     AND l.lock_id = p_lock_id
     AND l.owner = p_owner
     AND l.mode = 'shared'
     AND l.expires_ts > clock_timestamp()
  RETURNING l.expires_ts INTO v_expires;

  RETURN v_expires;
END;
$func$;

-- Release one shared lease in one statement, then run the resource-scoped
-- cascade (dropping the last shared holder is what completes a draining
-- exclusive).  Shared-only on purpose: an exclusive release owes the targeted
-- back-up broadcast, which stays on tryReleaseResource.  Returns jsonb
-- {released, expired}; expired=true when the lease had lapsed before release.
CREATE OR REPLACE FUNCTION resource_release_shared(
  p_feature_key          integer,
  p_coordination_domain  text,
  p_resource             text,
  p_owner                text,
  p_lock_id              uuid,
  p_lock_timeout_ms      integer
)
RETURNS jsonb
LANGUAGE plpgsql AS $func$
DECLARE
  v_expired  boolean;
  v_released int;
BEGIN
  PERFORM resource_scope_lock(p_feature_key, p_coordination_domain, p_resource, p_lock_timeout_ms);

  SELECT EXISTS (
    SELECT 1 FROM agent_resource_locks l
     WHERE l.coordination_domain = p_coordination_domain
       AND l.resource = p_resource
       AND l.lock_id = p_lock_id
       AND l.owner = p_owner
       AND l.expires_ts <= clock_timestamp()
  ) INTO v_expired;

  PERFORM resource_sweep_expired_scoped(p_coordination_domain, p_resource);

  DELETE FROM agent_resource_locks l
   WHERE l.coordination_domain = p_coordination_domain
     AND l.resource = p_resource
     AND l.lock_id = p_lock_id
     AND l.owner = p_owner
     AND l.mode = 'shared';
  GET DIAGNOSTICS v_released = ROW_COUNT;

  PERFORM resource_grant_cascade(p_coordination_domain, clock_timestamp(), p_resource);

  RETURN jsonb_build_object('released', v_released, 'expired', v_expired);
END;
$func$;
