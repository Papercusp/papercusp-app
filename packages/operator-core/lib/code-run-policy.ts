/**
 * code-run-policy.ts — re-export of the shared "collapse a multi-step tool flow into ONE `code:run`
 * to remove sequential model inference turns / intermediate context" clause for the operator prompt
 * base (code-execution-tool-orchestration B-CX-3 rollout).
 *
 * The one `CODE_RUN_NUDGE` string is owned by `@papercusp/orchestrator` (prompt-build.ts), where it
 * is injected into the SPAWNED-BEE base. operator-core depends on the orchestrator (not the
 * reverse), so the operator-launched-role base re-exports the SAME constant here and injects it via
 * `assembleRolePrompt` — so the two bases (plus the su playbooks + the papercup-hive su instance
 * override) can't desync. Mirror of `renderConcurrencyFirstNote` / `renderReuseFirstNudge`. The
 * clause text + rationale (when to reach for code:run, the dry-run/code:tools chaining, and the
 * "summarize conservatively — over-filtering backfires" §8 point) live in `CODE_RUN_NUDGE`'s
 * doc-comment.
 */
import { CODE_RUN_NUDGE } from '@papercusp/orchestrator/role-prompt';

/** The shared code:run nudge, injected into every operator-launched role's prompt base by
 *  `assembleRolePrompt` (mirror of `renderConcurrencyFirstNote` / `renderReuseFirstNudge`). */
export function renderCodeRunNudge(): string {
  return CODE_RUN_NUDGE;
}
