/**
 * concurrency-first-policy.ts — re-export of the shared "never wait for a 'calm window';
 * effectively-unbounded concurrency is the design, so a non-resource block is a BUG to FIX,
 * not a reason to back off" clause for the operator-launched-role prompt base.
 *
 * The behavioral dual of `account-routing-policy`'s `renderAccountRoutingNote` (that note kills
 * the FALSE limit — a routing/config fault mis-read as capacity; this one governs what to DO when
 * something genuinely tempts you to pause). The one `CONCURRENCY_FIRST_NOTE` string is owned by
 * `@papercusp/orchestrator` (prompt-build.ts), where it is injected into the SPAWNED-BEE base.
 * operator-core depends on the orchestrator (not the reverse), so the operator-launched-role base
 * re-exports the SAME constant here and injects it via `assembleRolePrompt` — the two bases (plus
 * the su playbooks + the papercup-hive su instance override) can't desync. The clause text + its
 * rationale (the ONLY legit block is true verified resource exhaustion; massive concurrency is the
 * design; investigate + fix the root cause instead of waiting) live in `CONCURRENCY_FIRST_NOTE`'s
 * doc-comment.
 */
import { CONCURRENCY_FIRST_NOTE } from '@papercusp/orchestrator/role-prompt';

/** The shared concurrency-first clause, injected into every operator-launched role's prompt base
 *  by `assembleRolePrompt` (mirror of `renderAccountRoutingNote` / `renderDeployPipelineNote`). */
export function renderConcurrencyFirstNote(): string {
  return CONCURRENCY_FIRST_NOTE;
}
