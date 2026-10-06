-- 1326: re-queue every chat bucket of a data source when a column that routes its units changes.
--
-- WI-10005117 (plan enterprise-data-sources-2026-10-01, P-015 / D-005 follow-up).
--
-- rollupChatUnits re-renders only QUEUED buckets (chat_rollup_queue), and until now only message
-- writes enqueued them (upsertChatMessages / tombstoneChatMessage / purgeExpiredChatMessages). So
-- when a source's routing changed (scope, scope_ref, owner, provider account, datatype mapping,
-- destination policy or permission mapping), its existing units kept their OLD destination until a
-- new message happened to touch each bucket. Example: an organization source moved to a pot kept
-- its organization corpus rows readable through the channel permission list.
--
-- The fix lives in the database so every writer is covered (config tools, admin SQL, future
-- connectors). The trigger enqueues every bucket that has a chat_retrieval_units row for the
-- source; a unit row exists for every rendered bucket whether or not it routes to the corpus
-- (document_dedupe_key is NULL when it does not), so units are a complete bucket index. A bucket
-- with messages but no unit yet is already queued by the message write that created it.
--
-- unit_kind -> bucket_kind mapping (1320 section 3/4): thread units recompute from their thread
-- bucket; window units recompute from their UTC-day bucket. unit.bucket_key stores that key.
--
-- The column list and the WHEN clause mirror exactly what rollupChatUnits reads to route a unit
-- (packages/operator-core/lib/data-sources/chat-retrieval-units.ts, the data_sources SELECT in
-- rollupChatUnits, and corpusRouteFor). A change to status, config, credential_ref or the
-- connection timestamps enqueues nothing.
--
-- RLS: data_sources, chat_retrieval_units and chat_rollup_queue share the same workspace
-- isolation policy and owner, and none is FORCE ROW LEVEL SECURITY. A session that can update a
-- data_sources row either bypasses RLS (and so does this trigger) or is scoped to that row's
-- workspace (and so are the trigger's SELECT and INSERT). SECURITY DEFINER is not needed.
--
-- Additive only: a new function and a new trigger. Re-runnable.

CREATE OR REPLACE FUNCTION harness_shared.data_sources_requeue_chat_buckets()
RETURNS trigger
LANGUAGE plpgsql
AS $requeue$
BEGIN
  INSERT INTO harness_shared.chat_rollup_queue
    (workspace_id, data_source_id, channel_id, bucket_kind, bucket_key)
  SELECT DISTINCT
         u.workspace_id,
         u.data_source_id,
         u.channel_id,
         CASE u.unit_kind WHEN 'thread' THEN 'thread' ELSE 'day' END,
         u.bucket_key
    FROM harness_shared.chat_retrieval_units AS u
   WHERE u.workspace_id = NEW.workspace_id
     AND u.data_source_id = NEW.id
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$requeue$;

COMMENT ON FUNCTION harness_shared.data_sources_requeue_chat_buckets() IS
  'WI-10005117: re-queue every chat_rollup_queue bucket of a data source whose routing columns changed, so rollupChatUnits moves existing units to the new destination without waiting for a new message.';

DROP TRIGGER IF EXISTS data_sources_requeue_chat_buckets ON harness_shared.data_sources;
CREATE TRIGGER data_sources_requeue_chat_buckets
  AFTER UPDATE OF kind, scope, scope_ref, owner_user_id, provider_account_id,
                  datatype_mappings, destination_policy, permission_mapping
  ON harness_shared.data_sources
  FOR EACH ROW
  WHEN (
       OLD.kind                IS DISTINCT FROM NEW.kind
    OR OLD.scope               IS DISTINCT FROM NEW.scope
    OR OLD.scope_ref           IS DISTINCT FROM NEW.scope_ref
    OR OLD.owner_user_id       IS DISTINCT FROM NEW.owner_user_id
    OR OLD.provider_account_id IS DISTINCT FROM NEW.provider_account_id
    OR OLD.datatype_mappings   IS DISTINCT FROM NEW.datatype_mappings
    OR OLD.destination_policy  IS DISTINCT FROM NEW.destination_policy
    OR OLD.permission_mapping  IS DISTINCT FROM NEW.permission_mapping
  )
  EXECUTE FUNCTION harness_shared.data_sources_requeue_chat_buckets();
