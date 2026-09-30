-- EI-212178: the Tauri desktop owns the working-tree operator on :3270 via
-- papercusp-desktop/bin/dev-operator-ifneeded.sh, not a systemd unit. The
-- coordinated dev:restart { target: 'desktop-dev' } path drains this resource,
-- verifies the owner-visible hono-host child and SIGKILLs only that child so the
-- wrapper can respawn it. Keep this separate from dev-server (:3070) and
-- staging-server (:3170); those are different processes and blast radii.
-- Idempotent: never overwrite an operator-edited registry row.

INSERT INTO agent_resource_registry (resource, description, rule_text, enforcement, match_patterns) VALUES
  ('desktop-dev-server',
   'The owner-visible desktop dev operator (:3270), supervised by dev-operator-ifneeded.sh. Restarting it reloads the working tree for the owner''s Tauri session.',
   'Acquire shared(desktop-dev-server) before relying on the desktop dev operator. To reload it, use dev:restart { target: ''desktop-dev'', confirm: true }; the tool drains current users, verifies the wrapper-owned :3270 hono-host listener, and signals only that child so the wrapper respawns it. Never signal the wrapper, its process group, or an unverified :3270 listener directly.',
   'enforced',
   ARRAY[]::text[])
ON CONFLICT (resource) DO NOTHING;
