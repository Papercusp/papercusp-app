-- Voice utterance audit. Per /docs/agents/operator-persona §10d/§10e.
--
-- Logs per-utterance shape data for the persona-drift audit:
--   - mode distribution (target ~5% wry, ~80% default)
--   - name-use rate (target ~1 per 5-min window)
--   - backstory fires (target ≤3 per session)
--   - banned-preamble strips (target 0)
--   - company-name leakage (target 0)
--
-- Logged from prepareForTTS in the legacy path. EL Conv AI utterances
-- aren't logged here yet (no pre-TTS interception); a future EL
-- post-process webhook will fill that gap.

CREATE TABLE IF NOT EXISTS harness_shared.voice_utterances (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  workspace     TEXT,
  source        TEXT NOT NULL,            -- 'legacy' | 'elevenlabs-conv' | 'realtime'
  mode          TEXT,                     -- 'default' | 'assertive' | 'sober' | 'apologetic' | 'wry' | 'narration'
  length_chars  INT,
  name_used     BOOLEAN NOT NULL DEFAULT FALSE,
  had_backstory BOOLEAN NOT NULL DEFAULT FALSE,
  modifications JSONB                     -- prepareForTTS modifications array
);

CREATE INDEX IF NOT EXISTS voice_utterances_ts_idx
  ON harness_shared.voice_utterances (ts DESC);
CREATE INDEX IF NOT EXISTS voice_utterances_mode_idx
  ON harness_shared.voice_utterances (mode, ts DESC);

GRANT SELECT, INSERT ON harness_shared.voice_utterances TO harness_app;
GRANT USAGE, SELECT ON SEQUENCE harness_shared.voice_utterances_id_seq TO harness_app;
