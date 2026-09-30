/**
 * champion-escalation.ts — NOV-4 champion escalation (autonomous-loop-prod-audit-
 * 2026-07-02 P-016 / WI-4636): "gym champions auto-file improvement work items
 * into the queen frontier."
 *
 * A gym proposal's ACCEPTANCE (`decideProposal`, control-plane.ts) makes it the
 * new live prompt for its (harness, role) — the champion. That event already
 * opens the post-acceptance outcome tracking window (`recordChampionAcceptance`)
 * and writes a change-ledger entry (`recordBehaviorChange`), but neither one
 * reaches the QUEEN's triage backlog: a champion promotion is exactly the kind
 * of "does this winning pattern generalize elsewhere?" judgment call the Queen
 * frontier exists to make, and until this landed nothing surfaced it there — the
 * Queen only learned about a new champion by happening to browse the gym pane.
 *
 * This module closes that gap: every accepted champion FILES a real, human-gated
 * improvement candidate (`kind:'change'`, `lane:'improvement'` — the DEFAULT
 * triage pipeline, distinct from the OBSERVATION-only lane deprecate-learnings.ts
 * uses for salvage) into the standard `papercusp-improvement` topic, so it
 * appears in the Queen's ordinary backlog exactly like any other filed
 * improvement.
 *
 * REUSE-FIRST: a thin composer over the shared writer {@link captureImprovement}
 * (the same seam deprecate-learnings.ts uses for its salvage observation) — no
 * new storage, no new schema, no new mechanism.
 */
import {
  captureImprovement,
  type CaptureImprovementInput,
  type CaptureImprovementResult,
} from '../harness/improvements/capture-core';

export interface ChampionEscalationInput {
  /** The accepted gym_proposals row id. */
  proposalId: string;
  harnessSlug: string;
  role: string;
  cycle?: number | null;
  variantId?: string | null;
  /** Δ dev-anchor (judge composite) score the accepted variant carried, when known. */
  devAnchorDelta?: number | null;
  /** Δ per-run USD cost the accepted variant carried, when known. */
  costDelta?: number | null;
  probeStatus?: string | null;
  /** Attribution — the accepting agent's ownerId, when known. */
  createdBy?: string;
}

