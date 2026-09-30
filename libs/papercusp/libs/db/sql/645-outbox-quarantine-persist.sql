-- 645-outbox-quarantine-persist.sql
--
-- WI-3896 follow-up (federation-drain-stall perpetual-refile incident,
-- papercusp 2026-07-20): the per-row poison-row quarantine that
-- outbox-drain.ts's `startOutboxDrain` maintains (`quarantinedIds`) is
-- IN-MEMORY ONLY — a `Set` closed over inside the running process. Two
-- consequences, both real, live symptoms on the papercusp harness:
--
--   1. Every process restart (this dev box's hosts self-recycle every
--      ~5-8min) forgets the quarantine and re-discovers the SAME poison
--      row(s) from scratch: 3 consecutive ROW_STAGE_TIMEOUT_MS (45s) stage
--      timeouts (~135s) before re-quarantining — repeated forever, on every
--      restart, burning drain throughput on rows already known-poison.
--
--   2. Worse: `load-drain-stats.ts` (feeding the federation-drain-reconcile,
--      WI-254) measures `oldestUndrainedAgeMs` over ALL `drained_at IS NULL`
--      rows — including permanently-quarantined ones. A poison row that is
--      correctly, deliberately left undrained (quarantine is a triage
--      decision, never a silent drop — see outbox-drain.ts's WI-3896
--      doc-comment) therefore keeps the harness looking "stalled" FOREVER
--      (the age only grows), so the reconcile refiles a fresh "Federation
--      stall" bug (EI-681 class) every time the previous one is closed —
--      even though the harness is, in fact, healthy and draining fresh
--      writes in near-real-time. Live evidence: papercusp's outbox_drain
--      backlog fluctuated 0 -> 11576 -> 7554 rows for `engineer_issues`
--      captures within minutes while a handful of ~9-day-old rows (captured
--      2026-07-10, already `state='done'`) sat permanently undrained —
--      exactly the quarantined-row shape.
--
-- FIX: persist quarantine as a `quarantined_at` timestamp on the row itself.
-- outbox-drain.ts (companion change, same commit):
--   - loads persisted quarantined ids into its in-memory set at start (a
--     restart no longer re-discovers + re-times-out the same poison rows),
--   - stamps `quarantined_at` the moment a row crosses ROW_QUARANTINE_THRESHOLD,
--   - excludes `quarantined_at IS NOT NULL` rows from the drain SELECT batch
--     (frees full batch capacity for real candidates instead of re-fetching +
--     skipping known-poison rows every pass).
-- load-drain-stats.ts (companion change) excludes quarantined rows from the
-- undrained/oldest-age computation, so the reconcile's stall metric reflects
-- only the REAL, actionable backlog.
--
-- Manual clear (the runbook these doc-comments have promised since WI-3896):
-- once a quarantined row's root cause is understood, either
--   (a) accept it will never federate: leave quarantined_at set (already
--       excluded from health/backlog metrics — no further action needed), or
--   (b) retry it: `UPDATE harness_shared.substrate_outbox SET quarantined_at
--       = NULL WHERE id = <id>` — the next drain pass re-attempts it fresh.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.
-- NOTE: no top-level BEGIN/COMMIT and no psql \set meta-commands — the
-- migration runner (pg-based db:migrate) applies each migration inside its
-- own transaction and records schema_migrations in that same txn; an explicit
-- transaction here breaks that wrapping and is rejected by lint-migrations.

ALTER TABLE harness_shared.substrate_outbox
  ADD COLUMN IF NOT EXISTS quarantined_at bigint;

COMMENT ON COLUMN harness_shared.substrate_outbox.quarantined_at IS
  'WI-3896 follow-up (mig 645): epoch-ms this row was quarantined as poison '
  '(consecutive per-row stage timeouts, ROW_QUARANTINE_THRESHOLD) — the row '
  'is deliberately left undrained (drained_at stays NULL) and excluded from '
  'the drain SELECT batch + the federation-drain-reconcile stall metric. '
  'NULL = not quarantined (normal). Manual retry: SET quarantined_at = NULL.';
