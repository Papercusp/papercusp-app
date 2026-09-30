-- 462-agent-facts-fed-key.sql — F1-1 wire-correctness fix over mig 461.
-- capture_substrate_outbox takes ONE key column (TG_ARGV[0]); a fact's bare
-- `key` is NOT unique across scopes, so two different facts would share a
-- hyperbee hbKey slot and LWW-clobber each other ON THE WIRE. Add a STORED
-- generated column carrying the full identity and re-point the triggers at it.
-- Idempotent.

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE harness_shared.agent_facts
  ADD COLUMN IF NOT EXISTS fed_key text GENERATED ALWAYS AS
    (scope || '/' || coalesce(scope_ref, '') || '/' || key) STORED;

DROP TRIGGER IF EXISTS capture_agent_facts_outbox_ins_trg ON harness_shared.agent_facts;
DROP TRIGGER IF EXISTS capture_agent_facts_outbox_del_trg ON harness_shared.agent_facts;
DROP TRIGGER IF EXISTS capture_agent_facts_outbox_upd_trg ON harness_shared.agent_facts;

CREATE TRIGGER capture_agent_facts_outbox_ins_trg
  AFTER INSERT ON harness_shared.agent_facts
  FOR EACH ROW WHEN (NEW.shareable = true)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('fed_key');

CREATE TRIGGER capture_agent_facts_outbox_del_trg
  AFTER DELETE ON harness_shared.agent_facts
  FOR EACH ROW WHEN (OLD.shareable = true)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('fed_key');

CREATE TRIGGER capture_agent_facts_outbox_upd_trg
  AFTER UPDATE ON harness_shared.agent_facts
  FOR EACH ROW
  WHEN ((NEW.shareable = true OR OLD.shareable = true)
    AND (OLD.body IS DISTINCT FROM NEW.body
      OR OLD.retracted_at IS DISTINCT FROM NEW.retracted_at
      OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
      OR OLD.shareable IS DISTINCT FROM NEW.shareable))
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('fed_key');

COMMIT;
