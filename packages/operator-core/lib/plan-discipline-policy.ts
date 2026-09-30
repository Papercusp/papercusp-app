/**
 * plan-discipline-policy.ts — re-export of the shared "a plan is REQUIRED when work spans multiple
 * steps — not for a one-shot fix" bright-line for the operator-launched-role prompt base
 * (enforce-system-on-generic-work-2026-06-29 P-016).
 *
 * The sibling of `work-record-policy`'s `renderWorkRecordNote`: the one `PLAN_DISCIPLINE_NOTE` string
 * is owned by `@papercusp/orchestrator` (prompt-build.ts), where it is injected into the SPAWNED-BEE
 * base (buildPromptParts). operator-core depends on the orchestrator (not the reverse), so the
 * operator-launched-role base re-exports the SAME constant here and injects it via `assembleRolePrompt`
 * — the two bases (plus the su persona spine + the su playbooks) can't desync. The clause text + its
 * rationale (the bright line for when a plan is required vs. an over-applied ceremony) live in
 * `PLAN_DISCIPLINE_NOTE`'s doc-comment.
 */
import { PLAN_DISCIPLINE_NOTE } from '@papercusp/orchestrator/role-prompt';

/** The shared plan-discipline clause, injected into every operator-launched role's prompt base by
 *  `assembleRolePrompt` (mirror of `renderWorkRecordNote`). */
export function renderPlanDisciplineNote(): string {
  return PLAN_DISCIPLINE_NOTE;
}
