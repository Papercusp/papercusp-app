-- 1392: admission_rules.action — what a matching rule does (slack-messages-to-bug-reports-2026-10-05
-- P-003, decision D-008).
--
-- admission_rules.action  'admit'   (default, every existing rule) the match becomes work through
--                                   admitWorkItem, exactly as before this column existed.
--                         'suggest' the match creates NOTHING; the evaluator only reports it, so a
--                                   person can be offered "file this as a bug?" (P-007/P-008).
--
-- Slack bug rules are ordinary admission_rules rows on the Slack data source with source_kind
-- 'chat-message' or 'chat-thread' (validated in work-admission/admission-rules.ts, which owns the
-- set of source kinds). No new rule table: one more source kind on the existing mechanism.
--
-- Additive only: a new column with a default and a CHECK on that new column. The deployed release
-- never reads it, and every existing row keeps admitting.

ALTER TABLE harness_shared.admission_rules
  ADD COLUMN IF NOT EXISTS action text NOT NULL DEFAULT 'admit'
    CONSTRAINT admission_rules_action_check CHECK (action IN ('admit', 'suggest'));

COMMENT ON COLUMN harness_shared.admission_rules.action IS
  'What a matching rule does: admit (create work via admitWorkItem) or suggest (create nothing; report the match so a person can be offered to file it). slack-messages-to-bug-reports-2026-10-05 D-008.';
