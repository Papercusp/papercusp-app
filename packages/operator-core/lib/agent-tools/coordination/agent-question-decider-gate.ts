/**
 * agent-question-decider-gate — the B-10 ⇄ B-12 bridge (queen-autonomous-execution
 * B-17 seam-gap, su-37d9d's find). A ready-to-wire {@link AgentQuestionGate} backed
 * by the autonomy decider (queen-autonomy-policy B-12, `lib/autonomy/decider.ts`).
 * Pass it to `configureAgentQuestionGate` to route an autonomous agent's intercepted
 * question through the D-004 gate instead of the static owner-Queue default.
 *
 * THE CONTRACT (coordinate with B-17's persona, su-37d9d — do not let these drift):
 * the decider's binary posture maps to the question rung —
 *   gated → owner-queue   (the owner answers via the D-011 Queue; today's default)
 *   auto  → bee-self       (the bee may self-answer-with-undo; P-040)
 * The Queen mid-level (P-043) is a persona layer ATOP bee-self (the Queen elects to
 * answer a subset for consistency/authority), NOT a distinct decider posture — so it
 * is not a separate rung here; the persona decides when to intercept a bee-self.
 *
 * BEHAVIOR-NEUTRAL until armed (D-007): while `papercusp-queen-autonomy-armed` is OFF,
 * `resolveAutonomyDecision` returns `gated` for every input → owner-Queue, identical
 * to the default gate. A question carrying no decision-context fail-safes to gated
 * (the decider treats a null category as unmapped → never-auto). ANY import/IO/await
 * failure falls safe to owner-Queue — a classifier error must never freeze a bee nor
 * silently auto-decide.
 *
 * NOT wired by default. B-17 (the designated gate CONSUMER per autonomy-policy's Now)
 * decides where to `configureAgentQuestionGate(deciderAgentQuestionGate)` and threads
 * the per-question decision-context (action/risk/reversibility) from the bee — see
 * `AgentQuestionInput`'s optional fields. This file only provides the bridge.
 */

import type {
  AgentQuestionGate,
  AgentQuestionRouting,
  QuestionRung,
} from './agent-question-gate';

/** The agreed posture → rung contract (see file header). Pure. */
export function postureToRung(posture: 'auto' | 'gated'): QuestionRung {
  return posture === 'gated' ? 'owner-queue' : 'bee-self';
}

/**
 * An async {@link AgentQuestionGate} backed by B-12's `resolveAutonomyDecision`.
 * Resolves the workspace from the asking agent's identity, reads the policy ceiling
 * + arming flag, runs the D-004 gate, and maps the posture to a rung.
 */
export const deciderAgentQuestionGate: AgentQuestionGate = async (
  input,
): Promise<AgentQuestionRouting> => {
  try {
    const [{ getOrgPg }, { activeWorkspaceId }, { resolveAutonomyDecision, defaultDeciderDeps }] =
      await Promise.all([
        import('@papercusp/db-org'),
        import('../../workspace-registry'),
        import('../../autonomy/decider'),
      ]);
    const wsRaw = input.identity.workspaceId;
    const ws = wsRaw && wsRaw !== '*' ? wsRaw : activeWorkspaceId();
    const { sql } = getOrgPg();
    const decision = await resolveAutonomyDecision(
      {
        // With a declared action the decider maps the real category (B-04); without
        // one a free-text question is unmapped → never-auto → gated (fail-safe).
        ...(input.action ? { action: input.action } : { category: null }),
        ...(input.riskTier ? { riskTier: input.riskTier as never } : {}),
        ...(input.authority ? { authority: input.authority as never } : {}),
        ...(input.reversibility ? { reversibility: input.reversibility as never } : {}),
      },
      defaultDeciderDeps(sql, ws),
    );
    return { rung: postureToRung(decision.posture) };
  } catch {
    // fail-safe: never freeze a bee, never silently auto-decide.
    return { rung: 'owner-queue' };
  }
};
