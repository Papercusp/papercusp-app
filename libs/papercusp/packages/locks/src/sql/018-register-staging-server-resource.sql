-- WI-4221: papercup-staging-api.service was restarting every ~5-6min for
-- hours with zero coalescing — every agent's "systemctl --user restart
-- papercup-staging-api.service to test a live edit" (the CLAUDE.md-sanctioned
-- workflow) fired its OWN raw, uncoordinated restart. The existing
-- 'dev-server' resource's match pattern ('systemctl.*restart.*papercup') was
-- loose enough to incidentally MATCH a staging-api restart too, but nothing
-- ever registered a staging-specific resource or debounced repeat restarts —
-- so raw commands sailed through unless a peer happened to hold dev-server
-- exclusive at that exact instant (rare, since restarts are momentary).
--
-- This migration:
--   1. Narrows 'dev-server' to ONLY match papercup-dev-api (its actual
--      target, :3070/:3055) so it stops conflating with staging.
--   2. Registers 'staging-server' (:3170) as its own enforced resource,
--      mirroring dev-server's shared/exclusive drain semantics.
--   3. Registers 'staging-server-cooldown' — a pure debounce marker, never
--      targeted by an agent's raw command (no match_patterns), acquired only
--      by the dev:restart tool itself (target:'staging') and deliberately
--      left to expire via its own TTL instead of being released. Any restart
--      attempt that lands while the cooldown is still held is coalesced
--      (skipped, reported as such) instead of firing a redundant restart —
--      see packages/operator-core/lib/agent-tools/dev/restart.ts.
-- Idempotent (UPDATE / ON CONFLICT DO NOTHING).

UPDATE agent_resource_registry
   SET match_patterns = ARRAY['systemctl.*restart.*papercup-dev-api', 'overmind.*restart', 'npm run dev'],
       updated_ts = clock_timestamp()
 WHERE resource = 'dev-server';

INSERT INTO agent_resource_registry (resource, description, rule_text, enforcement, match_patterns) VALUES
  ('staging-server',
   'The staging operator (:3170), restarted routinely by agents to pick up a live lib/**/apps/operator/** edit (bin/hono-host.ts has no file-watch). Restarting it disrupts every agent currently probing :3170.',
   'Acquire shared(staging-server) before relying on the running staging operator (API probes, UI checks against :3170). To restart it, prefer the coordinated `dev:restart { target: "staging", confirm: true }` tool over a raw systemctl command — it drains concurrent users AND coalesces back-to-back restart requests (WI-4221) instead of each agent firing its own.',
   'enforced',
   ARRAY['systemctl.*restart.*papercup-staging-api']),
  ('staging-server-cooldown',
   'Internal debounce marker for staging-server restarts (WI-4221) — never acquired directly by agents. Held (never released) for a short TTL immediately after a real restart so a redundant restart requested within the window is coalesced instead of re-executed.',
   'Not for direct use — acquired/left-to-expire only by dev:restart { target: "staging" }.',
   'advisory',
   ARRAY[]::text[])
ON CONFLICT (resource) DO NOTHING;
