-- 1329-claim-retractions.sql — EI-23765337478012299 (claim identity + retraction)
--
-- A CLAIM (a loop:checkpoint checks[] row, keyed by its `id`, or any surface
-- that cites `claim:<id>`) has no lifecycle after it is written: when it turns
-- out wrong it sits on N unlinked durable surfaces and each is a manual hunt.
-- This is the append-only EVENT LOG of retract / reinstate decisions about a
-- claim id. The latest event per (workspace_id, claim_id) is the claim's
-- current standing; originals are never mutated or deleted, and a retraction is
-- itself revisable (`reinstate`), so an over-retraction (EI-23759277029988080)
-- is repairable and the audit trail keeps the full oscillation.
--
-- Additive only: a new table, no existing object touched.

CREATE TABLE IF NOT EXISTS harness_shared.claim_retraction_events (
  event_seq     bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  text        NOT NULL,
  claim_id      text        NOT NULL CHECK (length(claim_id) BETWEEN 1 AND 160),
  event_kind    text        NOT NULL CHECK (event_kind IN ('retract', 'reinstate')),
  because       text        NOT NULL CHECK (length(because) BETWEEN 1 AND 1000),
  superseded_by text        CHECK (superseded_by IS NULL OR length(superseded_by) BETWEEN 1 AND 300),
  actor         text        NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS claim_retraction_events_claim_idx
  ON harness_shared.claim_retraction_events (workspace_id, claim_id, event_seq DESC);

ALTER TABLE harness_shared.claim_retraction_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS claim_retraction_events_workspace_isolation
  ON harness_shared.claim_retraction_events;
CREATE POLICY claim_retraction_events_workspace_isolation
  ON harness_shared.claim_retraction_events FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT ON harness_shared.claim_retraction_events TO harness_app, harness_admin;

COMMENT ON TABLE harness_shared.claim_retraction_events IS
  'Append-only retract/reinstate log for claims (EI-23765337478012299). Latest event per (workspace_id, claim_id) = current standing; see packages/operator-core/lib/claim-retractions.ts.';
