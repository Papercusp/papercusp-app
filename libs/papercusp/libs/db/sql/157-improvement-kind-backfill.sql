-- Migration 157 — backfill engineer_issues.kind from the legacy [kind] title
-- prefixes + strip them (plan close-the-self-improvement-loop-2026-06-05, D-002).
--
-- Before this, `improvements:capture` recorded an item's kind only as a
-- `[bug]`/`[change]`/`[feature]` TITLE PREFIX and left the real `kind` column at
-- its DEFAULT 'bug' for EVERY capture — so the column lied for change/feature
-- captures, and the read seam had to re-parse titles (`deriveKind`). The capture
-- path now writes the column natively and the parser is retired; this migration
-- repairs the existing rows so the column is the single source of truth:
--
--   [bug]           → kind 'bug'
--   [change]        → kind 'change'
--   [feature]       → kind 'change' + payload.improvementKind = 'feature'
--                     (engineer_issues = work_items[kind ∈ bug|change|task],
--                      migration 152 — the feature FAMILY lives in the features
--                      base table; 'feature' is a display refinement here)
--   [research-task] → kind 'change' + payload.improvementKind = 'research-task'
--
-- The prefix is stripped from the title in the same pass. Idempotent: after the
-- strip the WHERE no longer matches, so a re-run is a no-op. Safe additive data
-- repair — no schema change.

\set ON_ERROR_STOP on
BEGIN;

UPDATE harness_shared.engineer_issues
   SET kind = CASE lower((regexp_match(title, '^\s*\[(bug|change|feature|research-task)\]', 'i'))[1])
                WHEN 'bug' THEN 'bug'
                ELSE 'change'
              END,
       payload = CASE lower((regexp_match(title, '^\s*\[(bug|change|feature|research-task)\]', 'i'))[1])
                   WHEN 'feature' THEN COALESCE(payload, '{}'::jsonb) || '{"improvementKind":"feature"}'::jsonb
                   WHEN 'research-task' THEN COALESCE(payload, '{}'::jsonb) || '{"improvementKind":"research-task"}'::jsonb
                   ELSE payload
                 END,
       title = regexp_replace(title, '^\s*\[(bug|change|feature|research-task)\]\s*', '', 'i'),
       updated_at = now()
 WHERE title ~* '^\s*\[(bug|change|feature|research-task)\]';

COMMIT;
