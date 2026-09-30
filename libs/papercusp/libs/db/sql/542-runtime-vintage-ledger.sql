-- Migration 542 — runtime_vintage: every runtime self-reports its build identity
-- at boot (fleet-reliability-verification-2026-07-10 P-008, filed from the
-- 2026-07-09/10 night-shift outage review).
--
-- Problem this answers: "is the fix actually RUNNING there?" was asked ~5x by
-- manual ssh + log-tailing during the outage (a Mac desktop bundle predating a
-- landed fix; a tower bundle mid half-rename break; a watchdog silently
-- auto-deploying an instrumented build). One row per (workspace, unit, host) —
-- an upserted CURRENT-vintage ledger, not a full history — updated every time
-- that runtime boots. `deploys:vintage` (agent tool) reads this table and
-- diffs `tree_sha` against `origin/staging` HEAD to report commit-lag per unit.
--
-- `unit` is a free-form label the reporting process chooses (e.g. 'bg-host',
-- 'staging-api', 'dev-api', 'desktop-sidecar', 'watchdog', 'gateway') — kept a
-- plain text column (not an enum) since new runtime kinds appear over time and
-- this ledger must never block on a schema change to accept one.

CREATE TABLE IF NOT EXISTS harness_shared.runtime_vintage (
  workspace_id    text NOT NULL DEFAULT 'default',
  unit            text NOT NULL,
  host            text NOT NULL,
  tree_sha        text,
  build_time      timestamptz,
  bundle_version  text,
  pid             integer,
  extra           jsonb NOT NULL DEFAULT '{}'::jsonb,
  reported_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, unit, host)
);

CREATE INDEX IF NOT EXISTS runtime_vintage_reported_at_idx
  ON harness_shared.runtime_vintage (reported_at DESC);

COMMENT ON TABLE harness_shared.runtime_vintage IS
  'Per-(workspace,unit,host) CURRENT runtime build identity, upserted on every boot (P-008 fleet-reliability-verification, mig 542): tree_sha/build_time/bundle_version answer "is the fix actually running there" without manual ssh. deploys:vintage computes commit-lag vs origin/staging HEAD from tree_sha.';

COMMENT ON COLUMN harness_shared.runtime_vintage.unit IS
  'Free-form reporting-process label, e.g. bg-host, staging-api, dev-api, desktop-sidecar, watchdog, gateway. Not an enum: new runtime kinds must never block on a migration to be recorded.';

COMMENT ON COLUMN harness_shared.runtime_vintage.tree_sha IS
  'The git sha this runtime was built from (build-info.ts getBuildInfo().sha) — null when unresolved (e.g. a packaged bundle with neither PAPERCUSP_BUILD_SHA nor a .git dir).';

COMMENT ON COLUMN harness_shared.runtime_vintage.extra IS
  'Best-effort extra context the reporter wants recorded (platform, arch, env-operator-id, …) — additive, never load-bearing for the commit-lag computation.';
