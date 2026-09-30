/**
 * improvements:filing-classes — per-surface CLASS aggregation over the ungraded filing
 * population (agent-review-filing-rail-and-class-aggregation-2026-09-05, P-002).
 *
 * The population had no consumer that could see it in aggregate. Measured 2026-09-05:
 * 911 ungraded `agent-review` filings, 215 carrying a structured `toolFailure` report,
 * and 24 surfaces holding three or more of them — so one defect class was arriving as N
 * instance nits, each costing its own triage decision. An agent cannot fix that by
 * "filing the class instead": no agent is ever holding the aggregate. This tool is.
 *
 * ADDITIVE BY CONSTRUCTION (D-001). `mode:'file'` creates ONE new work-item that CITES
 * its members with `relates` edges. It never merges, closes or edits a member: the
 * filing population is also the grading and attribution substrate, and collapsing it is
 * irreversible. The aggregation itself lives in `scout/filing-class-aggregation.ts`,
 * which carries the recurrence guard pinning that property.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { COORD_ROLES } from '../coordination/roles';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { createWorkItem, linkWorkItem } from '../../work-items';
import { IMPROVEMENT_TOPIC } from '../../harness/improvements/read-items';
import {
  FILING_CLASS_MIN_MEMBERS,
  buildFilingClassItemDraft,
  readFilingClasses,
  type FilingClass,
} from '../../scout/filing-class-aggregation';

/** An open class row already filed for this surface, so a second run reports instead of re-filing. */
async function findExistingClassItem(
  workspaceId: string,
  toolName: string,
): Promise<{ id: string; state: string } | null> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ feature_id: string; status: string }>>`
    SELECT feature_id, status
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND payload -> 'filingClass' ->> 'toolName' = ${toolName}
       AND status NOT IN ('done', 'dropped', 'resolved', 'closed')
     ORDER BY created_ts DESC
     LIMIT 1`;
  const row = rows[0];
  return row ? { id: row.feature_id, state: row.status } : null;
}

