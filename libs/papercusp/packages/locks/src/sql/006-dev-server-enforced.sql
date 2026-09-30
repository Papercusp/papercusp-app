-- Promote dev-server from advisory → enforced (P-016 decision).
-- Rationale: the raw-Bash PreToolUse gate (P-026) makes `systemctl restart
-- papercup` matchable, so detection IS reliable enough — a held exclusive
-- should BLOCK a colliding raw restart, not just warn. Idempotent UPDATE of
-- the existing seeded row (005's seed is ON CONFLICT DO NOTHING, so existing
-- installs need this; fresh installs run 005 then this).
UPDATE agent_resource_registry
   SET enforcement = 'enforced', updated_ts = clock_timestamp()
 WHERE resource = 'dev-server' AND enforcement <> 'enforced';
