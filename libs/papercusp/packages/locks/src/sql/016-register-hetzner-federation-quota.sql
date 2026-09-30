-- EI-5884 (WI-1442 fix (b) split): register ops/hetzner-federation-quota as a
-- REAL exclusive resource lock. Today the "acquire before provisioning" rig
-- protocol is prose-only — the name was never registered, so
-- locks:acquire_resource returns unknown_resource and every live-brief run
-- races the 2-server Hetzner project cap directly (confirmed live 2026-07-01:
-- Brief 3 checked servers=0, then lost the provision race to a concurrent
-- Brief run that grabbed both slots in the check->provision gap).
--
-- 'enforced' (not just advisory) — a rig run acquiring exclusive(ops/hetzner-
-- federation-quota) before rig_provision and releasing on teardown turns the
-- N-way contention into a clean serial queue; a dead holder's lease lapses on
-- TTL expiry (agent_resource_locks.expires_ts) instead of leaving a phantom
-- hold, which is the liveness-tie half of WI-1442's broader fix.
--
-- Idempotent; ON CONFLICT DO NOTHING so a human-edited row is never clobbered.
INSERT INTO agent_resource_registry (resource, description, rule_text, enforcement, match_patterns) VALUES
  ('ops/hetzner-federation-quota',
   'The Hetzner project''s permanent 2-server cap shared across every federation-release-hardening live-brief rig run. Concurrent runs racing rig_provision without a real mutex either hit resource_limit_exceeded or, worse, silently starve each other''s server slots.',
   'A live-brief scenario acquires exclusive(ops/hetzner-federation-quota) (with a drain) via locks:acquire_resource BEFORE rig_provision/rig_create_server, and releases on teardown (including the exit trap on a killed run) so a dead holder''s lease lapses on TTL rather than leaving a phantom hold. Concurrent runs queue serially instead of racing the 2-server cap.',
   'enforced',
   ARRAY['rig_create_server', 'rig_provision', 'deb-hetzner-rig.sh', 'deb-hetzner-matrix.sh'])
ON CONFLICT (resource) DO NOTHING;
