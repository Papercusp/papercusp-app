\set ON_ERROR_STOP on
BEGIN;

-- Migration 037 — operator scan tier presets. The first-run budget prompt
-- offers three preset tiers; previously inlined as TS literals in
-- apps/operator/app/_components/OperatorPanel.tsx. Now table-driven so
-- adjusting cap or adding a tier doesn't require a code edit.

CREATE TABLE IF NOT EXISTS harness_shared.operator_budget_tiers (
  ord       INT NOT NULL,                -- display order in the picker
  label     TEXT NOT NULL,                -- e.g. 'Light', 'Active', 'Heavy'
  cap_usd   NUMERIC(10, 2) NOT NULL,      -- daily cap in USD
  blurb     TEXT NOT NULL,                -- one-line description
  PRIMARY KEY (ord)
);

INSERT INTO harness_shared.operator_budget_tiers (ord, label, cap_usd, blurb) VALUES
  (1, 'Light',  5,  '~50 scans/day with default model'),
  (2, 'Active', 20, 'recommended for daily use'),
  (3, 'Heavy',  50, 'large workspaces or always-on background')
ON CONFLICT (ord) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_budget_tiers TO harness_app, harness_admin;

COMMENT ON TABLE harness_shared.operator_budget_tiers IS
  'Preset daily-budget tiers shown in the first-run Operator picker. Edit rows to adjust caps without a code change.';

COMMIT;
