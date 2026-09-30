/**
 * evidence-discipline-policy.ts — re-export of the shared "a likely cause is a HYPOTHESIS, verify it
 * with hard evidence (or build the means to)" clause for the operator-launched-role prompt base.
 *
 * The sibling of `account-routing-policy`'s `renderAccountRoutingNote` and
 * `concurrency-first-policy`'s `renderConcurrencyFirstNote`: the one `EVIDENCE_DISCIPLINE_NOTE` string
 * is owned by `@papercusp/orchestrator` (prompt-build.ts), where it is injected into the SPAWNED-BEE
 * base. operator-core depends on the orchestrator (not the reverse), so the operator-launched-role base
 * re-exports the SAME constant here and injects it via `assembleRolePrompt` — the two bases (plus the su
 * playbooks) can't desync. The clause text + rationale (agents keep treating a plausible cause as proven
 * without checking; ACCOUNT_ROUTING_NOTE is the rate-limit-specific instance of this general rule) live
 * in `EVIDENCE_DISCIPLINE_NOTE`'s doc-comment.
 */
import { EVIDENCE_DISCIPLINE_NOTE } from '@papercusp/orchestrator/role-prompt';

/** The shared evidence-discipline clause, injected into every operator-launched role's prompt base by
 *  `assembleRolePrompt` (mirror of `renderAccountRoutingNote` / `renderConcurrencyFirstNote`). */
export function renderEvidenceDisciplineNote(): string {
  return EVIDENCE_DISCIPLINE_NOTE;
}
