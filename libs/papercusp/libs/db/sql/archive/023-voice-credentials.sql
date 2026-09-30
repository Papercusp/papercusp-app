-- 023-voice-credentials.sql
--
-- Closes the gap left by 020 (operator_credentials): voice-credentials.ts
-- still wrote ~/.papercusp/credentials.json directly even though credentials.ts
-- had migrated to operator_credentials in PG. Both modules used the same
-- physical file with different shapes (flat keys vs nested per-service
-- objects). With credentials.ts on PG and voice-credentials.ts on disk,
-- writes to one didn't show up in the other.
--
-- Splitting voice keys into their own table is intentional: separate
-- security surface (operator_credentials has anthropic/openai/github
-- system-level keys; this table holds per-voice-engine API keys), and
-- the read paths are different (10 voice/STT/TTS bootstrap routes here
-- vs the single /api/credentials caller for operator_credentials).
--
-- NOT published to Zero (credentials must not broadcast over WS).

CREATE TABLE IF NOT EXISTS harness_shared.operator_voice_credentials (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);
