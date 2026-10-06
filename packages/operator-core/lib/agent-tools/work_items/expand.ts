/**
 * work_items:expand — emit child work_items from a deferred-expansion node, in one call
 * (plan-implementation-framework-2026-06-15 P-005; flag papercusp-deferred-expansion). The
 * record starts shallow and self-elaborates: a node reaches the point of best context, and
 * the executing bee PROPOSES children / the Queen DISPOSES them (created). Each child carries
 * payload.expanded_from = parent id (durable parentage; no migration). Reuses createWorkItem.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { getWorkItem, createWorkItem, commentWorkItem, isSettledWorkItemState } from '../../work-items';
import { planExpansion, renderExpansion } from './plan-expansion';
import { hardText, LIMITS } from '../limits';

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

export default defineTool({
  name: 'work_items:expand',
  profile: 'engineer',
  description:
    'Expand a deferred-expansion node into child work_items in one call. The Mug/operator DISPOSES (children are created); a bee PROPOSES (recorded, the steerer ratifies). Each child carries payload.expanded_from = the parent id. Lets a plan-run start shallow and self-elaborate at the point of best context.',
  guidance: {
    when: 'You have reached an "expand-here" node (or any node) that should now fan out into concrete child work_items — the decomposition you deferred until you had the context to make it well.',
    notWhen:
      'A flat structural note / re-approach → work_items:amend. A single follow-up → just create/convert one work_item. Re-prioritizing existing nodes → no expansion.',
    chaining:
      'work_items:get → work_items:expand { id, children:[{title, files?, brief?}] }. A bee PROPOSES (disposition=proposed, nothing created yet); the Mug DISPOSES (children created with payload.expanded_from = parent).',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).describe('the parent (expand-here) work_item id'),
    children: z
      .array(
        z.object({
          title: hardText(LIMITS.SHORT_TITLE),
          summary: hardText(LIMITS.ANNOTATION).optional(),
          files: z.array(z.string()).max(50).optional().describe('declared file touch-set (feeds P-002 exclusion)'),
          brief: hardText(LIMITS.BRIEF).optional(),
        }),
      )
      .min(1)
      .max(20)
      .describe('the child nodes to emit'),
    harness: z.string().max(80).optional(),
    force: z
      .boolean()
      .optional()
      .describe(
        'WI-1400: override the two default-on safety guards for a DELIBERATE re-decomposition — ' +
          '(1) expanding an already-SETTLED parent (passed/deprecated/resolved/closed), and ' +
          '(2) cross-call dedup (re-expanding the same child title(s) already expanded from this parent in a prior call). ' +
          'Default false: both guards apply.',
      ),
  }),
  async handler(args, ctx) {
    if (!(await getFlag(FLAGS.DEFERRED_EXPANSION, 'system').catch(() => false))) {
      return json({ ok: false, disabled: true, reason: 'work_items:expand is behind the papercusp-deferred-expansion flag (currently off)' });
    }
    const ident = resolveAgentIdentity(ctx);
    const parent = await getWorkItem(args.id, args.harness);
    if (!parent) return json({ ok: false, error: `work_item '${args.id}' not found` });

    // WI-1400 guard 1: fail closed on a settled parent by default — expanding a
    // passed/deprecated/resolved/closed parent risks orphaned child work with no live
    // parent tracking it. `force:true` is the explicit escape hatch for a deliberate
    // re-decomposition of already-settled work.
    if (isSettledWorkItemState(parent.state) && !args.force) {
      return json({
        ok: false,
        error:
          `parent work_item '${args.id}' is already settled (state=${parent.state}) — refusing to expand it. ` +
          'Pass force:true if this is a deliberate re-decomposition of settled work.',
        settledState: parent.state,
      });
    }

    // WI-1400 guard 2: cross-call idempotency. Look up titles ALREADY expanded from this
    // parent (children always land as kind:'task' in engineer_issues, stamped
    // payload.expanded_from) so a retried/duplicate call doesn't silently double-create.
    // Skipped entirely under force:true (the caller wants the duplicate).
    let existingChildTitles: Set<string> | undefined;
    if (!args.force) {
      const { sql } = getOrgPg();
      const rows = await sql<{ title: string }[]>`
        SELECT title FROM harness_shared.engineer_issues
         WHERE payload ->> 'expanded_from' = ${args.id}`;
      existingChildTitles = new Set(rows.map((r) => r.title.toLowerCase()));
    }

    // Propose/dispose: a bee PROPOSES, every steerer (queen / operator / su) DISPOSES.
    const role = (ctx as { role?: string }).role ?? '';
    const authoritative = role !== 'cup';

    const plan = planExpansion({
      parentId: args.id,
      parentHarness: args.harness ?? parent.harness ?? null,
      children: args.children,
      by: ident.ownerId,
      authoritative,
      existingChildTitles,
    });

    // Durable record on the parent's thread either way (the proposal, or the disposed set).
    await commentWorkItem(args.id, renderExpansion(plan), ident.ownerId, {
      harness: args.harness ?? parent.harness ?? undefined,
      writerOwnerId: ident.ownerId,
    });

    if (plan.disposition === 'proposed') {
      return json({ ok: true, disposition: 'proposed', proposed: plan.children.map((c) => c.title), dropped: plan.dropped });
    }

    // Disposed: create the children (reusing createWorkItem; payload.expanded_from is the link).
    const created: string[] = [];
    for (const c of plan.children) {
      const child = await createWorkItem({
        kind: c.kind,
        title: c.title,
        summary: c.summary,
        harness: c.harness ?? undefined,
        parent: c.parent,
        payload: c.payload,
        createdBy: ident.ownerId,
      });
      created.push(child.id);
    }
    return json({ ok: true, disposition: 'disposed', created, dropped: plan.dropped });
  },
});
