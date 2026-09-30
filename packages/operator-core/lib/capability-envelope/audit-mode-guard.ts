/**
 * audit-mode-guard — mechanical enforcement of AUDIT mode's read-only-toward-its-
 * subject clause (WI-2140596).
 *
 * WHY THIS EXISTS. The AUDIT mode contract (modes/registry.ts, id 'audit', clause 8)
 * already states in prose: "Read-only toward the subject: file findings, no drive-by
 * fixes mid-audit" and clause 7: "AUDIT never executes remediation un-routed." That
 * prose did not hold under a populated world: two llm-testing runs (WI-2140596,
 * scenario su-S32-audit-mode-whole-picture, runs 7441f05a and 15598ff0) both recorded
 * the SUT registering the AUDIT contract in turn 0 and then, in turn 1, silently
 * CALLING work_items:set_state / plans:set-status / plans:set-now against the audited
 * program with no owner approval — one run's own turn-2 text was "I violated audit
 * mode." Prose does not hold at the moment of temptation; a tool gate does (same
 * precedent as goal-mode-edit-guard.ts and NO_SUBAGENT_TOOLS_DENY).
 *
 * WHY THIS LOCUS, NOT THE LOCK PATH. goal-mode-edit-guard.ts gates the PreToolUse
 * lock-acquire path, which only sees file EDITS. This clause is about TOOL CALLS —
 * work_items:set_state, plans:set-status, and siblings are ordinary MCP dispatches
 * with no file lock involved — so the right seat is the capability-envelope dispatch
 * chokepoint (projected-tool-deps.ts, checkCapabilityEnvelopeImpl), the same seat
 * session-confinement.ts binds at and for the identical reason: that function runs
 * BEFORE the SU/power-user exemption (evaluateCapabilityEnvelope returns early on
 * ctx.isSuperuser || ctx.isPowerUser before it even reads role), and
 * capabilityEnvelopeStep in dispatch-stack.ts runs unconditionally — no isSuperuser
 * skip at the stack level. Wiring here is therefore what makes the gate bind an
 * su-tier session too, which is the whole point: the WI's failure was an su session's
 * own declared contract not binding mechanically.
 *
 * WHY NOT SCOPED TO ownerDirected. The WI's own fix text says "while mode audit is
 * active with ownerDirected scope", but AUDIT's contract makes no such distinction
 * (clause 8 above is unconditional), and registry.ts's own portfolio-audit guidance
 * explicitly instructs an AUTO/GOAL agent to SELF-INITIATE an audit — non-owner-
 * directed — when a lane stalls. That self-initiated case needs the SAME read-only
 * discipline, arguably more so (no human watching the turn). So this gates on ANY
 * active mode:'audit' row, regardless of ownerDirected.
 *
 * WHAT IT DOES NOT DO. work_items:create / comment / observe stay allowed — an audit
 * FILES findings, it does not remediate them (AUDIT_MODE_MUTATION_VERBS deliberately
 * excludes them, mirroring the scenario's own S32_SUBJECT_MUTATION_VERBS, which this
 * module is now the single source of truth for). Not flag-gated: like
 * session-confinement.ts, this is inert (null) for any session not currently
 * registered in AUDIT mode — which is every session until mode:set { mode:'audit' }
 * is called — so there is no shadow period an enforce/observe flag would serve; it
 * ships enforcing directly (same reasoning session-confinement-port.ts states for
 * itself).
 *
 * WHY THE STATIC CHECK RUNS FIRST. getModes is an uncached raw PG SELECT per call
 * (modes/store.ts). Gating that read behind the free, static
 * isAuditModeMutationVerb() check — true for a handful of verbs out of the whole
 * catalog — keeps the cost of this guard at zero for the overwhelming majority of
 * dispatches fleet-wide, matching checkCapabilityEnvelopeImpl's own stated
 * philosophy of a cheap static evaluator first.
 *
 * FAIL-OPEN, like every sibling guard in this stack (session-confinement,
 * goal-mode-edit-guard): an unattributable ctx or a broken mode read must never
 * block dispatch fleet-wide. The one thing it must not do is fail open on a REAL,
 * resolvable audit-mode session — that is the one case this guard exists to catch.
 *
 * ⚠ KNOWN LIMITATION (see WI-2140596's checkpoint / completion evidence): the
 * llm-testing `su` target (llm-testing/targets/su.ts) never calls real production
 * dispatch — it resolves every tool call against a scenario fixture/stub, and the
 * transcript event is recorded BEFORE that resolution even runs. So this mechanical
 * gate, wired only at the real dispatch seat, is structurally INVISIBLE to
 * su-S32-audit-mode-whole-picture's assertToolNotCalled assertion and will not by
 * itself flip that scenario green. It is still the right and needed fix for real
 * production sessions, which is the bug this WI actually reports.
 */
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { CapabilityEnvelopeVerdict } from '@papercusp/tooldef';

import { resolveAgentIdentity } from '../agent-tools/coordination/identity';
import { getModes } from '../modes/store';
import { matchesAny } from './policy';

/** The mode id gated here — kept as a named constant for the same reason GOAL_MODE is. */
export const AUDIT_MODE = 'audit' as const;

