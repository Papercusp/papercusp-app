-- 732-coord-event-log-supersession.sql
--
-- plan agent-epistemics-2026-08-02 P-004 — MAKE A DELIVERED MESSAGE ADDRESSABLE.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
-- A wrong broadcast to 17 agents can today be corrected only by ANOTHER
-- broadcast to 17 agents. That invites a counter-retraction, and the Nth flip
-- carries LESS information than the first — the 2026-08-02 morning produced
-- 4+ public retractions across 16–17 recipients, and the reviewing agent's
-- verdict was that the retraction cascade, not any single wrong answer, was
-- the expensive part.
--
-- `plans:add-decision` exists for exactly this reason, and CLAUDE.md states the
-- principle plainly: "a message is not addressable after delivery, so a peer who
-- received a wrong paraphrase has no way back to the source. A decision is."
-- But that covers RULINGS. What actually cascaded was an OBSERVATION, which had
-- no equivalent — so the only tool left was another broadcast.
--
-- ── WHY THESE TWO COLUMNS ARE ENOUGH ─────────────────────────────────────────
-- The audience problem is ALREADY solved and simply unused: coord_event_log.body
-- preserves the original envelope, including `to` (the recipient selectors as
-- sent) and `from`. So a correction can re-resolve the ORIGINAL audience from the
-- stored row — the sender never re-addresses N recipients by hand, which is the
-- "without an N-recipient counter-broadcast" half of the ask.
--
-- What is missing is only the BACK-POINTER: nothing records that a message has
-- been corrected. Without it a peer running coord:catch-up after the fact reads
-- the original as live and acts on retracted information — the silent half of the
-- cascade, and the one nobody notices because it produces no message at all.
--
--   superseded_by_msg_id — the correction's msg_id. A POINTER, not a copy: the
--                          correction is itself an ordinary coord message with
--                          its own row, audience and history, so storing its id
--                          keeps exactly one source of truth for the new claim.
--   superseded_at        — when. Distinguishes "corrected" from "never
--                          corrected" without needing to join to find out.
--
-- Deliberately NOT a `retracted` boolean: a retraction that does not say what
-- REPLACES it strands the reader in the same way an exit-less `undecidable`
-- does (see migration 730). Superseded-BY is the honest shape — every retraction
-- names its successor.
--
-- NULLABLE and unindexed-by-default: the overwhelming majority of messages are
-- never superseded, so this must cost nothing on the write path. The partial
-- index covers only the corrected rows, which is a tiny minority.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS. Adding a
-- nullable column with no DEFAULT is metadata-only and never rewrites the table.

ALTER TABLE harness_shared.coord_event_log
  ADD COLUMN IF NOT EXISTS superseded_by_msg_id text,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

-- PARTIAL: only superseded rows are indexed. A reader asking "has this been
-- corrected?" hits the row by msg_id anyway; this index serves the reverse
-- question ("what did this correction supersede?") without carrying an entry
-- for every uncorrected message in the log.
CREATE INDEX IF NOT EXISTS coord_event_log_superseded_by_idx
  ON harness_shared.coord_event_log (workspace_id, superseded_by_msg_id)
  WHERE superseded_by_msg_id IS NOT NULL;

COMMENT ON COLUMN harness_shared.coord_event_log.superseded_by_msg_id IS
  'msg_id of the correction that supersedes this message (agent-epistemics-2026-08-02 P-004). '
  'A POINTER, never a copy — the correction is an ordinary coord message with its own row and audience. '
  'Deliberately not a `retracted` boolean: every retraction must name its successor, so a reader is never '
  'told "this was wrong" with no statement of what is right.';
