-- 954 — agent_couplings: a typed relation alongside the free-text reason (P-009 / WI-41579).
--
-- WHY. A DECLARED coupling has carried only prose (`reason`) while DERIVED couplings carry
-- a machine-diffable `relation`. That asymmetry is what D-087 calls out: `relation` is what
-- a machine compares, `because`/`reason` is what a reader reads, and a surface that has only
-- the second cannot participate in any typed comparison — including the P-010 concentration
-- census that now watches relation share.
--
-- EXPAND-ONLY, so no FORWARD-COMPAT acknowledgement is required: this migration only ADDS a
-- nullable column. The currently-deployed release never selects or writes it, and every
-- existing row stays valid unchanged. There is no contract phase to schedule.
--
-- ⚠ NULLABLE AND DELIBERATELY NOT BACKFILLED (D-017). Measured before writing: of 187 rows
-- here, the 101 `coupled` ones all carry a reason, and those reasons cluster into four
-- shapes — of which the TWO COMMONEST have no member in the derived vocabulary:
--
--     · duplicate/overlapping work on ONE subject
--         "Both currently hold duplicate work-items WI-38745/WI-38746 for the same
--          compute.ts GitSyncFailingLeg typecheck red"
--     · both blocked on a SHARED SINGLETON
--         "Both lanes are blocked on green-checkpoint candidate 2431aa0e"
--
-- That is structural rather than accidental: a declared edge exists precisely BECAUSE the
-- relationship is not auto-detectable, so a vocabulary enumerating detectable mechanisms
-- systematically under-covers it. Backfilling those into an ill-fitting member would make
-- the typed column actively misleading — worse than the prose it improves on, because a
-- machine would then act on it. NULL is the honest value: "no typed member yet".
--
-- ⚠ NO CHECK CONSTRAINT, ON PURPOSE. The vocabulary lives in
-- `DERIVED_COUPLING_RELATIONS` (packages/operator-core/lib/coord/couplings.ts) and the
-- application types every write through it. A CHECK here would be a SECOND hand-maintained
-- copy of a value the code already owns — the exact drift the derived-truth-ladder forbids
-- — and it would additionally require a migration every time a relation is added, which is
-- precisely the friction that leaves vocabularies stale. The column comment below names the
-- authority so the next reader does not have to guess where it is enforced.

ALTER TABLE harness_shared.agent_couplings
  ADD COLUMN IF NOT EXISTS relation text;

COMMENT ON COLUMN harness_shared.agent_couplings.relation IS
  'Typed coupling relation for a DECLARED edge, mirroring the derived vocabulary. '
  'SOURCE OF TRUTH: DERIVED_COUPLING_RELATIONS in '
  'packages/operator-core/lib/coord/couplings.ts — enforced in the application, '
  'deliberately NOT by a CHECK constraint (a second copy would drift, and would force a '
  'migration per vocabulary change). NULL means no typed member fits this edge yet, which '
  'is the honest state for the two commonest declared shapes (same-subject contention and '
  'shared-singleton blocking) — see plan '
  'agent-obligation-coupling-and-consult-liveness-2026-08-25 decision D-017.';
