/**
 * observation-capture-policy.ts — re-export of the shared "capture what you notice the moment you
 * notice it; route it to the right ledger" clause for the operator-launched-role prompt base
 * (enforce-system-on-generic-work-2026-06-29 P-017).
 *
 * The sibling of `work-record-policy`'s `renderWorkRecordNote`: the one `OBSERVATION_CAPTURE_NOTE`
 * string is owned by `@papercusp/orchestrator` (prompt-build.ts), where it is injected into the
 * SPAWNED-BEE base (buildPromptParts). operator-core depends on the orchestrator (not the reverse), so
 * the operator-launched-role base re-exports the SAME constant here and injects it via
 * `assembleRolePrompt` — the two bases (plus the su persona spine + the su playbooks) can't desync.
 * Distinct from `observation-rubric-policy` (which grades an observation once it is being filed): this
 * one names WHERE each kind of noticing goes (signal → improvements:capture, problem → issue/work-item,
 * how-it-works → an agent-insights doc). The clause text + its rationale live in
 * `OBSERVATION_CAPTURE_NOTE`'s doc-comment.
 */
import { OBSERVATION_CAPTURE_NOTE } from '@papercusp/orchestrator/role-prompt';

/** The shared observation-capture clause, injected into every operator-launched role's prompt base by
 *  `assembleRolePrompt` (mirror of `renderWorkRecordNote`). */
export function renderObservationCaptureNote(): string {
  return OBSERVATION_CAPTURE_NOTE;
}
