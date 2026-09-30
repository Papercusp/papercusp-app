-- 015_operator_turns_tools.sql
--
-- Add `tools jsonb` to harness_shared.operator_turns so the operator
-- chat sidebar can persist tool-call entries (specifically
-- chat:ask_choice cards) alongside the turn text. Without this, the
-- assistant's tool array is in-memory-only and cards disappear on
-- page reload.
--
-- Shape stored in the column (matches ChatToolCall + an optional
-- `answered` field):
--   [
--     {
--       "name": "chat:ask_choice",
--       "args": { "question": "...", "options": [...] },
--       "answered": { "option_id": "yes", "label": "Yes", "at": 1778524800000 }
--     },
--     ...
--   ]
--
-- Nullable on purpose — existing rows pre-migration have no tools, app
-- code treats NULL the same as `[]`.
--
-- IDEMPOTENCY: column-existence check so re-running is a no-op.

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'harness_shared'
      AND table_name = 'operator_turns'
      AND column_name = 'tools'
  ) THEN
    ALTER TABLE harness_shared.operator_turns
      ADD COLUMN tools jsonb;
    RAISE NOTICE '[015] added operator_turns.tools jsonb';
  END IF;
END
$migration$;
