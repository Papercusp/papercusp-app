-- 444-agent-facts.sql — the generalized standing-facts ledger
-- (queen-memory-hybrid-2026-07-02 L1b; owner-approved generalization + D-001
-- amendment: harness/work_item are OPTIONAL scope dimensions).
--
-- A fact is a DETERMINISTIC, scoped, TTL'd conclusion an agent asserts so it is
-- folded VERBATIM into future briefs/dossiers/orients (unlike mem0's fuzzy
-- semantic recall). Canonical example: "WI-1439 is owner-residue — exclude from
-- the placeable frontier" (the Queen re-derived this ~6 consecutive wakes on
-- 2026-07-02 because nothing carried it forward).
--
-- Scoping (D-001): scope ∈ workspace|role|owner|harness|work_item.
--   • workspace  → scope_ref NULL  (workspace-global fact)
--   • role       → scope_ref = role name (queen/bee/scout/su/…)
--   • owner      → scope_ref = ownerId  (an agent's personal fact)
--   • harness    → scope_ref = harness slug   (OPTIONAL dimension)
--   • work_item  → scope_ref = feature_id     (OPTIONAL dimension)
-- Upsert identity: (workspace_id, scope, coalesce(scope_ref,''), key).
--
-- Idempotent. Applied via the runner (db:migrate) so schema_migrations records it.

CREATE TABLE IF NOT EXISTS harness_shared.agent_facts (
  workspace_id  text        NOT NULL,
  scope         text        NOT NULL CHECK (scope IN ('workspace','role','owner','harness','work_item')),
  scope_ref     text,                 -- NULL only for scope='workspace' (enforced below)
  key           text        NOT NULL, -- stable slug; the upsert/supersede target
  body          text        NOT NULL CHECK (char_length(body) <= 500),
  source_ref    text,                 -- optional anchor: WI-/EI-/plan slug that proved the fact
  created_by    text        NOT NULL, -- ownerId / role of the asserting agent
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL, -- TTL is mandatory (default applied by the tool: 7d)
  retracted_at  timestamptz,          -- soft-retract: excluded from folds, kept for audit
  CHECK (scope = 'workspace' OR scope_ref IS NOT NULL)
);

-- Upsert identity (nullable scope_ref folded to '' so the unique index is total).
CREATE UNIQUE INDEX IF NOT EXISTS agent_facts_identity
  ON harness_shared.agent_facts (workspace_id, scope, coalesce(scope_ref, ''), key);

-- The fold read: live facts for a scope, newest first.
CREATE INDEX IF NOT EXISTS agent_facts_fold
  ON harness_shared.agent_facts (workspace_id, scope, scope_ref, expires_at)
  WHERE retracted_at IS NULL;
