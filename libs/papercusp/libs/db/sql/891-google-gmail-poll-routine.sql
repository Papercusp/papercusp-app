-- 891-google-gmail-poll-routine.sql — external-triggers P-010 / D-011
--
-- Each fire renews owned users.watch registrations when due, pulls the
-- workspace-specific subscription on the shared Gmail topic, and advances the
-- persisted historyId only after trigger + Personal Vault delivery succeeds.
--
-- FORWARD-COMPAT: an older routines host fail-soft skips an unregistered
-- system action, so arming this row before the runtime deploy cannot consume a
-- Pub/Sub message or mutate a Gmail cursor.

INSERT INTO harness_shared.routines
  (id, install_slug, workspace_id, name, trigger_kind, trigger_config,
   target_role, concurrency, catchup, active, next_fire_at, tier)
VALUES
  ('rt_papercusp_google_gmail_poll', 'papercusp', 'papercusp-workspace',
   'google-gmail-poll', 'cron',
   '{"cron":"15 * * * * *","max_messages":100,"renew_before_ms":86400000}'::jsonb,
   'system:google-gmail-poll', 'skip', 'skip-old', TRUE, now(), 'durable')
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
