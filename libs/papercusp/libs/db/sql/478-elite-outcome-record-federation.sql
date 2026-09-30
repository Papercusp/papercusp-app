-- 478-elite-outcome-record-federation.sql — F1-6 / P-014 of
-- federated-scout-gym-learning-2026-07-02 (review H3, D-005 hole 3).
--
-- DEVICE-SIGNED elite OUTCOME RECORD federation. D-005 (3) ELIGIBILITY:
-- "sender-asserted outcomes are NOT a gate — device-signed outcome records
-- (reuse P-044 gate-verdict shape) WHERE VERIFIABLE." Today the elite gate is the
-- sender-stamped `gym_qd_archive.federatable` boolean (D-002: outcome=won OR
-- grade>=4) — a peer can stamp it on any garbage to farm a locally-empty niche's
-- novelty-gift bonus. This carries a device-signed proof so the receiver can
-- VERIFY the outcome offline (lib/gym/qd/elite-outcome-record.ts):
--
--   * gym_qd_archive.outcome_record (jsonb): the LOCAL writer's signed
--     EliteOutcomeRecord for this niche's elite. CDC-captured onto the peer-log
--     alongside the elite op (via the archive's existing capture triggers) so it
--     federates with the elite. NULL until the send-side signer (federate-elite.ts
--     markEliteFederatable) is wired — the column is inert-but-present, tier-1
--     backward-compatible.
--   * gym_qd_foreign_elites.outcome_record (jsonb): the RECEIVED signed record,
--     retained for audit / re-verification / revocation re-checks.
--   * gym_qd_foreign_elites.outcome_verified (boolean): the RECEIVER-side verdict —
--     TRUE iff verifyEliteOutcomeForElite passed (shape + Ed25519 signature +
--     D-002 outcome + niche/candidate binding + signer-device anti-lift +
--     admitted-member membership). An ABSENT or INVALID record => FALSE: the elite
--     is STILL admitted (tier-1 hive-members admission stays backward-compatible),
--     just outcome-UNVERIFIED, so the P-009 reputation/weighting layer can weight a
--     device-verified elite above a merely sender-asserted one ("where verifiable").
--     Storage admission != gate trust — the same split gate verdicts draw.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS). Additive columns inherit the tables'
-- existing RLS policies + grants — no re-grant needed. Runner records
-- schema_migrations (filename + sha256); this file just COMMITs.

\set ON_ERROR_STOP on
BEGIN;

-- SEND side: the local writer's signed outcome record, captured + federated with
-- the elite. (The archive's PK is (workspace_id, harness_slug, niche_key) — one
-- row per niche; the record is for THAT niche's current elite.)
ALTER TABLE harness_shared.gym_qd_archive
  ADD COLUMN IF NOT EXISTS outcome_record jsonb;

COMMENT ON COLUMN harness_shared.gym_qd_archive.outcome_record IS
  'F1-6/P-014: device-signed EliteOutcomeRecord (elite-outcome-record.ts) for this niche''s elite, CDC-captured + federated with the elite op. NULL until the send-side signer is wired (tier-1 backward-compatible).';

-- RECEIVE side: the received signed record (audit) + the receiver-side verdict.
ALTER TABLE harness_shared.gym_qd_foreign_elites
  ADD COLUMN IF NOT EXISTS outcome_record jsonb,
  ADD COLUMN IF NOT EXISTS outcome_verified boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN harness_shared.gym_qd_foreign_elites.outcome_record IS
  'F1-6/P-014: the RECEIVED device-signed EliteOutcomeRecord (audit / re-verification / revocation re-check). NULL when a foreign elite carried no record (sender-asserted only).';
COMMENT ON COLUMN harness_shared.gym_qd_foreign_elites.outcome_verified IS
  'F1-6/P-014: receiver-side verdict — TRUE iff verifyEliteOutcomeForElite passed (sig + D-002 + niche/candidate binding + signer-device anti-lift + membership). Absent/invalid record => FALSE (still admitted, just outcome-UNVERIFIED; the reputation layer weights verified elites higher).';

COMMIT;
