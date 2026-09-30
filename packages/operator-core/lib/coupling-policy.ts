/**
 * coupling-policy.ts — re-export of the shared "you can COUPLE yourself (or any two agents)
 * to see each other's state, and you should DECOUPLE when you stop needing it" clause for
 * the operator-launched-role prompt base (owner directive 2026-07-27;
 * unified-agent-state-plane-2026-07-27 P-031, D-061/D-062).
 *
 * Coupling is the relevance gate on peer state. It was DERIVED-only, so an agent that
 * already knew it was working alongside a peer had to wait for a derivation to notice;
 * `coord:couple` / `coord:decouple` are the declaration path, unrestricted by ruling (any
 * agent may couple ANY two agents, including a pair it is not part of).
 *
 * The one `COUPLING_NOTE` string is owned by `@papercusp/orchestrator` (prompt-build.ts),
 * where it is injected into the SPAWNED-BEE base. operator-core depends on the orchestrator
 * (not the reverse), so the operator-launched-role base re-exports the SAME constant here
 * and injects it via `assembleRolePrompt` — the two bases can't desync. The clause text +
 * its rationale (including WHY it carries no token number yet) live in `COUPLING_NOTE`'s
 * doc-comment. Mirrors `peer-wake-policy.ts` exactly.
 */
import { COUPLING_NOTE } from '@papercusp/orchestrator/role-prompt';

/** The shared coupling clause, injected into every operator-launched role's prompt base by
 *  `assembleRolePrompt` (mirror of `renderPeerWakeNote` / `renderWaitLoopNote`). */
export function renderCouplingNote(): string {
  return COUPLING_NOTE;
}
