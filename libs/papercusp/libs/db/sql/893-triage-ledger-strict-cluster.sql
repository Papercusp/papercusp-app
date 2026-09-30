-- 893-triage-ledger-strict-cluster.sql
-- P-003 of plan learning-loop-backlog-triage-2026-08-22 (work-item WI-40670).
--
-- Migration 892 stored ONE cluster id (the 0.90 review-queue component) while
-- deriving cluster_tier from a DIFFERENT partition (the 0.94 auto-merge band).
-- That is a reporting trap: a tier-A row's cluster_size reported its 0.90
-- component (up to 24 members) rather than the 0.94 component the tier refers
-- to, so the tier could not be acted on without re-running the clustering --
-- which is precisely what the ledger exists to avoid.
--
-- D-019 is explicit that the tiers are NOT interchangeable, so both partitions
-- are now stored side by side and cluster_tier becomes derivable from data in
-- the row itself.
--
-- Purely additive (ADD COLUMN ... NULL, no rewrite, no DROP, no SET NOT NULL),
-- so no FORWARD-COMPAT acknowledgment is required.

ALTER TABLE harness_shared.triage_ledger
  ADD COLUMN IF NOT EXISTS cluster_id_strict   text,
  ADD COLUMN IF NOT EXISTS cluster_size_strict integer;

COMMENT ON COLUMN harness_shared.triage_ledger.cluster_id IS
  'Connected component at cosine >= 0.90 -- the TIER B judged review queue. Single-linkage, so it chains: at 0.88 it merges 28% of the corpus into one component (D-019).';
COMMENT ON COLUMN harness_shared.triage_ledger.cluster_size IS
  'Size of the 0.90 component. NOT the size of the tier-A band component -- see cluster_size_strict.';
COMMENT ON COLUMN harness_shared.triage_ledger.cluster_id_strict IS
  'Connected component at cosine >= 0.94 -- the TIER A band. NOTE D-021: the 1.000 precision originally published for this band was RETRACTED to 0.833 on a full-text re-read, so this band is NOT an auto-merge licence; it is the highest-confidence review queue.';
COMMENT ON COLUMN harness_shared.triage_ledger.cluster_size_strict IS
  'Size of the 0.94 component. cluster_tier = A exactly when this exceeds 1.';
