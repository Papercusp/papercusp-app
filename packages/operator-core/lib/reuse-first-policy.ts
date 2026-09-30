/**
 * reuse-first-policy.ts — re-export of the shared soft "extend, don't fork" clause for the
 * operator-launched-role prompt base (agents-reuse-first-default-2026-06-20 P-001/D-001).
 *
 * The sibling of `deploy-pipeline-policy`'s `renderDeployPipelineNote` and `testing-standard-policy`'s
 * `renderTestingStandard`: the one `REUSE_FIRST_NUDGE` string is owned by `@papercusp/orchestrator`
 * (prompt-build.ts), where it is injected into the SPAWNED-BEE base. operator-core depends on the
 * orchestrator (not the reverse), so the operator-launched-role base re-exports the SAME constant here
 * and injects it via `assembleRolePrompt` — the two bases (plus the su persona base) can't desync. The
 * clause text + its rationale (greenfield is locally simpler than extending; a bare principle is too
 * weak; name the concrete trigger + the discovery tools; a SOFT nudge, not a hard cite-on-every-change
 * requirement — owner decision D-001) live in `REUSE_FIRST_NUDGE`'s doc-comment.
 */
import { REUSE_FIRST_NUDGE } from '@papercusp/orchestrator/role-prompt';

/** The shared reuse-first clause, injected into every operator-launched role's prompt base by
 *  `assembleRolePrompt` (mirror of `renderDeployPipelineNote` / `renderTestingStandard`). */
export function renderReuseFirstNudge(): string {
  return REUSE_FIRST_NUDGE;
}