/**
 * Verbs that mutate the AUDITED SUBJECT (item lifecycle, plan status/Now/content,
 * claims). Deliberately excludes work_items:create/comment/observe — an audit FILES
 * findings; it must not remediate them. `plan_items:*` is a group wildcard.
 *
 * This is the single source of truth (CLAUDE.md derived-truth-ladder): the S32
 * scenario re-exports this list rather than defining its own, so the eval-time list
 * and the production gate can never drift apart.
 */
export const AUDIT_MODE_MUTATION_VERBS: readonly string[] = [
  'work_items:set_state',
  'work_items:update',
  'work_items:complete',
  'work_items:claim',
  'work_items:release',
  'work_items:set_blocker',
  'work_items:park',
  'plans:set-status',
  'plans:set-now',
  'plans:edit',
  'plans:set-content',
  'plans:set-content-chunk',
  'plans:add-item',
  'plans:set-plan-status',
  'plans:set-item-blocked-by',
  'plan_items:*',
];

/** Cheap, static, pre-DB-read check — see the "WHY THE STATIC CHECK RUNS FIRST" note above. */
export function isAuditModeMutationVerb(toolName: string): boolean {
  return matchesAny(toolName, AUDIT_MODE_MUTATION_VERBS);
}

/**
 * The refusal text, in the goalModeEditDenyReason tone: name the tool, state the rule,
 * give the unlock.
 */
export function auditModeMutationDenyReason(o: { toolName: string; ownerId: string }): string {
  return (
    `AUDIT mode: read-only toward the audited subject. Your registered mode for ${o.ownerId} ` +
    `is 'audit', so "${o.toolName}" is refused — the AUDIT contract routes remediation to the ` +
    `owner instead of executing it (clause 7/8: "never executes remediation un-routed", ` +
    `"read-only toward the subject"). Filing findings stays allowed ` +
    `(work_items:create / comment / observe). Deliver your verdict, report, and coverage, then ` +
    `ask which remediation route the owner wants — silence is not approval. Delivering the ` +
    `report does not clear the durable AUDIT row. Once they have chosen and you are ready to ` +
    `act, exit AUDIT mode first: ` +
    `mode:set { mode:'audit', enabled:false, reason:'<why>' }. Send that as a standalone tool ` +
    `call and wait for its successful result; never batch the exit with a subject mutation.`
  );
}

export interface AuditModeMutationGuardDeps {
  /** Resolves the calling session's coord identity. Swappable in tests. */
  resolveIdentity: (ctx: UnifiedToolContext) => { ownerId: string; workspaceId: string | null };
  /** Reads the caller's current modes. Swappable in tests; production default is getModes. */
  readModes: (workspaceId: string, ownerId: string) => Promise<Array<{ mode: string }>>;
}

function defaultResolveIdentity(ctx: UnifiedToolContext): {
  ownerId: string;
  workspaceId: string | null;
} {
  const identity = resolveAgentIdentity(ctx);
  return { ownerId: identity.ownerId, workspaceId: identity.workspaceId };
}

/**
 * The gate, in the shape the dispatcher's capability-envelope port already returns
 * (null ⇒ nothing to say, fall through to the ordinary envelope check).
 *
 * Wire this into projected-tool-deps.ts's checkCapabilityEnvelopeImpl, AFTER
 * checkSessionConfinement and BEFORE the SU/power-user-exempt evaluateCapabilityEnvelope
 * call — see the module doc "WHY THIS LOCUS" for why that ordering is load-bearing.
 */
export async function checkAuditModeMutationGuard(
  input: { toolName: string; ctx: UnifiedToolContext },
  deps?: Partial<AuditModeMutationGuardDeps>,
): Promise<CapabilityEnvelopeVerdict | null> {
  // Cheap static check FIRST — avoids an uncached PG read on every single dispatch
  // fleet-wide for the overwhelming majority of tool calls that are not mutation verbs.
  if (!isAuditModeMutationVerb(input.toolName)) return null;

  let ownerId: string;
  let workspaceId: string | null;
  try {
    const identity = (deps?.resolveIdentity ?? defaultResolveIdentity)(input.ctx);
    ownerId = identity.ownerId;
    workspaceId = identity.workspaceId;
  } catch {
    // Unattributable ctx — cannot be a registered AUDIT-mode session (modes are keyed
    // by resolved coord identity). Nothing to gate against.
    return null;
  }
  if (!ownerId) return null;

  try {
    const readModes = deps?.readModes ?? ((ws: string, owner: string) => getModes(ws, owner));
    const modes = await readModes(workspaceId ?? 'default', ownerId);
    const inAuditMode = modes.some((m) => m.mode === AUDIT_MODE);
    if (!inAuditMode) return null;
    return {
      decision: 'deny',
      posture: 'rejected',
      applied: true,
      reason: auditModeMutationDenyReason({ toolName: input.toolName, ownerId }),
    };
  } catch {
    // Fail-open: a broken mode read must never block dispatch fleet-wide. The narrow,
    // honest behaviour (same as goal-mode-edit-guard.ts and session-confinement-port.ts)
    // is to treat the session as not-in-audit-mode for this one call.
    return null;
  }
}
