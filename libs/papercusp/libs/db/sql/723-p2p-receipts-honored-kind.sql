-- 723-p2p-receipts-honored-kind.sql — EI-19333624101736074.
-- Widen the p2p_receipts kind taxonomy to admit 'honored': the SUCCESS receipt.
--
-- WHY a new kind rather than reusing one (the reuse was tried and rejected):
--   * kind='refusal' REQUIRES a structured refusal {code, detail} (receipts.ts)
--     and feeds bumpRefusedOpCounter — the M15/P-413 counters that are the
--     trust boundary's ONLY evidence that a foreign-work op was refused. A
--     SUCCESS emitted through that path corrupts exactly that evidence, and
--     renders in p2p:trace as a refusal. Strictly worse than the silence.
--   * kind='excused-breach' is preemption-class (X8), excluded from
--     reliability signals. A completed honor is not a breach.
--   * work-intake-tick.ts:362-367 hit this same wall on the WON path and
--     declined to fake it: "no 'claimed'/'executed' kind to emit truthfully
--     anyway ... A distinct success-receipt kind is real product surface —
--     flagged, not invented." This migration is that surface.
--
-- THE DEFECT IT CLOSES: the delegated-spawn path was LOUD on refusal and
-- SILENT on success. `local_disposition` is deliberately host-local and never
-- federates (projections/work-offers.ts:22,330), so a successful honor left
-- NOTHING on the requester's host. Measured 2026-08-02 (tower->Win rig): a
-- member spawned, joined fleet 'fed-drill' at 08:11:25Z and died at boot; the
-- requesting host's total evidence afterwards was zero receipts, no
-- disposition, and a presence row that aged out — i.e. a phantom honor was
-- indistinguishable from "nobody picked it up". Two full wakes were spent on
-- that ambiguity alone.
--
-- FORWARD/BACKWARD COMPAT (the ordering actually matters here):
--   A peer that has not run this migration DROPS an inbound 'honored' row at
--   isP2pReceiptWireRow (KIND_SET) before it ever reaches this constraint. That
--   is a silent drop of a receipt which TODAY IS NOT EMITTED AT ALL, so it is
--   strictly not-worse than the status quo and self-heals once the peer
--   updates. The emitting side is the HONORING host, so for the broken
--   tower->rig direction the RECEIVER is the tower (updatable) and the emitter
--   is the rig (which cannot emit anything until it updates — see
--   EI-19330215508907244). Nothing regresses in the interim.
--
-- Idempotent; apply via the runner (db:migrate) or psql + schema_migrations
-- row in one txn.

-- FORWARD-COMPAT: the DROP+ADD below WIDENS p2p_receipts_kind from
-- ('refusal','excused-breach') to add 'honored' as a third allowed value — every value
-- the deployed release can possibly write today remains valid under the new, superset
-- CHECK. This is the DROP-then-ADD idempotent-re-add pattern PG requires for altering a
-- CHECK body (no ADD CONSTRAINT IF NOT EXISTS exists), not a narrowing; the deployed
-- release (checked against sha 1e0ddc5864) does not emit 'honored' yet (that is exactly
-- what this migration's own header explains — the emitting code ships separately,
-- EI-19330215508907244). (WI-6842)

\set ON_ERROR_STOP on

DO $$
BEGIN
    IF to_regclass('harness_shared.p2p_receipts') IS NULL THEN
        RAISE NOTICE 'harness_shared.p2p_receipts absent (mig 468 not applied) — nothing to widen.';
        RETURN;
    END IF;

    -- DROP-then-ADD is what makes this re-runnable: ADD CONSTRAINT alone is not
    -- idempotent, and there is no ADD CONSTRAINT IF NOT EXISTS in PG.
    ALTER TABLE harness_shared.p2p_receipts
        DROP CONSTRAINT IF EXISTS p2p_receipts_kind;

    ALTER TABLE harness_shared.p2p_receipts
        ADD CONSTRAINT p2p_receipts_kind
        CHECK (kind IN ('refusal', 'excused-breach', 'honored'));
END $$;

COMMENT ON CONSTRAINT p2p_receipts_kind ON harness_shared.p2p_receipts IS
    'X8 receipt taxonomy. refusal = a refused/interrupted cross-peer action '
    '(carries refusal_code). excused-breach = preemption-class interruption, '
    'excluded from reliability signals (P-203). honored = the SUCCESS fact for '
    'a completed cross-peer action (EI-19333624101736074) — carries NO '
    'refusal_code and does NOT bump the M15 refused-op counters. Keep this list '
    'in sync with P2P_RECEIPT_KINDS in packages/operator-core/lib/p2p/receipts.ts: '
    'it is a WIRE CONTRACT, and a peer predating a new kind drops those rows.';
