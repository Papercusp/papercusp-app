/**
 * agent-activity-truth-policy.ts — re-export of the shared "who's doing what is a
 * LIVE derived truth, never a stale announcement" clause for the operator-launched-
 * role prompt base (agent-activity-liveness-truth-2026-06-21 P-004/P-006, D-002).
 *
 * The behavioral half of the durable fix: even with the truthful reconciled read in
 * place (fleet:assignments / whoIsDoingWhat surfacing orphaned + stalled), an agent
 * must actually READ it instead of concluding "someone's on it" from a coord
 * broadcast that outlives the work — the incident class. The one
 * `AGENT_ACTIVITY_TRUTH_NOTE` string is owned by `@papercusp/orchestrator`
 * (prompt-build.ts), where it is injected into the SPAWNED-BEE base. operator-core
 * depends on the orchestrator (not the reverse), so the operator-launched-role base
 * re-exports the SAME constant here and injects it via `assembleRolePrompt` — the
 * two bases can't desync. The clause text + its rationale live in
 * `AGENT_ACTIVITY_TRUTH_NOTE`'s doc-comment.
 */
import { AGENT_ACTIVITY_TRUTH_NOTE } from '@papercusp/orchestrator/role-prompt';

/** The shared agent-activity-truth clause, injected into every operator-launched role's prompt
 *  base by `assembleRolePrompt` (mirror of `renderConcurrencyFirstNote` / `renderDeployPipelineNote`). */
export function renderAgentActivityTruthNote(): string {
  return AGENT_ACTIVITY_TRUTH_NOTE;
}
