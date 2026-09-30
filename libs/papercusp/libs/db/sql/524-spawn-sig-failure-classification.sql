-- 524-spawn-sig-failure-classification.sql
--
-- WI-3190: a spawn-signing key rotation (coarse revocation) invalidates every
-- in-flight signed MCP URL, which then fails verification with reason
-- `invalid_signature` — byte-identical to the reason a genuine role-escalation
-- ATTEMPT produces. The on-call dashboard (harness_shared.spawn_sig_verification_failures)
-- therefore could not tell an operational strand (a previously-authenticated
-- agent whose key was rotated out from under it — must be re-spawned) from an
-- attack (a worker rewriting ?role=). This column records that classification so
-- `WHERE classification = 'rotation_strand'` is the actionable re-spawn queue.
--
-- Values written by the MCP handler (spawn-signing.ts classifyAndConsumeFailure):
--   'rotation_strand' — reason ∈ {invalid_signature,expired} AND this operator
--                       process had previously verified this exact spawn.
--   'unverified'      — a first-seen spawn / malformed params / escalation attempt
--                       (never authenticated by this process).
--   NULL              — pre-migration rows (classification unknown).
--
-- Additive + idempotent. No backfill (history is unclassifiable after the fact).

ALTER TABLE harness_shared.spawn_sig_verification_failures
  ADD COLUMN IF NOT EXISTS classification text;

-- Partial index so the dashboard's "show me the rotation strands" query stays
-- cheap without bloating the index for the common (NULL/unverified) rows.
CREATE INDEX IF NOT EXISTS spawn_sig_failures_classification_idx
  ON harness_shared.spawn_sig_verification_failures (classification, ts DESC)
  WHERE classification IS NOT NULL;
