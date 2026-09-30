/**
 * work-record-policy.ts — re-export of the shared "record all work as a work-item, even small ones"
 * clause for the operator-launched-role prompt base (audit-trail discipline; owner ask 2026-06-23).
 *
 * The sibling of `reuse-first-policy`'s `renderReuseFirstNudge`: the one `WORK_RECORD_NOTE` string is
 * owned by `@papercusp/orchestrator` (prompt-build.ts), where it is injected into the SPAWNED-BEE base
 * (buildPromptParts). operator-core depends on the orchestrator (not the reverse), so the
 * operator-launched-role base re-exports the SAME constant here and injects it via `assembleRolePrompt`
 * — the two bases can't desync. The clause text + its rationale (every unit of work leaves a trace; a
 * small task may be recorded AFTER the fact / batched rather than pre-claimed since its live window is
 * small but the record persists; recurring small task ⇒ a recipe) live in `WORK_RECORD_NOTE`'s doc-comment.
 */
import { WORK_RECORD_NOTE } from '@papercusp/orchestrator/role-prompt';

/** The shared work-record clause, injected into every operator-launched role's prompt base by
 *  `assembleRolePrompt` (mirror of `renderReuseFirstNudge`). */
export function renderWorkRecordNote(): string {
  return WORK_RECORD_NOTE;
}
