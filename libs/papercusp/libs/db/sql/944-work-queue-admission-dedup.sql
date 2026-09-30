-- 944-work-queue-admission-dedup.sql
-- Plan: work-queue-admission-and-bulk-dedup-2026-08-24 (owner-directed 2026-08-24).
-- Admission gate ("born-pending") + bulk-dedup instrumentation. EXPAND-only: new
-- nullable column + new tables + partial indexes. No destructive DDL.
--
-- Design notes (the decisions live on the plan):
--  * work_items.admission extends the EXISTING G2 admission predicate
--    (packages/operator-core/lib/work-items-admission.ts) rather than adding a
--    parallel mechanism. NULL = legacy/pre-gate row, treated as admitted
--    (back-compat, exactly like origin NULL = local in that module).
--    'pending'    = born-pending, invisible to claim/place until promoted.
--    'admitted'   = promoter judged it (dup-only charter; never merit).
--    'auto'       = bypass class at filing time (plan-promoted, critical/security).
--    'unreviewed' = fail-open auto-promotion (promoter dead/lagging) — admitted,
--                   tagged so the stats ledger can alarm on it.
--  * The census the ratchet asserts on counts UNADJUDICATED pairs only —
--    dedup_adjudications is what retires a pair (plan decision: R-remedy pairs
--    legitimately enter at >=0.90, so raw pair count must NOT be the metric).

-- ---- 1. admission column on work_items -------------------------------------
ALTER TABLE harness_shared.work_items
  ADD COLUMN IF NOT EXISTS admission text,
  ADD COLUMN IF NOT EXISTS admitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS admitted_by text;

COMMENT ON COLUMN harness_shared.work_items.admission IS
  'Admission-gate state (plan work-queue-admission-and-bulk-dedup-2026-08-24): NULL=pre-gate legacy (admitted), pending=born-pending invisible to claim/place, admitted=promoter-judged, auto=filing-time bypass (plan-promoted/critical), unreviewed=fail-open auto-promotion. Enforced via work-items-admission.ts predicates, never ad-hoc WHERE clauses.';

-- Guarded because ADD CONSTRAINT has no IF NOT EXISTS: this file runs with no
-- BEGIN/COMMIT wrapper (psql autocommits per statement), so a mid-file failure
-- -- e.g. lock_timeout waiting on work_items behind the host pg_dump's
-- AccessShareLock -- commits the statements above and leaves this one to re-run.
-- Without the guard that retry aborts on "constraint already exists", which
-- would wedge boot auto-apply on every subsequent boot. Every other statement
-- here is already IF NOT EXISTS; this makes the whole migration re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.work_items'::regclass
       AND conname  = 'work_items_admission_chk'
  ) THEN
    ALTER TABLE harness_shared.work_items
      ADD CONSTRAINT work_items_admission_chk
      CHECK (admission IS NULL OR admission IN ('pending','admitted','auto','unreviewed'))
      NOT VALID;
  END IF;
END $$;
-- NOT VALID: constraint applies to new writes only; no full-table scan at apply
-- time on a 100k+-row table, and no legacy row can violate it (all NULL).

CREATE INDEX IF NOT EXISTS wi_admission_pending_idx
  ON harness_shared.work_items (workspace_id, harness_slug, created_ts)
  WHERE admission = 'pending';

-- ---- 2. dedup_edges: persisted >=0.85 similarity edges ---------------------
CREATE TABLE IF NOT EXISTS harness_shared.dedup_edges (
  workspace_id text NOT NULL,
  harness_slug text NOT NULL,
  a            text NOT NULL,  -- feature_id, lexicographically < b
  b            text NOT NULL,
  cos          real NOT NULL,  -- cosine similarity at compute time
  trgm         real,           -- pg_trgm title similarity (NULL if either title empty)
  run_id       text NOT NULL,  -- admission_runs.id of the census run that wrote it
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, harness_slug, a, b),
  CHECK (a < b),
  CHECK (cos >= 0.0 AND cos <= 1.0)
);
COMMENT ON TABLE harness_shared.dedup_edges IS
  'Similarity edges >=0.85 between non-terminal, non-observation work items. Durable + resumable census substrate: stage N+1 recomputes only rows whose canonical changed. Components for sharding are union-find over the >=0.90 subset; 0.85-0.90 edges are ghost-context material (plan decision: sharding spec).';

