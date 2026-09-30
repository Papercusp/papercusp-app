/**
 * work_items:claim_next — self-selection over central assignment (D-004 / D-007).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. The tuple-space associative `in`:
 * atomically claim the OLDEST unclaimed work-item in a harness via SELECT … FOR UPDATE
 * SKIP LOCKED. Competing idle agents each grab a different item (no double-claim), and
 * oldest-first steals the most-starved tail of the queue. Leaning to self-selection
 * (the Oct-2025 LLM-blackboard result: +13–57% task success) — named assignment stays
 * the deliberate exception (work_items:claim with an explicit assignee).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { resolveAgentIdentity, resolveSelfLiteral } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { CLAIM_STATES_ALLOWLIST, claimNextWorkItem, releaseWorkItem, diagnoseClaimNextMiss } from '../../work-items';
import { workItemClaimLeaseEnabled, leaseClaimedWorkItem } from '../../work-item-claim-lease-wiring';
import { workItemRedundancyEnabled } from '../../work-item-redundancy';
import { localSwarmId } from '../../fleet/swarm-identity';
import { activeWorkspaceId } from '../../workspace-registry';
import { getNextForBee, resolveClaimSpecWorkspace } from '../../scheduler/claim-spec-store';
import { cancelClaimableAwaits } from '../../events/await/store';
import {
  fleetScopedMiss,
  reconcileFleetScopeClaims,
  readFleetPauseState,
  diagnoseFleetScopeCooldownMiss,
} from '../../scheduler/fleet-scope-admission';
import { getClaimTimeRetractionAdvisory } from './retraction-advisory';
import {
  fetchContextPressure,
  resolveContextPressureRecoveryPath,
  resolveContextPressureHeadroom,
} from '../coordination/context-pressure';
import { decideContextPressureGate, contextCriticalRefusalResult } from '../../scheduler/context-pressure-claim-gate';
import { decideGoalStewardGate, goalStewardRefusalResult } from '../../scheduler/goal-steward-claim-gate';
import { readGoalHolderAuthority } from '../../goals/holder-authority';
import { getOrgPg } from '@papercusp/db-org';

export default defineTool({
  name: 'work_items:claim_next',
  profile: 'engineer',
  description:
    'Self-select the next work-item. This compatibility wrapper honors fleet scope through the same selector as scheduler:get_next. Outside a fleet, disabling scheduler claim-specs degrades to legacy oldest-first SKIP LOCKED; a fleet MEMBER never takes that fallback. Returns the claimed item or a self-describing miss; a scoped miss carries windDown:true.',
  guidance: {
    when: 'You are an idle agent picking up work. Fleet members should prefer scheduler:get_next; this older wrapper is still fleet-scope-safe even if the scheduler flag is off.',
    notWhen:
      "A SPECIFIC item must go to a SPECIFIC agent → work_items:claim with an explicit assignee. Named claim bypasses self-select readiness floors, but it never bypasses a fleet member's claim-spec boundary.",
    chaining:
      'work_items:claim_next → work_items:set_state → work_items:release. On a non-fleet miss, read drained/pendingUnclaimed. On a fleet scoped miss, windDown:true means checkpoint/release, loop:end, and report to the leader; do not scan generic backlog. windDown:false with excludedBreakdown.claimable>0 is a claim-path bug, NOT a drain — claim by id instead.',
    // EI-6981: when the scheduler-spec bridge is OFF, the legacy path self-selects the
    // OLDEST unclaimed item HARNESS-WIDE, not just your fleet/plan — a peer's "solo takeover"
    // of an item they haven't formally
    // work_items:claim'd (declared only in a coord message / the item's own summary
    // prose, assignee field still empty/stale) is INVISIBLE to this atomic claim and can
    // get self-selected out from under them (observed live: WI-1729). Before acting on a
    // freshly-claimed item, skim its title/summary for an existing "taken over by <owner>"
    // / "solo takeover" note — if you find one, work_items:release it immediately rather
    // than proceeding, and prefer a narrower harness/kind filter (or a leader-set
    // claim-spec / scheduler:get_next) when you know you're one of several fleets sharing
    // one harness.
    seeAlso: [
      'work_items:claim (by-id / named-assignee claim — the exception to self-select)',
      'work_items:list (on a drained:false miss, see which items are blocked/gated)',
      'work_items:set_state (advance the item you just claimed)',
    ],
  },
  capability: 'work_items:write',
  // tool-call-batching-wrappers-2026-06-21 P-011 — composite marker: atomic self-select
  // replaces a manual work_items:claim (find-oldest + claim, race-free).
  replaces: ['work_items:claim'],
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().min(1),
    kind: z.enum(['feature']).optional().describe("active feature-family narrowing; retired 'chunk' rows are never self-selected"),
    assignee: z.string().max(120).optional().describe('default: you (also resolves the literal "self" to you)'),
    ignoreContextPressure: z
      .boolean()
      .optional()
      .describe(
        'WI-5940 escape hatch: proceed even though your CACHED context-pressure bucket reads critical (self-pull only). Pass true only when your OWN live gauge contradicts it.',
      ),
    // WI-1912: clamped to the claimable allowlist — same wall as scheduler:get_next; a
    // free-string `states` let a caller widen past the resolver-owned blocked/cursed floors.
    states: z
      .array(z.enum(CLAIM_STATES_ALLOWLIST as unknown as [string, ...string[]]))
      .max(20)
      .optional()
      .describe(
        "claimable states — subset of ['open','failing'] (default ['open'] — the unified claimable token for BOTH families; feature `todo` retired). 'blocked'/'cursed' are resolver-owned floors (blocked items are leader-triage-only) and terminal states are settled — neither is requestable (D-002 / WI-1912).",
      ),
    count: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe(
        'How many of the OLDEST unclaimed items to claim (default 1, max 25). >1 loops the same race-free SKIP-LOCKED claim path N times, stopping at the first miss — so you may get FEWER than `count` when the queue runs dry. count>1 returns { ok, claimed: [...] }; omitted/1 keeps the single-item { ok, workItem } shape (backward-compatible).',
      ),
    rigAvailable: z
      .boolean()
      .optional()
      .describe(
        'WI-2796: pass true ONLY when you actually have/coordinate a live ≥2-machine or Hetzner federation rig. Default (false/omitted): items tagged payload.needs_2_machine_rig are excluded from self-select — a single-box caller cannot execute them anyway, and claiming-then-releasing one is pure recycle churn. A rig-equipped fleet passes true to see them.',
      ),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    // EI-9274: resolve a literal `'self'` assignee the same as an omitted one (both →
    // the caller) — previously stored verbatim, producing an unmatchable, permanently
    // orphaned claim (WI-3881).
    const assignee = resolveSelfLiteral(args.assignee, ident.ownerId) ?? ident.ownerId;
    // workspace-work-scope-policy-2026-09-04 P-006: a pull from an out-of-scope harness is
    // refused before any SKIP-LOCKED claim runs (held, never deleted; ledgered). No policy ⇒
    // one cached read, byte-identical behaviour.
    {
      const { gateWorkScope, workScopeRefusal } = await import('../../work-scope-policy');
      const scope = await gateWorkScope('work_items:claim_next', { harness: args.harness, actor: assignee });
      if (!scope.allowed) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(workScopeRefusal(scope)) }] };
      }
    }
    // WI-5940: the same compact-first refusal scheduler:get_next applies, via the SHARED
    // decision so the two self-select surfaces cannot drift (the WI-6409 failure mode).
    //
    // SELF-PULL ONLY. When `assignee` is someone else this is a DIRECTED placement, not a
    // self-select — the caller is a leader handing work to another agent, and refusing that on
    // the LEADER's context pressure would gate the wrong agent's state. Directed claims stay
    // ungated here (work_items:claim, the by-id surface, is likewise deliberately not gated).
    if (assignee === ident.ownerId) {
      const gateEnabled = await getFlag(FLAGS.SCHEDULER_CONTEXT_PRESSURE_GATE, ident.ownerId).catch(() => true);
      const bucket = gateEnabled
        ? await fetchContextPressure([ident.ownerId])
            .then((m) => m.get(ident.ownerId) ?? null)
            .catch(() => null)
        : null;
      // EI-23744538757758407: both remedy reads fire ONLY on the refusal path, and in PARALLEL.
      // Headroom answers a question `recovery` cannot — whether this caller's limit is even
      // SATISFIABLE — so that a session whose fixed baseline already exceeds its soft limit is
      // told to raise the limit rather than to compact, which provably cannot clear it.
      const contextRefusing = bucket === 'critical' && args.ignoreContextPressure !== true;
      const [recovery, headroom] = contextRefusing
        ? await Promise.all([
            resolveContextPressureRecoveryPath(ident.ownerId, ident.workspaceId).catch(() => null),
            resolveContextPressureHeadroom(ident.ownerId).catch(() => null),
          ])
        : [null, null];
      const gate = decideContextPressureGate({
        bucket,
        override: args.ignoreContextPressure === true,
        enabled: gateEnabled,
        overrideArg: 'ignoreContextPressure',
        recovery,
        headroom,
      });
      if (gate.refuse) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(contextCriticalRefusalResult(gate)) }],
        };
      }
      // WI-2092233: the same route-it-instead refusal scheduler:get_next applies to an active
      // GOAL steward, via the SHARED decision so the two self-select surfaces cannot drift.
      // Self-pull only (this block) — a directed placement gates the wrong agent's authority.
      // Fails OPEN on an unreadable flag/authority (see the gate module's hazard note).
      const stewardGateEnabled = await getFlag(FLAGS.SCHEDULER_GOAL_STEWARD_GATE, ident.ownerId).catch(() => true);
      // try/catch rather than .catch(): a synchronous getOrgPg() throw (no org pool in a
      // unit-test harness) must fail open too, not escape past the promise chain.
      let stewardAuthority = null as Awaited<ReturnType<typeof readGoalHolderAuthority>> | null;
      if (stewardGateEnabled && ident.workspaceId) {
        try {
          stewardAuthority = await readGoalHolderAuthority(getOrgPg().sql, ident.workspaceId, ident.ownerId);
        } catch {
          stewardAuthority = null;
        }
      }
      const stewardGate = decideGoalStewardGate({
        authority: stewardAuthority,
        enabled: stewardGateEnabled,
      });
      if (stewardGate.refuse) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(goalStewardRefusalResult(stewardGate)) }],
        };
      }
    }
    const reconciliation = await reconcileFleetScopeClaims({
      ownerId: assignee,
      workspaceId: ident.workspaceId,
      identity: ident,
    });
    // WI-2971: claim_next is an older public self-pull surface. In a fleet with a
    // leader-authored claim spec, letting this wrapper call the raw oldest-first primitive
    // bypasses the fleet lane and can hand feature/plan work to a bug-drain member. When the
    // scheduler claim flag is ON, route through the same getNextForBee path as
    // scheduler:get_next. P-016: a fleet member NEVER takes the legacy generic
    // fallback, even when the scheduler flag is off — scope is an admission
    // boundary, not a feature toggle.
    // EI-12832: a paused fleet (control_state='winding-down') floors self-select too — a
    // member woken during the pause must stand down, not pull the next item. Gate here,
    // before any claim, with the same durable-control-state read the by-id admission path uses.
    if (reconciliation.scope) {
      const pause = await readFleetPauseState(reconciliation.scope, ident.workspaceId);
      if (pause.windingDown) {
        // EI-15777: retire the caller's own standing `work-item:claimable` await(s)
        // right here — otherwise a peer's compliant stand-down release still fires
        // it (the admission gate only refuses the ensuing claim), burning a full
        // session-resume cycle on a pull this member is forbidden to make anyway.
        // Mirrors the same-purpose cancel on a successful claim below.
        const claimableAwaitsCancelled = await cancelClaimableAwaits(assignee).catch(() => 0);
        const miss = fleetScopedMiss(reconciliation.scope, reconciliation.quarantinedIds, {
          pausedReason: pause.reason,
          claimableAwaitsCancelled,
          harness: args.harness,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(args.count && args.count > 1 ? { ...miss, claimed: [] } : miss),
            },
          ],
        };
      }
    }
    const specOn = await getFlag(FLAGS.SCHEDULER_SPEC_CLAIM, ident.ownerId).catch(() => true);
    // P-002 co-location lever: under the per-Hive claim lease, honor each item's
    // swarm_affinity by passing THIS Swarm's id — the claim then skips work affined to
    // another Swarm and prefers work affined to us. Flag OFF (default) ⇒ swarmId omitted
    // ⇒ affinity-blind, claim is byte-identical to before.
    const leaseOn = workItemClaimLeaseEnabled();
    const swarmId = leaseOn ? localSwarmId(activeWorkspaceId(), args.harness) : undefined;
    // P-014: under the redundancy flag, skip high-stakes items here — they fan out to N
    // Swarms via work_items:claim_replica, not an exactly-once claim. Flag OFF ⇒ omitted.
    const excludeRedundant = workItemRedundancyEnabled();

    // EI-6480: when claimOne claims a row locally but LOSES the per-Hive authority lease, the
    // item is released back to the pool yet the lease-arbitration loss is invisible to the miss
    // diagnosis — which then misreports it as a peer race ("retry"). A stale lease surviving a
    // non-terminal release (the reaper / issue-requeue path) keeps the item reading as unclaimed
    // while it fails arbitration for everyone but its dead prior owner. Capture the last such loss
    // so missResult can name it truthfully. Observability ONLY — no claim/release-semantics change.
    let lastLeaseLoss: { id: string } | null = null;
    const claimViaScheduler = async () => {
      const res = await getNextForBee({
        cupId: assignee,
        workspaceId: resolveClaimSpecWorkspace(ident.workspaceId),
        harness: args.harness,
        states: args.states,
        swarmId,
        excludeRedundant,
        rigAvailable: args.rigAvailable,
      });
      const wi = res?.workItem ?? null;
      if (wi && leaseOn) {
        const leased = await leaseClaimedWorkItem({ harness: args.harness, workItemId: wi.id, owner: assignee });
        if (!leased) {
          await releaseWorkItem(wi.id, { harness: args.harness });
          lastLeaseLoss = { id: wi.id };
          return null;
        }
      }
      return res;
    };
    /** One race-free claim (the existing path) incl. the cross-Swarm lease arbitration.
     *  Returns the claimed item, or null when nothing was (or could be) claimed. */
    const claimOne = async () => {
      if (reconciliation.scope?.record.source === 'default') return null;
      if (specOn || reconciliation.scope) {
        return claimViaScheduler();
      }
      const wi = await claimNextWorkItem({
        harness: args.harness,
        assignee,
        kind: args.kind,
        states: args.states,
        swarmId,
        excludeRedundant,
        rigAvailable: args.rigAvailable,
      });
      // P-004 / D-002 (D-007 hybrid), flag-gated default-OFF: once the owner ratifies
      // (the WORKITEM_CLAIM_LEASE flag), the local SKIP-LOCKED claim is arbitrated by
      // the per-Hive authority lease. On a single box this is a no-op (authority = self);
      // cross-Swarm, only one Swarm wins the Hive lease — the loser releases its local
      // claim so the item returns to the backlog (work-stealing across machines).
      if (wi && leaseOn) {
        const leased = await leaseClaimedWorkItem({ harness: args.harness, workItemId: wi.id, owner: assignee });
        if (!leased) {
          await releaseWorkItem(wi.id, { harness: args.harness });
          lastLeaseLoss = { id: wi.id }; // EI-6480: record the arbitration loss for a truthful miss
          return null;
        }
      }
      return wi;
    };

    /** EI-5919: a bare null CONFLATES "queue drained" with "items exist but none are
     *  self-selectable now" (blocked / affinity-elsewhere / redundant / just-claimed). A bee
     *  reading "no claimable work-item" then idles on a FULL-but-blocked backlog (the EI-5803
     *  "fleet saturated with work still queued" signal). On a miss we run a read-only diagnosis
     *  and return a SELF-DESCRIBING result so the caller distinguishes drained (idle is correct)
     *  from pending-but-gated (do NOT idle). Self-select being stricter than a NAMED
     *  work_items:claim(id) is BY DESIGN — the named claim bypasses status/readiness
     *  floors, never a fleet member's authoritative scope boundary. */
    const missResult = async () => {
      if (reconciliation.scope) {
        // EI-13520: distinguish a release-cooldown-only miss from a genuine scope/spec
        // miss — see fleet-scope-admission.ts for the full rationale. Best-effort/fails
        // soft: a diagnosis failure degrades to the original bare fleetScopedMiss.
        const cooldownDiag = await diagnoseFleetScopeCooldownMiss({
          scope: reconciliation.scope,
          harness: args.harness,
          workspaceId: ident.workspaceId ?? undefined,
          states: args.states,
        });
        return fleetScopedMiss(reconciliation.scope, reconciliation.quarantinedIds, {
          cooldownDiag,
          harness: args.harness,
        });
      }
      const diag = await diagnoseClaimNextMiss({
        harness: args.harness,
        assignee,
        kind: args.kind,
        states: args.states,
        swarmId,
        excludeRedundant,
        rigAvailable: args.rigAvailable,
      });
      // EI-6480: a lease-ARBITRATION loss is NOT a peer race. When claimOne claimed a row
      // locally but lost the per-Hive authority lease, the misleading 'retry' hint sent callers
      // into a busy-idle against an item that keeps reading unclaimed until the stale lease is
      // cleaned up (the reaper/issue-requeue lease-cleanup fix) or lapses. Name it truthfully so
      // the miss is DISTINGUISHABLE from a genuine race.
      if (lastLeaseLoss) {
        return {
          ok: false as const,
          error:
            `no claimable work-item RIGHT NOW: you claimed item ${lastLeaseLoss.id} locally but LOST the ` +
            `per-Hive authority-lease ARBITRATION for it (held by another owner's unexpired lease — the ` +
            `EI-6480 stale-lease class). It will keep reading as unclaimed until that lease is cleaned up ` +
            `or lapses, so a blind retry may not help. ${diag.readyUnclaimed} ready / ${diag.pendingUnclaimed} ` +
            `unclaimed pending — NOT a peer race and NOT drained; surface this rather than spin.`,
          drained: diag.drained,
          pendingUnclaimed: diag.pendingUnclaimed,
          readyUnclaimed: diag.readyUnclaimed,
          leaseArbitrationLoss: true as const,
        };
      }
      // EI-14108: a flag-READ failure (fail-closed) must not present as "the flag is off /
      // the issue pool is empty" — say plainly that the read itself failed, distinct from a
      // genuine drained/gated verdict (which the feature-family-only counts below may still
      // legitimately be reporting).
      const flagReadErrorSuffix = diag.flagReadError
        ? ` NOTE: the SCHEDULER_ISSUES_CLAIMABLE flag read FAILED this call (${diag.flagReadError}) — issue-family (bug/change/task) counts above are UNDERCOUNTED (fail-closed, excluded entirely), not necessarily empty.`
        : '';
      const error = diag.drained
        ? 'no claimable work-item: queue DRAINED (no unclaimed work in a claimable state for this harness) — idling is correct' +
          flagReadErrorSuffix
        : `no claimable work-item RIGHT NOW: ${diag.pendingUnclaimed} unclaimed item(s) exist but are gated out of self-select (blocked / affinity-elsewhere / redundant / just-claimed)${diag.readyUnclaimed > 0 ? ` — ${diag.readyUnclaimed} are ready but a peer likely raced you (retry)` : ''}. The queue is NOT drained — do NOT idle; re-check shortly or unblock the backlog.${flagReadErrorSuffix}`;
      return {
        ok: false as const,
        error,
        drained: diag.drained,
        pendingUnclaimed: diag.pendingUnclaimed,
        readyUnclaimed: diag.readyUnclaimed,
      };
    };

    // Claim-time recall port (memory-delivery-unification-2026-07-12 P-008 /
    // D-006): piggyback a targeted memory recall for the just-claimed item(s)
    // — deadline-bounded, epoch-deduped (port 'claim'), never-throws. Dynamic
    // import keeps the memory chain off this module's static graph.
    const recallFor = async (
      witems: Array<{ id?: string; title?: string; summary?: string; harness?: string | null } | null | undefined>,
    ): Promise<string | null> => {
      const items = witems.filter((w): w is NonNullable<typeof w> => w != null);
      if (items.length === 0) return null;
      return import('../../memory/claim-port')
        .then((m) => m.buildClaimRecallBlock({ sessionId: assignee, workspaceId: ident.workspaceId, items }))
        .catch(() => null);
    };
    const wiOf = (
      // `unknown` (not a narrow union): the callers pass the claimOne() result, which is
      // `(GetNextResult & {…}) | WorkItem` — a WorkItem is not assignable to a bare
      // `Record<string, unknown>`, so the narrow param type reddened the operator-core tsc
      // ratchet by 2 (pre-existing, from the 2026-07-12 recallFor addition). The body already
      // narrows defensively (`typeof c === 'object'` + `'workItem' in c`), so `unknown` is safe.
      c: unknown,
      // `payload` included (superset of the memory-port shape) so the same extraction
      // also feeds the plan-decisions port below without a second unwrap.
    ): {
      id?: string;
      title?: string;
      summary?: string;
      harness?: string | null;
      family?: 'feature' | 'issue' | null;
      state?: string | null;
      payload?: unknown;
      sourcePlanSlug?: string | null;
      sourcePlanItemIds?: string[] | null;
    } | null =>
      c && typeof c === 'object'
        ? (('workItem' in c ? (c as { workItem: unknown }).workItem : c) as {
            id?: string;
            title?: string;
            summary?: string;
            harness?: string | null;
            family?: 'feature' | 'issue' | null;
            state?: string | null;
            payload?: unknown;
            sourcePlanSlug?: string | null;
            sourcePlanItemIds?: string[] | null;
          })
        : null;
    // EI-19387745408924340: agent-trap-guards-2026-07-26 P-003b's plan-Decisions brief
    // was wired at scheduler:get_next ONLY — this self-select compatibility wrapper saw
    // no governing decisions either. Same fail-soft seam as the memory recall port above
    // (recallFor); rendered via the shared helper so the note text cannot drift from
    // scheduler:get_next's / work_items:claim's copies.
    const planDecisionsFor = async (
      wi: { payload?: unknown; harness?: string | null } | null,
    ): Promise<{ decisions: unknown; note: string } | null> => {
      if (!wi) return null;
      return import('../../plan-decisions-claim-port')
        .then(async (m) => {
          const brief = await m.getClaimTimePlanDecisions({
            workItem: { payload: wi.payload },
            harness: wi.harness ?? args.harness,
            workspaceId: ident.workspaceId,
          });
          return brief ? { decisions: brief.decisions, note: m.renderPlanDecisionsNote(brief) } : null;
        })
        .catch(() => null);
    };
    const priorAttemptsFor = async (
      wi: {
        id?: string;
        payload?: unknown;
        harness?: string | null;
        sourcePlanSlug?: string | null;
        sourcePlanItemIds?: string[] | null;
      } | null,
    ): Promise<unknown | null> => {
      if (!wi) return null;
      return import('../../prior-attempt-context')
        .then((m) =>
          m.getClaimTimePriorAttemptBrief({
            workItem: wi,
            harness: wi.harness ?? args.harness,
          }),
        )
        .catch(() => null);
    };
    // EI-18733326519945478: claim_next was the remaining claim surface that did
    // not pass the claimed item through the shared premises port. In particular,
    // it could serve an aged proposal citing terminal evidence that explicitly
    // invalidated the proposal's premise with no recheck. Keep this fail-soft and
    // dynamic like the sibling memory/decision ports above.
    // Batch claims share one module load. Besides avoiding N identical loader trips,
    // this makes the fail-soft boundary coherent: either this response can decorate
    // every claimed row, or the one shared import fails and all rows omit the advisory.
    let premisesModulePromise: Promise<typeof import('../../premises-claim-port') | null> | null = null;
    const loadPremisesModule = () => (premisesModulePromise ??= import('../../premises-claim-port').catch(() => null));
    const premisesFor = async (
      wi: {
        id?: string;
        payload?: unknown;
        title?: string;
        summary?: string;
        harness?: string | null;
      } | null,
    ): Promise<{ premises: string[]; note: string } | null> => {
      if (!wi) return null;
      const m = await loadPremisesModule();
      if (!m) return null;
      try {
        const brief = await m.getClaimTimePremises({
          workItem: {
            id: wi.id,
            payload: wi.payload,
            title: wi.title,
            summary: wi.summary,
          },
          harness: wi.harness ?? args.harness,
          workspaceId: ident.workspaceId,
        });
        return brief ? { premises: brief.rendered, note: brief.note } : null;
      } catch {
        return null;
      }
    };

    const authorshipRevalidationFor = async (
      wi: { id?: string; harness?: string | null } | null,
    ): Promise<{ authorshipRevalidation: unknown; authorshipRevalidationWarning: string } | null> => {
      if (!wi?.id) return null;
      try {
        const m = await import('../../work-item-prior-work');
        const authorshipRevalidation = await m.getClaimTimeAuthorshipRevalidationHint({
          harness: wi.harness ?? args.harness,
          workItemId: wi.id,
          workspaceId: ident.workspaceId ?? undefined,
        });
        const authorshipRevalidationWarning = m.authorshipRevalidationWarning(authorshipRevalidation);
        return authorshipRevalidation && authorshipRevalidationWarning
          ? { authorshipRevalidation, authorshipRevalidationWarning }
          : null;
      } catch {
        return null;
      }
    };

    /**
     * WI-41182 / WI-39498 — the plan-says-done contradiction: the linked plan item
     * is already terminal (often annotated "← <this id> completed") while the row
     * just claimed is still open, so the work may already be finished.
     *
     * This was the ONE guard of the six that never reached this surface. It landed
     * at scheduler:get_next and work_items:claim when WI-39498 was fixed; claim_next
     * — a self-select path, i.e. exactly the shape that serves a zombie to whoever
     * asks next — was missed, and nothing caught it because there was no definition
     * of the set to check against. There is now: `CLAIM_TIME_ENRICHMENT_LEGS`, which
     * the parity guard enumerates.
     *
     * Same fail-soft posture as every sibling helper above: a swallowed read omits
     * the hint rather than asserting the item is clean.
     */
    const planContradictionFor = async (
      wi: { id?: string; payload?: unknown } | null,
    ): Promise<{ planItemContradiction: unknown; planItemContradictionWarning: string } | null> => {
      if (!wi?.id) return null;
      try {
        const m = await import('../../work-item-plan-contradiction');
        const hint = await m.getClaimTimePlanItemContradiction({ workItemId: wi.id, payload: wi.payload });
        const warning = m.planItemContradictionWarning(hint, wi.id);
        return hint && warning ? { planItemContradiction: hint, planItemContradictionWarning: warning } : null;
      } catch {
        return null;
      }
    };

    /**
     * P-011: WHICH behavior clauses the claim puts the agent on the hook for, at
     * WHICH revision. Advisory (D-017) — reported, never enforced; P-013 owns any
     * refusal. Delegates to the shared port so what a claimant is told cannot drift
     * from what the completion gate will hold them to, and so this surface satisfies
     * the `behaviorContract` leg the parity guard enumerates.
     *
     * Same fail-soft posture as every sibling helper above: a swallowed read omits
     * the hint rather than asserting the item is on the hook for nothing.
     */
    const behaviorContractFor = async (
      wi: {
        id?: string;
        payload?: unknown;
        harness?: string | null;
        sourcePlanSlug?: string | null;
        sourcePlanItemIds?: string[] | null;
      } | null,
    ): Promise<{ behaviorContract: unknown; behaviorContractNote: string } | null> => {
      if (!wi?.id) return null;
      try {
        const m = await import('../../behavior-contract-claim-port');
        return await m.getClaimTimeBehaviorContract(
          {
            id: wi.id,
            payload: wi.payload,
            harness: wi.harness,
            sourcePlanSlug: wi.sourcePlanSlug,
            sourcePlanItemIds: wi.sourcePlanItemIds,
          },
          wi.harness ?? args.harness,
        );
      } catch {
        return null;
      }
    };

    /**
     * EI-21267393427094356 — which stored payload paths are dead at HEAD, and where each
     * moved to, via the shared stale-path-hints port. Modules relocate while hints freeze
     * at filing time; without this resolution a self-selected claim hands its successor
     * fossilized paths whose literal check fails into a repository-wide fallback search.
     *
     * Same fail-soft posture as every sibling helper above: a swallowed read omits the
     * hint rather than asserting the paths are clean.
     */
    const pathHintsFor = async (
      wi: { id?: string; payload?: unknown; title?: string | null; summary?: string | null } | null,
    ): Promise<import('../../stale-path-hints-claim-port').ClaimTimeStalePathAdvisory | null> => {
      if (!wi?.payload && !wi?.title && !wi?.summary) return null;
      try {
        const m = await import('../../stale-path-hints-claim-port');
        return m.getClaimTimeStalePathAdvisory({ workItem: wi });
      } catch {
        return null;
      }
    };

    /**
     * EI-18713141708830049: the MIRROR of `planContradictionFor` above and deliberately
     * disjoint from it — that one fires when the plan item is already TERMINAL, this one
     * when the plan item is still OPEN but a settled sibling already implements it ("the
     * tree says done"). Both directions are needed because the ledger drifts from the tree
     * in both, and the measured cost of the un-flipped direction is an agent re-running an
     * investigation that a peer already finished — or re-implementing it.
     *
     * Same fail-soft posture as every sibling helper above: a swallowed read omits the
     * hint rather than asserting the item is clean.
     */
    const planItemLandedFor = async (
      wi: {
        id?: string;
        payload?: unknown;
        sourcePlanSlug?: string | null;
        sourcePlanItemIds?: string[] | null;
      } | null,
    ): Promise<{ planItemLanded: unknown; planItemLandedWarning: string } | null> => {
      if (!wi?.id) return null;
      try {
        const m = await import('../../work-item-plan-item-landed');
        const hint = await m.getClaimTimePlanItemLanded({
          workItemId: wi.id,
          payload: wi.payload,
          sourcePlanSlug: wi.sourcePlanSlug,
          sourcePlanItemIds: wi.sourcePlanItemIds,
        });
        const warning = m.planItemLandedWarning(hint, wi.id);
        return hint && warning ? { planItemLanded: hint, planItemLandedWarning: warning } : null;
      } catch {
        return null;
      }
    };

    // EI-19329513980117751: a DIFFERENT work-item shares this one's stored paths and has
    // already landed. Unlike every sibling-finding leg beside it, this one reaches the
    // sibling WITHOUT a plan — the measured duplicate-filing instances are all plan-less,
    // so the plan-linked legs are structurally silent for exactly that population.
    const siblingPathOverlapFor = async (
      wi: { id?: string; payload?: unknown; harness?: string | null } | null,
    ): Promise<{ siblingPathOverlap: unknown; siblingPathOverlapWarning: string } | null> => {
      if (!wi?.id) return null;
      try {
        const m = await import('../../sibling-path-overlap-claim-port');
        const hint = await m.getClaimTimeSiblingPathOverlap({
          workItemId: wi.id,
          payload: wi.payload,
          harness: wi.harness ?? null,
        });
        const warning = m.siblingPathOverlapWarning(hint, wi.id);
        return hint && warning
          ? { siblingPathOverlap: hint, siblingPathOverlapWarning: warning }
          : null;
      } catch {
        return null;
      }
    };

    // EI-19418245218824265: does the TREE already cite this item's own id? Every other
    // leg here reads the ROW, so all of them are silent for an item implemented by an
    // agent who never claimed it — the row is then indistinguishable from never-started.
    // Advisory only: a citation can be a reference rather than an implementation.
    const sourceCitationFor = async (
      wi: { id?: string; harness?: string | null; family?: 'feature' | 'issue' | null } | null,
    ): Promise<{ sourceCitation: unknown; sourceCitationWarning: string } | null> => {
      if (!wi?.id) return null;
      try {
        const m = await import('../../source-citation-claim-port');
        const hint = await m.getClaimTimeSourceCitation({
          workItemId: wi.id,
          workspaceId: ident.workspaceId ?? undefined,
          harness: wi.harness ?? args.harness,
          family: wi.family,
        });
        const warning = m.sourceCitationWarning(hint, wi.id);
        return hint && warning
          ? { sourceCitation: hint, sourceCitationWarning: warning }
          : null;
      } catch {
        return null;
      }
    };

    const count = args.count ?? 1;
    // Backward-compatible single-item shape when count is omitted/1.
    if (count === 1) {
      const claimed = await claimOne();
      if (!claimed) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(await missResult()) }] };
      }
      const base =
        'workItem' in claimed
          ? { ok: true as const, workItem: claimed.workItem, claimedUnder: claimed.claimedUnder }
          : { ok: true as const, workItem: claimed };
      // EI-10541: idle -> working transition — cancel this agent's stale `work-item:claimable`
      // idle-park await(s) (best-effort, see cancelClaimableAwaits). Mutually exclusive with holding a claim.
      await cancelClaimableAwaits(assignee).catch(() => 0);
      const memory = await recallFor([wiOf(claimed)]);
      const [
        planDecisionsResult,
        priorAttemptBrief,
        premisesResult,
        retractionAdvisory,
        authorshipRevalidationResult,
        planContradictionResult,
        behaviorContractResult,
        pathHintsResult,
        planItemLandedResult,
        siblingPathOverlapResult,
        sourceCitationResult,
      ] = await Promise.all([
        planDecisionsFor(wiOf(claimed)),
        priorAttemptsFor(wiOf(claimed)),
        premisesFor(wiOf(claimed)),
        getClaimTimeRetractionAdvisory(wiOf(claimed), args.harness),
        authorshipRevalidationFor(wiOf(claimed)),
        planContradictionFor(wiOf(claimed)),
        behaviorContractFor(wiOf(claimed)),
        pathHintsFor(wiOf(claimed)),
        planItemLandedFor(wiOf(claimed)),
        siblingPathOverlapFor(wiOf(claimed)),
        sourceCitationFor(wiOf(claimed)),
      ]);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ...base,
              ...(memory ? { memory } : {}),
              ...(planDecisionsResult
                ? { planDecisions: planDecisionsResult.decisions, planDecisionsNote: planDecisionsResult.note }
                : {}),
              ...(priorAttemptBrief ? { priorAttemptBrief } : {}),
              ...(premisesResult ? { premises: premisesResult.premises, premisesNote: premisesResult.note } : {}),
              ...(retractionAdvisory ? { retractionWarning: retractionAdvisory.retractionWarning } : {}),
              ...(authorshipRevalidationResult ?? {}),
              ...(planContradictionResult ?? {}),
              ...(behaviorContractResult ?? {}),
              ...(pathHintsResult ?? {}),
              ...(planItemLandedResult ?? {}),
              ...(siblingPathOverlapResult ?? {}),
              ...(sourceCitationResult ?? {}),
            }),
          },
        ],
      };
    }

    // count>1: loop the same atomic claim up to N times, STOPPING at the first miss
    // (queue dry / all leases lost) — each iteration claims a DIFFERENT oldest row
    // (SKIP LOCKED), so this batches a self-select sweep without a double-claim. Returns
    // an array (possibly shorter than `count`, possibly empty).
    const claimed = [];
    for (let i = 0; i < count; i += 1) {
      const res = await claimOne();
      if (!res) break;
      claimed.push('workItem' in res ? { workItem: res.workItem, claimedUnder: res.claimedUnder } : res);
    }
    // EI-5919: on an EMPTY sweep, attach the same drained-vs-pending diagnosis so a batch
    // caller can also distinguish a truly-drained queue from a full-but-gated backlog.
    if (claimed.length === 0) {
      const miss = await missResult();
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...miss, claimed }) }] };
    }
    // EI-10541: claimed >=1 item — cancel this agent's stale `work-item:claimable` idle-park await(s).
    await cancelClaimableAwaits(assignee).catch(() => 0);
    const memory = await recallFor(claimed.map((c) => wiOf(c)));
    // EI-19387745408924340: attach each claimed item's governing plan decisions, same as
    // the single-claim path above — a batch self-select is otherwise the one claim shape
    // that never saw this brief even after the fix, since it doesn't reuse the count===1
    // return branch.
    const claimedWithDecisions = await Promise.all(
      claimed.map(async (c) => {
        const [
          planDecisionsResult,
          priorAttemptBrief,
          premisesResult,
          retractionAdvisory,
          authorshipRevalidationResult,
          planContradictionResult,
          behaviorContractResult,
          pathHintsResult,
          planItemLandedResult,
          siblingPathOverlapResult,
          sourceCitationResult,
        ] = await Promise.all([
          planDecisionsFor(wiOf(c)),
          priorAttemptsFor(wiOf(c)),
          premisesFor(wiOf(c)),
          getClaimTimeRetractionAdvisory(wiOf(c), args.harness),
          authorshipRevalidationFor(wiOf(c)),
          planContradictionFor(wiOf(c)),
          behaviorContractFor(wiOf(c)),
          pathHintsFor(wiOf(c)),
          planItemLandedFor(wiOf(c)),
          siblingPathOverlapFor(wiOf(c)),
          sourceCitationFor(wiOf(c)),
        ]);
        return {
          ...c,
          ...(planDecisionsResult
            ? { planDecisions: planDecisionsResult.decisions, planDecisionsNote: planDecisionsResult.note }
            : {}),
          ...(priorAttemptBrief ? { priorAttemptBrief } : {}),
          ...(premisesResult ? { premises: premisesResult.premises, premisesNote: premisesResult.note } : {}),
          ...(retractionAdvisory ? { retractionWarning: retractionAdvisory.retractionWarning } : {}),
          ...(authorshipRevalidationResult ?? {}),
          ...(planContradictionResult ?? {}),
          ...(behaviorContractResult ?? {}),
          ...(pathHintsResult ?? {}),
          ...(planItemLandedResult ?? {}),
          ...(siblingPathOverlapResult ?? {}),
          ...(sourceCitationResult ?? {}),
        };
      }),
    );
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            memory ? { ok: true, claimed: claimedWithDecisions, memory } : { ok: true, claimed: claimedWithDecisions },
          ),
        },
      ],
    };
  },
});
