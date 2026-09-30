/**
 * plan_items:convert — convert-at-pickup (project-centric-harness-rethink D-015).
 *
 * "Working a plan item = convert it to a work_item first — no untracked
 * self-item." This is THE pickup verb: one call takes the policy-checked
 * plan-item lease, mints (or resumes) the work_item execution record with the
 * caller as assignee, and links it back to the plan item. The plan-item status
 * flip (todo→wip) and the claim broadcast both ride `emits:` — and the
 * work_item's later lifecycle reflects back onto the plan item via
 * ../../plan-items/reflect-rules.ts (complete→done, release→todo).
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): convert ONE inline
 * ({ plan, item, … }), MANY in the SAME plan ({ plan, itemIds:[…] }), or MANY
 * heterogeneous (items:[{ plan, item, kind?, title?, brief?, … }]) → { ok,
 * results:[{ ok, plan, item, status, workItem?, planItem?, … }], counts }. Each
 * result self-describes its { plan, item }; a refused/conflicted convert is that
 * item's ok:false without failing the rest. The pickup broadcast + todo→wip flip
 * `emits:` fire off the FIRST converted result (the single-item pickup case the
 * TUI + agents use); each result carries the same convert payload the single call
 * always returned.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePlanScope } from '../plans/source';
import { bestEffortOwnerUser, resolveAdoptedName } from '../../plan-items/agent-names';
import { convertPlanItem, type ConvertPlanItemResult } from '../../plan-items/convert';
import { WORK_ITEM_KINDS, isDeprecatedWorkItemKind, type WorkItemKind } from '../../work-items';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import type { LivenessMode } from '../../plan-items/claims';
import { hardText, softText, clampText, LIMITS } from '../limits';

/** The flattened success payload the emits rules read off the event. */
interface ConvertEventData {
  ok: boolean;
  status?: string;
  workItem?: { id?: string; harness?: string | null };
  planItem?: { plan?: string; item?: string; status?: string | null };
  /** EI-7189: set when the item's prior (just-lapsed) claim holder still looks alive. */
  priorHolderWarning?: { owner: string; ownerLabel: string | null; sessionState: string };
}

/**
 * The convert tool returns the bulk envelope `{ ok, results, counts }`. The emits
 * rules (pickup broadcast + todo→wip flip) target the FIRST result — the
 * single-item pickup the TUI + agents drive. Dig that result out so the rules read
 * the same flat `{ ok, status, workItem, planItem }` shape they always did.
 */
function dataOf(e: { result?: { data?: unknown } }): ConvertEventData {
  const data = e.result?.data as { results?: unknown[] } | ConvertEventData | undefined;
  const first =
    data && typeof data === 'object' && Array.isArray((data as { results?: unknown[] }).results)
      ? ((data as { results?: unknown[] }).results![0] as ConvertEventData | undefined)
      : (data as ConvertEventData | undefined);
  return (first ?? {}) as ConvertEventData;
}

interface ConvertSpecItem {
  plan: string;
  item: string;
  harness?: string;
  kind?: string;
  title?: string;
  brief?: string;
  intent?: string;
  mode?: LivenessMode;
  ttl_sec?: number;
}

const CREATABLE_WORK_ITEM_KINDS = WORK_ITEM_KINDS.filter((kind) => !isDeprecatedWorkItemKind(kind));
const KIND = z.enum([...CREATABLE_WORK_ITEM_KINDS] as [string, ...string[]]);

const itemSpec = z.object({
  plan: z.string().min(1).describe('plan slug'),
  item: z.string().min(1).describe('plan-item id (P-NNN)'),
  harness: z.string().max(120).optional().describe('per-item harness (else the batch `harness` default)'),
  kind: KIND.optional().describe("work_item kind to mint (default 'task')"),
  title: hardText(LIMITS.SHORT_TITLE).optional().describe('override the work-item title'),
  brief: softText(LIMITS.BRIEF).optional().describe(`per-lane situational overlay persisted on the work-item's payload.brief. Auto-truncated to ${LIMITS.BRIEF} chars if longer.`),
  intent: hardText(LIMITS.SHORT_TITLE).optional().describe('one line on what you are doing'),
  mode: z.enum(['availability', 'activity']).optional().describe('force the lease liveness mode'),
  ttl_sec: z.number().int().positive().max(7200).optional().describe('lease TTL seconds'),
});

