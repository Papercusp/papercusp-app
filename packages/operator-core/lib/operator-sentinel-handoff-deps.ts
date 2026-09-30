/**
 * operator-sentinel-handoff-deps — the real-substrate wiring of SentinelHandoffDeps
 * (sentinel-herald Phase 4). Kept SEPARATE from the dispatch core
 * (operator-sentinel-handoff.ts) so the core unit-tests against injected deps with
 * no PG/coord, and converse.ts gets one factory to call.
 *
 * Each dep maps onto an EXISTING substrate primitive — reuse, don't rebuild:
 *   - createWorkItem      → work-items.createWorkItem (kind=change, the user-ask
 *                            issue-family kind; unassigned so the Mug's default
 *                            create-demand subscription wakes her; urgent → hive
 *                            urgent-wake). Tags `user-requested` (the P-016 gate).
 *   - setPriority         → work-items.setWorkItemPriority (the Mug's backlog
 *                            order lever; bump to head).
 *   - subscribeOperator   → work-items.subscribeWorkItem as OPERATOR_COORD_OWNER
 *                            (the same owner the hindsight drain reads).
 *   - nudgeRecipient      → scout/nudge-recipient.resolveNudgeRecipient (the SHARED
 *                            ladder: live Mug while the tier runs → live su →
 *                            escalate to the owner), then delivered on the channel
 *                            that suits the recipient. Was `nudgeMug`, which parked
 *                            non-urgent handoffs in `@role:mug` — a slot with no
 *                            drainer once the tier is retired (WI-37616 / P-052).
 *   - surfaceForApproval  → coord:escalate (question) to the human + a standing-
 *                            approval candidate refresh, so the user can grant a
 *                            standing approval for the (capability, harness) pair.
 *   - standingApprovals   → operator-preferences.loadPreferences().standingApprovals
 */

import type { SentinelHandoffDeps } from './operator-sentinel-handoff';
import { USER_REQUESTED_LABEL, HANDOFF_CAPABILITY } from './operator-sentinel-handoff';

/** Build the real-substrate deps. Pure module-level — no PG touched until a dep
 *  is actually called (each lazy-imports its substrate module so importing this
 *  factory stays cheap on the converse hot path). */