export default defineTool({
  name: 'improvements:filing-classes',
  profile: 'engineer',
  description:
    'Per-surface defect CLASSES over the ungraded filing population: groups structured toolFailure filings by the tool their report names, ranks the concentrated head, and can file ONE class work-item that CITES its members. Read-only unless mode:"file"; members are never merged or closed.',
  guidance: {
    when: 'To see whether a surface is drawing repeat tool-contract filings — the aggregate no individual filer can see — and to turn one such surface into a single actionable item instead of N instance nits. Read `classedMembers` vs `totalMembers` for the aggregation\'s reach.',
    notWhen:
      'You want the captured papercusp-improvement backlog — improvements:digest. You want one filing — work_items:get { id }. You want to file one — improvements:capture. You want to grade one — blender:grade-idea.',
    chaining:
      'improvements:filing-classes → pick a surface from `classes` → improvements:filing-classes { mode:"file", toolName } → work_items:claim the class item; its `relates` links reach every member filing.',
    seeAlso: [
      'improvements:digest (the captured improvement backlog — a different population)',
      'blender:grade-idea (grade an individual member filing; aggregation never replaces it)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    mode: z
      .enum(['read', 'file'])
      .optional()
      .describe('read (default) returns the class census; file materialises ONE class item for `toolName`'),
    toolName: z.string().min(1).max(200).optional().describe('required for mode:"file" — the surface to file the class for'),
    origin: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe('restrict to one producer origin (e.g. agent-review); default: every non-shadow producer'),
    harnessSlug: z.string().min(1).max(80).optional().describe('restrict to one harness (default: all in the workspace)'),
    workspace: z.string().min(1).max(120).optional().describe('workspace to read (default: the session/active workspace)'),
    minMembers: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe(`filings required to make a class (default ${FILING_CLASS_MIN_MEMBERS})`),
    limit: z.number().int().positive().max(200).optional().describe('max classes returned (the census still reports the whole set)'),
    force: z.boolean().optional().describe('mode:"file" — file even when an open class item already exists for this surface'),
  }),
  async handler(args, ctx) {
    // Identity is resolved in the `file` branch ONLY. It is attribution for a WRITE
    // (`createdBy` on the class item, `by` on each citation edge); the census is a
    // read of an aggregate that belongs to no one. Resolving it up front made the
    // read-only door throw for any caller without a principal — an attribution
    // requirement on a surface that attributes nothing.
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const { sql } = getOrgPg();
    const census = await readFilingClasses(sql, {
      workspaceId,
      harnessSlug: args.harnessSlug,
      origin: args.origin,
      minMembers: args.minMembers,
      limit: args.mode === 'file' ? undefined : args.limit,
    });

    if (args.mode !== 'file') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              census,
              note: 'Aggregation is ADDITIVE: a class row cites its members and never replaces them (D-001). Every member filing stays independently findable, gradable and attributable.',
            }),
          },
        ],
      };
    }

    if (!args.toolName) {
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, error: 'mode:"file" requires toolName' }) },
        ],
      };
    }
    const cls: FilingClass | undefined = census.classes.find((c) => c.toolName === args.toolName);
    if (!cls) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'no_class_for_surface',
              toolName: args.toolName,
              minMembers: census.minMembers,
              note: `'${args.toolName}' is not at or above the class threshold in this population — nothing to file.`,
            }),
          },
        ],
      };
    }

    if (cls.openMemberCount === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'class_has_no_open_members',
              toolName: cls.toolName,
              memberCount: cls.memberCount,
              byState: cls.byState,
              note: 'Every member work-item is already terminal — the class closed itself. Filing one would route triage at dead filings. (The routed-ledger outcome lags the work-item state; that lag is what makes this check necessary.)',
            }),
          },
        ],
      };
    }

    const existing = await findExistingClassItem(workspaceId, cls.toolName);
    if (existing && !args.force) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              filed: false,
              reason: 'class_item_already_open',
              existing,
              memberCount: cls.memberCount,
              note: 'An open class item already cites this surface. Pass force:true only to file a second one.',
            }),
          },
        ],
      };
    }

    const id = resolveAgentIdentity(ctx);
    const draft = buildFilingClassItemDraft(cls, { nowMs: Date.now(), minMembers: census.minMembers });
    const harness = resolveConcreteHarnessSlug(args.harnessSlug, ctx) ?? 'papercusp';
    const item = await createWorkItem({
      kind: 'change',
      title: draft.title,
      summary: draft.body,
      harness,
      severity: 'minor',
      workspaceId,
      createdBy: id.ownerId,
      payload: draft.payload,
      // THE topic is what makes this reach triage. `improvements:triage` (and the
      // digest, and the auto-implement lane) select on `topic: IMPROVEMENT_TOPIC`
      // — an untagged row is invisible to all three BY CONSTRUCTION, so a class
      // filed without it would satisfy "aggregate the filings" while failing the
      // half that matters: the class arriving in triage as ONE item instead of N.
      topics: [IMPROVEMENT_TOPIC],
      // Born admitted: duplicate screening is what the class row is FOR — it is the
      // aggregate of the duplicates, not another instance of them.
      admission: 'auto',
      admittedBy: 'bypass:filing-class-aggregation',
    });

    // Citation edges only. A failed edge must not sink the class row (the row still names
    // every member in its body and payload), so link failures are reported, never thrown.
    const linkErrors: Array<{ targetId: string; error: string }> = [];
    for (const link of draft.links) {
      const res = await linkWorkItem(item.id, { kind: 'issue', ref: link.targetId }, link.rel, {
        harness,
        by: id.ownerId,
      });
      if ('error' in res) linkErrors.push({ targetId: link.targetId, error: res.error });
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            filed: true,
            classItem: item.id,
            toolName: cls.toolName,
            memberCount: cls.memberCount,
            citedMembers: draft.links.length,
            linkErrors: linkErrors.length ? linkErrors : undefined,
            note: 'Members were CITED, not merged or closed — each stays independently findable, gradable and attributable (D-001).',
          }),
        },
      ],
    };
  },
});
