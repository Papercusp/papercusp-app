-- 843-local-backend-lifecycle
--
-- On-demand lifecycle for local inference backends.
-- Plan: on-demand-local-inference-lifecycle-2026-08-17 (P-005/P-006), decision D-005.
--
-- WHY THESE COLUMNS LIVE HERE AND NOT ONLY IN provisioner/catalog.ts (D-005):
-- the catalog is a RECOMMENDATION source the wizard consults; `local_backends` is what the
-- gateway actually routes on. The idle-reaper (P-007) and gateway ensure-running (P-008) read
-- the registry, so without these columns they have nothing to act on. Deriving lifecycle by
-- mapping registry id -> catalog entry does not work: the one live row is `ornith-llamaserver`
-- while a provisioner-created id would be `provisioner-ornith-35b-iq3m-llama-server`.
--
-- WHY unit_name IS NOT DERIVABLE FROM base_url: they are different processes on different
-- ports. `ornith-llamaserver` has base_url http://127.0.0.1:11435, which is the always-on
-- `ollama-schema-proxy.service`; the GPU-resident llama-server it forwards to is
-- `llama-ornith.service` on :11436. A reaper that stopped "whatever serves base_url" would kill
-- the cheap proxy and leave the 19.8GB process resident.
--
-- EXPAND-ONLY, so no FORWARD-COMPAT acknowledgment is required: every column is nullable or
-- defaulted, and the currently-deployed release at :3070 neither reads nor writes them. Existing
-- rows become 'always-on', which is exactly today's behaviour — adding this migration cannot make
-- a running backend reapable. Making one reapable is a deliberate, separate UPDATE.

ALTER TABLE harness_shared.local_backends
  ADD COLUMN IF NOT EXISTS lifecycle    text    NOT NULL DEFAULT 'always-on',
  ADD COLUMN IF NOT EXISTS idle_ttl_sec integer,
  ADD COLUMN IF NOT EXISTS unit_name    text;

-- The three constraints below are added through a guarded DO block rather than the usual
-- `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` idiom. All three names are introduced BY this
-- migration, so a drop could only ever be a re-run convenience — but a bare DROP is still
-- destructive DDL against a database the currently-deployed :3070 release is live on, and it
-- trips lint:migration-forward-compat for good reason. Guarding the ADD keeps the migration
-- re-runnable with no destructive statement to acknowledge.

-- 'always-on': start it and leave it resident (the pre-843 behaviour, and the default).
-- 'on-demand': the idle-reaper may stop it once idle past idle_ttl_sec; the gateway starts it
--              again on a request routed to it.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'local_backends_lifecycle_check'
  ) THEN
    ALTER TABLE harness_shared.local_backends
      ADD CONSTRAINT local_backends_lifecycle_check
      CHECK (lifecycle IN ('always-on', 'on-demand'));
  END IF;
END $$;

-- A TTL is only meaningful for an on-demand backend, and a non-positive TTL would mean "reap it
-- the instant it goes idle", which is never what anyone means. Enforce both rather than leaving
-- the reaper to guess at a nonsense value.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'local_backends_idle_ttl_sec_check'
  ) THEN
    ALTER TABLE harness_shared.local_backends
      ADD CONSTRAINT local_backends_idle_ttl_sec_check
      CHECK (idle_ttl_sec IS NULL OR idle_ttl_sec > 0);
  END IF;
END $$;

-- An on-demand backend the reaper cannot stop is a configuration that looks armed and silently
-- does nothing — the exact failure mode this plan exists to remove. Require the unit up front.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'local_backends_on_demand_needs_unit_check'
  ) THEN
    ALTER TABLE harness_shared.local_backends
      ADD CONSTRAINT local_backends_on_demand_needs_unit_check
      CHECK (lifecycle <> 'on-demand' OR unit_name IS NOT NULL);
  END IF;
END $$;

-- The reaper's hot read: every enabled on-demand backend. Partial, because that set stays tiny
-- while the table as a whole is read on every gateway hot-reload.
CREATE INDEX IF NOT EXISTS local_backends_on_demand
  ON harness_shared.local_backends (workspace_id)
  WHERE enabled AND lifecycle = 'on-demand';

COMMENT ON COLUMN harness_shared.local_backends.lifecycle IS
  'always-on (default, pre-843 behaviour) | on-demand (reapable when idle, started on demand). Operative truth; provisioner/catalog.ts carries only the recommended default per combo (D-005).';
COMMENT ON COLUMN harness_shared.local_backends.idle_ttl_sec IS
  'Idle seconds before an on-demand backend is eligible for reaping. NULL => the reaper default. Meaningless for always-on.';
COMMENT ON COLUMN harness_shared.local_backends.unit_name IS
  'systemd --user unit that OWNS this backend process, e.g. llama-ornith.service. NOT derivable from base_url: base_url may point at an always-on sanitizing proxy in front of the real unit (D-005). Required when lifecycle = on-demand.';
