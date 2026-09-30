-- Migration 160 — add the `report` jsonb column to operator_turns.
--
-- Plan: structured-report-protocol-2026-06-05 (Brief 22), decision D-003.
--
-- The operator emits a `<report>` control tag alongside `<say>` carrying a
-- structured per-plan/per-item status payload (rendered as a card on desktop
-- and a two-tiered plan→item list in the TUI). It is semantically distinct
-- from a turn's `text` (the say, tag-stripped for the transcript + search)
-- and from `tools` (the MCP tool calls the model made, with `answered`
-- state), so it gets its own column rather than overloading `tools`.
--
-- Persisting it (vs re-parsing the raw turn) is required: the client stores
-- the finalized say as `text` and does not keep the raw tag document, so a
-- report could not be reconstructed on reload without a dedicated column.
--
-- Shape (validated by parseReportBody / chat_tags::extract_report):
--   { "title"?: string,
--     "plans": [ { "slug"?, "title", "status"?, "summary"?,
--                  "items"?: [ { "id"?, "text", "status"? } ] } ] }
--
-- Nullable, no default — the vast majority of turns carry no report.
-- Idempotent: ADD COLUMN IF NOT EXISTS so re-running is a no-op.

ALTER TABLE harness_shared.operator_turns
  ADD COLUMN IF NOT EXISTS report jsonb;
