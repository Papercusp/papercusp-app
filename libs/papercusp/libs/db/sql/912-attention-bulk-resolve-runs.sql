-- 912-attention-bulk-resolve-runs.sql — inbox-bulk-resolve-2026-08-23 (P-001).
--
-- The durable substrate for a BULK RESOLVE run: the owner clicks the Inbox
-- pane's command strip, and one resolver agent works the exact set of attention
-- items the pane was showing at that moment (D-002 central resolver + directed
-- consults to live askers; D-003 command-strip UI).
--
-- Two tables, because a run and its per-item outcomes have different lifetimes
-- and different readers: the RUN drives the strip's three states (idle →
-- running → review) and is read once per render, while the ITEMS accumulate as
-- the agent reports and are read as a list.
--
-- Why the item ids are SNAPSHOT here rather than re-derived from the stored
-- filter: `plans.attention` is a live, SSE-invalidated feed, so re-running the
-- owner's filter server-side would resolve against a set that has since moved.
-- The owner must get what they SAW, so the client posts the concrete id list it
-- is displaying and `filter_snapshot` rides along as human-readable provenance
-- only (never as the source of truth for membership). Requirement 1's "never
-- drifts mid-run" falls straight out of that choice.
--
-- No FOREIGN KEY to an attention item: attention items are DERIVED (projected
-- from ~15 upstream sources), not rows — there is no table to reference, which
-- is also why `item_ref` snapshots the ref shape needed to re-dispatch later.

-- ── the run ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.attention_bulk_runs (
  workspace_id    TEXT        NOT NULL,
  run_id          TEXT        NOT NULL,
  harness_slug    TEXT,
  -- Who asked for the run (the owner/operator identity that clicked).
  requested_by    TEXT,
  -- The resolver agent's ownerId once launched — NULL until the launch lands,
  -- which is exactly how a failed launch is distinguished from a slow one.
  resolver_owner  TEXT,
  phase           TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (phase IN ('pending', 'running', 'review', 'complete', 'failed')),
  -- Human-readable provenance of the filters in force at click time
  -- ({ tier, kinds[], query, shownCount }) — NOT the membership source.
  filter_snapshot JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- Denormalized progress counters so the strip renders without aggregating the
  -- item rows on every SSE tick. `total` is fixed at creation; the rest are
  -- maintained by the same writer that upserts an item outcome.
  total_items     INTEGER     NOT NULL DEFAULT 0,
  auto_resolved   INTEGER     NOT NULL DEFAULT 0,
  recommended     INTEGER     NOT NULL DEFAULT 0,
  skipped         INTEGER     NOT NULL DEFAULT 0,
  failed          INTEGER     NOT NULL DEFAULT 0,
  -- Set when the run ends abnormally; surfaced to the owner rather than leaving
  -- the strip stuck on "running" forever (Requirement 8).
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, run_id)
);

-- "The owner's most recent run" is the pane's opening question on every mount,
-- so it gets an index rather than a seq-scan-and-sort per render.
CREATE INDEX IF NOT EXISTS attention_bulk_runs_recent_idx
  ON harness_shared.attention_bulk_runs (workspace_id, created_at DESC);

-- The resolver's own "is this run still live?" check, and the reaper's sweep for
-- runs stranded in a non-terminal phase.
CREATE INDEX IF NOT EXISTS attention_bulk_runs_active_idx
  ON harness_shared.attention_bulk_runs (workspace_id, phase)
  WHERE phase IN ('pending', 'running', 'review');

-- ── the per-item outcomes ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.attention_bulk_run_items (
  workspace_id  TEXT        NOT NULL,
  run_id        TEXT        NOT NULL,
  -- The AttentionItem id (`<kind>:<…>`) — the same key attention_triage uses,
  -- so an outcome here and its audit row there join without translation.
  item_id       TEXT        NOT NULL,
  -- Ordinal position in the owner's filtered list at click time, so the review
  -- list can preserve the order the owner was looking at.
  position      INTEGER     NOT NULL DEFAULT 0,
  item_kind     TEXT,
  item_title    TEXT,
  -- Snapshot of the item's `ref` (its dispatch coordinates: msgId / slug+itemId
  -- / issueId / capability+targetHarness …). Attention items are projections,
  -- so without this a run could not re-dispatch an item whose source row has
  -- since left the live feed.
  item_ref      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  owner_agent_id TEXT,
  outcome       TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (outcome IN ('pending', 'auto_resolved', 'recommended', 'skipped', 'failed')),
  -- For auto_resolved: the option id actually dispatched.
  -- For recommended: the option id pre-selected for the owner.
  -- ALWAYS an id the item's own `actions` offered — never invented (Req 5).
  action_id     TEXT,
  -- ≤2 sentences of why. Mandatory in practice for both auto_resolved (it is
  -- the audit note) and recommended (it is what the owner reads to decide).
  rationale     TEXT,
  -- Pre-drafted free-text reply where the resolution path takes prose, so the
  -- owner edits rather than composes.
  draft_answer  TEXT,
  -- 'high' when settled from direct evidence or an asker's own reply; 'low'
  -- when the consult deadline lapsed and the resolver inferred it anyway. The
  -- review list labels these differently — a timed-out guess must never be
  -- presented with the authority of an evidence-backed one (Req 8).
  confidence    TEXT        CHECK (confidence IS NULL OR confidence IN ('low', 'high')),
  -- Consult bookkeeping (D-002): whether the asking agent was consulted, and
  -- whether they answered before the deadline.
  consulted     BOOLEAN     NOT NULL DEFAULT FALSE,
  consult_reply TEXT,
  -- Why an item was skipped, or how a dispatch failed — never silently blank.
  error         TEXT,
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, run_id, item_id)
);

-- The review list's read: one run's items, in the owner's original order.
CREATE INDEX IF NOT EXISTS attention_bulk_run_items_run_idx
  ON harness_shared.attention_bulk_run_items (workspace_id, run_id, position);

-- "Is this attention item already inside a live run?" — the guard that stops a
-- second run from double-dispatching an item the first is mid-way through.
CREATE INDEX IF NOT EXISTS attention_bulk_run_items_item_idx
  ON harness_shared.attention_bulk_run_items (workspace_id, item_id);

-- ── grants (curator-operator D-009: the runtime app role needs real CRUD) ───
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.attention_bulk_runs TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.attention_bulk_run_items TO harness_app;

-- harness_zero may not exist on every substrate (fresh embedded-pg) — guarded.
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.attention_bulk_runs TO harness_zero;
  GRANT SELECT ON harness_shared.attention_bulk_run_items TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

-- ── workspace isolation (matches the attention_triage / operator-state idiom) ─
ALTER TABLE harness_shared.attention_bulk_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS attention_bulk_runs_workspace_isolation ON harness_shared.attention_bulk_runs;
CREATE POLICY attention_bulk_runs_workspace_isolation ON harness_shared.attention_bulk_runs
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

ALTER TABLE harness_shared.attention_bulk_run_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS attention_bulk_run_items_workspace_isolation ON harness_shared.attention_bulk_run_items;
CREATE POLICY attention_bulk_run_items_workspace_isolation ON harness_shared.attention_bulk_run_items
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
