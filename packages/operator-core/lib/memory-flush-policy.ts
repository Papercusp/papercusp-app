/**
 * memory-flush-policy.ts — re-export of the shared "flush a durable conclusion the MOMENT it forms,
 * not when the context fills" clause for the operator-launched-role prompt base
 * (compaction-context-loss-2026-07-05 P-004; D-001 "the carry system's weakness is behavioral at the
 * WRITE end").
 *
 * The sibling of `work-record-policy`'s `renderWorkRecordNote`: the one `WRITE_THROUGH_NOTE` string is
 * owned by `@papercusp/orchestrator` (prompt-build.ts), where it is injected into the SPAWNED-BEE base
 * (buildPromptParts). operator-core depends on the orchestrator (not the reverse), so the
 * operator-launched-role base re-exports the SAME constant here and injects it via `assembleRolePrompt`
 * — the two bases (plus the su playbooks + compaction-strategy.md) can't desync. Complements
 * `turn-yield-policy` (checkpoint ON yield) + `work-record-policy` (record the work) with the WHEN of
 * the flush. The clause text + its rationale live in `WRITE_THROUGH_NOTE`'s doc-comment.
 */
import { WRITE_THROUGH_NOTE } from '@papercusp/orchestrator/role-prompt';

/** The shared write-through clause, injected into every operator-launched role's prompt base by
 *  `assembleRolePrompt` (mirror of `renderWorkRecordNote`). */
export function renderWriteThroughNote(): string {
  return WRITE_THROUGH_NOTE;
}
