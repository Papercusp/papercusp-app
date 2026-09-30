-- Migration 901 — rich Papercup conversations bound to work items.
--
-- `operator_conversations` remains the transcript/card authority.  Global
-- Papercup chat rows keep subject_kind='global' + status='active'; a work-item
-- thread is a distinct subject_kind='work-item' + status='scoped' row whose
-- operator_turns retain the same rich tools/report/answer persistence.
--
-- `scoped` is deliberately not `active`: the release deployed before this
-- migration filters only status='active' and therefore cannot accidentally
-- select a newly-created work-item thread as the workspace-global chat during
-- the expand/deploy window.

ALTER TABLE harness_shared.operator_conversations
  ADD COLUMN IF NOT EXISTS subject_kind text NOT NULL DEFAULT 'global',
  ADD COLUMN IF NOT EXISTS subject_ref text;

COMMENT ON COLUMN harness_shared.operator_conversations.subject_kind IS
  'Conversation subject discriminator: global = workspace Papercup chat; work-item = a rich Papercup thread attached to one work item.';

COMMENT ON COLUMN harness_shared.operator_conversations.subject_ref IS
  'Subject id when subject_kind is not global. For work-item conversations this is the WI-/EI-/F- id; NULL for the global chat.';

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'harness_shared.operator_conversations'::regclass
       AND conname = 'operator_conversations_subject_shape_check'
  ) THEN
    ALTER TABLE harness_shared.operator_conversations
      ADD CONSTRAINT operator_conversations_subject_shape_check
      CHECK (
        (
          subject_kind = 'global'
          AND subject_ref IS NULL
          AND status <> 'scoped'
        )
        OR
        (
          subject_kind = 'work-item'
          AND subject_ref IS NOT NULL
          AND subject_ref <> ''
          AND harness_slug IS NOT NULL
          AND harness_slug <> ''
          AND status = 'scoped'
        )
      ) NOT VALID;
  END IF;
END
$migration$;

ALTER TABLE harness_shared.operator_conversations
  VALIDATE CONSTRAINT operator_conversations_subject_shape_check;

-- FORWARD-COMPAT: The currently deployed release inserts only status='active'
-- global rows, which inherit subject_kind='global'; this work-item-only
-- uniqueness predicate cannot reject or redirect any write that release makes.
CREATE UNIQUE INDEX IF NOT EXISTS operator_conversations_work_item_subject_uq
  ON harness_shared.operator_conversations
    (workspace_id, harness_slug, subject_ref)
  WHERE subject_kind = 'work-item';
