-- 888-google-calendar-poll-routine.sql — external-triggers P-019 / D-010
--
-- Local, queue-free Calendar time-wheel. The action first advances each source's
-- Google events.list syncToken, then performs the bounded upcoming window. The
-- trigger_deliveries ledger dedupes repeat polls by event id + start time.
--
-- FORWARD-COMPAT: an older routines host fail-soft skips an unregistered
-- system action, so arming this row before the runtime deploy mutates no cursor.

INSERT INTO harness_shared.routines
  (id, install_slug, workspace_id, name, trigger_kind, trigger_config,
   target_role, concurrency, catchup, active, next_fire_at, tier)
VALUES
  ('rt_papercusp_google_calendar_poll', 'papercusp', 'papercusp-workspace',
   'google-calendar-poll', 'cron',
   '{"cron":"0 * * * * *","lead_minutes":15}'::jsonb,
   'system:google-calendar-poll', 'skip', 'skip-old', TRUE, now(), 'durable')
ON CONFLICT (install_slug, name) DO UPDATE SET
  workspace_id = EXCLUDED.workspace_id,
  trigger_kind = EXCLUDED.trigger_kind,
  trigger_config = EXCLUDED.trigger_config,
  target_role = EXCLUDED.target_role,
  concurrency = EXCLUDED.concurrency,
  catchup = EXCLUDED.catchup,
  tier = EXCLUDED.tier,
  -- Preserve an operator's explicit pause on re-apply/re-seed.
  active = harness_shared.routines.active,
  updated_at = now();
