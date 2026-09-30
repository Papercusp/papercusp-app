-- 689-agent-facts-append-versioning.sql
--
-- unified-agent-state-plane-2026-07-27, P-008 (a): append-versioning for
-- `harness_shared.agent_facts`, so a corrected fact APPENDS a new version
-- instead of destroying the old one.
--
-- WHY. D-003's invariant is "a pointed-at record is never mutated — corrections
-- append, and the pointer keeps naming the old one." `agent_facts` violates it
-- today: `agent_facts_identity` is UNIQUE on
-- (workspace_id, scope, scope_ref, key, source_hive), so `assertFact`'s
-- ON CONFLICT DO UPDATE overwrites `body` in place. P-009 is specified to stamp
-- an `assumption_set_id` pointing AT a fact record; against an in-place-mutated
-- row that pointer silently names different content than it did when stamped,
-- which is exactly the "value that can be wrong and then needs re-verifying"
-- pattern D-003 exists to forbid.
--
-- THE SHAPE. Each version is its own row with its own immutable `id`. The
-- CURRENT version is the one with `superseded_at IS NULL`; `supersedes_id`
-- chains a version to the one it replaced, so the history is walkable in either
-- direction. Nothing is deleted here — `sweepExpiredFacts` remains the only
-- reaper, and it is what bounds version-chain growth.
--
-- ⚠ THE UNIQUE INDEX BECOMES PARTIAL, AND THAT IS A BREAKING CHANGE FOR EVERY
-- `ON CONFLICT` SITE. PostgreSQL infers a conflict target by matching a unique
-- index; once the index carries a predicate, an inference spec WITHOUT that
-- predicate matches NO index and the statement fails AT PLAN TIME — every write,
-- not just conflicting ones. This table has already been broken exactly this way
-- once: migration 461 widened the identity to 5 columns and the surviving
-- 4-column spec errored EVERY assert, so there were ZERO fact writes until it
-- was caught on 2026-07-03. Both remaining ON CONFLICT sites
-- (`agent-facts/store.ts`, `sync/hyperbee/projections/agent-facts.ts`) are
-- updated in the same change to carry `WHERE superseded_at IS NULL`.
--
-- SCOPE OF VERSIONING: the LOCAL partition (`source_hive IS NULL`). A federated
-- row is a remote peer's CURRENT observation, already last-write-wins by
-- `fed_ts` and never the target of a local pointer; versioning foreign
-- observations would multiply rows by peer × version to no reader's benefit.
-- The federation projection therefore keeps upserting the live row — it only
-- has to name the new index predicate.

-- NOTE: no top-level BEGIN/COMMIT here. The migration runner already wraps every
-- file in BEGIN … <ddl> … <schema_migrations INSERT> … COMMIT
-- (embedded-postgres-server/src/migration-runner.js), so an inner COMMIT ends that
-- transaction EARLY and the ledger INSERT then lands outside it — the migration can
-- apply without being recorded and re-runs on every boot. Enforced by
-- `lint:migrations` check 2.

-- (1) The version columns. Both nullable: every EXISTING row is, correctly, a
-- current version that supersedes nothing.
ALTER TABLE harness_shared.agent_facts
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  ADD COLUMN IF NOT EXISTS supersedes_id bigint;

COMMENT ON COLUMN harness_shared.agent_facts.superseded_at IS
  'NULL = this is the CURRENT version of its identity. Non-NULL = a prior version, '
  'kept immutable so a pointer taken when it was current still resolves to what it '
  'then said (D-003). Set by the supersede-then-insert in assertFact.';
COMMENT ON COLUMN harness_shared.agent_facts.supersedes_id IS
  'The agent_facts.id of the version this row replaced; NULL for the first version '
  'of an identity. Chains the history so it is walkable without re-deriving identity.';

-- (2) Swap the identity index for its partial form. Uniqueness now constrains
-- only CURRENT versions — which is precisely the invariant that was always
-- meant: one live value per (workspace, scope, ref, key, source), with the
-- superseded tail unconstrained.
--
-- Order matters: create the new index BEFORE dropping the old one so the
-- identity is never briefly unprotected, and so a re-run finds the new one
-- already present.
CREATE UNIQUE INDEX IF NOT EXISTS agent_facts_identity_current
  ON harness_shared.agent_facts
     (workspace_id, scope, COALESCE(scope_ref, ''::text), key, COALESCE(source_hive, ''::text))
  WHERE superseded_at IS NULL;

DROP INDEX IF EXISTS harness_shared.agent_facts_identity;

-- (3) History reads walk an identity's versions newest-first. The fold/list
-- indexes are all partial on `retracted_at IS NULL` and none of them lead with
-- `key`, so a version-chain read would seq-scan without this.
CREATE INDEX IF NOT EXISTS agent_facts_version_chain
  ON harness_shared.agent_facts
     (workspace_id, scope, COALESCE(scope_ref, ''::text), key, superseded_at DESC);

-- (4) The hot read paths (fold / shareable) must not have to consider
-- superseded rows at all. Both existing partial indexes are re-created with
-- `superseded_at IS NULL` folded into the predicate, so the version tail never
-- enters a fold scan as the table grows.
DROP INDEX IF EXISTS harness_shared.agent_facts_fold;
CREATE INDEX IF NOT EXISTS agent_facts_fold
  ON harness_shared.agent_facts
     (workspace_id, scope, scope_ref, expires_at)
  WHERE retracted_at IS NULL AND superseded_at IS NULL;

DROP INDEX IF EXISTS harness_shared.agent_facts_shareable;
CREATE INDEX IF NOT EXISTS agent_facts_shareable
  ON harness_shared.agent_facts
     (workspace_id, scope, expires_at)
  WHERE shareable = true AND retracted_at IS NULL AND superseded_at IS NULL;
