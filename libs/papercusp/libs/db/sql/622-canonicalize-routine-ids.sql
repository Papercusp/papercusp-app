-- 622-canonicalize-routine-ids.sql
-- WI-5359 (found verifying EI-2217): canonicalize harness_shared.routines.id to the
-- derived form upsertRoutine uses (rt_<install_slug>_<name>, non-alnum -> _, lowercased —
-- see libs/papercusp/libs/db/src/routines-runtime.ts). 25 legacy rows (papercup->papercusp
-- rename residue, plus 2 dead-pot 'hive-wake' rows) kept pre-rename ids; under the flag-ON
-- ON CONFLICT (id) arbiter, an upsert of those (install_slug, name) pairs derives a
-- DIFFERENT id, misses the PK match, and the fallthrough INSERT throws on
-- routines_install_slug_name_key — the EI-2217/EI-2019 symptom class, re-armed by data.
-- Data-only, idempotent; no DDL. 0 FKs reference routines.id; pending_events.source_id
-- carries routine ids as historical provenance only (not a FK). The skip-if-taken guard
-- keeps an unexpected derived-id collision (audit 2026-07-18: none exist) from wedging the
-- deploy — a skipped row stays a filed landmine instead of failing the migration.
UPDATE harness_shared.routines r
   SET id = lower(regexp_replace('rt_' || r.install_slug || '_' || r.name, '[^a-zA-Z0-9_]', '_', 'g')),
       updated_at = now()
 WHERE r.id <> lower(regexp_replace('rt_' || r.install_slug || '_' || r.name, '[^a-zA-Z0-9_]', '_', 'g'))
   AND NOT EXISTS (
     SELECT 1 FROM harness_shared.routines other
      WHERE other.id = lower(regexp_replace('rt_' || r.install_slug || '_' || r.name, '[^a-zA-Z0-9_]', '_', 'g'))
        AND other.ctid <> r.ctid
   );
