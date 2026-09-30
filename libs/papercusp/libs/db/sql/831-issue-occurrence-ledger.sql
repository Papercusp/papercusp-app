-- 831: append-only occurrences for canonical issue-family work-items (P-004).
--
-- The canonical issue remains harness_shared.work_items.  This table records
-- every report that created, duplicated, coalesced into, or promoted that
-- canonical row.  It is deliberately an occurrence ledger, not another issue
-- store: lifecycle, ownership, title, and resolution continue to live only on
-- work_items.  Repeated evidence is therefore lossless without inflating the
-- claimable queue.
CREATE TABLE IF NOT EXISTS harness_shared.work_item_occurrences (
  occurrence_id           bigserial PRIMARY KEY,
  workspace_id            text        NOT NULL,
  canonical_harness_slug  text        NOT NULL,
  canonical_work_item_id  text        NOT NULL,
  reporter                text,
  source_tool             text        NOT NULL,
  report_kind             text        NOT NULL,
  reported_title          text        NOT NULL,
  evidence                jsonb       NOT NULL DEFAULT '{}'::jsonb,
  admission_identity      jsonb,
  occurred_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_item_occurrences_report_kind_check CHECK (
    report_kind IN ('canonical-created', 'duplicate', 'coalesced', 'promoted', 'regression')
  )
);

CREATE INDEX IF NOT EXISTS work_item_occurrences_canonical_idx
  ON harness_shared.work_item_occurrences
  (workspace_id, canonical_harness_slug, canonical_work_item_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS work_item_occurrences_flow_idx
  ON harness_shared.work_item_occurrences (workspace_id, occurred_at DESC);

COMMENT ON TABLE harness_shared.work_item_occurrences IS
  'Append-only reports/evidence attached to the existing canonical issue-family work-item. Counts are occurrence flow; work_items rows remain canonical issue stock.';

