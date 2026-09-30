-- 443-comms-trust-gate-grant.sql
-- cross-machine-coord-parity-and-trust-2026-07-01 P-047 (DG-4): the explicit
-- GATE trust grant in the comms-trust store — "this member's test-shard
-- verdicts COUNT toward the distributed gate's green(S)". SEPARABLE from the
-- comms tier lattice by construction (its own column): a member can be
-- steer-trusted but gate-untrusted (their agents may direct yours, but their
-- verdicts don't green a release) and vice versa (a dedicated CI box you'd
-- never let steer, whose verdicts you fully trust).
--
-- Two changes to harness_shared.comms_trust_list (mig 435):
--   1. `gate boolean NOT NULL DEFAULT false` — the grant. Default DENY
--      (fail-closed: the DG-5 aggregator only counts verdicts from explicitly
--      gate-granted members).
--   2. `tier` becomes NULLABLE: a row created purely to carry a gate grant
--      stores tier = NULL, which resolution (comms-trust.ts effectiveCommsTier)
--      SKIPS — so granting gate never fabricates a comms-tier override that
--      would shadow the hive-policy default. (The CHECK constraint passes on
--      NULL — CHECK only fails on FALSE.)
--
-- LOCAL-ONLY / NEVER FEDERATED, exactly like the tier grants (mig 435 posture):
-- federating a gate grant would let a peer influence what greens YOUR release.
-- No capture trigger, no stamp trigger (no fed_hlc column — the stamp-coverage
-- guard keys on that).

BEGIN;

ALTER TABLE harness_shared.comms_trust_list
  ADD COLUMN IF NOT EXISTS gate boolean NOT NULL DEFAULT false;

ALTER TABLE harness_shared.comms_trust_list
  ALTER COLUMN tier DROP NOT NULL;

COMMENT ON COLUMN harness_shared.comms_trust_list.gate IS
  'DG-4 (P-047): the OWNER''s explicit grant that this member''s distributed-test-gate verdicts count toward green(S). Separable from the comms tier; default false (fail-closed). Respects the row''s expires_at (a probationary gate grant decays).';
COMMENT ON COLUMN harness_shared.comms_trust_list.tier IS
  'Comms-tier override (observe<message<wake<steer), or NULL when the row exists only for other grants (e.g. gate) — a NULL tier is SKIPPED at resolution and never shadows the hive-policy default.';

COMMIT;