CREATE INDEX IF NOT EXISTS dedup_edges_b_idx
  ON harness_shared.dedup_edges (workspace_id, harness_slug, b);
CREATE INDEX IF NOT EXISTS dedup_edges_component_idx
  ON harness_shared.dedup_edges (workspace_id, harness_slug, cos)
  WHERE cos >= 0.90;

-- ---- 3. dedup_adjudications: what retires a pair from the census -----------
CREATE TABLE IF NOT EXISTS harness_shared.dedup_adjudications (
  workspace_id text NOT NULL,
  harness_slug text NOT NULL,
  a            text NOT NULL,  -- feature_id, lexicographically < b
  b            text NOT NULL,
  verdict      text NOT NULL,  -- r-finding-merge | r-remedy-keep | r-related | distinct
  canonical    text,           -- merge target when verdict = r-finding-merge
  judged_by    text NOT NULL,  -- model id (provenance, plan ruling) or agent owner id
  run_id       text NOT NULL,
  judged_at    timestamptz NOT NULL DEFAULT now(),
  evidence     jsonb,
  PRIMARY KEY (workspace_id, harness_slug, a, b),
  CHECK (a < b),
  CHECK (verdict IN ('r-finding-merge','r-remedy-keep','r-related','distinct')),
  CHECK (verdict <> 'r-finding-merge' OR canonical IS NOT NULL)
);
COMMENT ON TABLE harness_shared.dedup_adjudications IS
  'Pair adjudications. The ratchet census = pairs >=0.90 in dedup_edges with NO row here; every verdict permanently retires its pair, which is what makes monotone non-increase a real guarantee instead of a false alarm on legitimate R-remedy admissions (plan decision: census metric corrected).';

-- ---- 4. admission_runs: the owner-inspectable stats ledger -----------------
CREATE TABLE IF NOT EXISTS harness_shared.admission_runs (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  harness_slug  text NOT NULL,
  run_kind      text NOT NULL, -- census | promoter-tick | bulk-stage | delta-sweep | daily-digest
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  batch_size    integer,
  promoted      integer,
  merged        integer,
  held          integer,
  auto_promoted_unreviewed integer,
  census_before integer,       -- UNADJUDICATED pairs >=0.90 before the run
  census_after  integer,
  model_id      text,          -- provenance: which model judged (NULL = no model call)
  tokens_in     bigint,
  tokens_out    bigint,
  latency_ms    integer,
  detail        jsonb,
  CHECK (run_kind IN ('census','promoter-tick','bulk-stage','delta-sweep','daily-digest'))
);
COMMENT ON TABLE harness_shared.admission_runs IS
  'One row per admission/dedup run — owner-directed ledger ("stats on all their runs inspectable by the user", 2026-08-24). census_before/after carry the UNADJUDICATED-pair metric; the alarm fires when it RISES. Admin surface reads this table via a sync query.';

CREATE INDEX IF NOT EXISTS admission_runs_ws_kind_idx
  ON harness_shared.admission_runs (workspace_id, harness_slug, run_kind, started_at DESC);

-- ---- 5. dedup_shard_map: which items each bulk-stage shard reads -----------
CREATE TABLE IF NOT EXISTS harness_shared.dedup_shard_map (
  run_id       text NOT NULL,   -- admission_runs.id of the census/stage run
  workspace_id text NOT NULL,
  harness_slug text NOT NULL,
  shard_id     integer NOT NULL,
  item_id      text NOT NULL,
  role         text NOT NULL,   -- member (verdict authority) | ghost (read-only context)
  PRIMARY KEY (run_id, item_id, role),
  CHECK (role IN ('member','ghost'))
);
COMMENT ON TABLE harness_shared.dedup_shard_map IS
  'Shard assignment per census run. Invariant asserted before any model call: SUM(role=member) = corpus size exactly (the 670/877 silent-gap trap, plan decision). An item is member in exactly one shard; ghost in any number.';
