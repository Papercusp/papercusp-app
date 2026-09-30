-- 334-model-pricing-snapshot-table.sql
-- B-TOK-ROLL (token-tracking-plan-and-briefs-2026-06-20, B-TOK-3): a SQL-queryable
-- per-model price book for $-cost transparency + effective-dated history.
--
-- WHY: cost_usd is already stored per agent_usage_samples row, but the per-model
-- $/Mtok RATES (especially the cache-read tier — cache-read is ~82-92% of all
-- tokens, so its price dominates) are only in code (@papercusp/model-pricing's
-- MODEL_PRICES). The Tokens dashboard + audits need to SHOW the rates and to be
-- able to re-price historical/estimated rows from SQL.
--
-- SOURCE-OF-TRUTH: MODEL_PRICES (@papercusp/model-pricing) stays CANONICAL
-- (cross-backend-cost-capture D-002-A: "update THIS table only — every consumer
-- follows"). This DB table is a DERIVED PROJECTION: the seed below is a dated
-- bootstrap snapshot, and `syncModelPricingFromCode()` (model-pricing-sync.ts)
-- UPSERTs from MODEL_PRICES at boot so any drift self-heals. DO NOT hand-edit a
-- price here — edit MODEL_PRICES; the next boot re-syncs.
--
-- Explicit cache rates (not multipliers) so SQL can price directly:
--   cache_read_per_mtok     = MODEL_PRICES.cacheRead  ?? input × 0.1   (Anthropic 0.1×)
--   cache_creation_per_mtok = MODEL_PRICES.cacheWrite ?? input × 1.25  (5-min write premium)
--
-- The migration runner wraps each file in its own transaction (strips psql
-- metacommands), so NO top-level BEGIN;/COMMIT;/\set (migration-runner.js
-- contract; lint:migrations). Idempotent: CREATE TABLE/INDEX IF NOT EXISTS +
-- seed via ON CONFLICT DO NOTHING (the boot sync owns updates).

CREATE TABLE IF NOT EXISTS harness_shared.model_pricing (
  model_id                text PRIMARY KEY,            -- bare normalized id, e.g. 'claude-opus-4-8'
  input_per_mtok          numeric NOT NULL,            -- USD / 1M uncached input tokens
  output_per_mtok         numeric NOT NULL,            -- USD / 1M output tokens
  cache_read_per_mtok     numeric NOT NULL,            -- USD / 1M cache-READ tokens (the dominant tier)
  cache_creation_per_mtok numeric NOT NULL,            -- USD / 1M cache-WRITE (creation) tokens
  effective_date          date   NOT NULL DEFAULT CURRENT_DATE,
  source                  text   NOT NULL DEFAULT 'code-table',  -- provenance of the row
  updated_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE harness_shared.model_pricing IS
  'Derived projection of @papercusp/model-pricing MODEL_PRICES (canonical). Refreshed by syncModelPricingFromCode() at boot. Do not hand-edit prices; edit MODEL_PRICES.';

-- Bootstrap snapshot (verified 2026-06-05, matching the MODEL_PRICES header). The
-- boot sync UPSERTs over these, so they are only the fresh-DB / pre-sync baseline.
-- ON CONFLICT DO NOTHING: never clobber a sync-updated row on a migration re-run.
INSERT INTO harness_shared.model_pricing
  (model_id, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_creation_per_mtok, effective_date, source)
VALUES
  ('claude-opus-4-8',   5.0,  25.0,  0.5,    6.25,   DATE '2026-06-05', 'code-table'),
  ('claude-opus-4-7',   5.0,  25.0,  0.5,    6.25,   DATE '2026-06-05', 'code-table'),
  ('claude-opus-4-6',   5.0,  25.0,  0.5,    6.25,   DATE '2026-06-05', 'code-table'),
  ('claude-opus-4-5',   5.0,  25.0,  0.5,    6.25,   DATE '2026-06-05', 'code-table'),
  ('claude-opus-4-1',  15.0,  75.0,  1.5,   18.75,   DATE '2026-06-05', 'code-table'),
  ('claude-opus-4-0',  15.0,  75.0,  1.5,   18.75,   DATE '2026-06-05', 'code-table'),
  ('claude-sonnet-4-6', 3.0,  15.0,  0.3,    3.75,   DATE '2026-06-05', 'code-table'),
  ('claude-sonnet-4-5', 3.0,  15.0,  0.3,    3.75,   DATE '2026-06-05', 'code-table'),
  ('claude-sonnet-4-0', 3.0,  15.0,  0.3,    3.75,   DATE '2026-06-05', 'code-table'),
  ('claude-haiku-4-5',  1.0,   5.0,  0.1,    1.25,   DATE '2026-06-05', 'code-table'),
  ('gpt-5',             1.25, 10.0,  0.125,  1.25,   DATE '2026-06-05', 'code-table'),
  ('gpt-5.5',           2.5,  20.0,  0.25,   2.5,    DATE '2026-06-05', 'code-table'),
  ('gpt-4o-mini',       0.15,  0.6,  0.015,  0.1875, DATE '2026-06-05', 'code-table'),
  ('gpt-4o',            2.5,  10.0,  0.25,   3.125,  DATE '2026-06-05', 'code-table')
ON CONFLICT (model_id) DO NOTHING;
