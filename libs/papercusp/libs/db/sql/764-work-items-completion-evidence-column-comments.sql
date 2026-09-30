-- 764-work-items-completion-evidence-column-comments.sql
--
-- WI-37360: harness_shared.work_items carries THREE plausible completion-evidence
-- fields, and only one of them is where completion evidence actually lives:
--
--   completion_ref (jsonb)          -- 0 of 2657 rows populated (papercusp, item_kind='bug').
--                                       Dead pre-unification schema; nothing writes it anymore.
--   terminal_completion_ref (text)  -- ~38% populated historically. A free-text completion
--                                       REFERENCE (e.g. a duplicate/superseded pointer), not
--                                       the structured evidence record.
--   payload->'_completionEvidence'  -- CANONICAL. Written by work_items:complete's structured
--                                       `completion` arg (summary/testsRun/testResult/
--                                       verifiedHow/filesChanged/...). ~94% populated on recent
--                                       closes. See work_items:get{detail:true}'s
--                                       terminalCompletionEvidence field, or query it directly
--                                       as `payload->'_completionEvidence'`.
--
-- Both `completion_ref` and `terminal_completion_ref` are legitimately non-empty-LOOKING
-- columns (terminal_completion_ref especially: a healthy ~38% baseline), so a base-rate
-- sanity check does not catch a query that reads the wrong one -- it just returns a
-- confident, well-formed, WRONG answer (measured live: an audit reading
-- terminal_completion_ref concluded a fleet's closes were "10x less evidenced than
-- baseline"; the payload field showed the opposite, 94.3% vs a 56.5% baseline).
--
-- These comments are surfaced by `dev:pg_query { describe: 'harness_shared.work_items' }`
-- (see describeRelation in pg-read-query.ts, which this migration's sibling change teaches
-- to read column comments) -- i.e. they land exactly where an agent orienting to this table
-- looks, which is the point: this is documentation-as-data, not a code change, so it cannot
-- go stale the way a doc comment in a file nobody greps can.

COMMENT ON COLUMN harness_shared.work_items.completion_ref IS
  'DEAD — 0% populated (papercusp, item_kind=bug, all cohorts measured 2026-08-09). Pre-unification jsonb column; nothing writes it. Do NOT use as a completion-evidence signal. Canonical store: payload->''_completionEvidence'' (written by work_items:complete). WI-37360.';

COMMENT ON COLUMN harness_shared.work_items.terminal_completion_ref IS
  'A free-text completion REFERENCE/pointer (e.g. duplicate-of), NOT the structured completion-evidence record — partially populated (~38% historically) so it LOOKS like a healthy signal but answers a different question than "was this close evidenced". For completion evidence (summary/testsRun/testResult/verifiedHow/filesChanged) read payload->''_completionEvidence'' instead (work_items:get{detail:true}.terminalCompletionEvidence). WI-37360.';
