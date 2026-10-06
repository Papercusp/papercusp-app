-- 1302 — Personal Vault reader-set labels: owner privacy rules + the
-- per-agent disclosure ledger.
--
-- Plan personal-data-reader-set-labels-2026-10-01 P-001 (WI-10004864),
-- decisions D-001..D-003. [owner 2026-09-29 #950]: an agent that has read
-- an email of a given privacy level may, while that content is in its context,
-- send only to the people the email came from.
--
--   personal_privacy_rules — OWNER-authored rules mapping a document to a
--     privacy level. Absent a matching rule a document is `unrestricted`
--     (D-001), which preserves pre-existing behaviour.
--   personal_disclosures   — append-only ledger: one row per restricted
--     document delivered to one agent identity, with the reader set derived
--     from the document's real headers (never its body). Outbound capability
--     verbs intersect the caller's ACTIVE rows and refuse any recipient outside
--     the intersection. A row is released only by a verified owner directive
--     (D-002); there is no TTL (D-003).
--
-- Expand-only and idempotent. Every object is new, so the currently deployed
-- release neither reads nor writes it; the one FORWARD-COMPAT note below records
-- why its partial unique index cannot strand a deployed ON CONFLICT.

CREATE TABLE IF NOT EXISTS harness_shared.personal_privacy_rules (
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  workspace_id text        NOT NULL,
  user_id      uuid        NOT NULL REFERENCES harness_shared.users(id) ON DELETE CASCADE,
  -- What the rule matches. `source` = a vault source (e.g. 'gmail');
  -- `sender` = an exact normalized address; `sender-domain` = the part after @.
  match_kind   text        NOT NULL CHECK (match_kind IN ('source', 'sender', 'sender-domain')),
  match_value  text        NOT NULL CHECK (length(btrim(match_value)) > 0),
  level        text        NOT NULL CHECK (level IN ('unrestricted', 'participants', 'sender-only')),
  created_by   text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text        NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- Owner directive that authorized a LOOSENING edit (D-002); NULL for a rule
  -- that has only ever been created or tightened.
  authority_ref text,
  PRIMARY KEY (workspace_id, user_id, id),
  UNIQUE (workspace_id, user_id, match_kind, match_value)
);

CREATE TABLE IF NOT EXISTS harness_shared.personal_disclosures (
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  workspace_id  text        NOT NULL,
  user_id       uuid        NOT NULL REFERENCES harness_shared.users(id) ON DELETE CASCADE,
  -- The agent identity the content was delivered to (resolveAgentIdentity
  -- ownerId). Persists across compaction / carry-respawn by design (D-003).
  agent_owner_id text       NOT NULL CHECK (length(btrim(agent_owner_id)) > 0),
  document_id   uuid        NOT NULL,
  source        text        NOT NULL,
  level         text        NOT NULL CHECK (level IN ('participants', 'sender-only')),
  -- Normalized addresses permitted to receive this content, derived from
  -- headers only. The owner's own addresses are always implicitly permitted.
  reader_set    text[]      NOT NULL,
  delivered_via text        NOT NULL,
  delivered_at  timestamptz NOT NULL DEFAULT now(),
  released_at   timestamptz,
  released_by   text,
  release_ref   text,
  PRIMARY KEY (workspace_id, user_id, id),
  CHECK ((released_at IS NULL) = (release_ref IS NULL))
);

-- One ACTIVE row per (agent, document): re-reading the same document is not a
-- new disclosure. A released row does not block a later re-disclosure.
-- FORWARD-COMPAT: personal_disclosures is created by this same migration, so no deployed release has any ON CONFLICT statement against it that this partial index could fail to arbitrate.
CREATE UNIQUE INDEX IF NOT EXISTS personal_disclosures_active_uniq
  ON harness_shared.personal_disclosures (workspace_id, user_id, agent_owner_id, document_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS personal_disclosures_agent_active_idx
  ON harness_shared.personal_disclosures (workspace_id, agent_owner_id)
  WHERE released_at IS NULL;
