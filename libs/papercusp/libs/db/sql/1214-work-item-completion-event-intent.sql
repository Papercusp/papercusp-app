-- P-020: keep the intent to publish work-item:done in the same committed row
-- as the terminal state. The await sweeper retries an intent until the existing
-- event_key_fires latch confirms publication. No second task-state ledger.
-- The runner wraps this file in its transaction.

CREATE OR REPLACE FUNCTION harness_shared.stamp_work_item_completion_event_intent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, harness_shared
AS $fn$
DECLARE
  prior_intent text;
  acknowledged boolean;
BEGIN
  -- A caller cannot invent a pending completion at creation. Federated
  -- terminal inserts keep their status/closed_ts but are not a local close.
  IF TG_OP = 'INSERT' THEN
    NEW.payload := COALESCE(NEW.payload, '{}'::jsonb) - '_completionEventIntentId';
    RETURN NEW;
  END IF;

  IF NOT harness_shared.work_item_status_is_terminal(OLD.status)
     AND harness_shared.work_item_status_is_terminal(NEW.status) THEN
    -- A fresh UUID distinguishes rapid close/reopen/close cycles even when
    -- closed_ts rounds both transitions to the same millisecond.
    NEW.payload := COALESCE(NEW.payload, '{}'::jsonb)
      || jsonb_build_object('_completionEventIntentId', gen_random_uuid()::text);
  ELSIF NOT harness_shared.work_item_status_is_terminal(NEW.status) THEN
    -- Reopening retires the old cycle; the existing reopen path also clears
    -- its work-item:done fire latch before returning.
    NEW.payload := COALESCE(NEW.payload, '{}'::jsonb) - '_completionEventIntentId';
  ELSE
    prior_intent := OLD.payload->>'_completionEventIntentId';
    IF prior_intent IS NULL THEN
      -- Terminal reassertions may not manufacture a new intent.
      NEW.payload := COALESCE(NEW.payload, '{}'::jsonb) - '_completionEventIntentId';
    ELSIF NEW.payload->>'_completionEventIntentId' IS DISTINCT FROM prior_intent THEN
      IF NEW.payload->>'_completionEventIntentId' IS NOT NULL THEN
        -- Never replace an in-flight cycle with caller-provided payload.
        NEW.payload := COALESCE(NEW.payload, '{}'::jsonb)
          || jsonb_build_object('_completionEventIntentId', prior_intent);
      ELSE
        -- Only the matching, durably published event may clear the intent.
        SELECT EXISTS (
          SELECT 1 FROM harness_shared.event_key_fires AS fire
           WHERE fire.workspace_id = 'default'
             AND fire.event_key = 'work-item:done:' || OLD.feature_id
             AND fire.last_payload->>'completionIntentId' = prior_intent
        ) INTO acknowledged;
        IF acknowledged THEN
          NEW.payload := COALESCE(NEW.payload, '{}'::jsonb)
            - '_completionEventIntentId';
        ELSE
          NEW.payload := COALESCE(NEW.payload, '{}'::jsonb)
            || jsonb_build_object('_completionEventIntentId', prior_intent);
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

-- Backfill before installing the trigger: a terminal-to-terminal UPDATE after
-- installation rightly rejects a caller-manufactured token. Only rows with a
-- still-pending waiter need rescue; historical terminal rows without listeners
-- are not replayed en masse as surprise inbox notifications.
UPDATE harness_shared.work_items AS item
   SET payload = COALESCE(item.payload, '{}'::jsonb)
                 || jsonb_build_object('_completionEventIntentId', gen_random_uuid()::text)
 WHERE item.closed_ts IS NOT NULL
   AND harness_shared.work_item_status_is_terminal(item.status)
   AND NOT (COALESCE(item.payload, '{}'::jsonb) ? '_completionEventIntentId')
   AND EXISTS (
     SELECT 1 FROM harness_shared.event_awaits AS awaited
      WHERE awaited.workspace_id = 'default'
        AND awaited.event_key = 'work-item:done:' || item.feature_id
        AND awaited.policy <> 'announce'
        AND awaited.fired_at IS NULL
        AND awaited.cancelled_at IS NULL
   )
   AND NOT EXISTS (
     SELECT 1 FROM harness_shared.event_key_fires AS fire
      WHERE fire.workspace_id = 'default'
        AND fire.event_key = 'work-item:done:' || item.feature_id
        AND (extract(epoch FROM fire.last_fired_at) * 1000)::bigint >= item.closed_ts
   );

DROP TRIGGER IF EXISTS zz_work_item_completion_event_intent_trg ON harness_shared.work_items;
CREATE TRIGGER zz_work_item_completion_event_intent_trg
  BEFORE INSERT OR UPDATE ON harness_shared.work_items
  FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_work_item_completion_event_intent();

-- Bounded sweep reads touch only newly pending rows, rather than scanning all
-- historical terminal work_items on every 30-second await tick.
CREATE INDEX IF NOT EXISTS work_items_completion_event_intent_idx
  ON harness_shared.work_items (workspace_id, closed_ts, feature_id)
  WHERE payload ? '_completionEventIntentId';
