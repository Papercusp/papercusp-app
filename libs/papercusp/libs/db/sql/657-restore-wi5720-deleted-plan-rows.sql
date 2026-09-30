-- Migration 657 — INCIDENT REPAIR for migration 656.
--
-- Work-item: WI-5720. Applied 2026-07-25 immediately after 656 on the dev box.
--
-- WHAT WENT WRONG --------------------------------------------------------------------
-- 656 folded retired-slug plan rows into papercusp with a MOVE-then-DELETE. The move was
-- correct; the DELETE was not, and the reason is a trap worth writing down:
--
--   harness_shared.harness_plans carries `capture_substrate_outbox_trg`, an AFTER INSERT
--   OR DELETE trigger, and migration 359 rewrote that capture function to route each op
--   through canonical_harness_slug(). So a DELETE of a `papercup` row does NOT emit a
--   `papercup` tombstone — it emits a tombstone keyed (papercusp, <plan_slug>), which is
--   the LIVE plan. 156 such `del` ops were captured. The federation projection then
--   applied them, deleting 78 harness_plans rows: the 64 live papercusp twins AND the 14
--   rows 656 had just correctly moved in. papercusp went 973 → 909 plans.
--
--   The lesson generalises beyond this migration: on any table whose capture trigger
--   canonicalizes its routing key, DELETING a row under a retired/aliased key is
--   indistinguishable — to every downstream consumer — from deleting the canonical row.
--   Retire such rows by UPDATE (or with the capture trigger disabled), never by DELETE.
--
-- WHY A FULL-FIDELITY RESTORE IS POSSIBLE ---------------------------------------------
-- The capture writes the COMPLETE pre-image row into substrate_outbox.row as jsonb (all
-- 45 columns, including the derived items/decisions/now_state projections). Each of the
-- 78 lost rows therefore has a byte-exact snapshot in the `del` op that destroyed it,
-- distinguishable from the retired-slug op by row->>'harness_slug' = 'papercusp'.
-- Verified before writing this: 78/78 reconstruct with the right workspace + slug, no
-- empty content, 2,008,824 content chars total; and spot-checked content lengths match
-- the pre-incident measurements exactly (bee-context-efficiency 60710,
-- whole-app-test-coverage-breadth 94770, workspace-data-isolation-leaks 49342,
-- deterministic-blueprints-migration 67407, docs-and-memory-as-projections 31418).
-- plan_revisions carries the same content independently and agrees.
--
-- The restore is a pure INSERT, so the capture trigger emits fresh `put` ops that
-- supersede the tombstones by HLC — healing federated peers as well as this node.
--
-- Idempotent: ON CONFLICT DO NOTHING, and the source window is bounded to the incident.
-- A fresh install has no such outbox rows, so this whole migration is a no-op there.

\set ON_ERROR_STOP on

-- NO top-level BEGIN;/COMMIT; here — the migration runner already wraps this file
-- in a transaction together with its schema_migrations ledger INSERT
-- (embedded-postgres-server/src/migration-runner.js). An inner COMMIT ends that
-- wrapper early and breaks apply+record atomicity. Enforced by lint:migrations /
-- lint-migrations.test.ts (audit P-074, EI-170).

INSERT INTO harness_shared.harness_plans (
  workspace_id, harness_slug, plan_slug, title, status, created, updated, owner,
  supersedes, superseded_by, content, content_hash, version, op_status, op_started_at,
  op_updated_at, current_wave, op_priority, archived, is_legacy, created_at, updated_at,
  author_pubkey, origin, items, decisions, now_state, now_next, fed_ts, initiative,
  schedule, schedule_active, scheduled_at, expires_at, tzid, template_slug, run_seq,
  fed_hlc, promote_policy, template, template_data, owner_author_pubkey,
  embedding, embedding_mode
)
SELECT
  r.workspace_id, r.harness_slug, r.plan_slug, r.title, r.status, r.created, r.updated, r.owner,
  r.supersedes, r.superseded_by, r.content, r.content_hash, r.version, r.op_status, r.op_started_at,
  r.op_updated_at, r.current_wave, r.op_priority, r.archived, r.is_legacy, r.created_at, r.updated_at,
  r.author_pubkey, r.origin, r.items, r.decisions, r.now_state, r.now_next, r.fed_ts, r.initiative,
  r.schedule, r.schedule_active, r.scheduled_at, r.expires_at, r.tzid, r.template_slug, r.run_seq,
  r.fed_hlc, r.promote_policy, r.template, r.template_data, r.owner_author_pubkey,
  r.embedding, r.embedding_mode
FROM (
  -- The newest `del` op per plan whose PRE-IMAGE was the canonical papercusp row.
  -- (The sibling op for the same plan carries the retired-slug pre-image — not this one.)
  SELECT DISTINCT ON (o.key) (jsonb_populate_record(null::harness_shared.harness_plans, o.row)).*
  FROM harness_shared.substrate_outbox o
  WHERE o.table_name = 'harness_plans'
    AND o.op = 'del'
    AND o.row->>'harness_slug' = 'papercusp'
    AND o.ts BETWEEN 1785006000000 AND 1785010000000  -- the 656 apply window, 2026-07-25
  ORDER BY o.key, o.ts DESC
) r
ON CONFLICT (workspace_id, harness_slug, plan_slug) DO NOTHING;
