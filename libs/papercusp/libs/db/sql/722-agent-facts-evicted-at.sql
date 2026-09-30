-- 722-agent-facts-evicted-at.sql
--
-- WI-6935 (b): make a per-scope CAP EVICTION distinguishable from a deliberate
-- `facts:retract`.
--
-- ── THE DEFECT ───────────────────────────────────────────────────────────────
--
-- The per-scope cap (FACTS_PER_SCOPE_CAP = 50, agent-facts/store.ts) enforces
-- itself by setting `retracted_at = now()` on the oldest-updated live facts past
-- the cap. That is the SAME field a deliberate retract writes, so to every
-- downstream reader a machine eviction is INDISTINGUISHABLE from a human or
-- agent deciding the fact no longer applies. The word in the work-item title is
-- "silently", and this column is the fix for that word specifically.
--
-- This is not hypothetical. Measured 2026-08-02: 11 facts were evicted from
-- scope harness:papercusp in 25 minutes — ordinary long-TTL `conclusion` rows,
-- some with TTLs months out — and two were traceable to the evicting agent's
-- OWN asserts to the millisecond. Nothing in the table recorded that those
-- retractions were machine-authored, so the destruction could only be inferred
-- by correlating timestamps by hand.
--
-- ── WHY ADDITIVE, NOT A REPLACEMENT ──────────────────────────────────────────
--
-- The obvious shape — "stop writing retracted_at, write evicted_at instead" —
-- is WRONG here, and quietly so. `retracted_at IS NULL` is not merely a filter
-- in a few queries; it is baked into the table's partial INDEXES (444, 689 x2,
-- 690) and into the federation update-capture triggers (461, 462). Moving the
-- eviction off that field would spring every evicted row back into every fold —
-- i.e. the cap would silently STOP CAPPING — while also dropping eviction out of
-- federation capture. So the cap keeps writing `retracted_at` exactly as before
-- and additionally stamps `evicted_at`, which changes no existing behavior and
-- adds the provenance that was missing:
--
--   evicted_at IS NOT NULL  ⇒ the machine cap chose this row
--   evicted_at IS NULL      ⇒ somebody decided it no longer applies
--
-- Deliberately NOT indexed: this column is for audit/forensics ("was that fact
-- retracted or evicted?"), not for a hot read path. `agent_facts` is a hot table
-- and every partial index on it is already carrying its weight; adding an index
-- with no query behind it would be pure write-amplification. Add one WITH the
-- query that needs it, not before.

ALTER TABLE harness_shared.agent_facts
  ADD COLUMN IF NOT EXISTS evicted_at timestamptz;

COMMENT ON COLUMN harness_shared.agent_facts.evicted_at IS
  'WI-6935: set (alongside retracted_at) when the per-scope cap evicted this row. '
  'NULL alongside a non-NULL retracted_at means a DELIBERATE facts:retract. '
  'Audit provenance only — never a fold filter; retracted_at remains the liveness field.';
