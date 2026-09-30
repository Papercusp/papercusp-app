-- 1151 — index exact open-escalation subject lookup.
--
-- WI-2145586: settlement cleanup for a critical work-item uses the stable
-- `(dedupKind, subjectSignature)` identity even when the item's severity was
-- re-rated before settlement. The projection is already scoped by workspace,
-- so index the same three equality predicates used by
-- listOpenEscalationsBySubjectSignature(). Without this index the new
-- severity-independent cleanup regresses to a JSONB sequential scan of the
-- entire open-escalation projection on every settled work-item.
--
-- Expression columns intentionally match the adapter's `body->>` predicates
-- exactly. This is additive and idempotent; legacy rows with absent metadata
-- remain indexed as NULL and are safely excluded by the equality predicates.

CREATE INDEX IF NOT EXISTS coord_open_escalations_ws_dedup_subject
  ON harness_shared.coord_open_escalations (
    workspace_id,
    ((body ->> 'dedupKind')),
    ((body ->> 'subjectSignature'))
  );

COMMENT ON INDEX harness_shared.coord_open_escalations_ws_dedup_subject IS
  'WI-2145586: exact workspace + dedupKind + subjectSignature lookup for severity-independent work-item settle cleanup';
