-- 461-agent-facts-federation.sql — F1-1 of federated-scout-gym-learning-2026-07-02.
-- SHAREABLE standing facts federate as table ops over the hive peer-log, exactly
-- like hive_settings (mig 186): capture triggers enqueue local writes via
-- capture_substrate_outbox; the agent-facts projection applies inbound ops.
--
-- H6 (peer-review D-005): facts are OBSERVATIONS, not consensus — the apply side
-- partitions by SOURCE so peers can never clobber each other's facts. Local rows
-- keep source_hive NULL; foreign rows carry the RECEIVER-STAMPED source (from the
-- admitted log identity, never sender-claimed). The identity index is extended
-- with the source dimension.
--
-- Privacy (D-006, owner-ratified): only shareable=true rows capture (trigger WHEN
-- clause) — hive-private facts never reach the outbox at all.
-- Idempotent; apply via runner or psql + schema_migrations row in one txn.

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE harness_shared.agent_facts
  ADD COLUMN IF NOT EXISTS harness_slug  text,          -- the Hive home slug (federation identity carrier; NULL = un-hived local fact)
  ADD COLUMN IF NOT EXISTS author_pubkey text,
  ADD COLUMN IF NOT EXISTS origin        text NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS fed_ts        bigint,
  ADD COLUMN IF NOT EXISTS source_hive   text;          -- receiver-stamped foreign source (NULL = locally authored)

-- Rebuild the identity to include the source dimension (H6: per-source partitioning).
DROP INDEX IF EXISTS harness_shared.agent_facts_identity;
CREATE UNIQUE INDEX IF NOT EXISTS agent_facts_identity
  ON harness_shared.agent_facts (workspace_id, scope, coalesce(scope_ref, ''), key, coalesce(source_hive, ''));

-- Federation capture: SHAREABLE rows only (privacy default D-006). The echo-guard
-- in capture_substrate_outbox already skips origin<>'local' (inbound applies never
-- re-capture). key column for the op = `key` (TG_ARGV[0]).
CREATE OR REPLACE TRIGGER capture_agent_facts_outbox_ins_trg
  AFTER INSERT ON harness_shared.agent_facts
  FOR EACH ROW
  WHEN (NEW.shareable = true)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('key');

CREATE OR REPLACE TRIGGER capture_agent_facts_outbox_del_trg
  AFTER DELETE ON harness_shared.agent_facts
  FOR EACH ROW
  WHEN (OLD.shareable = true)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('key');

-- UPDATE captures only when a FEDERATED field changes AND the row is (or was)
-- shareable — a private fact's edits never reach the outbox; flipping shareable
-- off captures once (peers apply the retraction of sharing).
CREATE OR REPLACE TRIGGER capture_agent_facts_outbox_upd_trg
  AFTER UPDATE ON harness_shared.agent_facts
  FOR EACH ROW
  WHEN ((NEW.shareable = true OR OLD.shareable = true)
    AND (OLD.body IS DISTINCT FROM NEW.body
      OR OLD.retracted_at IS DISTINCT FROM NEW.retracted_at
      OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
      OR OLD.shareable IS DISTINCT FROM NEW.shareable))
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('key');

COMMIT;
