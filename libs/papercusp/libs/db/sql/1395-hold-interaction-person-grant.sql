-- 1395: hold the person -> record grant that migration 1393 gave interaction sources
-- (plan crm-agent-sales-onboarding-apps-2026-10-06, decision D-020, bug WI-10006570).
--
-- 1393 granted person -> record to gmail/gcal sources and made it their kind default. The built-in
-- Google sources are personal-scope and carry no config.harnessSlug, so the record sink in the
-- release running connector-sync threw data_source_harness_missing while it was being BUILT, and
-- that aborted the whole Gmail sync (09:40Z-09:59Z on 2026-10-06). The fix (graph records take the
-- workspace home harness; a participant sink fault never aborts the sync) is in the source tree but
-- not yet in the release that runs connector-sync, and the database migrates before the release.
--
-- Until that release serves the fix, nothing may carry this grant on a source without a harness:
--   1. the gmail/gcal kind defaults go back to their pre-1393 policy, so a newly connected or
--      reconnected Google source does not pick the grant up again;
--   2. personal-scope sources without config.harnessSlug lose `person` from destination_policy
--      (the live database was already corrected by hand at 09:58Z; this makes it reproducible).
-- Sources that name a harness keep the grant: the release in service handles them correctly.
-- A later migration re-grants both once the fix is live; that step is tracked on WI-10006570.

CREATE OR REPLACE FUNCTION harness_shared.data_source_kind_defaults(
  p_kind text,
  OUT sync_mode text,
  OUT datatype_mappings jsonb,
  OUT destination_policy jsonb)
RETURNS record
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    CASE p_kind
      WHEN 'gmail' THEN 'poll'
      WHEN 'gcal' THEN 'poll'
      WHEN 'contacts' THEN 'poll'
      WHEN 'slack' THEN 'socket'
      WHEN 'webhook' THEN 'webhook'
      ELSE 'manual'
    END,
    (CASE p_kind
      WHEN 'gmail' THEN '{"message":"email-message"}'
      WHEN 'gcal' THEN '{"event":"calendar-event"}'
      WHEN 'contacts' THEN '{"person":"contact"}'
      WHEN 'slack' THEN '{"message":"chat-message"}'
      WHEN 'webhook' THEN '{"payload":"webhook-payload"}'
      ELSE '{}'
    END)::jsonb,
    (CASE p_kind
      WHEN 'gmail' THEN '{"email-message":["document","event"]}'
      WHEN 'gcal' THEN '{"calendar-event":["document","event"]}'
      WHEN 'contacts' THEN '{"contact":["document","event"]}'
      WHEN 'slack' THEN '{"chat-message":["document","event"]}'
      WHEN 'webhook' THEN '{"webhook-payload":["event"]}'
      ELSE '{}'
    END)::jsonb
$$;

UPDATE harness_shared.data_sources
   SET destination_policy = destination_policy - 'person',
       updated_at = now()
 WHERE scope = 'personal'
   AND coalesce(config->>'harnessSlug', '') = ''
   AND destination_policy ? 'person'
   AND destination_policy ?| ARRAY['email-message', 'calendar-event'];
