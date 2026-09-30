-- Migration 156 — drain the retired mem0 scopes
-- (plan docs-and-memory-as-projections-2026-06-05, D-005 + D-006).
--
-- mem0 is now the SOLE semantic store, holding only STABLE facts. Two things are
-- retired and drained here (pre-alpha: no aliases, no back-compat window):
--   • the `ephemeral` kind (D-006) — ephemeral state belongs in coord (delta-
--     delivered), never in a semantic store. Delete every ephemeral memory + its
--     embedding rows.
--   • the deprecated `workspace:`/`shared` scope (D-005) — re-scope each workspace
--     memory to its CREATOR (user scope). A workspace memory has no single harness,
--     so the faithful, lossless drain is user-scope-to-creator (the plan names
--     `harness:` as the target, but no harness exists on a workspace row); rows with
--     no recorded creator are dropped.
--
-- mem0 stores its fields FLAT in `payload` (top-level `kind`/`scope`/`user_id`/
-- `created_by`), filtering recall by `payload->>'user_id'` — so re-scoping is a
-- jsonb rewrite of those keys.
--
-- Idempotent + additive-safe: on a fresh/empty store (the live box has 0 ephemeral
-- and 0 workspace rows) every statement is a no-op. Composes onto 000-baseline for
-- fresh/embedded-pg boots. Runs as harness_admin.

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  has_canonical boolean := to_regclass('harness_shared.memory_canonical') IS NOT NULL;
  has_vec_openai boolean := to_regclass('harness_shared.memory_vec_openai') IS NOT NULL;
  has_vec_local  boolean := to_regclass('harness_shared.memory_vec_local') IS NOT NULL;
BEGIN
  IF NOT has_canonical THEN
    RAISE NOTICE 'memory_canonical absent — nothing to drain';
    RETURN;
  END IF;

  -- 1) Delete embeddings for the ephemeral memories first (FK-safe), then the rows.
  IF has_vec_openai THEN
    DELETE FROM harness_shared.memory_vec_openai v
    USING harness_shared.memory_canonical m
    WHERE v.memory_id = m.id AND m.payload->>'kind' = 'ephemeral';
  END IF;
  IF has_vec_local THEN
    DELETE FROM harness_shared.memory_vec_local v
    USING harness_shared.memory_canonical m
    WHERE v.memory_id = m.id AND m.payload->>'kind' = 'ephemeral';
  END IF;
  DELETE FROM harness_shared.memory_canonical WHERE payload->>'kind' = 'ephemeral';

  -- 2) Re-scope workspace memories to their creator (user scope). The embedding
  --    rows are unaffected (the vector is over the content, not the scope).
  UPDATE harness_shared.memory_canonical
  SET payload = jsonb_set(
        jsonb_set(payload, '{user_id}', to_jsonb(payload->>'created_by'), true),
        '{scope}', '"user"'::jsonb, true)
        - 'shared'
  WHERE payload->>'user_id' LIKE 'workspace:%'
    AND coalesce(payload->>'created_by', '') <> '';

  -- 3) Drop any creator-less workspace rows (cannot be re-scoped) + their vectors.
  IF has_vec_openai THEN
    DELETE FROM harness_shared.memory_vec_openai v
    USING harness_shared.memory_canonical m
    WHERE v.memory_id = m.id AND m.payload->>'user_id' LIKE 'workspace:%';
  END IF;
  IF has_vec_local THEN
    DELETE FROM harness_shared.memory_vec_local v
    USING harness_shared.memory_canonical m
    WHERE v.memory_id = m.id AND m.payload->>'user_id' LIKE 'workspace:%';
  END IF;
  DELETE FROM harness_shared.memory_canonical WHERE payload->>'user_id' LIKE 'workspace:%';
END $$;

COMMIT;
