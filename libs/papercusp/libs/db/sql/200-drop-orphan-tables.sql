-- Migration 200 — drop 9 confirmed-orphan tables (owner-directed DB hygiene audit).
--
-- Method (the rule: orphan = EMPTY *and* zero live writer *and* no live reference).
-- Verified against the LIVE native :5432 DB on 2026-06-09: real count(*)=0 for all 9
-- (pg_stat estimates were null/unreliable — the trap that broke the earlier pass),
-- zero inbound FKs, zero dependent views/RLS, and zero live writers (raw-SQL grep +
-- drizzle `.insert()` importer check + migration-history reconciliation).
--
-- The 9, and why each is a true orphan:
--   • delegates, delegate_inbox  — collapsed into work_items (collapse-delegate-into-
--       workitems-2026-06-04); DROPPED by mig 152. They reappeared as empty ZOMBIES
--       because 000-baseline.sql (which still CREATEs them) was re-applied 2026-06-05,
--       AFTER 152 was recorded applied, so the drop didn't re-run. No live writer
--       (delegated-tasks.ts replaced them; operator-hindsight.ts replaced the inbox).
--   • operator_claims            — DROPPED by mig 112 (DBOS-only cutover; dedupID
--       replaced the lock+TTL+heartbeat). Same baseline-re-apply zombie. No writer.
--   • harness_experts, harness_expert_turns, harness_expert_feedback
--                                — the experts subsystem is dead; no live code writes
--       them (only a stale Zero query def + drizzle schema mirror reference them).
--   • harness_dispatches         — superseded by the DBOS pipeline; the only writer
--       lives in libs/papercusp/_retired/orchestrator-run-loop/ (retired dead code).
--   • coord_subscriptions        — superseded by coord_entity_subscriptions (live,
--       274 rows). No live writer.
--   • beekeeper_sessions         — created speculatively by mig 180 but never wired:
--       the gen-0 BeekeeperStorePg writes beekeeper_instances/runs/scores only
--       (beekeeper-store-pg.ts even documents the session table was omitted for MVP).
--
-- EXPLICITLY NOT DROPPED — harness_promotions: although empty, it has a LIVE writer —
--   endpoint-route/routes/harness/promote.ts does db.insert(harnessPromotions…) on a
--   registered route (the prior audit mislabeled it an orphan; the raw-SQL grep missed
--   the drizzle insert). It is empty only because no promotion has run on this DB.
--
-- Durability: the migration runner skips already-applied files BY FILENAME (never
--   re-applies on content change), so this drop sticks on every subsequent boot, and a
--   fresh init applies baseline → 112/152/180 → THIS in order (net: all 9 gone).
--   000-baseline.sql / 180 are NOT hand-edited here (000 is GENERATED — "schema changes
--   are NEW migrations, never edits here"); both self-correct on their next regeneration
--   from a reference build, which now applies this drop.
--
-- Idempotent: DROP TABLE IF EXISTS … CASCADE (cascades each table's own indexes, RLS
--   policies, grants, and any FK among these orphans; no inbound FK from a live table).

\set ON_ERROR_STOP on
BEGIN;

-- expert child tables before the parent (FK), though CASCADE makes order moot
DROP TABLE IF EXISTS harness_shared.harness_expert_feedback CASCADE;
DROP TABLE IF EXISTS harness_shared.harness_expert_turns CASCADE;
DROP TABLE IF EXISTS harness_shared.harness_experts CASCADE;

DROP TABLE IF EXISTS harness_shared.delegate_inbox CASCADE;
DROP TABLE IF EXISTS harness_shared.delegates CASCADE;
DROP TABLE IF EXISTS harness_shared.operator_claims CASCADE;
DROP TABLE IF EXISTS harness_shared.harness_dispatches CASCADE;
DROP TABLE IF EXISTS harness_shared.coord_subscriptions CASCADE;
DROP TABLE IF EXISTS harness_shared.beekeeper_sessions CASCADE;

COMMIT;
