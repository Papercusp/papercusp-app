/**
 * deploy-pipeline-policy.ts — re-export of the shared "the deploy pipeline is ASYNC; don't babysit
 * your OWN change, but a RED gate is EVERYONE's job to FIX (no owner-ask, even out of your lane)"
 * clause for the operator-launched-role prompt base.
 *
 * The sibling of `account-routing-policy`'s `renderAccountRoutingNote` and `testing-standard-policy`'s
 * `renderTestingStandard`: the one `DEPLOY_PIPELINE_NOTE` string is owned by `@papercusp/orchestrator`
 * (prompt-build.ts), where it is injected into the SPAWNED-BEE base. operator-core depends on the
 * orchestrator (not the reverse), so the operator-launched-role base re-exports the SAME constant here
 * and injects it via `assembleRolePrompt` — the two bases can't desync. The clause text + its rationale
 * (agents keep getting confused getting changes live; teach the async stages + the dev:pipeline_position
 * reflex; a RED gate is everyone's job to FIX) live in `DEPLOY_PIPELINE_NOTE`'s doc-comment.
 */
import { DEPLOY_PIPELINE_NOTE } from '@papercusp/orchestrator/role-prompt';

/** The shared deploy-pipeline clause, injected into every operator-launched role's prompt base by
 *  `assembleRolePrompt` (mirror of `renderAccountRoutingNote` / `renderTestingStandard`). */
export function renderDeployPipelineNote(): string {
  return DEPLOY_PIPELINE_NOTE;
}
