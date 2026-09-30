/**
 * plan_items:assign — push-assign a plan item to a stable agent-NAME (D-002/D-005).
 *
 * Intra-user push only: you assign to a name YOU own (your tokens). Assigning to a
 * fresh name claims it for you; assigning to a name owned by ANOTHER user is refused
 * (cross-user is pull-only — they claim from the pool). The assignment is durable
 * (survives sleep/interrupt) and federates as content.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): assign ONE inline
 * ({ plan, item, assignee, … }), MANY in the SAME plan to the SAME assignee
 * ({ plan, itemIds:[…], assignee }), or MANY heterogeneous
 * (items:[{ plan, item, assignee, … }]) → { ok, results:[{ ok, plan, item,
 * assignment? | refused | error }], counts }. Each result self-describes its
 * { plan, item }; one refusal/error never fails the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePlanScope } from '../plans/source';
import { bestEffortOwnerUser, agentNameOwner, registerAgentName } from '../../plan-items/agent-names';
import { assignItem, planItemEffectiveStatus } from '../../plan-items/assignments';
import { isTerminalStatus } from '../plans/set-status';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import { softText, clampText, LIMITS } from '../limits';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveStableAgentTarget } from '../coordination/actionable-work-item-dispatch';
import {
  admitSubjectForFleetTarget,
  admitWorkItemForFleetTarget,
  notifyFleetScopeRefusal,
  fleetScopeLeaderRemedy,
} from '../../scheduler/fleet-scope-admission';
import { findImplementingWorkItem } from '../../plan-items/convert';

interface AssignSpecItem {
  plan: string;
  item: string;
  assignee: string;
  harness?: string;
  strategy?: string;
  note?: string;
}

const itemSpec = z.object({
  plan: z.string().min(1).describe('plan slug'),
  item: z.string().min(1).describe('plan-item id (P-NNN)'),
  assignee: z.string().min(1).max(80).describe('the agent-name to assign to'),
  harness: z.string().max(120).optional().describe('per-item harness (else the batch `harness` default)'),
  strategy: z.string().max(200).optional().describe('optional execution-strategy/blueprint hint'),
  note: softText(LIMITS.ANNOTATION).optional(),
});

export default defineTool({
  name: 'plan_items:assign',
  description:
    'Push-assign one OR many plan items to a stable agent-NAME. Durable intent survives interruption. If the name resolves to a fleet MEMBER, the plan/item must match its per-member/inherited claim spec or assignment is refused before mutation and its leader is alerted. Intra-user only; cross-user is pull-only. Supports one, itemIds:[…], or heterogeneous items:[…] and returns per-item outcomes.',
  guidance: {
    when: 'You are dividing your own plan work across your named agents — "builder-1 takes P-001..P-003". Assign several at once via itemIds:[…] or items:[…].',
    notWhen: 'You want to start working on an item right now — that is plan_items:claim (the live grip). Handing work to another USER\'s agents — they pull it (you cannot push onto their machine).',
    chaining: 'plan_items:assign { harness, plan, item, assignee } → the named agent: plan_items:my_items → plan_items:claim.',
    seeAlso: [
      'plan_items:unassign (undo an assignment)',
      'plan_items:status (see current assignments)',
      'plan_items:my_items (what the assignee sees)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      plan: z.string().min(1).optional().describe('plan slug (use with `item` / `itemIds`)'),
      item: z.string().min(1).optional().describe('single-assign shorthand: the plan-item id (P-NNN)'),
      assignee: z.string().min(1).max(80).optional().describe('the agent-name to assign to (the inline item / every id in `itemIds`)'),
      itemIds: z.array(z.string().min(1)).min(1).max(200).optional().describe('assign MANY items in `plan` to the same `assignee` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('assign many plan items at once — each { plan, item, assignee, harness?, strategy?, note? }'),
      harness: z.string().max(120).optional().describe('default harness for the inline item / itemIds / items that omit one (default: papercup)'),
      strategy: z.string().max(200).optional().describe('optional execution-strategy/blueprint hint (the inline item / every id in `itemIds`)'),
      note: softText(LIMITS.ANNOTATION).optional().describe('note for the inline item / every id in `itemIds`. Auto-truncated to 2000 chars if longer.'),
    })
    .refine(
      (a) =>
        (a.items?.length ?? 0) > 0 ||
        (Boolean(a.plan) && Boolean(a.assignee) && ((a.itemIds?.length ?? 0) > 0 || Boolean(a.item))),
      {
        message:
          'pass { plan, item, assignee } for one, { plan, itemIds:[…], assignee } for many of the same plan, or items:[{ plan, item, assignee }] for many',
      },
    ),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const ownerUser = bestEffortOwnerUser(ctx);
    const list: AssignSpecItem[] = args.items?.length
      ? args.items.map((it) => ({
          plan: it.plan,
          item: it.item,
          assignee: it.assignee,
          harness: it.harness ?? args.harness,
          strategy: it.strategy ?? args.strategy,
          note: it.note ?? args.note,
        }))
      : args.itemIds?.length
        ? args.itemIds.map((item) => ({
            plan: args.plan as string,
            item,
            assignee: args.assignee as string,
            harness: args.harness,
            strategy: args.strategy,
            note: args.note,
          }))
        : [
            {
              plan: args.plan as string,
              item: args.item as string,
              assignee: args.assignee as string,
              harness: args.harness,
              strategy: args.strategy,
              note: args.note,
            },
          ];
    const env = await runBulk(
      list,
      async (it): Promise<BulkItemResult> => {
        const { workspaceId, harnessSlug } = await resolvePlanScope({ harnessSlug: it.harness });
        let admission = await admitSubjectForFleetTarget({
          target: it.assignee,
          workspaceId,
          subject: {
            id: null,
            title: null,
            summary: null,
            // Plan-item assignment is the pre-promotion feature lane. A bug-only
            // or fixed-id member therefore refuses it; a plan-scoped feature fleet
            // admits it through its plan/plan_item leaves.
            kind: 'feature',
            priority: null,
            tags: [],
            paths: [],
            plan: it.plan,
            planItem: [it.item],
            fleet: null,
            triageGate: null,
            age: Date.now(),
            riskTier: null,
            redundancy: null,
            estCost: null,
            assignee: it.assignee,
            // WI-6675: plan-item assignment is the feature-family pre-promotion lane —
            // features carry no severity, so this subject always reports null (matches
            // work_items/create.ts's feature-family construction).
            severity: null,
            // WI-37711: plan-item assignment happens pre-promotion, before any work-item
            // row (and so before any goal stamp) exists — there is nothing to read here.
            // Same fail-closed direction as work_items/create.ts's construction.
            goal: null,
          },
        });
        // A converted plan item is represented by a plan-item subject before
        // promotion, but its target's claim spec may be exact-work-item keyed.
        // Re-check that linked execution record by its canonical ID so an
        // in-scope assignment is not rejected merely because the pre-promotion
        // subject has no matching `id`.
        //
        // Deliberately keep this fallback narrow and fail closed: only a
        // fleet-scope violation can be repaired by proving the linked row is in
        // scope. Missing links, lookup/admission errors, by-ID refusals, and
        // other refusal codes retain the original decision.
        if (!admission.allowed && admission.code === 'fleet_scope_violation') {
          try {
            const linkedWorkItem = await findImplementingWorkItem(it.plan, it.item);
            if (linkedWorkItem) {
              const linkedAdmission = await admitWorkItemForFleetTarget({
                target: it.assignee,
                workItemId: linkedWorkItem.id,
                harness: linkedWorkItem.harness ?? harnessSlug,
                workspaceId,
              });
              if (linkedAdmission.allowed) admission = linkedAdmission;
            }
          } catch {
            // The original plan-item refusal is the safe result when the
            // optional link lookup or re-admission cannot be established.
          }
        }
        if (!admission.allowed) {
          // WI-6326: reuse the SAME liveness read the leader notification just performed
          // (never a second lookup) so the caller-facing refusal's "route elsewhere"
          // advice is code-conditional too.
          const { liveRouteTarget } =
            (await notifyFleetScopeRefusal(identity, admission, `plan_items:assign ${it.plan}#${it.item} → ${it.assignee}`, {
              // EI-18680302159738037: `<plan>#<item>` is a real addressable id, so this
              // block can be listed in fleet:leader-brief like a work-item one.
              subject: { itemId: `${it.plan}#${it.item}`, member: it.assignee },
            })) ?? {};
          return {
            ok: false,
            plan: it.plan,
            item: it.item,
            // EI-18673501896258575: same concrete remedy already sent to the fleet leader
            // (via notifyFleetScopeRefusal) — echoed to the caller so they see the exact
            // scheduler:set_claim_spec shape instead of only a bare refusal reason.
            refused: `${admission.code}: ${admission.reason} ${fleetScopeLeaderRemedy(admission, liveRouteTarget)}`,
          };
        }
        const existingOwner = await agentNameOwner(workspaceId, it.assignee);
        if (existingOwner && existingOwner !== ownerUser) {
          return {
            ok: false,
            plan: it.plan,
            item: it.item,
            refused: `agent-name '${it.assignee}' is owned by another user — cross-user assignment is pull-only (D-005). They join the work-group and claim it.`,
          };
        }
        // EI-2140304: coord:dispatch may pass a raw ownerId when its target
        // has no stable-name handle. That spelling used to bypass both the
        // stable-name ownership guard and liveness check, so a foreign or
        // already-ended session could receive a durable assignment that no
        // process would ever pick up. Only apply this guard when the targeted
        // presence row proves the input is the exact ownerId; an absent target
        // remains eligible as a fresh stable name (or a just-starting session).
        const target = await resolveStableAgentTarget({
          targetAgent: it.assignee,
          workspaceId,
          harness: harnessSlug,
        });
        const isExactRawOwnerId = target.present && target.ownerId === it.assignee;
        if (isExactRawOwnerId && target.sessionState === 'ended') {
          return {
            ok: false,
            plan: it.plan,
            item: it.item,
            refused:
              `agent target '${it.assignee}' resolves to ended session '${target.ownerId}' ` +
              '(sessionState=ended) — assignment would strand the plan item; relaunch/resume ' +
              'the target or use a live/parked agent.',
          };
        }
        if (isExactRawOwnerId) {
          // Presence userId is the stronger power-user ownership signal. For
          // superuser sessions it is null, so the best-effort ownerId fallback
          // preserves the existing single-user identity contract.
          const targetOwnerUser = target.userId ?? target.ownerId;
          if (targetOwnerUser !== ownerUser) {
            return {
              ok: false,
              plan: it.plan,
              item: it.item,
              refused:
                `agent target '${it.assignee}' resolves to ownerId '${target.ownerId}' ` +
                `owned by another user ('${targetOwnerUser}') — cross-user assignment is ` +
                'pull-only (D-005). They join the work-group and claim it.',
            };
          }
        }
        // EI-2295 (push-assign leg): never (re)assign an ALREADY-TERMINAL plan item.
        // Re-assigning a done/dropped item is a no-op whose only effect is a stale
        // wake — the dead-dispatch class this issue is about. FAIL-OPEN: an
        // undeterminable status (null) never blocks a legitimate assign.
        const effStatus = await planItemEffectiveStatus(harnessSlug, it.plan, it.item);
        if (effStatus && isTerminalStatus(effStatus)) {
          return {
            ok: false,
            plan: it.plan,
            item: it.item,
            refused: `plan item ${it.item} is already ${effStatus} (terminal) — not (re)assigning. Flip it off-terminal (plans:set-status) first to reopen it.`,
          };
        }
        if (!existingOwner) await registerAgentName(workspaceId, it.assignee, ownerUser);
        const assignment = await assignItem({
          workspaceId,
          harnessSlug,
          planSlug: it.plan,
          itemId: it.item,
          assigneeName: it.assignee,
          assignedByUser: ownerUser,
          strategy: it.strategy ?? null,
          note: clampText(it.note, LIMITS.ANNOTATION) ?? null,
        });
        return { ok: true, plan: it.plan, item: it.item, assignment };
      },
      { keyOf: (it) => ({ plan: it.plan, item: it.item }) },
    );
    return bulkContent(env);
  },
});
