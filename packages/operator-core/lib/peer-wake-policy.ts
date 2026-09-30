/**
 * peer-wake-policy.ts — re-export of the shared "you can WAKE a peer; a parked agent sleeps until
 * something re-invokes it, so handing work off is not enough" clause for the operator-launched-role
 * prompt base (owner directive 2026-06-24).
 *
 * The active complement of the wait-loop guidance: where WAIT_LOOP_NOTE tells an agent not to sleep
 * forever on a result that may never come, this tells the agent holding the next step that it can (and
 * usually must) WAKE the peer it depends on rather than assume a handed-off/parked agent will act on
 * its own. The one `PEER_WAKE_NOTE` string is owned by `@papercusp/orchestrator` (prompt-build.ts),
 * where it is injected into the SPAWNED-BEE base. operator-core depends on the orchestrator (not the
 * reverse), so the operator-launched-role base re-exports the SAME constant here and injects it via
 * `assembleRolePrompt` — the two bases can't desync. The clause text + its rationale live in
 * `PEER_WAKE_NOTE`'s doc-comment.
 */
import { PEER_WAKE_NOTE } from '@papercusp/orchestrator/role-prompt';

/** The shared peer-wake clause, injected into every operator-launched role's prompt base by
 *  `assembleRolePrompt` (mirror of `renderWaitLoopNote` / `renderAgentActivityTruthNote`). */
export function renderPeerWakeNote(): string {
  return PEER_WAKE_NOTE;
}
