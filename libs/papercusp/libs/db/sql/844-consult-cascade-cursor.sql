-- 844-consult-cascade-cursor.sql — plan consult-min-max-and-rubric-vetting-2026-08-17,
-- P-013 (owner ruling D-005): the always-advance consult cascade.
--
-- EXPAND-ONLY. Two columns on harness_shared.consult_state:
--   cascade_cursor — index into routing.selection.selected (migration 837-era
--     snapshot; stamped by get-feedback-core at selection time) of the CURRENT
--     responder: the one whose reply / decline / expiry advances the chain.
--     0 = the initially-woken top selectee. Meaningless (stays 0) for consults
--     that never selected anyone (no_qualified_responder, archive-served).
--   cascade_digest — append-only bounded array of chain events
--     [{ ownerId, kind: answer|clarifying_question|new_fact|decline|expired,
--        at, excerpt }] — the "feedback gathered so far" rendered into each
--     next selectee's wake body (D-005: later reviewers build on, or contest,
--     earlier reviews).
--
-- The wake-budget REMOVAL half of D-005 is code-side in this step: the
-- now-unread wake_budget column is deliberately NOT dropped here — the
-- currently-deployed release's consult verbs still SELECT it, so the drop is
-- a later CONTRACT migration once the release that stops reading it is live
-- (expand/contract; see scripts/next-migration.mjs forward-compat note).

ALTER TABLE harness_shared.consult_state
  ADD COLUMN IF NOT EXISTS cascade_cursor integer NOT NULL DEFAULT 0
    CONSTRAINT consult_state_cascade_cursor_check CHECK (cascade_cursor >= 0);

ALTER TABLE harness_shared.consult_state
  ADD COLUMN IF NOT EXISTS cascade_digest jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN harness_shared.consult_state.cascade_cursor IS
  'Index into routing.selection.selected of the CURRENT responder — the one whose reply/decline/expiry advances the always-advance cascade (consult-min-max-and-rubric-vetting-2026-08-17 D-005). 0 = the initially-woken top selectee.';

COMMENT ON COLUMN harness_shared.consult_state.cascade_digest IS
  'Append-only bounded array [{ ownerId, kind, at, excerpt }] of chain-advancing events (replies, declines, expiries) — the prior-feedback digest carried into each next selectee''s wake body (D-005).';
