-- 1183 — append-only, LABELLED fire log for dev:pg_query advisories.
-- Plan `dry-run-for-claims-preview-a-predicate-partition-null-traps-2026-09-20`, P-003.
--
-- WHY: dev:pg_query carries ~25 advisory builders and records NOTHING when one
-- fires. So the plan's central bet — "showing an agent the partition instead of
-- the scalar changes what it concludes" — is currently unsettleable in either
-- direction. P-003 exists to make it falsifiable BOTH ways:
--   FALSE if the advisory fires regularly and the population-claim correction
--         rate does not move (an advisory nobody reads);
--   FALSE if it fires on <5 queries/week (a trigger too narrow to matter).
-- Neither sentence can be evaluated without a per-advisory fire count, and the
-- second one is why this table is LABELLED rather than a single total: an
-- undifferentiated "advisories fired N times" cannot answer a question asked
-- about one specific trigger.
--
-- WHY NOT DERIVE IT (checked before adding a durable surface, per the
-- derived-truth ladder): harness_shared.tool_invocations stores tool_name,
-- status, duration and an `output_ref` — but NOT the result body, so which
-- advisory fired is not recoverable from it, and dev:telemetry (a rollup over
-- that same table) inherits the blindness. coord_event_log.superseded_by_msg_id
-- was measured at 0 of 122,386 message rows over 14 days — a counter nobody
-- writes, which is precisely the failure mode migration 720 documents. There is
-- no generic counter store to extend (dev:state_counter is an SSE demo).
--
-- WHY A SIBLING TABLE rather than extending harness_shared.bash_tool_substitution_fires
-- (migration 720), whose SHAPE this deliberately copies: that table's row_id is a
-- NOT NULL foreign key into a registry of substitution ROWS. pg_query advisories
-- are builder FUNCTIONS with no registry rows, so every fire here would carry a
-- synthetic row_id, and its compliance resolver asks a question ("did the next
-- call use the named tool") that has no meaning for an advisory that names no
-- tool. Same shape, genuinely different key and different resolvable question.
--
-- SHAPE NOTE: append-only log only — no hot counter column, because there is no
-- registry row to hang one on. Aggregates are served from the indexes below over
-- bounded windows, never a full scan.

CREATE TABLE IF NOT EXISTS harness_shared.pg_query_advisory_fires (
  id              bigserial   PRIMARY KEY,
  workspace_id    text        NOT NULL,
  harness_slug    text,
  -- Stable kebab identity of the advisory KIND (e.g. 'non-summing-partition').
  -- Denormalised on purpose: it must survive the builder being renamed, moved,
  -- or deleted, so a historical window stays readable after a refactor.
  advisory_label  text        NOT NULL,
  -- The agent session whose query it was. Nullable: an internal or unattributed
  -- caller is a real population, and forcing a placeholder here would silently
  -- merge it with a real session.
  session_id      text,
  -- How the payload that CARRIED this advisory ended. A fire is counted only
  -- when the advisory was actually DELIVERED to a caller, never merely computed:
  -- pg_query composes every sql-shape advisory up front, but the unbounded
  -- json-search path returns early carrying only its own, and counting the
  -- others there would inflate the very number the <5/week falsifier reads.
  outcome         text        NOT NULL CHECK (outcome IN ('success', 'error', 'refused')),
  -- How many advisories rode in the SAME payload. An advisory delivered ninth in
  -- a wall of text is not the same event as one delivered alone, and collapsing
  -- the two would hide a dilution effect as if it were engagement.
  delivered_with  integer     NOT NULL DEFAULT 1,
  fired_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE harness_shared.pg_query_advisory_fires IS
  'Append-only per-fire log for dev:pg_query advisories (plan dry-run-for-claims P-003). A fire is recorded at DELIVERY, not at computation. A label absent from a long window means that advisory never fired — a finding, not a gap.';
COMMENT ON COLUMN harness_shared.pg_query_advisory_fires.advisory_label IS
  'Stable kebab identity of the advisory kind, denormalised so it survives a rename or deletion of the builder function.';
COMMENT ON COLUMN harness_shared.pg_query_advisory_fires.outcome IS
  'success | error | refused — the disposition of the payload that carried this advisory. Recorded at delivery so computed-but-never-shown advisories are not counted as fires.';
COMMENT ON COLUMN harness_shared.pg_query_advisory_fires.delivered_with IS
  'Count of advisories delivered in the same payload, so dilution (one advisory among many) stays distinguishable from a solo delivery.';

-- The instrument's own query: fires for one label within a window.
CREATE INDEX IF NOT EXISTS pg_query_advisory_fires_label_window_idx
  ON harness_shared.pg_query_advisory_fires (workspace_id, advisory_label, fired_at DESC);

-- The cross-label rollup over a window ("which advisories fire at all").
CREATE INDEX IF NOT EXISTS pg_query_advisory_fires_window_idx
  ON harness_shared.pg_query_advisory_fires (fired_at DESC);
