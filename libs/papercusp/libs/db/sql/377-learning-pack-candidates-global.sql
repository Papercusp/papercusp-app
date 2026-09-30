-- 377: learning_pack_candidates -> GLOBAL (data-scoping-audit-2026-06-22, P-002).
--
-- Decision (the owner's tools-and-recipes principle, plan D-004 lens): a LEARNING is
-- a reusable capability, like a tool or a code recipe — a lesson earned in one
-- workspace should help every workspace. So the fleet candidate staging area is no
-- longer workspace-scoped. The existing applies_to + scopes columns stay as the
-- TARGETING fields (global definition; applicability is a field, not a hard scope).
--
-- Mechanics: drop workspace_id; move the structural dedup from (workspace_id,
-- signature) to (signature), KEEPING the constraint name so candidates.ts's
-- `ON CONFLICT ON CONSTRAINT learning_pack_candidates_signature_uniq` is unchanged;
-- recreate the listing index without workspace_id. The pending-cap + listing reads
-- become global (intended). Backfill (D-006): collapse any duplicate signatures
-- across workspaces first (keep the earliest row) — 1 row today, no collision.
--
-- Idempotent: guarded on the workspace_id column still existing. No RLS policies or
-- triggers on this table (verified), so nothing else to migrate.

DO $mig377$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'harness_shared'
      AND table_name   = 'learning_pack_candidates'
      AND column_name  = 'workspace_id'
  ) THEN
    -- 1. dedup signatures across workspaces (keep the earliest; tiebreak on id)
    DELETE FROM harness_shared.learning_pack_candidates a
      USING harness_shared.learning_pack_candidates b
     WHERE a.signature = b.signature
       AND (a.created_at > b.created_at
            OR (a.created_at = b.created_at AND a.id > b.id));

    -- 2. swap the unique (workspace_id, signature) -> (signature), same name so the
    --    ON CONFLICT ON CONSTRAINT path in candidates.ts is untouched
    ALTER TABLE harness_shared.learning_pack_candidates
      DROP CONSTRAINT IF EXISTS learning_pack_candidates_signature_uniq;
    ALTER TABLE harness_shared.learning_pack_candidates
      ADD CONSTRAINT learning_pack_candidates_signature_uniq UNIQUE (signature);

    -- 3. recreate the listing index without workspace_id (status, created_at DESC)
    DROP INDEX IF EXISTS harness_shared.learning_pack_candidates_listing_idx;
    CREATE INDEX learning_pack_candidates_listing_idx
      ON harness_shared.learning_pack_candidates USING btree (status, created_at DESC);

    -- 4. drop the scope column
    ALTER TABLE harness_shared.learning_pack_candidates
      DROP COLUMN workspace_id;
  END IF;
END $mig377$;
