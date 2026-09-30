/**
 * turn-yield-policy.ts — re-export of the shared cooperative-yield clause for the
 * operator-launched-role prompt base (turn-lifecycle-control-2026-06-08 P-017).
 *
 * The dual of friction-markers' `renderFrictionTripwire`: the one `YIELD_POLICY`
 * string is owned by `@papercusp/orchestrator` (prompt-build.ts), where it is
 * injected into the SPAWNED-BEE base. operator-core depends on the orchestrator
 * (not the reverse), so the operator-launched-role base re-exports the SAME
 * constant here and injects it via `assembleRolePrompt` — the two bases (plus the
 * su playbook) can't desync. The policy text + its rationale (D-007/D-009) live in
 * `YIELD_POLICY`'s doc-comment in prompt-build.ts.
 */
import { YIELD_POLICY } from '@papercusp/orchestrator/role-prompt';

/** The shared cooperative-yield clause, injected into every operator-launched
 *  role's prompt base by `assembleRolePrompt` (mirror of `renderFrictionTripwire`). */
export function renderYieldPolicy(): string {
  return YIELD_POLICY;
}
