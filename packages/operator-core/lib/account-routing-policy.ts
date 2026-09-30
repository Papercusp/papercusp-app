/**
 * account-routing-policy.ts — re-export of the shared "LLM inference is multi-account; a
 * 'limit' is usually a routing bug, not real" clause for the operator-launched-role prompt base.
 *
 * The sibling of `testing-standard-policy`'s `renderTestingStandard` and `turn-yield-policy`'s
 * `renderYieldPolicy`: the one `ACCOUNT_ROUTING_NOTE` string is owned by `@papercusp/orchestrator`
 * (prompt-build.ts), where it is injected into the SPAWNED-BEE base. operator-core depends on the
 * orchestrator (not the reverse), so the operator-launched-role base re-exports the SAME constant
 * here and injects it via `assembleRolePrompt` — the two bases (plus the su playbooks) can't desync.
 * The clause text + its rationale (agents keep mis-reading a routing/config fault as a true capacity
 * limit; build LLM work ON the account-routing system) live in `ACCOUNT_ROUTING_NOTE`'s doc-comment.
 */
import { ACCOUNT_ROUTING_NOTE } from '@papercusp/orchestrator/role-prompt';

/** The shared multi-account inference clause, injected into every operator-launched role's prompt
 *  base by `assembleRolePrompt` (mirror of `renderTestingStandard` / `renderYieldPolicy`). */
export function renderAccountRoutingNote(): string {
  return ACCOUNT_ROUTING_NOTE;
}
