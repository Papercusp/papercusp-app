-- Migration 558 — created_by (originator provenance) on the routed-idea ledger
-- (P-001, su-ideate-learning-substrate-2026-07-10).
--
-- WHY: origin='su-ideate' rows (su-loop-capability-parity P-005 / D-009) carry
-- no record of WHICH agent originated the idea, so the grade→revise wake (that
-- plan's P-005), the scope:'mine' feedback read (D-014), and per-agent ideation
-- analytics (P-013) have no join key. Nullable text: Scout-origin rows never
-- set it, and pre-P-001 su rows are backfilled best-effort later (P-016 —
-- feature_audit first-actor), so NULL stays a legitimate value forever.
--
-- The partial index serves the two hot su reads — "my ideas" (created_by =
-- caller within origin='su-ideate') and the su-partition analytics scans —
-- without taxing Scout-origin rows or the existing readers.
--
-- Migration-runner contract: each file runs in its own transaction — no
-- top-level BEGIN;/COMMIT; (files >= 215).

ALTER TABLE harness_shared.scout_routed_ideas
  ADD COLUMN IF NOT EXISTS created_by text NULL;

CREATE INDEX IF NOT EXISTS scout_routed_ideas_su_creator_idx
  ON harness_shared.scout_routed_ideas (origin, created_by)
  WHERE origin = 'su-ideate';
