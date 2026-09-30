/**
 * state-plane-policy.ts — re-export of the shared "read the cell instead of transcribing a
 * value; say what you want back and split a mixed message into sections" clause for the
 * operator-launched-role prompt base.
 *
 * The reachability half of `unified-agent-state-plane-2026-07-27`. The plane shipped both
 * behaviours correct and gated where a gate was possible, and both were still unreached:
 * `state:read` had 5 distinct agents of the 157 that oriented in 7 days, and the D-064
 * sectioned message body had ONE instance in 30 hours across 5,642 messages — the owner
 * typing "HI" in the admin GUI, every field stamped `owner-gui-derived`. Per-tool `guidance`
 * was present and correct on all of them; per-tool guidance tells you HOW to use a tool you
 * already reached for, and nothing made anyone reach.
 *
 * The one `STATE_PLANE_NOTE` string is owned by `@papercusp/orchestrator` (prompt-build.ts),
 * where it is injected into the SPAWNED-BEE base. operator-core depends on the orchestrator
 * (not the reverse), so the operator-launched-role base re-exports the SAME constant here and
 * injects it via `assembleRolePrompt` — the two bases (plus the su playbooks) can't desync.
 * The clause text, the measurements above, and the honest scoping of what a prompt can and
 * cannot enforce (D-016: the prompt is NOT a tier) live in `STATE_PLANE_NOTE`'s doc-comment.
 */
import { STATE_PLANE_NOTE } from '@papercusp/orchestrator/role-prompt';

/** The shared state-plane clause, injected into every operator-launched role's prompt base
 *  by `assembleRolePrompt` (mirror of `renderCouplingNote` / `renderConcurrencyFirstNote`). */
export function renderStatePlaneNote(): string {
  return STATE_PLANE_NOTE;
}
