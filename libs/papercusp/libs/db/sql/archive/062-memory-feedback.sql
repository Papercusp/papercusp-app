-- Plan 3 — memory feedback signal capture.
--
-- Records every user-driven action on a memory (edit, delete) so we
-- have learning signal for future tuning of mem0's extraction prompt.
-- Aggregate stats: which memories get edited most, which get deleted
-- shortly after creation, etc.
--
-- We deliberately do NOT FK to mem0's vector table — mem0 owns its
-- own schema and may rotate it. mem_id is the opaque mem0 row id.

CREATE TABLE IF NOT EXISTS harness_shared.memory_feedback (
  id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  mem_id      text        NOT NULL,
  user_id     uuid        NOT NULL,
  workspace_id text       NOT NULL,
  action      text        NOT NULL CHECK (action IN ('edit', 'delete', 'forget_all')),
  -- mem0 metadata.kind snapshot at action time (preference/project/...).
  -- Lets the learning loop emit per-kind extraction hints without
  -- another lookup against the (possibly-deleted) memory row.
  kind        text,
  -- For edits: snapshot of the prior memory text so we can later
  -- compare what mem0 extracted vs what the user actually wanted.
  prior_text  text,
  new_text    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE harness_shared.memory_feedback
  ADD COLUMN IF NOT EXISTS kind text;

CREATE INDEX IF NOT EXISTS memory_feedback_user_idx
  ON harness_shared.memory_feedback (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_feedback_mem_idx
  ON harness_shared.memory_feedback (mem_id);
