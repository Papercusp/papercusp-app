-- EI-13729: the green-time deploy trigger has NO real mutual exclusion between
-- its three callers — the auto-serve `release-trigger` routine, a manual
-- `PAPERCUSP_ALLOW_DEV_RESTART=1 deploy-cli.ts --execute` (the CLAUDE.md-
-- sanctioned "force the deploy now" escape hatch), and `release:deploy { op:
-- 'trigger' }` — even though two of the three already coordinate via a shared
-- systemd transient-unit name (`papercup-auto-deploy`, systemd-run --collect
-- refuses a second unit of the same name). A directly-invoked manual deploy-cli
-- bypasses that systemd-level coordination entirely, AND the pre-existing
-- guardResource('dev-server') call inside executeDeploy's withDrain never
-- actually blocked deploy-vs-deploy contention either: every deploy-cli process
-- built its lock identity from the SAME static ownerId ('release-deploy'), so a
-- second concurrent process's acquire was treated as "the same owner refreshing
-- its own lock" (resource-lock-store.ts's `holders.some(h => h.mode ===
-- 'exclusive' && h.owner !== owner)` check) and silently granted instead of
-- draining/refusing — two real OS processes each believed they alone held the
-- lock and raced runSetup/migrate/restart against the SAME shared release
-- checkout, producing the observed :3070 old/new-build flap.
--
-- This registers a NEW, dedicated resource that deploy-cli.ts's main() now
-- acquires TRY-ONLY (maxDrainSec: 0 — coalesce, never queue-and-execute-with-
-- a-stale-plan) around its ENTIRE gather+execute flow, with a per-PROCESS
-- unique owner id (see deploy-deps.ts realRunUnderDeployLock / deployIdentity).
-- This is the SINGLE chokepoint all three callers already funnel through
-- (deploy-cli.ts's main()), so fixing it here protects every current AND
-- future caller uniformly — the correct-state item #1 from EI-13729.
-- Idempotent (ON CONFLICT DO NOTHING).

INSERT INTO agent_resource_registry (resource, description, rule_text, enforcement, match_patterns) VALUES
  ('release-deploy',
   'The single-flight lock around the ENTIRE deploy-cli gather+execute flow (apps/operator/lib/release/deploy-cli.ts main()) — guards the shared release checkout (papercup-release) against concurrent swap/migrate/restart from the auto-serve release-trigger routine, a manual deploy-cli --execute, and release:deploy { op: "trigger" }.',
   'Acquired internally by deploy-cli.ts main() (TRY-ONLY, maxDrainSec 0) around the whole gatherPlan+executeDeploy flow — never acquired directly by an agent. A concurrent deploy attempt while this is held COALESCES (skips, exit 0) instead of draining and redeploying a possibly-stale plan.',
   'enforced',
   ARRAY[]::text[])
ON CONFLICT (resource) DO NOTHING;
