-- 690-agent-facts-depends-on-kind-claim.sql
--
-- unified-agent-state-plane-2026-07-27, P-008 (b): `harness_shared.agent_facts`
-- gains the three columns that turn it into the ASSUMPTION substrate D-019
-- specifies, rather than only a conclusions ledger.
--
--   depends_on jsonb — the CELLS this fact rests on, captured AT ASSERT TIME.
--   kind       text  — conclusion | assumption | convention (D-019 DEFECT 1).
--   claim      jsonb — the optional TYPED assertion P-011 compares (DEFECT 2).
--
-- All three land in ONE migration deliberately. They are one ALTER on a hot
-- table, they share a fixture list and a schema pull, and D-019 specifies them
-- as one change ("P-008 must add a `kind` discriminator alongside the version
-- and `dependsOn` changes"). Splitting them would buy nothing and cost this
-- table three separate rewrites.
--
-- ── depends_on: WHY THE DIGEST IS CAPTURED AT ASSERT TIME ────────────────────
--
-- D-007: an assumption "auto-invalidates when a declared dependency changes, so
-- no agent has to remember to retract". To decide that mechanically you need to
-- know what the dependency LOOKED LIKE when the claim was made — otherwise
-- "changed" is unanswerable and staleness stays the judgement call D-012 says it
-- must stop being.
--
-- A cell has no version counter to read: `CellSpec.changeSignal` is
-- `{ kind:'poll', tool, path }`, i.e. a POINTER to a resolver, and the value
-- only exists once something dispatches that tool. So the anchor is a DIGEST of
-- the observed value, taken at assert time, compared against a fresh read later.
-- Shape (see `FactDependency` in agent-facts/store.ts):
--
--   [{ "cell": "pipeline.myChange", "observedAt": "2026-07-27T…Z",
--      "digest": "9f2b…", "observed": "deployed" }]
--   [{ "cell": "gate.greenCheckpoint.verdict", "observedAt": "…",
--      "unknown": "not-measured" }]      -- honest: unreadable at assert time
--
-- A dependency that could NOT be read when the fact was filed stores its
-- enumerated `unknown` code instead of a digest. That is the honest record — it
-- is later reported `undeterminable`, never silently `fresh`, because a
-- comparison against a value that was never observed is not a comparison.
--
-- jsonb (not a side table) for the same reason `source_provenance` is jsonb:
-- it is read on exactly the paths that already read the fact row, it is bounded
-- (a handful of cells), and a join per folded fact on a hot read is precisely
-- what D-003 rejects. Bounded in code, not by a CHECK — an over-long
-- declaration should clip like a body, never fail the write (the P-007
-- never-lose-a-write rule this table already follows).
--
-- ── kind: WHY `scope` CANNOT SUBSTITUTE (D-019 DEFECT 1) ─────────────────────
--
-- `scope` (workspace|role|owner|harness|work_item) says WHO a fact is about, not
-- WHAT KIND of claim it is. Conventions are normative, assumptions provisional,
-- conclusions settled — three modalities needing different fold behaviour and
-- distinct discoverability (P-011 must find ASSUMPTIONS specifically; P-018 must
-- find CONVENTIONS specifically). Workspace-scope CORRELATES with conventions
-- but is not identical to them, so correlation cannot discriminate.
--
-- NULLABLE, and null is NOT silently rewritten to 'conclusion'. Every one of the
-- ~N existing rows predates the discriminator, and backfilling them to
-- 'conclusion' would be inventing a modality nobody declared — the same
-- manufactured-certainty defect `confidence` (mig 671) deliberately avoided by
-- leaving legacy rows unbadged. Absent means "not declared", which reads
-- correctly; a wrong non-null value would not.
--
-- ── claim: THE TYPED FIELD P-011 COMPARES (D-019 DEFECT 2) ───────────────────
--
-- P-011 (contradiction detection) is specified as "TYPED fields only — do not
-- attempt prose contradiction detection", but `body` is free text under a
-- char_length CHECK, so as written P-011 had NOTHING to compare and was
-- unbuildable. `claim` is that field, e.g.
--   { "subject": "cell:gate.greenCheckpoint.verdict", "assertion": "unrelated-to-my-change" }
-- Prose `body` remains what agents and humans read; `claim` is what a detector
-- compares. A fact filed WITHOUT a claim stays valid and still folds — it is
-- simply invisible to the detector, which is the honest degradation rather than
-- a gate that would suppress facts to feed a consumer that does not exist yet.

-- NOTE: no top-level BEGIN/COMMIT here. The migration runner already wraps every
-- file in BEGIN … <ddl> … <schema_migrations INSERT> … COMMIT
-- (embedded-postgres-server/src/migration-runner.js), so an inner COMMIT ends that
-- transaction EARLY and the ledger INSERT then lands outside it — the migration can
-- apply without being recorded and re-runs on every boot. Enforced by
-- `lint:migrations` check 2.

ALTER TABLE harness_shared.agent_facts
  ADD COLUMN IF NOT EXISTS depends_on jsonb,
  ADD COLUMN IF NOT EXISTS kind text,
  ADD COLUMN IF NOT EXISTS claim jsonb;

-- The discriminator's vocabulary is CLOSED, enforced here rather than only in
-- TypeScript — mirroring how `confidence` (mig 671) and `scope` (mig 444) are
-- both constrained in the DB. The read side still parses defensively
-- (parseFactKind), because a CHECK does not protect against a future migration
-- widening the column and an old reader mapping the new value onto a modality
-- it does not have.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_facts_kind_check'
       AND conrelid = 'harness_shared.agent_facts'::regclass
  ) THEN
    ALTER TABLE harness_shared.agent_facts
      ADD CONSTRAINT agent_facts_kind_check
      CHECK (kind IS NULL OR kind IN ('conclusion', 'assumption', 'convention'));
  END IF;
