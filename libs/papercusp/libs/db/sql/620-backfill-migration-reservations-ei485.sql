-- 620-backfill-migration-reservations-ei485.sql
--
-- EI-485 (green-checkpoint gate coverage gap): green-checkpoint's `greenCmd`
-- (npm run test:affected) + the SPA build are the ENTIRE definition of
-- "green" — lint:migrations' PG-backed unreserved-number check (check 5:
-- every migration number >= ENFORCED_FROM must have a
-- harness_shared.migration_reservations row, i.e. was allocated via
-- db:next-migration rather than hand-picked `ls | tail`) was never wired
-- into any automated gate. Running `npm run lint:migrations` locally today
-- (2026-07-17) surfaces 16 already-applied, already-ledgered migration
-- numbers >= ENFORCED_FROM (494) that were hand-picked without a
-- reservation row:
--
--   550 555 562 563 564 569 573 580 584 600 608 609 610 612 613 614
--
-- These are immutable applied history (sha256-verified by the migration
-- runner) — they cannot be renumbered or re-picked. Backfilling their
-- reservation rows here (idempotent, ON CONFLICT DO NOTHING, so a fleet-wide
-- concurrent re-apply is a no-op) is the same grandfathering shape
-- lint-migrations.mjs already uses for its FS-only checks: acknowledge the
-- pre-gate debt once, then let the gate hold the line on anything NEW. This
-- is what makes it safe to add `lint:migrations` to green-checkpoint's
-- runGreen() in the SAME change (release-config.ts / green-checkpoint.ts) —
-- wiring the gate first, without this backfill, would immediately hold
-- `main` red on 16 numbers nobody today can act on.
INSERT INTO harness_shared.migration_reservations (num, filename, reserved_by, intent, reserved_at)
VALUES
  (550, '550-event-awaits-announce-scope.sql', 'backfill-ei485', 'backfilled: applied without a db:next-migration reservation row (EI-485 gate-coverage sweep)', now()),
  (555, '555-cup-lexicon-db-rename-phase2-bee-claim-specs-beekeeper.sql', 'backfill-ei485', 'backfilled: applied without a db:next-migration reservation row (EI-485 gate-coverage sweep)', now()),
  (562, '562-memory-shareable-federation.sql', 'backfill-ei485', 'backfilled: applied without a db:next-migration reservation row (EI-485 gate-coverage sweep)', now()),
  (563, '563-memory-federation-capture-triggers.sql', 'backfill-ei485', 'backfilled: applied without a db:next-migration reservation row (EI-485 gate-coverage sweep)', now()),
  (564, '564-memory-federation-columns.sql', 'backfill-ei485', 'backfilled: applied without a db:next-migration reservation row (EI-485 gate-coverage sweep)', now()),
  (569, '569-event-awaits-policy-allow-announce.sql', 'backfill-ei485', 'backfilled: applied without a db:next-migration reservation row (EI-485 gate-coverage sweep)', now()),
  (573, '573-owner-activity-human-turn-presence.sql', 'backfill-ei485', 'backfilled: applied without a db:next-migration reservation row (EI-485 gate-coverage sweep)', now()),
  (580, '580-memory-live-recall-canary.sql', 'backfill-ei485', 'backfilled: applied without a db:next-migration reservation row (EI-485 gate-coverage sweep)', now()),
  (584, '584-beacon-consent-change-notify-natural-key.sql', 'backfill-ei485', 'backfilled: applied without a db:next-migration reservation row (EI-485 gate-coverage sweep)', now()),
  (600, '600-fleet-headcount-governor.sql', 'backfill-ei485', 'backfilled: applied without a db:next-migration reservation row (EI-485 gate-coverage sweep)', now()),
  (608, '608-spawned-agents-result-path.sql', 'backfill-ei485', 'backfilled: applied without a db:next-migration reservation row (EI-485 gate-coverage sweep)', now()),
  (609, '609-session-cursor.sql', 'backfill-ei485', 'backfilled: applied without a db:next-migration reservation row (EI-485 gate-coverage sweep)', now()),
  (610, '610-push-delivery.sql', 'backfill-ei485', 'backfilled: applied without a db:next-migration reservation row (EI-485 gate-coverage sweep)', now()),
  (612, '612-collision-hysteresis.sql', 'backfill-ei485', 'backfilled: applied without a db:next-migration reservation row (EI-485 gate-coverage sweep)', now()),
  (613, '613-topic-hysteresis.sql', 'backfill-ei485', 'backfilled: applied without a db:next-migration reservation row (EI-485 gate-coverage sweep)', now()),
  (614, '614-adjacency-state.sql', 'backfill-ei485', 'backfilled: applied without a db:next-migration reservation row (EI-485 gate-coverage sweep)', now())
ON CONFLICT (num) DO NOTHING;
