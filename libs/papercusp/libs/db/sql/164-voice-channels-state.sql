-- 164: operator_voice_channels — P2P voice-channel registry (one JSONB row per
-- workspace, the operator-state pattern). Plan holepunch-voice-channels-2026-06-05
-- P-007 / D-011. Payload shape: { channels: [{ id, name, topicHex, createdAt }] }.
-- Idempotent; mirrors operator_voice_prefs (PK + RLS workspace isolation).

CREATE TABLE IF NOT EXISTS harness_shared.operator_voice_channels (
    workspace_id text NOT NULL,
    payload jsonb NOT NULL,
    updated_at bigint DEFAULT 0 NOT NULL
);

DO $body$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operator_voice_channels_pkey'
  ) THEN
    ALTER TABLE ONLY harness_shared.operator_voice_channels
      ADD CONSTRAINT operator_voice_channels_pkey PRIMARY KEY (workspace_id);
  END IF;
END
$body$;

ALTER TABLE harness_shared.operator_voice_channels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS operator_voice_channels_workspace_isolation ON harness_shared.operator_voice_channels;
CREATE POLICY operator_voice_channels_workspace_isolation ON harness_shared.operator_voice_channels USING ((workspace_id = current_setting('app.workspace_id'::text, true))) WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
