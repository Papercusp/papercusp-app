-- 597: owner-directive slots (EI-11484).
--
-- First-class store for explicit owner directives the agent chose to record
-- (orders:record). Open rows render ABOVE the loop contract in wake prompts,
-- coord:orient, and the post-compaction anchor until dispositioned
-- (orders:disposition done|declined). This is loop:checkpoint{walls} promoted
-- to a durable store: PG-keyed to workspace+owner, so it survives session
-- death and works in non-loop sessions. Recording is agent-explicit by owner
-- ruling — no auto-capture, no imperative detection.

CREATE TABLE IF NOT EXISTS harness_shared.owner_directives (
  id                  bigserial PRIMARY KEY,
  workspace_id        text NOT NULL,
  owner_id            text NOT NULL,
  session_ref         text,
  source_turn_ref     text,
  verbatim_text       text NOT NULL,
  recorded_by         text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  dispositioned_at    timestamptz,
  disposition_status  text CHECK (disposition_status IN ('done', 'declined')),
  disposition_note    text,
  dispositioned_by    text,
  CONSTRAINT owner_directives_disposition_consistent CHECK (
    (dispositioned_at IS NULL AND disposition_status IS NULL)
    OR
    (dispositioned_at IS NOT NULL AND disposition_status IS NOT NULL)
  )
);

-- The hot query: open directives for a workspace (rendered every wake).
CREATE INDEX IF NOT EXISTS owner_directives_open_idx
  ON harness_shared.owner_directives (workspace_id, created_at)
  WHERE dispositioned_at IS NULL;

COMMENT ON TABLE harness_shared.owner_directives IS
  'Explicit owner directives recorded by agents (orders:record, EI-11484). Open rows (dispositioned_at IS NULL) render above the loop agenda in every wake/orient/compaction-anchor until dispositioned. verbatim_text is the owner''s words verbatim, never a paraphrase.';

COMMENT ON COLUMN harness_shared.owner_directives.source_turn_ref IS
  'Provenance pointer to the OWNER (interactive) turn the verbatim text came from, when the recording agent could identify it (session id + turn marker). Directives whose ref traces only to an agent-origin turn are suspect.';

COMMENT ON COLUMN harness_shared.owner_directives.verbatim_text IS
  'The owner''s directive verbatim (mandatory). Renderers excerpt with substr(), never LLM summarization.';
