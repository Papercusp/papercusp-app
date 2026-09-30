-- 223-voice-relay-state.sql
--
-- EI-300 leg 1: `harness_shared.voice_relay` — the P2P voice blind-relay
-- state (relayKeys / serve / serverSeed, holepunch-voice-channels P-013/D-009).
--
-- voice-node/voice-relay.ts has read/written this operator-state key since
-- D-009 landed, but NO migration ever created the table: every read on a
-- fresh embedded-PG boot (production .deb first run) logs
--   ERROR: relation "harness_shared.voice_relay" does not exist
-- and the module's catch silently returns {} — so relay state could never
-- actually persist. Dev boxes hid it the same way (the catch), which is why
-- only the prod-build first-run leg caught it.
--
-- One JSONB row per workspace, the operator-state pattern; PK + RLS mirror
-- the voice-family sibling operator_voice_channels (migration 164).
-- Idempotent; the migration runner provides the transaction.

CREATE TABLE IF NOT EXISTS harness_shared.voice_relay (
    workspace_id text NOT NULL,
    payload jsonb NOT NULL,
    updated_at bigint DEFAULT 0 NOT NULL
);

DO $body$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'voice_relay_pkey'
  ) THEN
    ALTER TABLE ONLY harness_shared.voice_relay
      ADD CONSTRAINT voice_relay_pkey PRIMARY KEY (workspace_id);
  END IF;
END
$body$;

ALTER TABLE harness_shared.voice_relay ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS voice_relay_workspace_isolation ON harness_shared.voice_relay;
CREATE POLICY voice_relay_workspace_isolation ON harness_shared.voice_relay USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