END $$;

COMMENT ON COLUMN harness_shared.agent_facts.depends_on IS
  'P-008 (b) — the CELLS this fact rests on, captured AT ASSERT TIME as '
  '[{cell, observedAt, digest?, observed?, unknown?}]. `digest` is a stable hash of the '
  'value the cell resolved to when the fact was filed; a fresh read that digests '
  'differently makes the fact STALE mechanically (D-007/D-012) instead of by '
  'judgement. A dependency unreadable at assert time stores its enumerated `unknown` '
  'code instead, and is later reported undeterminable — never silently fresh.';
COMMENT ON COLUMN harness_shared.agent_facts.kind IS
  'P-008 (b) / D-019 DEFECT 1 — the claim MODALITY: conclusion (settled) | assumption '
  '(provisional, pairs with depends_on) | convention (normative, P-018). Orthogonal to '
  '`scope`, which says who the fact is ABOUT, not what kind of claim it is. NULL = not '
  'declared (every pre-migration row); never backfilled, because inventing a modality '
  'nobody declared is the defect the nullable `confidence` column already avoids.';
COMMENT ON COLUMN harness_shared.agent_facts.claim IS
  'P-008 (b) / D-019 DEFECT 2 — the optional TYPED assertion P-011 compares, e.g. '
  '{subject:"cell:gate.greenCheckpoint.verdict", assertion:"unrelated-to-my-change"}. '
  '`body` stays the prose humans and agents read. A fact without a claim is valid and '
  'still folds; it is simply invisible to the contradiction detector.';

-- Finding the ASSUMPTIONS in a scope is P-011's and D-050's central read ("does
-- this close rest on a fact that has gone stale?"), and it must not seq-scan a
-- table whose whole point is being read on every orient. Partial on the same
-- predicate as `agent_facts_fold` so it stays a small index over live current
-- rows only, and leading with `kind` so the discriminator is the access path
-- rather than a filter applied after the fact.
CREATE INDEX IF NOT EXISTS agent_facts_kind
  ON harness_shared.agent_facts
     (workspace_id, kind, scope, scope_ref)
  WHERE kind IS NOT NULL AND retracted_at IS NULL AND superseded_at IS NULL;
