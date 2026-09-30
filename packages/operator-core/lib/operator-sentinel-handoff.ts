/**
 * operator-sentinel-handoff — the Sentinel/Herald's file-and-nudge placement seam
 * (sentinel-herald Phase 4: P-014 / P-015 / P-016).
 *
 * The Sentinel is the Herald: it SUGGESTS and HANDS OFF, it never places work
 * itself. Its capability envelope denies cup:spawn/placement by design (the whole
 * point of the role), so where the OPERATOR turn dispatches `<spawn>` directly into
 * the nursery, the SENTINEL turn dispatches `<handoff>` THROUGH HERE:
 *
 *   1. (P-015) Resolve the action's TIER through the EXISTING standing-approval /
 *      tier system — the Sentinel is the user-facing approval tier.
 *        - low                    → just file + nudge (the common case).
 *        - medium/high, NOT yet a → surface for approval (record a standing-approval
 *          standing approval         candidate + escalate to the human) and DO NOT
 *                                    place yet. The Mug acts once the user approves.
 *        - medium/high, ALREADY   → file + nudge (the user has a standing approval
 *          standing-approved          for this (capability, harness) — treat like low).
 *   2. (P-014) File a HIGH-PRIORITY `work_item` describing what the user wants,
 *      tagged `user-requested` — the durable record the Mug triages. Filed
 *      UNASSIGNED so the Mug's default `work_items:create` demand subscription
 *      wakes her, and `urgent` when flagged so the hive urgent-wake fires NOW.
 *   3. (P-014) Nudge the Mug (a coord notify; an escalation when urgent) so she
 *      picks it up promptly — a wake, not just an inject.
 *   4. (P-016) Subscribe the operator-owner to the work_item thread and, when the
 *      item later lands, report it back through the hindsight "[While you were
 *      away]" channel (notifyOperatorHindsight) — the same push the delegate path
 *      uses. The landing watch itself is fired by the work_item lifecycle fan-out
 *      (subscribe→inject); this module records the subscription + seeds the
 *      pending-handoff registry the lifecycle observer drains.
 *
 * The Sentinel NEVER calls cup:spawn — the converse dispatch (converse.ts) only
 * reads `<handoff>` for role==='sentinel' and only reads `<spawn>` for the
 * operator, so the two paths can't cross.
 *
 * Dependency-injected (the `deps` arg) so the dispatch unit-tests without PG: the
 * work_item create, the Mug wake/nudge, the preferences/tier reads, and the
 * subscribe are all seams. The default deps wire the real substrate.
 */

import type { HandoffRequest } from './operator-converse-tags';
import { resolveActualTier } from './operator-suggestion-schema';
import type { CapabilityTier } from '@papercusp/plugin-sdk';

/** The label the Sentinel tags onto every handoff work_item (P-014). The Mug's
 *  survey + the user's filters key on it to spot "the user explicitly asked for
 *  this". */
export const USER_REQUESTED_LABEL = 'user-requested';

/** The capability the Sentinel's handoff is recorded under for the standing-approval
 *  tier resolution / candidate — i.e. the label a user's "don't ask me every time"
 *  grant is keyed on.
 *
 *  This was `'cup:spawn'` until 2026-08-12, on the reasoning that "the Sentinel
 *  itself can't place, so the handoff exercises the MUG's placement capability."
 *  The Mug tier is retired (retire-mug-kettle-su-only-2026-08-09) and `cup:spawn`
 *  retired with it, so that premise is dead — and the name was never quite right
 *  anyway. Read the deps interface below: this handoff calls `createWorkItem` +
 *  `setPriority` + `nudge`. It FILES work. It does not place it, and post-Mug
 *  nothing downstream places it either; the nudge routes through the surviving
 *  recipient ladder (live Mug while the tier ran → live su → owner).
 *
 *  So the grant now names the tool the handoff actually exercises. What the user
 *  is approving is "let the Sentinel file high-priority work for me without
 *  asking each time" — which is what this string should have said all along.
 *
 *  ⚠ Re-keying was safe ONLY because it was verified free: `operator_preferences`
 *  held ZERO rows, so no stored grant was keyed to the old string (D-086 carries
 *  the measurement). This is a CONSENT label — if you ever change it again, query
 *  the store first and migrate what is there. Do not repeat this edit on the
 *  strength of this comment alone. */
export const HANDOFF_CAPABILITY = 'work_items:create';

