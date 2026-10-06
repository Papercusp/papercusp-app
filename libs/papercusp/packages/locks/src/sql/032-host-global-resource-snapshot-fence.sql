-- EI-25181611831349662: the registry gate must change its MVCC row version.
-- 031's SELECT FOR UPDATE serializes read-committed writers, but an older
-- repeatable-read/serializable snapshot can still miss the preceding holder.
-- Actual-PG regression: both stale snapshots committed conflicting leases.
-- A no-op UPDATE preserves every registry value while making those snapshots
-- abort with serialization_failure (40001) before admitting another writer.
-- Keep this as a forward migration for databases that already applied 031.

CREATE OR REPLACE FUNCTION enforce_host_global_resource_exclusion()
RETURNS trigger
LANGUAGE plpgsql AS $func$
DECLARE
  v_resource text;
  v_conflict record;
BEGIN
  IF NEW.expires_ts <= clock_timestamp() THEN
    RETURN NEW;
  END IF;

  -- Reuse the existing per-resource row. No new table, counter, domain or
  -- advisory key; metadata (including updated_ts) remains byte-for-byte equal.
  UPDATE agent_resource_registry r
     SET resource = r.resource
   WHERE r.resource = NEW.resource
     AND r.coordination_domain_kind = 'host-global'
  RETURNING r.resource INTO v_resource;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  SELECT l.coordination_domain, l.owner, l.mode, l.status
    INTO v_conflict
    FROM agent_resource_locks l
   WHERE l.resource = NEW.resource
     AND l.coordination_domain <> NEW.coordination_domain
     AND l.expires_ts > clock_timestamp()
     AND (NEW.mode = 'exclusive' OR l.mode = 'exclusive')
   ORDER BY l.coordination_domain, l.owner
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23P01',
      CONSTRAINT = 'resource_host_global_exclusion',
      MESSAGE = 'Host-global resource has a conflicting lease in another coordination domain',
      DETAIL = json_build_object(
        'resource', NEW.resource,
        'requested_domain', NEW.coordination_domain,
        'coordination_domain', v_conflict.coordination_domain,
        'owner', v_conflict.owner,
        'mode', v_conflict.mode,
        'status', v_conflict.status
      )::text;
  END IF;
  RETURN NEW;
END;
$func$;
