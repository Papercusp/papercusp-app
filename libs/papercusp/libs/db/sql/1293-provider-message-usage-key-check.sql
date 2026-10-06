-- 1293-provider-message-usage-key-check.sql
--
-- WI-10004637 recurrence guard: one provider message can never persist as two usage rows.
--
-- The defect: the interactive-usage ingester keyed a provider message (`message:<id>`) by the
-- transcript FILE it was read from, so each copy of a carried/resumed session's transcript
-- inserted its own row (up to 96 copies of one request; ~4.7x inflated inference cost since
-- 2026-09-20). The ingester now keys it by transcriptUsageEventKey = sha256(['provider-message',
-- model, sourceId]); migrations 1287 and 1292 repaired the rows already written.
--
-- This CHECK makes the forward key a database invariant: an interactive `message:` row must
-- carry harness_shared.transcript_provider_message_usage_key(model, sourceId) (1287's SQL mirror
-- of the TypeScript key, byte-for-byte). Together with the existing unique index
-- agent_usage_samples_ws_event_key_idx on (workspace_id, usage_event_key), at most one row per
-- (workspace, model, provider message) can exist. A writer that regresses to a file-scoped key
-- now fails loudly at INSERT instead of silently multiplying cost. Id-less observations
-- (`line:` / `aggregate:`) stay file-scoped and are not constrained.
--
-- The constraint is added NOT VALID, then validated. 1287 deliberately leaves a group whose
-- copies carry DIFFERENT numbers on its old keys (deleting one would lose data). An install
-- holding such rows keeps the constraint NOT VALID (still enforced for every new write) instead
-- of failing to migrate. The dev box has none (verified 2026-10-01 after 1292), so it validates.
--
-- FORWARD-COMPAT: additive CHECK only; nothing is dropped or renamed. The only writer of these
-- rows is the interactive-usage ingester, which runs on the host that loads this tree's code
-- (bg-host here, the sidecar with the code it ships elsewhere), and that code already writes the
-- provider-message key (commit 4bebc278e0). Measured: 0 old-key rows ingested since 07:21Z.

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.agent_usage_samples'::regclass
       AND conname = 'agent_usage_samples_provider_message_key_ck'
  ) THEN
    ALTER TABLE harness_shared.agent_usage_samples
      ADD CONSTRAINT agent_usage_samples_provider_message_key_ck CHECK (
        source IS DISTINCT FROM 'interactive'
        OR usage_event_key IS NULL
        OR model IS NULL
        OR (usage_provenance->>'sourceId') IS NULL
        OR (usage_provenance->>'sourceId') NOT LIKE 'message:%'
        OR usage_event_key = harness_shared.transcript_provider_message_usage_key(model, usage_provenance->>'sourceId')
      ) NOT VALID;
  END IF;

  BEGIN
    ALTER TABLE harness_shared.agent_usage_samples
      VALIDATE CONSTRAINT agent_usage_samples_provider_message_key_ck;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'agent_usage_samples_provider_message_key_ck left NOT VALID: existing provider-message rows with diverged copies keep their legacy key (see migration 1287); new writes are still checked';
  END;
END
$do$;

COMMENT ON CONSTRAINT agent_usage_samples_provider_message_key_ck ON harness_shared.agent_usage_samples IS
  'WI-10004637: an interactive message: usage row must use transcript_provider_message_usage_key(model, sourceId), so with agent_usage_samples_ws_event_key_idx one provider message is one row.';
