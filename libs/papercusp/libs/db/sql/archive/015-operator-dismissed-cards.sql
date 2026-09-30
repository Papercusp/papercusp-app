-- 015-operator-dismissed-cards.sql
--
-- Multi-machine dismissed-cards sync (final v5 polish item).
-- File-based dismissed.json works on a single device but loses
-- coherence across laptop + desktop. This table is the canonical
-- store; the file-based cache becomes a fallback when PG isn't
-- reachable.
--
-- RLS-scoped to the active workspace, same pattern as 014.
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS harness_shared.operator_dismissed_cards (
  workspace_id  TEXT        NOT NULL,
  card_id       TEXT        NOT NULL,
  dismissed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, card_id)
);

CREATE INDEX IF NOT EXISTS operator_dismissed_cards_dismissed_at_idx
  ON harness_shared.operator_dismissed_cards(dismissed_at);

ALTER TABLE harness_shared.operator_dismissed_cards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS operator_dismissed_cards_workspace_iso ON harness_shared.operator_dismissed_cards;
CREATE POLICY operator_dismissed_cards_workspace_iso ON harness_shared.operator_dismissed_cards
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT, DELETE
  ON harness_shared.operator_dismissed_cards
  TO harness_app, harness_admin;
