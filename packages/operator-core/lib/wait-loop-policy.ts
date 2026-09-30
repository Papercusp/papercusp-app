/**
 * wait-loop-policy.ts — re-export of the shared "waiting on something? arm a self-wake LOOP — never
 * sleep on an event that may never fire" clause for the operator-launched-role prompt base (owner
 * directive 2026-06-23).
 *
 * The behavioral complement of the coordination "await an event and sleep" guidance: that is correct
 * only when a live emitter is GUARANTEED to fire; an agent blocked on something that may never fire
 * must keep a LIVE re-check alive (a recurring self-wake) and FIX what is preventing the firing,
 * because a never-firing event is itself the bug it needs to be awake to catch. The one
 * `WAIT_LOOP_NOTE` string is owned by `@papercusp/orchestrator` (prompt-build.ts), where it is
 * injected into the SPAWNED-BEE base. operator-core depends on the orchestrator (not the reverse),
 * so the operator-launched-role base re-exports the SAME constant here and injects it via
 * `assembleRolePrompt` — the two bases can't desync. The clause text + its rationale live in
 * `WAIT_LOOP_NOTE`'s doc-comment.
 */
import { WAIT_LOOP_NOTE } from '@papercusp/orchestrator/role-prompt';

/** The shared wait-loop clause, injected into every operator-launched role's prompt base by
 *  `assembleRolePrompt` (mirror of `renderAgentActivityTruthNote` / `renderDeployPipelineNote`). */
export function renderWaitLoopNote(): string {
  return WAIT_LOOP_NOTE;
}
