/**
 * testing-standard-policy.ts — re-export of the shared "write tests the project way"
 * clause for the operator-launched-role prompt base.
 *
 * The sibling of `turn-yield-policy`'s `renderYieldPolicy` and friction-markers'
 * `renderFrictionTripwire`: the one `TESTING_STANDARD` string is owned by
 * `@papercusp/orchestrator` (prompt-build.ts), where it is injected into the
 * SPAWNED-BEE base. operator-core depends on the orchestrator (not the reverse), so
 * the operator-launched-role base re-exports the SAME constant here and injects it
 * via `assembleRolePrompt` — the two bases (plus the su playbooks) can't desync. The
 * clause text + its rationale (project-agnostic; per-project specifics come from the
 * target repo's CLAUDE.md / testing docs) live in `TESTING_STANDARD`'s doc-comment.
 */
import { TESTING_STANDARD, VERIFICATION_STANDARD } from '@papercusp/orchestrator/role-prompt';

/** The shared testing-standard clause, injected into every operator-launched role's
 *  prompt base by `assembleRolePrompt` (mirror of `renderYieldPolicy`). A hive whose
 *  `acceptance.kind` is NOT `tests` (judge / human-gate / none) gets the domain-agnostic
 *  VERIFICATION_STANDARD instead — symmetric with the spawned-bee base's buildPrompt
 *  conditional so the two bases can't desync (hive-blueprint-generalization P-008).
 *  Default (no arg) ⇒ TESTING_STANDARD, so every existing caller is unchanged. */
export function renderTestingStandard(acceptanceKind?: 'tests' | 'judge' | 'human-gate' | 'none'): string {
  return acceptanceKind && acceptanceKind !== 'tests' ? VERIFICATION_STANDARD : TESTING_STANDARD;
}
