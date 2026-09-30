-- 937-bulk-run-kind-plan-cleanup.sql — cleanup-report-flows-2026-08-24 (P-002).
--
-- Generalize the bulk-run substrate (migrations 912 + 916) from "the inbox
-- bulk-resolve run" to "a bulk run of a KIND", so the Plans pane's clean-up run
-- rides the SAME machinery instead of a parallel store (reuse-first; the plan's
-- Design names run_kind as the ONLY fork point).
--
--  1. `run_kind` on attention_bulk_runs — 'inbox-resolve' (the 912 behavior,
--     and the backfill default for every existing row) or 'plan-cleanup'.
--  2. `seed_refs` — the click-time MEMBERSHIP snapshot for run kinds whose
--     membership is not an attention_bulk_run_items list. For a plan-cleanup
--     run this is the array of plan slugs the pane was rendering when the owner
--     clicked (Requirements: "membership is a click-time snapshot, never a
--     re-derived filter"). Inbox runs keep '[]' — their membership stays the
--     912 items table, unchanged.
--  3. Single-flight re-keyed per (workspace_id, run_kind): one inbox run and
--     one plan-cleanup run may coexist, but never two of a kind. Same
--     pending/running-only scope as 916 (review waits on the OWNER and must not
--     block a new run). The new index name deliberately still contains
--     'one_active_per_workspace' — bulk-run-store.ts's isSingleFlightViolation
--     matches on that substring; keep them in step.
--  4. `plan_cleanup_run_findings` — per-finding outcome rows for plan-cleanup
--     runs (the analog of attention_bulk_run_items, which stays inbox-only):
--     finding kind, target ref, from→to, evidence refs, confidence, outcome.
--     finding_id is the scanner's deterministic findingId
--     (packages/operator-core/lib/plan-cleanup/scanner.ts), which is what makes
--     seed/report idempotent across a resolver retry.
--
-- FORWARD-COMPAT: the DROP INDEX + re-keyed partial UNIQUE INDEX is safe under
-- the currently-deployed release because every existing and old-code-inserted
-- row carries run_kind = 'inbox-resolve' (column default), so the per-(workspace,
-- run_kind) index enforces exactly the same one-active-per-workspace rule for
-- every run the live release can create — the deployed code only creates runs
-- through the FLAGS.INBOX_BULK_RESOLVE-gated start route and never writes
-- run_kind at all. The swap happens inside this migration's transaction, so no
-- window exists in which neither index guards the insert.

-- ── 1+2. run_kind + seed_refs on the run table (expand-only) ────────────────
ALTER TABLE harness_shared.attention_bulk_runs
  ADD COLUMN IF NOT EXISTS run_kind TEXT NOT NULL DEFAULT 'inbox-resolve';

ALTER TABLE harness_shared.attention_bulk_runs
  ADD COLUMN IF NOT EXISTS seed_refs JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $ck$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'attention_bulk_runs_run_kind_check'
       AND conrelid = 'harness_shared.attention_bulk_runs'::regclass
  ) THEN
    ALTER TABLE harness_shared.attention_bulk_runs
      ADD CONSTRAINT attention_bulk_runs_run_kind_check
      CHECK (run_kind IN ('inbox-resolve', 'plan-cleanup'));
  END IF;
END
$ck$;

-- ── 3. single-flight per (workspace, kind) ──────────────────────────────────
DROP INDEX IF EXISTS harness_shared.attention_bulk_runs_one_active_per_workspace;

CREATE UNIQUE INDEX IF NOT EXISTS attention_bulk_runs_one_active_per_workspace_kind
    ON harness_shared.attention_bulk_runs (workspace_id, run_kind)
 WHERE phase IN ('pending', 'running');

COMMENT ON INDEX harness_shared.attention_bulk_runs_one_active_per_workspace_kind IS
  'WI-41012 generalized (P-002 cleanup-report-flows): at most one pending/running bulk run per (workspace, run_kind). Review-phase runs are excluded — they await the owner, not an agent.';

-- ── 4. per-finding outcome rows for plan-cleanup runs ───────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.plan_cleanup_run_findings (
  workspace_id  TEXT        NOT NULL,
  run_id        TEXT        NOT NULL,
  -- The scanner's deterministic findingId ('<kind>:<harness>/<plan>[#item]') —
  -- stable across runs over the same state, so seeding is idempotent and an
  -- apply targets a finding without translation.
  finding_id    TEXT        NOT NULL,
  finding_kind  TEXT        NOT NULL
                  CHECK (finding_kind IN ('flip-to-done', 'cleared-blocker', 'finish-plan',
                                          'orphaned-claim', 'stale-now', 'archive-candidate',
                                          'semantic')),
  plan_slug     TEXT        NOT NULL,
  harness_slug  TEXT,
  -- P-NNN for item-scoped findings; NULL for plan-scoped ones.
  item_id       TEXT,
  -- What would change, human-readable (target / from → to).
  target        TEXT        NOT NULL DEFAULT '',
  from_state    TEXT        NOT NULL DEFAULT '',
  to_state      TEXT        NOT NULL DEFAULT '',
  confidence    TEXT        NOT NULL DEFAULT 'recommended'
                  CHECK (confidence IN ('provable', 'recommended')),
  -- CleanupEvidenceRef[] from the scanner (kind/ref/note rows), or the
  -- resolver's re-verification evidence.
  evidence      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- Ordinal for stable review rendering (scanner emits a deterministic order).
  position      INTEGER     NOT NULL DEFAULT 0,
  -- pending      = seeded, not yet resolved
  -- auto_applied = provable fix applied by the resolver, evidence recorded
  -- recommended  = reported for the owner's review
  -- accepted     = owner accepted in review → applied via the same write path
  -- dismissed    = owner dismissed in review
  -- skipped      = resolver declined (names why in error/evidence)
  -- failed       = apply attempted and failed (error says how)
  outcome       TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (outcome IN ('pending', 'auto_applied', 'recommended', 'accepted',
                                     'dismissed', 'skipped', 'failed')),
  error         TEXT,
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, run_id, finding_id)
);

-- The review list's read: one run's findings, in scanner order.
CREATE INDEX IF NOT EXISTS plan_cleanup_run_findings_run_idx
  ON harness_shared.plan_cleanup_run_findings (workspace_id, run_id, position);

-- "Is this plan inside a live clean-up run?" — the per-plan guard/lookup.
CREATE INDEX IF NOT EXISTS plan_cleanup_run_findings_plan_idx
  ON harness_shared.plan_cleanup_run_findings (workspace_id, plan_slug);

-- ── grants (mirror 912: the runtime app role needs real CRUD) ───────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.plan_cleanup_run_findings TO harness_app;

-- harness_zero may not exist on every substrate (fresh embedded-pg) — guarded.
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.plan_cleanup_run_findings TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

-- ── workspace isolation (mirror 912) ────────────────────────────────────────
ALTER TABLE harness_shared.plan_cleanup_run_findings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plan_cleanup_run_findings_workspace_isolation ON harness_shared.plan_cleanup_run_findings;
CREATE POLICY plan_cleanup_run_findings_workspace_isolation ON harness_shared.plan_cleanup_run_findings
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