export interface SentinelHandoffDeps {
  /** Create the work_item. Returns the minted id (WI-NNN) or null on failure. */
  createWorkItem: (input: {
    title: string;
    summary: string;
    harness: string | null;
    label: string;
    urgent: boolean;
    workspaceId: string;
  }) => Promise<{ id: string } | null>;
  /** Bump the new item to high priority (the user-asked default). Best-effort. */
  setPriority: (id: string, priority: 'high', harness: string | null) => Promise<void>;
  /** Nudge whoever can ACTUALLY act on the filed item — resolved through the
   *  shared nudge-recipient ladder (a live Mug while the tier still runs → a live
   *  su → escalate to the owner), never hardcoded to the Mug.
   *
   *  Renamed from `nudgeMug` (WI-37616 / retire-mug-kettle-su-only-2026-08-09
   *  P-052). The rename IS part of the fix, not cosmetics: with the Mug/Kettle
   *  tier retired behind `papercusp-mug-kettle-system` (default OFF), a
   *  NON-URGENT handoff was parked in the `@role:mug` coord slot, which only a
   *  Mug drains and no Mug ever spawns — so a user-requested handoff was filed
   *  and then silently stranded. The old name taught that retired route to every
   *  reader of this interface, which is how the dead rail kept getting rebuilt.
   *
   *  `workspaceId` is REQUIRED because recipient resolution is workspace-scoped:
   *  the ladder reads presence + the liveness oracle for that workspace. */
  nudgeRecipient: (n: {
    workItemId: string;
    summary: string;
    urgent: boolean;
    harness: string | null;
    workspaceId: string;
  }) => Promise<void>;
  /** Subscribe the operator-owner to the work_item thread so its landing fans back
   *  via hindsight (P-016). */
  subscribeOperator: (workItemId: string, harness: string | null) => Promise<void>;
  /** Surface a medium/high handoff for the user's approval (P-015): record a
   *  standing-approval candidate + escalate. Returns nothing — the placement is
   *  deferred to the Mug, post-approval. */
  surfaceForApproval: (s: {
    summary: string;
    tier: CapabilityTier;
    capability: string;
    harness: string | null;
  }) => Promise<void>;
  /** The (capability, harness) pairs the user has already granted a STANDING
   *  approval for — a medium/high handoff matching one of these is auto-filed
   *  (treated like low) instead of re-surfaced. */
  standingApprovals: () => Promise<Array<{ capability: string; targetHarness: string }>>;
}

export type HandoffOutcome =
  | { status: 'filed'; workItemId: string; tier: CapabilityTier; nudged: boolean }
  | { status: 'surfaced_for_approval'; tier: CapabilityTier }
  | { status: 'error'; error: string };

/**
 * Resolve the AUTHORITATIVE tier for a handoff (P-015). When the brain named a
 * `capability`, the substrate tier-table is the source of truth
 * (resolveActualTier) — the brain's `tier` hint is only the fallback for a
 * capability-less generic handoff. An unknown capability fails SAFE to 'high'.
 */
export function resolveHandoffTier(h: HandoffRequest): CapabilityTier {
  if (h.capability) {
    const { tier } = resolveActualTier(
      {
        action: 'send_directive',
        capability: h.capability as 'messages:write',
      } as Parameters<typeof resolveActualTier>[0],
    );
    return tier;
  }
  // No capability named — trust the brain's self-classification (already
  // constrained to low|medium|high by the tag parser, default 'high').
  return h.tier;
}

/**
 * Dispatch ONE `<handoff>` request. Tier-gated (P-015), then file +
 * nudge (P-014) + subscribe-for-hindsight (P-016). Never throws — a failure is
 * returned as `{ status: 'error' }` so a bad handoff can't crash the user-visible
 * turn (same contract as the operator's `<spawn>` dispatch).
 */
export async function dispatchSentinelHandoff(
  h: HandoffRequest,
  workspaceId: string,
  deps: SentinelHandoffDeps,
): Promise<HandoffOutcome> {
  try {
    const tier = resolveHandoffTier(h);

    // P-015: the Sentinel is the user-facing approval tier. A medium/high action
    // the user has NOT standing-approved for this (capability, harness) is
    // surfaced for approval rather than placed — the Mug acts post-approval.
    if (tier !== 'low') {
      const approvals = await deps.standingApprovals().catch(() => []);
      const already = approvals.some(
        (a) =>
          a.capability === HANDOFF_CAPABILITY &&
          (a.targetHarness === (h.harness ?? '') || a.targetHarness === '*'),
      );
      if (!already) {
        await deps.surfaceForApproval({
          summary: h.summary,
          tier,
          capability: HANDOFF_CAPABILITY,
          harness: h.harness,
        });
        return { status: 'surfaced_for_approval', tier };
      }
    }

    // P-014: file the high-priority, user-requested work_item (unassigned →
    // wakes the Mug via her default create-demand subscription; urgent →
    // fires the hive urgent-wake NOW).
    const title = h.summary.slice(0, 200);
    const created = await deps.createWorkItem({
      title,
      summary: h.summary,
      harness: h.harness,
      label: USER_REQUESTED_LABEL,
      urgent: h.urgent,
      workspaceId,
    });
    if (!created) return { status: 'error', error: 'work_item create failed' };

    // High priority for user-asked work (the persona contract). Best-effort.
    await deps.setPriority(created.id, 'high', h.harness).catch(() => {});

    // P-016: subscribe the operator-owner so the item's landing fans back via
    // hindsight ("[While you were away]").
    await deps.subscribeOperator(created.id, h.harness).catch(() => {});

    // P-014: nudge whoever can act on it, with a wake (escalate when urgent).
    // WI-37616: `workspaceId` is threaded through so the dep can resolve a REAL
    // recipient rather than parking in the retired Mug's role-slot.
    let nudged = false;
    try {
      await deps.nudgeRecipient({
        workItemId: created.id,
        summary: h.summary,
        urgent: h.urgent,
        harness: h.harness,
        workspaceId,
      });
      nudged = true;
    } catch {
      /* the item is already filed and durable; a failed explicit nudge is non-fatal */
    }

    return { status: 'filed', workItemId: created.id, tier, nudged };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}