/** A signed decimal delta, or 'unmeasured' when absent/non-finite. */
function fmtDelta(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return 'unmeasured';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(3)}`;
}

/**
 * PURE: shape a {@link ChampionEscalationInput} into the {@link CaptureImprovementInput}
 * that files it into the Queen's ordinary triage backlog. No PG/IO — exhaustively
 * unit-testable.
 *
 * Invariants the tests pin:
 *  - `lane: 'improvement'` (the DEFAULT triage pipeline — must appear in the
 *    Queen's ordinary backlog, not a Scout-only observation feed).
 *  - `kind: 'change'` (human-gated: "should this generalize elsewhere?" is a
 *    judgment call, never auto-implement-eligible like a `bug`).
 *  - `watchdogKey: 'gym-champion:<harnessSlug>:<role>'` (WI-39594) — the stable
 *    per-(harness, role) identity. A re-promotion of the same role COALESCES onto
 *    the still-open escalation (repeatCount bump, title/body refreshed to the
 *    newest cycle) instead of filing a sibling: the queue audit of 2026-08-17
 *    dropped ~25 near-identical open "champion promoted" items that force:true
 *    had filed one-per-cycle. The signal is still never dropped — every
 *    occurrence is retained on the row — there is just ONE open item per
 *    role@harness for the Queen to judge.
 *  - `force: true` — when NO open escalation exists for this key, the filing must
 *    never be silently declined by the fuzzy near-duplicate nets (the original
 *    NOV-4 guarantee, now scoped to the case where it is correct).
 *  - `scope: 'harness:<harnessSlug>'` — the per-Hive lens the digest/triage read.
 *  - the proposal id + role + cycle ride the title/body, so the newest champion
 *    stays identifiable; prior cycles live in the row's occurrence history.
 */
export function buildChampionEscalationInput(input: ChampionEscalationInput): CaptureImprovementInput {
  const cyclePart = input.cycle != null ? ` cycle ${input.cycle}` : '';
  const title = `Gym champion promoted: ${input.role}@${input.harnessSlug}${cyclePart} — consider generalizing`;

  const body = [
    `A gym proposal was ACCEPTED and is now the live prompt for this role — a new`,
    `champion (NOV-4, "gym champions auto-file improvement work items into the`,
    `queen frontier"). Filed so the Queen judges whether the winning pattern`,
    `generalizes to other roles/hives — the acceptance itself already promoted it`,
    `locally; this is the escalation, not a duplicate of that action.`,
    ``,
    `- Proposal: gym:proposal-${input.proposalId}`,
    `- Harness / role: ${input.harnessSlug} / ${input.role}`,
    ...(input.variantId ? [`- Variant: ${input.variantId}`] : []),
    ...(input.cycle != null ? [`- Cycle: ${input.cycle}`] : []),
    `- Dev-anchor delta: ${fmtDelta(input.devAnchorDelta)}`,
    `- Cost delta: ${fmtDelta(input.costDelta)}`,
    ...(input.probeStatus ? [`- Probe status: ${input.probeStatus}`] : []),
  ].join('\n');

  return {
    title,
    kind: 'change',
    body,
    severity: 'nit',
    scope: `harness:${input.harnessSlug}`,
    lane: 'improvement',
    sourceRole: 'system',
    force: true,
    watchdogKey: `gym-champion:${input.harnessSlug}:${input.role}`,
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    payloadExtra: {
      championEscalation: {
        kind: 'gym-champion-promoted',
        proposalId: input.proposalId,
        harnessSlug: input.harnessSlug,
        role: input.role,
        variantId: input.variantId ?? null,
        cycle: input.cycle ?? null,
        devAnchorDelta: input.devAnchorDelta ?? null,
        costDelta: input.costDelta ?? null,
        probeStatus: input.probeStatus ?? null,
      },
    },
  };
}

/** Injectable writer seam — unit tests run the escalation with a fake captureImprovement. */
export interface ChampionEscalationDeps {
  captureImprovement: typeof captureImprovement;
}

const defaultDeps: ChampionEscalationDeps = { captureImprovement };

/**
 * Emit the champion-escalation improvement candidate. Thin: builds the input and
 * hands it to the shared writer. Callers (control-plane.ts's `decideProposal`
 * accept path) treat this as BEST-EFFORT — it runs strictly after the promotion
 * has already committed, so a failure here must never roll back or fail the accept.
 */
export async function escalateChampionToQueenFrontier(
  input: ChampionEscalationInput,
  deps: ChampionEscalationDeps = defaultDeps,
): Promise<CaptureImprovementResult> {
  const built = buildChampionEscalationInput(input);
  try {
    return await deps.captureImprovement(built);
  } catch (err) {
    // Pot-membership enforcement (P-005, 2026-07-20): scope 'harness:<slug>' resolves to a
    // Pot home slug at write time, and a gym target is often a THROWAWAY optimization
    // harness (e.g. gymloopharness) that is NOT a real Pot in the workspace — the strict
    // resolver then refuses the capture (PotMembershipError, code 'pot_not_found'). That
    // strictness is right for agent-supplied slugs, but a SYSTEM escalation must not drop
    // the champion signal: retry once under the workspace platform Pot (exactly what the
    // refusal prescribes). The harness identity stays in the title/body/payloadExtra, so
    // nothing is lost but the per-Hive scope label.
    if ((err as { code?: string } | null)?.code === 'pot_not_found' && built.scope !== undefined) {
      const { scope: _droppedScope, ...platformPotInput } = built;
      return await deps.captureImprovement(platformPotInput);
    }
    throw err;
  }
}
