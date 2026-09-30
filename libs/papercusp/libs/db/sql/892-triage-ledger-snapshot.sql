-- 892-triage-ledger-snapshot.sql
-- P-003 of plan learning-loop-backlog-triage-2026-08-22 (work-item WI-40670).
--
-- The authoritative triage ledger for the learning-loop backlog corpus: a STAMPED
-- SNAPSHOT (D-020) partitioned local/remote (D-022), carrying SPLIT verdict axes
-- (D-017) and a cluster id (D-019).
--
-- WHY A NEW RELATION — reuse-first justification, stated per repo policy:
--   * work_items.payload was the obvious host and is UNUSABLE: D-022 measured that
--     341 of 870 corpus items (39%) are origin='remote' and REFUSE state/link writes
--     on this node ("remote-authored and cannot be mutated locally; its authoring peer
--     must claim/resolve it"). A verdict stored on the item itself is therefore
--     unwritable for 39% of the corpus BY CONSTRUCTION, not by permission.
--   * harness_shared.attention_triage was evaluated and rejected: it carries a single
--     `action` enum -- precisely the single-verdict shape D-017 supersedes -- and a
--     primary key of (workspace_id, item_id) that admits exactly one verdict per item
--     ever, so it can hold neither snapshots, nor split axes, nor origin, nor cluster,
--     nor falsifier evidence.
--
-- Purely additive: two new tables. No DDL against any existing relation, so no
-- FORWARD-COMPAT acknowledgment is required (nothing currently deployed can break).

CREATE TABLE IF NOT EXISTS harness_shared.triage_snapshots (
  snapshot_id     text PRIMARY KEY,
  workspace_id    text        NOT NULL,
  harness_slug    text        NOT NULL,
  corpus          smallint    NOT NULL,
  taken_at        timestamptz NOT NULL DEFAULT now(),
  taken_by        text,

  -- The census as measured at the stamp. This is the LEFT-hand side of the
  -- reconciliation the plan item requires.
  census_total    integer     NOT NULL,
  census_local    integer     NOT NULL,
  census_remote   integer     NOT NULL,

  -- Materialised row count, and the reconciliation itself as a DERIVED value.
  -- P-003's VERIFY criterion demands the reconciliation be an assertion, never an
  -- eyeballed comparison; a generated column cannot be asserted wrong.
  ledger_rows     integer     NOT NULL DEFAULT 0,
  reconciled      boolean     GENERATED ALWAYS AS (ledger_rows = census_total) STORED,

  predicate_note  text,
  notes           text,

  CONSTRAINT triage_snapshots_corpus_check
    CHECK (corpus IN (1, 2, 3)),
  -- D-022: the origin partition must exhaust the census. If a third origin value ever
  -- appears, this refuses the snapshot instead of silently under-reporting a partition.
  CONSTRAINT triage_snapshots_partition_exhausts
    CHECK (census_local + census_remote = census_total),
  CONSTRAINT triage_snapshots_counts_nonneg
    CHECK (census_total >= 0 AND census_local >= 0 AND census_remote >= 0 AND ledger_rows >= 0)
);

COMMENT ON TABLE harness_shared.triage_snapshots IS
  'One row per stamped triage census (D-020). The corpus DRAINS ~64 items/24h from ordinary fleet work even with scout inflow paused, so every count is true only at its stamp and a burn-down against a LIVE denominator credits the triage with drain it did not cause.';
COMMENT ON COLUMN harness_shared.triage_snapshots.corpus IS
  '1 = routed non-terminal work-items (the core), 2 = gym-rail routed ideas (not work-items; no agent can claim one), 3 = loop-authored plans. Per D-001.';
COMMENT ON COLUMN harness_shared.triage_snapshots.reconciled IS
  'DERIVED, never written: ledger_rows = census_total. P-003 VERIFY criterion.';
COMMENT ON COLUMN harness_shared.triage_snapshots.census_local IS
  'The ACTIONABLE denominator (D-022). Progress must be reported against this, not against census_total, because remote items can never be dispositioned from this node.';

CREATE TABLE IF NOT EXISTS harness_shared.triage_ledger (
  snapshot_id   text NOT NULL
    REFERENCES harness_shared.triage_snapshots(snapshot_id) ON DELETE CASCADE,
  feature_id    text NOT NULL,
  workspace_id  text NOT NULL,
  harness_slug  text NOT NULL,

  -- D-022: the partition that decides whether a verdict can EVER be executed here.
  origin        text NOT NULL,
  actionable    boolean GENERATED ALWAYS AS (origin = 'local') STORED,

  -- The dimensions the plan item asks the ledger to split by.
  lens          text,
  routed_month  date,

  -- D-019 clustering. Tier A (>=0.94) / B (0.90-0.94) / C (<0.90) are NOT
  -- interchangeable and the tier must travel with the cluster id.
  cluster_id    text,
  cluster_tier  text,
  cluster_size  integer,

  -- D-017: the verdict is TWO axes, never one column. Redundancy and merit have
  -- opposite inter-judge reliability (kappa 0.679 vs 0.289); collapsing them destroys
  -- the only producer-quality signal the triage generates.
  redundancy    text NOT NULL DEFAULT 'untriaged',
  merit         text NOT NULL DEFAULT 'untriaged',
  provenance    text,

  -- D-017 section 3: a discard rests on a VERIFIED FALSIFIER, never on a low score.
  falsifier     text,
  judge         text,
  judged_at     timestamptz,
  notes         text,

  PRIMARY KEY (snapshot_id, feature_id),

  CONSTRAINT triage_ledger_origin_check
    CHECK (origin IN ('local', 'remote')),
  CONSTRAINT triage_ledger_tier_check
    CHECK (cluster_tier IS NULL OR cluster_tier IN ('A', 'B', 'C')),
  CONSTRAINT triage_ledger_provenance_check
    CHECK (provenance IS NULL OR provenance IN ('verified', 'argued', 'unverifiable')),

  -- Shape guards, deliberately NOT invented enums: D-017 fixes the discard-ward codes
  -- (M1-superseded / M1-invalid) and the redundancy split (R-finding / R-remedy), but
  -- the full M/R scales are not enumerated in a source this migration can cite. These
  -- catch typos without fabricating scale semantics.
  CONSTRAINT triage_ledger_merit_shape
    CHECK (merit = 'untriaged' OR merit ~ '^M[0-9](-[a-z]+)?$'),
  CONSTRAINT triage_ledger_redundancy_shape
    CHECK (redundancy = 'untriaged' OR redundancy ~ '^R([0-9]|-[a-z]+)$'),

  -- THE RAIL. D-017 section 3 becomes structurally unviolatable: a discard-ward merit
  -- verdict is REFUSED unless it carries a non-empty falsifier AND that falsifier is
  -- tagged verified. Verification changed 3 of judge B's scores and corrected 2 of the
  -- lead judge's, so this is an enforced rule, not a stylistic preference.
  CONSTRAINT triage_ledger_discard_needs_verified_falsifier
    CHECK (
      merit NOT LIKE 'M1-%'
      OR (falsifier IS NOT NULL AND length(btrim(falsifier)) > 0 AND provenance = 'verified')
    )
);

COMMENT ON TABLE harness_shared.triage_ledger IS
  'One row per (snapshot, corpus item). Verdicts are split across two axes per D-017; a discard-ward merit code is refused by CHECK unless it carries a verified falsifier (D-017 section 3).';
COMMENT ON COLUMN harness_shared.triage_ledger.actionable IS
  'DERIVED: origin = local. Remote items accept COMMENTS (which federate) but refuse state and link writes, so "untriaged" means something categorically different for them -- it can never become anything else from this node.';
COMMENT ON COLUMN harness_shared.triage_ledger.falsifier IS
  'The measurable falsifier: premise measurably untrue / fix measurably shipped / subsystem retired. An opinion is not a falsifier.';
COMMENT ON COLUMN harness_shared.triage_ledger.cluster_tier IS
  'A = auto-mergeable band, B = judged review queue, C = not surfaced (single-linkage chains 28% of the corpus into one component at 0.88). Per D-019, and see D-021: the Tier A precision originally published as 1.000 was retracted to 0.833.';

CREATE INDEX IF NOT EXISTS triage_ledger_snapshot_origin_idx
  ON harness_shared.triage_ledger (snapshot_id, origin);
CREATE INDEX IF NOT EXISTS triage_ledger_snapshot_cluster_idx
  ON harness_shared.triage_ledger (snapshot_id, cluster_id);
CREATE INDEX IF NOT EXISTS triage_ledger_feature_idx
  ON harness_shared.triage_ledger (feature_id);
CREATE INDEX IF NOT EXISTS triage_ledger_snapshot_verdict_idx
  ON harness_shared.triage_ledger (snapshot_id, merit, redundancy);
