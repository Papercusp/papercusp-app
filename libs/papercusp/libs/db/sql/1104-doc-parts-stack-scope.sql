-- 1104-doc-parts-stack-scope.sql
--
-- identities-v1-2026-08-30 P-022 — the Project guide becomes BLUEPRINT-ADDRESSABLE.
--
-- Until now `harness_doc_parts.client_scope` was the only projection axis: a part
-- reached CLAUDE.md / AGENTS.md by CLIENT, and every su in a pot received the same
-- guide regardless of what it was doing. This migration adds the second axis — WHO
-- the part is for — as an ADDRESSING DECLARATION on the part:
--
--   stack_scope   text[]   tokens of the form
--                          blueprint:<identity id>   e.g. blueprint:su.fleet-leader
--                          slot:<slot id>            e.g. slot:fleet-posture
--                          role:<role>               e.g. role:su
--
-- Semantics (mirrored in packages/operator-core/lib/doc-projection/guide-address.ts):
--   * EMPTY (the default, and the state of every existing row) = UNADDRESSED: the part
--     reaches every reader exactly as before. The projector's default file is composed
--     from unaddressed parts ONLY, so nothing changes for any existing reader.
--   * NON-EMPTY = the part reaches a wearer whose stack matches ANY listed token (the
--     same `&&` OR-semantics client_scope uses). The launch path expands the wearer's
--     stack (role + every bound layer's blueprint id + slot) into tokens and reads the
--     rows whose stack_scope intersects them, then splices them after the default guide
--     through projectGuideAtBudget (the budget seam).
--
-- EXPAND-only: a new column with a default, a new partial index, two CHECKs that hold
-- trivially for every existing row. Nothing the currently-deployed release reads
-- changes shape.

ALTER TABLE harness_shared.harness_doc_parts
  ADD COLUMN IF NOT EXISTS stack_scope text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN harness_shared.harness_doc_parts.stack_scope IS
  'P-022 addressing declaration: which WEARERS this part projects to, as tokens '
  '(blueprint:<id> | slot:<slot> | role:<role>), OR-matched against the wearer''s '
  'expanded stack. Empty = unaddressed = every reader (the default file). A non-empty '
  'value keeps the part OUT of the default CLAUDE.md / AGENTS.md and delivers it only '
  'to a launch whose stack matches (role-launch-spec → composeProjectGuideForWearer).';

-- An addressed part that projects to NO client is unreachable by construction — it
-- would be "for the fleet leader" and reach no fleet leader's file. Refuse it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'harness_doc_parts_addressed_must_project'
       AND conrelid = 'harness_shared.harness_doc_parts'::regclass
  ) THEN
    ALTER TABLE harness_shared.harness_doc_parts
      ADD CONSTRAINT harness_doc_parts_addressed_must_project
      CHECK (cardinality(stack_scope) = 0 OR cardinality(client_scope) > 0);
  END IF;
END $$;

-- Token shape: `<kind>:<value>` with kind ∈ {blueprint, slot, role} and a non-blank
-- value. The VOCABULARY check (is that slot registered? does that blueprint exist?)
-- lives at the write seat (set-doc-part → validateDocPart); this CHECK only stops a raw
-- SQL write from storing a token no matcher can ever satisfy.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'harness_doc_parts_stack_scope_shape'
       AND conrelid = 'harness_shared.harness_doc_parts'::regclass
  ) THEN
    ALTER TABLE harness_shared.harness_doc_parts
      ADD CONSTRAINT harness_doc_parts_stack_scope_shape
      CHECK (
        cardinality(stack_scope) = 0
        OR array_to_string(stack_scope, ' ') ~ '^(blueprint|slot|role):[^[:space:]:]+( (blueprint|slot|role):[^[:space:]:]+)*$'
      );
  END IF;
END $$;

-- The launch path's hot read: every addressed, projecting, live part whose tokens
-- intersect the wearer's — `stack_scope && $tokens`. Partial like the projection index.
CREATE INDEX IF NOT EXISTS harness_doc_parts_stack_scope_idx
  ON harness_shared.harness_doc_parts
  USING gin (stack_scope)
  WHERE tombstone = false AND cardinality(stack_scope) > 0;
