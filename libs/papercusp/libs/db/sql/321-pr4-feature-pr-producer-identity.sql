-- 321: PR-4 WI↔PR producer — per-operator identity column
-- (PLAN-pr-system-completion-dogfood Phase PR-4 / Brief PR-4 — (c) per-operator identity).
-- Number reserved via db:next-migration (harness_shared.migration_reservations) to
-- avoid the 319/320 collision with concurrent peers (PR-2/PR-3 took 319/320).
--
-- `harness_shared.harness_feature_prs` (baseline mig 000) tracks WI/feature → PR
-- → state but had NO PRODUCER and NO author attribution. PR-4 builds the producer
-- (lib/harness/feature-pr-producer.ts) that UPSERTs a row at fork→PR open; this
-- migration adds the identity column the producer records so every tracked PR is
-- attributable to the HUMAN operator who authored it (the `gh` user — owner
-- decision (c): per-operator, NOT a generic host token). The numeric github_user_id
-- is the stable anti-spam rate-bucket key (EN-2 P-RATE: one human = one bucket).
--
-- ADDITIVE + idempotent: a single nullable column, no rewrite, no data backfill.
-- Existing rows (none today — the table was vaporware) keep NULL; the producer
-- fills it going forward. No federation change — harness_feature_prs stays PG-local
-- (sync:'none'); PR visibility is GUI-served (Brief PR-4 (b)3 default LOCAL + GUI).
--
-- The migration runner wraps each file in its own transaction (and strips psql
-- metacommands), so this file carries NO top-level BEGIN;/COMMIT;/\set
-- (migration-runner.js contract; lint:migrations).

ALTER TABLE harness_shared.harness_feature_prs
  ADD COLUMN IF NOT EXISTS author_github_user_id bigint;

COMMENT ON COLUMN harness_shared.harness_feature_prs.author_github_user_id IS
  'Numeric GitHub id of the HUMAN operator who authored the fork to PR (gh user); recorded by the PR-4 producer at PR-open; the per-operator anti-spam rate-bucket key (EN-2 P-RATE).';
