-- 899-facebook-personal-vault-poll-routine.sql — personal-vault-live-integrations P-005
--
-- Reconciles the capability-accurate owner-authorized Facebook Graph surface
-- (profile, posts, and photo metadata) into the external-trigger delivery
-- ledger and Personal Vault. This is intentionally not an archive-equivalent
-- or Messenger/friends/private-group ingestion claim.
--
-- FORWARD-COMPAT: an older routines host fail-soft skips an unregistered
-- system action, so arming this row before the runtime deploy mutates no cursor.

INSERT INTO harness_shared.routines
  (id, install_slug, workspace_id, name, trigger_kind, trigger_config,
   target_role, concurrency, catchup, active, next_fire_at, tier)
VALUES
  ('rt_papercusp_facebook_personal_vault_poll', 'papercusp', 'papercusp-workspace',
   'facebook-personal-vault-poll', 'cron',
   '{"cron":"45 */15 * * * *"}'::jsonb,
   'system:facebook-personal-vault-poll', 'skip', 'skip-old', TRUE, now(), 'durable')
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
