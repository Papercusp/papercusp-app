-- 796-conversation-supersession.sql — EI-20187673450579221
--
-- Retiring an owner question by sending a plain coordination message leaves
-- the old coord_conversations row as the only open gate. Keep the replacement
-- in the same durable conversation surface and retain an explicit pointer from
-- the old row so readers can render it as retracted instead of open.
--
-- No top-level BEGIN/COMMIT: the migration runner wraps each file in one
-- transaction and records it in schema_migrations.

ALTER TABLE harness_shared.coord_conversations
  ADD COLUMN IF NOT EXISTS superseded_by text,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

ALTER TABLE harness_shared.coord_conversations
  -- FORWARD-COMPAT: the replacement CHECK preserves every pre-existing
  -- open/resolved/closed value; the deployed release never writes superseded,
  -- so replacing this constraint cannot reject an older release's writes.
  DROP CONSTRAINT IF EXISTS coord_conversations_state_check;

ALTER TABLE harness_shared.coord_conversations
  ADD CONSTRAINT coord_conversations_state_check
  CHECK (state = ANY (ARRAY['open'::text, 'resolved'::text, 'closed'::text, 'superseded'::text]));

COMMENT ON COLUMN harness_shared.coord_conversations.superseded_by IS
  'EI-20187673450579221: replacement conversation id when this gate was retracted; superseded rows are not answerable.';

COMMENT ON COLUMN harness_shared.coord_conversations.superseded_at IS
  'EI-20187673450579221: timestamp at which the old gate was atomically retired in favor of superseded_by.';

CREATE INDEX IF NOT EXISTS coord_conversations_superseded_by_idx
  ON harness_shared.coord_conversations (workspace_id, superseded_by)
  WHERE superseded_by IS NOT NULL;
