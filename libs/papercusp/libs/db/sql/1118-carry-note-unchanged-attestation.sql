-- 1118 — carry-note unchanged-attestation state (fleet-friction-remediation-2026-08-21 P-007 / R-06).
--
-- WHY. A held work-item's checkpoint older than STALE_CHECKPOINT_WARN_MS (15 min,
-- packages/operator-core/lib/enforcement-gate.ts) trips the 'stale-checkpoint' flush
-- tripwire, and today the ONLY way past it is to rewrite the body. When the in-flight
-- state genuinely has not moved, that rewrite is pure prose churn on the very tool an
-- agent calls because it is at its context limit. Measured over 48h to 2026-09-05 in
-- papercusp-workspace (harness_shared.tool_invocations, live build 6e898b6cf8):
-- 347 session:request-compaction refusals across 103 distinct agents; 261 of them
-- provoked a flush within 3 minutes, costing 339 checkpoint writes made only to clear
-- the gate; a further 73 were retried without flushing at all, so those boundaries
-- carried a system-written mechanical fallback instead of real state.
--
-- WHAT. Two columns on the canonical checkpoint store so an UNCHANGED ATTESTATION can
-- refresh a checkpoint's freshness without touching its text, and so that attestation
-- is BOUNDED rather than an indefinite way to look fresh while state moves underneath:
--
--   body_ts        — when `note` TEXT last actually changed. `updated_ts` continues to
--                    mean "row last touched", so an attestation bumps updated_ts while
--                    leaving body_ts pinned. The gap between them IS the attested age,
--                    which is what makes an age ceiling enforceable at all.
--   attested_count — consecutive attestations since the last real body write. Reset to
--                    0 by every genuine write. Enforces the chain ceiling.
--
-- EXPAND-ONLY, AND DELIBERATELY BACKFILL-FREE. Both columns are additive and
-- nullable-or-defaulted, so this is two catalog-only ALTERs (PG11+ fast default) and
-- nothing else. There is NO `UPDATE ... SET body_ts = updated_ts` backfill, and the
-- omission is the point rather than an oversight:
--
--   * It would be REDUNDANT. Every reader of body_ts already coalesces NULL to
--     updated_ts (attestCarryNoteUnchanged and attestWorkItemCheckpointUnchanged, both
--     with the comment "a NULL body_ts is a pre-1118 row; its last touch WAS its last
--     body write"). A backfill would only pre-compute what those two sites already
--     compute correctly, so it buys no behaviour.
--   * It would be EXPENSIVE ON THE WRONG TABLE. carry_notes is the hottest continuity
--     store in the fleet — every work_items:checkpoint and loop:checkpoint writes it —
--     and at the time of writing holds 15,450 rows in 218 MB. A whole-table UPDATE
--     rewrites every one of those rows, taking row locks that contend directly with
--     live checkpoint writes, to produce a value the code does not need.
--
-- Keeping the migration to two catalog operations also keeps its ACCESS EXCLUSIVE
-- window as short as it can be, which matters here: the ALTER queues ahead of every
-- subsequent writer, so its duration is paid by the whole fleet, not by this migration.
--
-- No FORWARD-COMPAT acknowledgment line is required: this migration contains no
-- destructive DDL (no DROP/RENAME/SET NOT NULL on an existing column, no partial
-- UNIQUE INDEX). The currently-deployed release simply does not select these columns.

ALTER TABLE harness_shared.carry_notes
  ADD COLUMN IF NOT EXISTS body_ts bigint,
  ADD COLUMN IF NOT EXISTS attested_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN harness_shared.carry_notes.body_ts IS
  'P-007/R-06: epoch ms when `note` TEXT last actually changed, as opposed to `updated_ts` which is when the row was last touched. An unchanged attestation bumps updated_ts and leaves this pinned, so (updated_ts - body_ts) is the attested age and an age ceiling is enforceable. NULL on every row written before migration 1118 — there is deliberately no backfill, because both readers coalesce NULL to updated_ts, which is the correct historical answer (attestation did not exist, so a pre-1118 row''s last touch WAS its last body write).';

COMMENT ON COLUMN harness_shared.carry_notes.attested_count IS
  'P-007/R-06: consecutive unchanged attestations since the last real body write; reset to 0 by every genuine write. Bounds the attestation chain so an attestation can extend a checkpoint''s freshness but never indefinitely — the property that stops an attestation concealing changed state.';
