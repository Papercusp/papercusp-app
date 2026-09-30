/**
 * finish-the-rollout-policy.ts — re-export of the shared "a capability built then left gated OFF is
 * INCOMPLETE, not done" clause for the operator-launched-role prompt base
 * (flags-default-on-reach-2026-06-21).
 *
 * The sibling of `reuse-first-policy`'s `renderReuseFirstNudge` and `code-run-policy`'s
 * `renderCodeRunNudge`: the one `FINISH_THE_ROLLOUT_NOTE` string is owned by `@papercusp/orchestrator`
 * (prompt-build.ts), where it is injected into the SPAWNED-BEE base. operator-core depends on the
 * orchestrator (not the reverse), so the operator-launched-role base re-exports the SAME constant here
 * and injects it via `assembleRolePrompt` — the two bases (plus the su playbooks + CLAUDE.md's flags
 * section) can't desync. The clause text + its rationale (a finished feature left dark — flag OR env
 * gate — is an unfinished rollout, not done; the PgBouncer incident; reach the fleet builders, not
 * just the su playbooks) live in `FINISH_THE_ROLLOUT_NOTE`'s doc-comment.
 */
import { FINISH_THE_ROLLOUT_NOTE } from '@papercusp/orchestrator/role-prompt';

/** The shared finish-the-rollout clause, injected into every operator-launched role's prompt base by
 *  `assembleRolePrompt` (mirror of `renderReuseFirstNudge` / `renderCodeRunNudge`). */
export function renderFinishTheRolloutNote(): string {
  return FINISH_THE_ROLLOUT_NOTE;
}
