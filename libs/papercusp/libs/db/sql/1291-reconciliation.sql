-- 1291-reconciliation.sql — agent-economy-flywheel-2026-08-30 P-043 (WI-10004681, D-025)
--
-- Reconciliation of the money journal (P-042) against Stripe, the bank feed
-- and the chain. The engine is packages/operator-core/lib/cupboard/reconciliation.ts;
-- the PG store is cupboard/reconciliation-store.ts.
--
-- reconciliation_runs: one row per run (hourly provisional, plus a final run
--   for the month that just closed). It keeps every invariant verdict, which
--   breaks the run opened or resolved, and the DAO-transfer gate it computed
--   and pushed to operator-public.
-- reconciliation_breaks: one row per break episode. At most one OPEN row per
--   (workspace, invariant), enforced by a partial unique index, so a break that
--   persists across hourly runs files one work item, not one per hour. A later
--   run that finds the invariant holding stamps resolved_at; a new break after
--   that opens a new row (and a new work item).
--
-- FORWARD-COMPAT: both tables are new in this migration and nothing in the currently deployed release reads or writes them, so the partial unique index cannot break live code.
-- Additive only.

CREATE TABLE IF NOT EXISTS harness_shared.reconciliation_runs (
  workspace_id   text        NOT NULL,
  run_id         text        NOT NULL CHECK (length(run_id) BETWEEN 1 AND 128),
  mode           text        NOT NULL CHECK (mode IN ('provisional', 'final')),
  month          text        NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  period_from    timestamptz NOT NULL,
  period_until   timestamptz NOT NULL,
  started_at     timestamptz NOT NULL,
  finished_at    timestamptz NOT NULL,
  verdicts       jsonb       NOT NULL CHECK (jsonb_typeof(verdicts) = 'array'),
  opened         jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(opened) = 'array'),
  resolved       jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(resolved) = 'array'),
  gate_open      boolean     NOT NULL,
  gate           jsonb       NOT NULL CHECK (jsonb_typeof(gate) = 'object'),
  gate_publish   jsonb       NOT NULL CHECK (jsonb_typeof(gate_publish) = 'object'),
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, run_id),
  CHECK (period_until > period_from),
  CHECK (finished_at >= started_at)
);

CREATE INDEX IF NOT EXISTS reconciliation_runs_workspace_finished_idx
  ON harness_shared.reconciliation_runs (workspace_id, finished_at DESC);

COMMENT ON TABLE harness_shared.reconciliation_runs IS
  'P-043 reconciliation runs: per-run invariant verdicts, breaks opened/resolved, and the DAO-transfer gate pushed to operator-public (D-025).';
COMMENT ON COLUMN harness_shared.reconciliation_runs.gate_open IS
  'The computed DAO-transfer gate: true only when no break is open and every mandated invariant evaluated.';
COMMENT ON COLUMN harness_shared.reconciliation_runs.gate_publish IS
  'Result of pushing the gate to operator-public: {published:true} or {published:false, detail}.';

CREATE TABLE IF NOT EXISTS harness_shared.reconciliation_breaks (
  id               bigserial   PRIMARY KEY,
  workspace_id     text        NOT NULL,
  invariant        text        NOT NULL CHECK (invariant IN (
                     'credit-reserve-covers-outstanding-credits',
                     'dao-payable-equals-accrued-minus-transferred',
                     'safe-balance-equals-receipts-minus-approved-spends',
                     'journal-matches-stripe',
                     'journal-matches-bank',
                     'journal-matches-chain')),
  work_item_id     text,
  opened_at        timestamptz NOT NULL,
  opened_by_run    text        NOT NULL CHECK (length(opened_by_run) BETWEEN 1 AND 128),
  last_run_id      text        NOT NULL CHECK (length(last_run_id) BETWEEN 1 AND 128),
  detail           text        NOT NULL CHECK (length(detail) <= 4000),
  resolved_at      timestamptz,
  resolved_by_run  text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((resolved_at IS NULL) = (resolved_by_run IS NULL)),
  CHECK (resolved_at IS NULL OR resolved_at >= opened_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_breaks_one_open_idx
  ON harness_shared.reconciliation_breaks (workspace_id, invariant)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS reconciliation_breaks_workspace_opened_idx
  ON harness_shared.reconciliation_breaks (workspace_id, opened_at DESC);

COMMENT ON TABLE harness_shared.reconciliation_breaks IS
  'P-043 break episodes: at most one open row per (workspace, invariant), so a persisting break files one work item (D-025).';
