-- 027-resource-coordination-domain-kind.sql — the coordination domain a named
-- resource lives in, as a PROPERTY OF THE REGISTERED RESOURCE rather than an
-- inference from its name. WI-562584 (root fix). Runs against papercusp_su.
-- Idempotent.
--
-- Every acquirer of a named resource must resolve the SAME coordination domain
-- or mutual exclusion silently does not hold: the two acquires land in disjoint
-- namespaces, both are granted, and nothing reports a conflict. Until now the
-- reader side (`resourceLockDomain()`) INFERRED the domain from the resource
-- NAME — a hardcoded host-global set plus a `git-sync:` prefix rule — while the
-- system-side acquirer (git-sync) puts its WHOLE lock set, including every
-- `trigger_config.extra_lock_resources` name, in `workspaceId || '*'`. An extra
-- name advertises neither family, so the inference answered "caller tree" for a
-- resource genuinely held in the workspace domain (`libs-papercusp-submodule`,
-- measured live as the only such name today).
--
-- Name-shaped inference cannot be fixed by adding more names: the set is
-- per-install human configuration (`extra_lock_resources`), so shared
-- operator-core code can never enumerate it. Recording the kind ON THE RESOURCE
-- lets the acquirer DECLARE it (derived-truth rung 1) and every reader agree by
-- construction.
--
-- 'tree' is the default and matches today's fallback exactly, so an unstamped
-- row behaves as it did before this migration. The reader treats 'tree' as
-- "undeclared" and falls through to the existing name inference, which makes
-- this column strictly additive: it can promote a resource OUT of the caller-tree
-- domain, never demote one INTO it.
ALTER TABLE agent_resource_registry
  ADD COLUMN IF NOT EXISTS coordination_domain_kind text NOT NULL DEFAULT 'tree';

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_resource_registry_coordination_domain_kind_chk'
  ) THEN
    ALTER TABLE agent_resource_registry
      ADD CONSTRAINT agent_resource_registry_coordination_domain_kind_chk
      CHECK (coordination_domain_kind IN ('tree', 'workspace', 'host-global'));
  END IF;
END;
$do$;

-- Backfill from the hardcoded sets this column replaces, so the registry AGREES
-- with today's inference the moment it exists (HOST_GLOBAL_RESOURCES and
-- WORKSPACE_SCOPED_RESOURCES/_PREFIXES in
-- packages/operator-core/lib/agent-tools/locks/coordination-domain.ts). Scoped
-- by `IS DISTINCT FROM` so a re-run and a hand-edited row are both no-ops.
UPDATE agent_resource_registry
   SET coordination_domain_kind = 'host-global', updated_ts = clock_timestamp()
 WHERE resource IN ('release-deploy', 'dev-server', 'memory-injection:mid-turn')
   AND coordination_domain_kind IS DISTINCT FROM 'host-global';

UPDATE agent_resource_registry
   SET coordination_domain_kind = 'workspace', updated_ts = clock_timestamp()
 WHERE (resource = 'git-sync' OR resource LIKE 'git-sync:%')
   AND coordination_domain_kind IS DISTINCT FROM 'workspace';