export function defaultSentinelHandoffDeps(): SentinelHandoffDeps {
  return {
    async createWorkItem(input) {
      try {
        const { createWorkItem } = await import('./work-items');
        const wi = await createWorkItem({
          // `change` = a desired one-off the user asked for (work_items:create
          // guidance) — issue-family, so it stays workspace/harness-scoped and is
          // NOT hive-gated (a feature would require a resolved hive). Unassigned so
          // the Mug's default demand wake fires.
          kind: 'change',
          title: input.title,
          summary: input.summary,
          harness: input.harness ?? undefined,
          workspaceId: input.workspaceId,
          topics: [input.label],
          createdBy: 'papercup',
          urgent: input.urgent,
        });
        return { id: wi.id };
      } catch (err) {
        console.warn('[sentinel-handoff] work_item create failed:', (err as Error).message);
        return null;
      }
    },

    async setPriority(id, _priority, harness) {
      const { setWorkItemPriority } = await import('./work-items');
      // priority 0 = head of the backlog (lower = claimed sooner). The user-asked
      // item should be the next thing the Mug's backlog surfaces.
      await setWorkItemPriority(id, 0, { harness: harness ?? undefined });
    },

    async subscribeOperator(workItemId, harness) {
      const [{ subscribeWorkItem }, { OPERATOR_COORD_OWNER }] = await Promise.all([
        import('./work-items'),
        import('./delegated-tasks'),
      ]);
      await subscribeWorkItem(OPERATOR_COORD_OWNER, workItemId, 'full', {
        harness: harness ?? undefined,
      });
    },

    async nudgeRecipient({ workItemId, summary, urgent, harness, workspaceId }) {
      const [{ sendMessage }, { openEscalation }, { OPERATOR_COORD_OWNER }, { resolveNudgeRecipient }] =
        await Promise.all([
          import('./agent-tools/coordination/messages'),
          import('./agent-tools/coordination/escalations'),
          import('./delegated-tasks'),
          import('./scout/nudge-recipient'),
        ]);
      // The Sentinel speaks AS the operator owner on the coord substrate (same
      // identity the hindsight channel + delegated-tasks use). It runs server-side
      // with no MCP ctx, so build the operator identity directly.
      const identity = {
        ownerId: OPERATOR_COORD_OWNER,
        ownerLabel: 'papercup',
        source: 'principal' as const,
        workspaceId: null,
        userId: null,
      };
      const body = `Filed ${workItemId} (user-requested): ${summary}`;

      // WI-37616 / P-052 — REUSE the Scout nudge ladder, do NOT build a second one.
      //
      // `mugOwner: null` is deliberate and is NOT a shortcut. The ladder's Mug rung
      // is gated on `tierRunnable()` (its own P-037 fix), so it cannot fire while
      // `papercusp-mug-kettle-system` is OFF — the delivered end state — no matter
      // what we pass. Resolving a real Mug owner here would need a `Sql` handle and
      // an install slug that this dep does not have, to feed a rung that is gated
      // shut. When the tier is flipped ON as a testing escape hatch, the legacy
      // `@role:mug` park below still reaches her, so no behaviour is lost either way.
      let recipient: Awaited<ReturnType<typeof resolveNudgeRecipient>>;
      try {
        recipient = await resolveNudgeRecipient({ workspaceId, mugOwner: null });
      } catch (e) {
        // The ladder is already fail-soft; this guard covers the dynamic import
        // itself throwing. Degrade to the legacy park rather than losing the nudge.
        recipient = {
          kind: 'unresolved',
          why: `nudge ladder unavailable (${e instanceof Error ? e.message : String(e)})`,
        };
      }

      // THE LADDER PICKS *WHO*; URGENCY PICKS *HOW LOUD*.
      //
      // Before this change the destination was hardcoded: urgent → an escalation
      // (which does still reach a human), and NON-urgent → a park in `@role:mug`.
      // That second path is the actual defect — the slot has no drainer once the
      // tier is retired, so a user-requested handoff was filed and then stranded
      // with nobody signalled. The work_item itself stays durable and claimable in
      // every branch below; what is being repaired is the "someone look at this
      // now" signal, which is the only part that was going nowhere.
      if (recipient.kind === 'su') {
        // A live su can act immediately. A DIRECTED message to a real session is
        // strictly stronger than the role-slot park it replaces: it is delivered
        // and wakes, rather than waiting for a spawn that never comes.
        await sendMessage(identity, {
          to: [recipient.ownerId],
          summary: `Sentinel handoff: ${summary}`.slice(0, 200),
          body:
            `${body}\n\n— Routed to you by the sentinel handoff ladder because the Mug was not ` +
            `deliverable: ${recipient.why}. Before this ladder existed the nudge parked in ` +
            `'@role:mug', which only a Mug drains.`,
          expectsReply: urgent,
          ...(harness ? { harnessSlug: harness } : {}),
        });
        return;
      }

      if (recipient.kind === 'escalate') {
        // Nobody is home. The owner is the only recipient left, so say so — this is
        // the branch that used to silently park into a slot with no drainer.
        // Advisory severity: it is a nudge, not a blocker (matching the prior
        // urgent-path severity).
        await openEscalation(identity, {
          severity: 'advisory',
          summary: `Sentinel handoff${urgent ? ' (urgent)' : ''}, nobody live: ${summary}`.slice(0, 280),
          body: `${body}\n\n— No live Mug and no live su to route to: ${recipient.why}`,
          ...(harness ? { meta: { harnessSlug: harness } } : {}),
        });
        return;
      }

      // kind === 'mug' (the tier is still running) or 'unresolved'.
      //
      // 'unresolved' means the presence/liveness substrate could not be READ — a
      // transient infra hiccup, which is NOT evidence that nobody is home. The
      // ladder's own contract is explicit that escalating on it would page the owner
      // every time a dependency stutters and train them to ignore the channel, so we
      // deliberately do not page here; the filed item remains durable and claimable.
      if (recipient.kind === 'unresolved') {
        console.warn(
          `[sentinel-handoff] nudge recipient unresolved for ${workItemId}: ${recipient.why} — ` +
            `falling back to the legacy @role:mug park; the work_item is still filed and claimable.`,
        );
      }
      if (urgent) {
        await openEscalation(identity, {
          severity: 'advisory',
          summary: `Sentinel handoff (urgent): ${summary}`.slice(0, 280),
          body,
          ...(harness ? { meta: { harnessSlug: harness } } : {}),
        });
      } else {
        await sendMessage(identity, {
          to: ['@role:mug'],
          summary: `Sentinel handoff: ${summary}`.slice(0, 200),
          body,
          ...(harness ? { harnessSlug: harness } : {}),
        });
      }
    },

    async surfaceForApproval({ summary, tier, capability, harness }) {
      const [{ openEscalation }, { refreshCandidates }, { OPERATOR_COORD_OWNER }] =
        await Promise.all([
          import('./agent-tools/coordination/escalations'),
          import('./operator-standing-candidates'),
          import('./delegated-tasks'),
        ]);
      const identity = {
        ownerId: OPERATOR_COORD_OWNER,
        ownerLabel: 'papercup',
        source: 'principal' as const,
        workspaceId: null,
        userId: null,
      };
      // A medium/high action awaiting approval → a `question` escalation the user
      // resolves, plus a standing-candidate refresh so the settings page can offer
      // a STANDING approval for this (capability, harness) pair (the user-facing
      // approval tier — P-015). The Mug places once the user approves.
      //
      // WI-2200 (EI-3643): the Sentinel re-proposes the SAME gate (identical
      // capability + harness) across turns with a FRESHLY-worded `summary` each
      // time (its own natural-language restatement) — without an explicit dedup
      // key, openEscalation's default subjectSignature falls back to the raw
      // summary text (escalationDedupIdentity), so every reworded restatement
      // reads as a NEW subject and never dedupes against the still-open request
      // for the SAME underlying approval. Observed live: 34 open escalations for
      // capability=cup:spawn/fleet:spawn harness=workspace, all differently
      // worded, none ever resolved — pure backlog-drift noise. Pin BOTH dedup
      // fields to the stable (capability, harness) identity so a re-proposal
      // bumps the EXISTING escalation's repeatCount (openEscalation's built-in
      // findOpenDuplicate/tryBumpProjectionDuplicate path) instead of minting a
      // duplicate the user has to individually triage.
      await openEscalation(identity, {
        severity: 'question',
        summary: `Approve ${tier}-tier action? ${summary}`.slice(0, 280),
        body:
          `The Sentinel wants to hand off a ${tier}-tier action (capability=${capability}, ` +
          `harness=${harness ?? 'workspace'}). Approve to let the Mug place it; ` +
          `grant a standing approval to skip this prompt next time.`,
        meta: {
          dedupKind: 'sentinel-handoff-approval',
          subjectSignature: `${capability}:${harness ?? 'workspace'}`,
        },
      });
      await refreshCandidates().catch(() => {});
    },

    async standingApprovals() {
      const { loadPreferences } = await import('./operator-preferences');
      const prefs = await loadPreferences();
      return prefs.standingApprovals.map((a) => ({
        capability: a.capability,
        targetHarness: a.targetHarness,
      }));
    },
  };
}

// Re-exported so converse.ts and tests have one import site for the label/cap.
export { USER_REQUESTED_LABEL, HANDOFF_CAPABILITY };
