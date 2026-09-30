/**
 * observation-rubric-policy.ts — re-export of the shared "check for a rubric before filing an
 * observation" clause for the operator-launched-role prompt base (rubric-driven-observations-2026-06-20
 * P-005 / D-001 / D-003).
 *
 * The sibling of `reuse-first-policy`'s `renderReuseFirstNudge` and `deploy-pipeline-policy`'s
 * `renderDeployPipelineNote`: the one `OBSERVATION_RUBRIC_NUDGE` string is owned by
 * `@papercusp/orchestrator` (prompt-build.ts), where it is injected into the SPAWNED-BEE base.
 * operator-core depends on the orchestrator (not the reverse), so the operator-launched-role base
 * re-exports the SAME constant here and injects it via `assembleRolePrompt` — the two bases can't
 * desync. The clause text + its rationale (grade a turn-end observation against an ACTIVE rubric
 * when one fits — rubricRef + per-criterion ratings + mandatory evidence — else free-text stays
 * first-class; authoring a rubric is a separate Queen-ratified step) live in
 * `OBSERVATION_RUBRIC_NUDGE`'s doc-comment.
 */
import { OBSERVATION_RUBRIC_NUDGE } from '@papercusp/orchestrator/role-prompt';

/** The shared observation-rubric clause, injected into every operator-launched role's prompt base by
 *  `assembleRolePrompt` (mirror of `renderReuseFirstNudge` / `renderFrictionTripwire`). */
export function renderObservationRubricNudge(): string {
  return OBSERVATION_RUBRIC_NUDGE;
}
