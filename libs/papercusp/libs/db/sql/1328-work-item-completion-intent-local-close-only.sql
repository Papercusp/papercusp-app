-- WI-10005136: only a LOCAL close mints a completion-event intent.
--
-- Migration 1214 stamps payload._completionEventIntentId on every
-- non-terminal -> terminal UPDATE. A federation projection apply of a PEER's close is
-- also such an UPDATE, so every receiving node minted its own intent for a close it did
-- not make. That node's completion-event reconciler then fired work-item:done locally and
-- cleared the key with a plain UPDATE, which the federation stamp turned into a fresh
-- origin='local' write with a newer HLC. The copy won LWW back on the publisher and
-- flipped the publisher's own row to origin='remote'. Measured 2026-10-01/02: a Mac rig
-- peer re-stamped tower-closed rows in bursts of 5-34; 3,713 tower work_items carried the
-- peer's clock (WI-10005136). The terminal->terminal branch had the same shape: when the
-- publisher's acknowledgement (key removed) arrived, a receiver with no local fire
-- RESTORED the stale intent, which its reconciler then cleared locally.
--
-- 1214's INSERT branch already states the rule ("Federated terminal inserts ... are not
-- a local close"). This applies it to UPDATE: a write that moves the wire order key
-- (fed_ts or fed_hlc) is a projection apply or an explicit repair, exactly as
-- stamp_local_federated_write classifies it, and its payload is the publisher's. Keep it
-- verbatim. The trigger runs before the federation stamp (migration 1227), so a local
-- write still carries OLD's clock here and takes the unchanged 1214 logic below.
--
-- The reconciler half (only sweep origin='local' rows) is in
-- packages/operator-core/lib/work-item-completion-event-reconciler.ts.
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
  -- WI-10005136: a projection apply (or explicit repair) moves the wire clock. The row
  -- now carries the publisher's state, including whatever intent the publisher holds,
  -- so neither mint, restore nor clear an intent here.
  IF NEW.fed_ts IS DISTINCT FROM OLD.fed_ts
     OR NEW.fed_hlc IS DISTINCT FROM OLD.fed_hlc THEN
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
