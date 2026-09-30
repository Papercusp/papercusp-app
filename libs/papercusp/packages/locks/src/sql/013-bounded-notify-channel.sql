-- 013: bound the ch_coord_* NOTIFY channel name (fix: "channel name too long").
--
-- PostgreSQL channel names are identifiers, capped at NAMEDATALEN-1 = 63
-- bytes — with a nasty asymmetry: LISTEN (identifier syntax) silently
-- TRUNCATES a longer name, while pg_notify() (function, text arg) RAISES
-- "channel name too long". The coordination domain is the realpath of the
-- repo root, so `'ch_coord_' || domain` crosses 63 bytes for any checkout
-- deeper than 54 chars. Live incident (2026-06-09): the GREEN release
-- checkout `/home/dev/papercupai-workspace/papercup-release`
-- yields a 65-byte channel, so EVERY release/poke whose cascade granted a
-- queued waiter blew up the whole transaction with "channel name too long"
-- — the lock could not be released while anyone was waiting on it (the §9
-- HTTP-MCP wake test caught it).
--
-- Fix: hash the domain into the channel name — `ch_coord_` + md5(domain)
-- = 41 bytes, always valid, still one channel per domain. The hash is
-- applied UNCONDITIONALLY (no "only when long" dual mode) so the SQL
-- NOTIFY side and the TS LISTEN side (workspace-listener.ts, which mirrors
-- this with node:crypto md5) can never disagree about the name.
--
-- Both cascade functions are re-created verbatim from their latest
-- versions (grant_cascade: 004; resource_grant_cascade: 010) with only the
-- pg_notify channel expression changed.

CREATE OR REPLACE FUNCTION coord_notify_channel(p_coordination_domain text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT 'ch_coord_' || md5(p_coordination_domain)
$$;

-- Rolling-upgrade bridge: processes built BEFORE this migration LISTEN on
-- the RAW `ch_coord_<domain>` name (which PG truncates to 63 bytes when
-- longer). This migration lands in the shared papercusp_su DB out-of-band
-- of those processes' code, so the cascades below notify BOTH the bounded
-- md5 channel and the legacy (truncated) raw name; otherwise every
-- already-running listener would silently degrade to its 30s poll ceiling
-- until restarted on new code. left(…, 63) is byte-exact for ASCII paths
-- (what coordination domains are) and never trips pg_notify's 63-byte cap.
-- Safe to drop in a later migration once no pre-013 listener remains.
CREATE OR REPLACE FUNCTION coord_notify_channel_legacy(p_coordination_domain text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT left('ch_coord_' || p_coordination_domain, 63)
$$;

-- ─────────────────────────────────────────────────────────────────────
-- grant_cascade — verbatim from 004 except the pg_notify channel.
-- ─────────────────────────────────────────────────────────────────────
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
        CONTINUE;
      END IF;

      v_new_lock := gen_random_uuid();
      v_expires  := p_now + (v_waiter.ttl_sec || ' seconds')::interval;

      INSERT INTO agent_file_locks
        (coordination_domain, path, owner, owner_label, intent,
         lock_id, acquired_ts, expires_ts)
      SELECT
        p_coordination_domain, p, v_waiter.owner, v_waiter.owner_label,
        v_waiter.intent, v_new_lock, p_now, v_expires
        FROM unnest(v_waiter.paths) AS p
        ON CONFLICT DO NOTHING;

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
      -- Legacy raw-name channel for pre-013 listeners (see header).
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
      -- Intentionally NOT catching WHEN OTHERS: real errors (syntax,
      -- assertion, permission) MUST abort the cascade.
    END;
  END LOOP;
END;
$func$;

-- ─────────────────────────────────────────────────────────────────────
-- resource_grant_cascade — verbatim from 010 except the pg_notify channel.
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION resource_grant_cascade(
  p_coordination_domain text,
  p_now                  timestamptz
)
RETURNS void
LANGUAGE plpgsql AS $func$
DECLARE
  v_excl         record;
  v_shared_count int;
BEGIN
  FOR v_excl IN
    SELECT * FROM agent_resource_locks
     WHERE coordination_domain = p_coordination_domain
       AND mode = 'exclusive'
       AND status = 'draining'
       AND expires_ts > p_now
  LOOP
    SELECT count(*) INTO v_shared_count
      FROM agent_resource_locks
     WHERE coordination_domain = p_coordination_domain
       AND resource = v_excl.resource
       AND mode = 'shared'
       AND expires_ts > p_now;

    IF v_shared_count = 0 THEN
      UPDATE agent_resource_locks
         SET status    = 'held',
             acquired_ts = p_now,
             fence_seq = resource_assign_fence(p_coordination_domain, v_excl.resource)
       WHERE coordination_domain = p_coordination_domain
         AND resource = v_excl.resource
         AND owner = v_excl.owner
         AND mode = 'exclusive';

      PERFORM pg_notify(coord_notify_channel(p_coordination_domain), v_excl.lock_id::text);
      -- Legacy raw-name channel for pre-013 listeners (see header).
      PERFORM pg_notify(coord_notify_channel_legacy(p_coordination_domain), v_excl.lock_id::text);
    END IF;
  END LOOP;
END;
$func$;
