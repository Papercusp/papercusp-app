-- Migration 117 — drop the experts + feedback feature tables.
--
-- The experts/feedback feature was fully removed (user-authorized): its
-- agent-tools, the /experts route, the orchestrator NEXT_EXPERT/NEXT_FEEDBACK
-- decision verbs + handlers, the expert/feedback AGENT_ROLES + prompts, the
-- /dev sync queries, and the docs are all deleted. NO code references these 3
-- tables anymore (sync-resolver, harness-state table-registry/git-export, and
-- agent-chats-data flipExpertEngaged were all removed). All 3 tables hold 0
-- rows on the dev DB.
--
-- CASCADE is verified safe: no pg_proc / trigger body references harness_expert*
-- (checked live + across sql/*.sql), so the CASCADE only drops the tables'
-- own indexes (he_recent_idx, harness_expert_feedback_expert_idx,
-- harness_expert_turns_fb_idx), PKs, the speaker CHECK, and the
-- *_workspace_isolation RLS policies — nothing else depends on them.
--
-- Idempotent (IF EXISTS). Drop children before parent is unnecessary under
-- CASCADE but kept for clarity.

DROP TABLE IF EXISTS harness_shared.harness_expert_turns CASCADE;
DROP TABLE IF EXISTS harness_shared.harness_expert_feedback CASCADE;
DROP TABLE IF EXISTS harness_shared.harness_experts CASCADE;
