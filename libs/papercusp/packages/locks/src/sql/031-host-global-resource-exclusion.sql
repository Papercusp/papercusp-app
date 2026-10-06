-- EI-25181611831349662: fence host-global resources at the database write
-- boundary, including callers that still resolve a legacy tree domain.
-- The tool's foreign-domain pre-read cannot serialize two writers and does
-- not run for internal/older callers. Reuse the declared registry property
-- and its row lock; no caller identity, lease domain or existing row is changed.
-- Tree/workspace resources keep their independent-domain behavior.

CREATE INDEX IF NOT EXISTS idx_reslocks_resource_live
  ON agent_resource_locks (resource, expires_ts);

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

  -- A transaction-scoped gate shared by every domain and every caller of
  -- this registered physical resource. Concurrent legacy INSERTs cannot
  -- both observe an empty foreign domain and then commit conflicting leases.
  SELECT r.resource INTO v_resource
    FROM agent_resource_registry r
   WHERE r.resource = NEW.resource
     AND r.coordination_domain_kind = 'host-global'
   FOR UPDATE;
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
    -- A foreign-domain shared lease cannot participate in this domain's
    -- drain. Even the same owner must release it before changing domains.
    -- Raising aborts the legacy transaction BEFORE its destructive body can
    -- obtain a granted lease; no partial reservation survives the refusal.
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

DROP TRIGGER IF EXISTS trg_host_global_resource_exclusion ON agent_resource_locks;
CREATE TRIGGER trg_host_global_resource_exclusion
  BEFORE INSERT OR UPDATE OF coordination_domain, resource, mode, status, expires_ts
  ON agent_resource_locks
  FOR EACH ROW EXECUTE FUNCTION enforce_host_global_resource_exclusion();