export default defineTool({
  name: 'plan_items:convert',
  description:
    'Convert-at-pickup (D-015): pick up one OR many plan items by converting each to a work_item in one call — takes the policy-checked plan-item lease, mints (or idempotently resumes) the work_item with you as assignee, links it back (`implements` edge + payload stamp), and auto-flips the plan item to wip. Single: { plan, item }. Many same plan: { plan, itemIds:[…] }. Many heterogeneous: items:[{ plan, item, kind?, title?, brief?, … }]. Returns { ok, results:[{ ok, plan, item, status, workItem?, planItem? }], counts } — correlate by { plan, item }; a refused/conflicted convert is that item\'s ok:false without failing the rest. The work_item is then your execution record: work_items:complete on it reflects the plan item to done.',
  guidance: {
    when: 'You are picking up plan item(s) to work them — this replaces a bare plan_items:claim: every worked item gets a tracked work_item (no untracked self-item). Pick up several at once via itemIds:[…] or items:[…].',
    notWhen:
      'You only want the lease without an execution record (rare; plan_items:claim). The item is already converted and you hold it — just keep working; re-converting is a harmless resume.',
    chaining:
      'plans:items { actionable:true } → plan_items:convert { plan, item } → work → work_items:complete { id, completion } (reflects the plan item to done) or work_items:release (returns it to todo).',
    seeAlso: [
      'work_items:complete (reflect the converted item to done)',
      'work_items:release (return it to todo)',
      'plans:set-status (flip the plan item directly instead of converting)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  emits: [
    // Pickup broadcast (lifecycle claim category — peers see "taking X" without prose).
    {
      fire: 'coord:emit',
      when: (e) => {
        const d = dataOf(e);
        return d.ok === true && Boolean(d.workItem?.id);
      },
      render: (e) => {
        const d = dataOf(e);
        const verb = d.status === 'resumed' ? 'resumed' : 'converted →';
        // EI-7189: when the item's prior claim just lapsed but its owner still looks
        // alive, surface that in the PICKUP BROADCAST itself — not just the caller's
        // own tool result — so the (possibly still-working) prior holder sees the
        // heads-up fleet-wide, the same channel that caught the WI-2086 collision.
        const warn = d.priorHolderWarning
          ? ` ⚠️ prior holder '${d.priorHolderWarning.ownerLabel ?? d.priorHolderWarning.owner}' still ${d.priorHolderWarning.sessionState} — coordinate before continuing`
          : '';
        return {
          category: 'claim',
          summary: `⛏ ${d.planItem?.plan}#${d.planItem?.item} ${verb} ${d.workItem?.id} — picked up${
            e.ctx.uiClientId ? ` (${e.ctx.uiClientId})` : ''
          }${warn}`,
          ...(d.planItem?.plan ? { plan_slug: d.planItem.plan } : {}),
          to: ['*'],
        };
      },
    },
    // Pickup flips the plan item todo → wip (through the real plans:set-status,
    // so the flip gets the plan lock + revision + plan-event for free).
    {
      fire: 'plans:set-status',
      when: (e) => {
        const d = dataOf(e);
        return (
          d.ok === true &&
          Boolean(d.workItem?.id) &&
          d.planItem?.status === 'todo' &&
          typeof d.planItem?.item === 'string' &&
          /^P-\d{3,}$/.test(d.planItem.item)
        );
      },
      render: (e) => {
        const d = dataOf(e);
        const a = e.args as { harness?: string };
        return {
          harness: a.harness ?? 'all',
          slug: d.planItem!.plan,
          item: d.planItem!.item,
          status: 'wip',
          note: `→ ${d.workItem!.id}`,
        };
      },
    },
  ],
  args: z
    .object({
      plan: z.string().min(1).optional().describe('plan slug (use with `item` / `itemIds`)'),
      item: z.string().min(1).optional().describe('single-convert shorthand: the plan-item id (P-NNN)'),
      kind: KIND.optional().describe(
        "work_item kind to mint (default 'task' — the generic execution record; pick feature/bug/… when the item warrants a pipeline-shaped unit); the inline item / every id in `itemIds`",
      ),
      title: hardText(LIMITS.SHORT_TITLE).optional().describe('override the work-item title (default: the plan-item text); the inline item / itemIds'),
      brief: softText(LIMITS.BRIEF)
        .optional()
        .describe(
          `per-lane situational overlay persisted on the work-item's payload.brief — the context the placed bee is MISSING, not a restatement of the item (queen-wave-dispatch P-021; carried from a \`## Promote\` lane's brief: field); the inline item / itemIds. Auto-truncated to ${LIMITS.BRIEF} chars if longer.`,
        ),
      intent: hardText(LIMITS.SHORT_TITLE).optional().describe('one line on what you are doing (the inline item / itemIds)'),
      mode: z
        .enum(['availability', 'activity'])
        .optional()
        .describe('force the lease liveness mode (default: resolved from the harness); the inline item / itemIds'),
      ttl_sec: z.number().int().positive().max(7200).optional().describe('lease TTL seconds (the inline item / itemIds)'),
      itemIds: z.array(z.string().min(1)).min(1).max(200).optional().describe('convert MANY items in `plan` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('convert many plan items at once — each { plan, item, kind?, title?, brief?, intent?, mode?, ttl_sec?, harness? }'),
      harness: z.string().max(120).optional().describe('default harness for the inline item / itemIds / items that omit one (default: papercup)'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.plan) && ((a.itemIds?.length ?? 0) > 0 || Boolean(a.item))), {
      message: 'pass { plan, item } for one, { plan, itemIds:[…] } for many of the same plan, or items:[{ plan, item }] for many',
    }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const ownerUser = bestEffortOwnerUser(ctx);
    // P-003 compiled-briefs: when on, convert compiles payload.brief from plan
    // context if the caller didn't supply one. Fail-safe to off (no compilation).
    // Read ONCE for the whole batch (SYNC at the tool layer — keeps the core flag-mock-free).
    const compileBriefIfMissing = await getFlag(FLAGS.COMPILED_BRIEFS, 'system').catch(() => false);

    const list: ConvertSpecItem[] = args.items?.length
      ? args.items.map((it) => ({
          plan: it.plan,
          item: it.item,
          harness: it.harness ?? args.harness,
          kind: it.kind ?? args.kind,
          title: it.title ?? args.title,
          brief: it.brief ?? args.brief,
          intent: it.intent ?? args.intent,
          mode: it.mode ?? args.mode,
          ttl_sec: it.ttl_sec ?? args.ttl_sec,
        }))
      : args.itemIds?.length
        ? args.itemIds.map((item) => ({
            plan: args.plan as string,
            item,
            harness: args.harness,
            kind: args.kind,
            title: args.title,
            brief: args.brief,
            intent: args.intent,
            mode: args.mode,
            ttl_sec: args.ttl_sec,
          }))
        : [
            {
              plan: args.plan as string,
              item: args.item as string,
              harness: args.harness,
              kind: args.kind,
              title: args.title,
              brief: args.brief,
              intent: args.intent,
              mode: args.mode,
              ttl_sec: args.ttl_sec,
            },
          ];

    const env = await runBulk(
      list,
      async (it): Promise<BulkItemResult> => {
        const { workspaceId, harnessSlug } = await resolvePlanScope({ harnessSlug: it.harness });
        const ownerName = await resolveAdoptedName(workspaceId, id.ownerId);
        const result: ConvertPlanItemResult = await convertPlanItem({
          workspaceId,
          harnessSlug,
          planSlug: it.plan,
          itemId: it.item,
          kind: it.kind as WorkItemKind | undefined,
          title: it.title,
          brief: clampText(it.brief, LIMITS.ANNOTATION),
          compileBriefIfMissing,
          owner: id.ownerId,
          ownerLabel: id.ownerLabel,
          ownerName,
          ownerUser,
          intent: it.intent,
          livenessMode: it.mode,
          ttlSec: it.ttl_sec,
        });
        const ok = result.status === 'converted' || result.status === 'resumed';
        // Flattened so the emits rules (and callers) read fields off one result object.
        return { ok, plan: it.plan, item: it.item, ...result };
      },
      { keyOf: (it) => ({ plan: it.plan, item: it.item }) },
    );
    return bulkContent(env);
  },
});
