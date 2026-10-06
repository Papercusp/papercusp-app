/**
 * work_items:amend — record a non-re-derivable structural decision on a plan-run node
 * durably, in ONE low-friction call (plan-implementation-framework-2026-06-15 P-004;
 * flag papercusp-workitem-amend). The Queen/operator DISPOSES; an executing bee
 * PROPOSES (propose/dispose, D-005). A disruptive amend (drop / re-approach) on a node
 * a worker is mid-execution on is flagged NEEDS-COMPENSATION — never silently yanked
 * (D-007 / the dynamism guard). The durable write IS the commit-before-dispatch record
 * (D-001): call this BEFORE dispatching the dependent work the amendment implies.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { getWorkItem, commentWorkItem } from '../../work-items';
import { buildAmendment, renderAmendment, AMENDMENT_KINDS, type AmendmentKind } from './build-amendment';

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

export default defineTool({
  name: 'work_items:amend',
  profile: 'engineer',
  description:
    'Record a structural decision on a plan-run node (split | drop | reapproach | expand | note) durably, in one call. The steerer (operator / su / the fleet leader) disposes; the agent executing the node proposes. A disruptive amend on an in-flight node is flagged NEEDS-COMPENSATION (coordinate, never silently yank). The record is the commit-before-dispatch truth — amend BEFORE dispatching the dependent work.',
  guidance: {
    when: 'You are making (or, as a cup, PROPOSING) a non-re-derivable structural change to a plan-run node — split it, drop/re-approach the approach, expand a deferred region. Record it here in ONE call before dispatching the dependent work; the durable record is the resumable truth.',
    notWhen:
      'A routine progress update / finding → work_items:comment. Re-prioritizing the frontier (re-derivable, costs nothing to lose) → no amend needed. Finishing a node → work_items:complete / set_state.',
    chaining:
      'work_items:get → work_items:amend { id, kind, rationale }. The executing agent PROPOSES (disposition=proposed); a steerer DISPOSES. requiresCompensation=true ⇒ a worker is mid-execution on the node — coordinate (coord:send) before/with the change.',
    // EI-21307426619986295: re-parenting a completed duplicate under the item that
    // supersedes it is a structural change to the graph, so amend is a reasonable first
    // guess — but amend RECORDS a decision about a node and never edits a field, and its
    // four-key schema could only answer with what it accepts. The distinction is the
    // whole point of the verb, so the fix is to name the field writer, not widen amend.
    argRedirects: {
      parent: {
        tool: 'work_items:update',
        args: { id: '<work-item-id>', parent: '<parent-work-item-id>' },
        note: 'amend records a structural DECISION about a node (split | drop | reapproach | expand | note) and edits no fields. The parent edge is a field: work_items:update writes it, and `parent: null` there clears it. Record the reasoning as an amend `note` if it is worth keeping.',
      },
    },
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).describe('the work_item id to amend'),
    kind: z
      .enum([...AMENDMENT_KINDS] as [string, ...string[]])
      .describe('the structural decision kind: split | drop | reapproach | expand | note'),
    rationale: hardText(LIMITS.ANNOTATION)
      .describe('why — the non-re-derivable decision (recorded durably; this is the resumable truth)'),
    harness: z.string().max(80).optional(),
  }),
  async handler(args, ctx) {
    // Flag gate (P-004 default OFF). A new additive tool: off ⇒ it simply declines.
    if (!(await getFlag(FLAGS.WORKITEM_AMEND, 'system').catch(() => false))) {
      return json({ ok: false, disabled: true, reason: 'work_items:amend is behind the papercusp-workitem-amend flag (currently off)' });
    }
    const ident = resolveAgentIdentity(ctx);
    const wi = await getWorkItem(args.id, args.harness);
    if (!wi) return json({ ok: false, error: `work_item '${args.id}' not found` });

    // Single-writer / propose-dispose: a bee PROPOSES, every steerer (queen / operator /
    // su) DISPOSES. (The home-pubkey refinement — only the HOME queen among many disposes
    // — rides the existing queen-guard.evaluateMugTurnGate seam when multi-Queen
    // single-writer is enforced; within one hive there is one steerer, so role suffices.)
    const role = (ctx as { role?: string }).role ?? '';
    const authoritative = role !== 'cup';
    const claimedByOther = !!wi.assignee && wi.assignee !== ident.ownerId;

    const rec = buildAmendment(
      { kind: args.kind as AmendmentKind, rationale: args.rationale, by: ident.ownerId },
      { targetState: wi.state, authoritative, claimedByOther },
    );
    // Durable, single-call write onto the node's thread (notifies its subscribers — the
    // assignee bee sees a NEEDS-COMPENSATION amend on the node it is executing).
    const post = await commentWorkItem(args.id, renderAmendment(rec), ident.ownerId, {
      harness: args.harness ?? wi.harness ?? undefined,
      writerOwnerId: ident.ownerId,
    });
    return json({ ok: true, amendment: rec, recorded: !!post });
  },
});
