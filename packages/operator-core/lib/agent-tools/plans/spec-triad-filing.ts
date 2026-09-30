/**
 * The one place a SPEC TRIAD work item is written — okf-frontmatter-adoption H(b).
 *
 * Two callers reach the same conclusion from different directions and must file
 * the SAME item, deduped against each other:
 *
 *   - `promotePlanItems` — refuses to promote a plan that owes the triad, and
 *     files at the moment of refusal so the exit exists immediately rather than
 *     up to a day later.
 *   - `runSpecTriadSweepOnce` — the daily backstop, for plans that never went
 *     through promotion (or whose filing was closed while the gap remained).
 *
 * Both routing to one function is what makes "the gate always has an exit" a
 * structural property instead of two implementations that can drift.
 *
 * The dedupe key is `payload.specTriadPlan` — the plan's fully-qualified
 * `workspace/harness/slug` ref. Deliberately NOT the bare slug: two tenants can
 * hold a plan of the same name, and suppressing one tenant's filing because
 * another tenant has one open would strand a lane with no way to notice.
 */

import { getOrgPg } from '@papercusp/db-org';
import { upsertConditionWorkItem } from '../../coord/condition-upsert';

/** Work-item statuses that mean an existing filing is still outstanding. */
export const SPEC_TRIAD_NON_TERMINAL_STATUSES = [
  'open',
  'todo',
  'wip',
  'in_progress',
  'blocked',
  'needs-human',
  'validating',
  'failing',
];

export interface SpecTriadFilingInput {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  /** The legs the plan owes, e.g. ['requirements','design']. */
  missing: string[];
  /** Human-readable gap, from `describeSpecTriadGap`. */
  gap: string;
}

export type SpecTriadFilingOutcome = 'created' | 'already-open' | 'error';

export interface SpecTriadFilingResult {
  outcome: SpecTriadFilingOutcome;
  id: string | null;
  ref: string;
  error?: string;
}

export function specTriadPlanRef(i: {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
}): string {
  return `${i.workspaceId}/${i.harnessSlug}/${i.planSlug}`;
}

/** The item body. Extracted so both callers say exactly the same thing. */
export function specTriadFilingBody(planSlug: string, gap: string): string {
  return (
    `Plan \`${planSlug}\` is in scope for the SPEC TRIAD (okf-frontmatter-adoption H(b)) ` +
    `and is missing: ${gap}\n\n` +
    `Its items are held back from \`plans:items { actionable: true }\` and from plan→work-item ` +
    `promotion until the sections are written — so this is not paperwork, it is what unblocks ` +
    `that plan's lane.\n\n` +
    `**To resolve** (\`plans:set-content\` / \`plans:edit\`):\n` +
    `- \`## Requirements\` — what must be TRUE when the change is done. Not a task list.\n` +
    `- \`## Design\` — how it will be built, and the trade-off you settled.\n` +
    `- \`P-NNN\` items — the tasks themselves (\`plans:add-item\`).\n\n` +
    `A heading with nothing under it does NOT satisfy the check, and neither does \`TBD\` — the ` +
    `detector requires real body content (\`evaluateSpecTriad\`, @papercusp/plan-parser).\n\n` +
    `**If the triad genuinely does not apply to this plan**, that is a legitimate answer, not a ` +
    `failure: add \`specTriad: exempt\` to its frontmatter and close this item with that as the ` +
    `completion evidence. The requirement is a floor for new work, never a wall.`
  );
}

/**
 * File the triad work item for a plan, unless one is already open.
 *
 * Never throws — both callers run inside paths where a throw is worse than the
 * gap it reports (a DBOS step that throws is marked permanently dead; a
 * promotion that throws fails a plan launch). A failure is returned, logged by
 * the caller, and retried on the next pass.
 */
export async function ensureSpecTriadFiling(
  input: SpecTriadFilingInput,
): Promise<SpecTriadFilingResult> {
  const ref = specTriadPlanRef(input);
  try {
    const { sql } = getOrgPg();
    // Legacy fast path: rows filed before the condition-key upsert existed carry
    // only the payload marker. Keep honoring them so a pre-existing open filing
    // is adopted instead of joined by a keyed sibling.
    const open = (await sql`
      SELECT 1
        FROM harness_shared.work_items
       WHERE payload->>'specTriadPlan' = ${ref}
         AND status = ANY(${SPEC_TRIAD_NON_TERMINAL_STATUSES})
       LIMIT 1
    `) as unknown as unknown[];
    if (open.length > 0) return { outcome: 'already-open', id: null, ref };

    // WI-39594: the payload check above is check-then-act and RACED — the two
    // callers (promotion refusal + daily sweep) run on independent schedules and
    // filed 11 exact-title pairs. The upsert claims migration 741's unique
    // condition-key index, so a concurrent double-file resolves to ONE open item
    // regardless of timing. The key embeds harness + plan (workspace-unique by
    // construction) because ownership reads are workspace-scoped — see
    // condition-upsert.ts on why a harness-scoped read is the wrong tool here.
    const res = await upsertConditionWorkItem(`spec-triad:${input.harnessSlug}/${input.planSlug}`, {
      kind: 'task',
      harness: input.harnessSlug,
      workspaceId: input.workspaceId,
      createdBy: 'system:spec-triad',
      title: `Write the spec triad for plan '${input.planSlug}' — missing ${input.missing.join(' + ')}`,
      summary: specTriadFilingBody(input.planSlug, input.gap),
      payload: { specTriadPlan: ref, planSlug: input.planSlug, missing: input.missing },
    });
    return res.created
      ? { outcome: 'created', id: res.id, ref }
      : { outcome: 'already-open', id: res.id, ref };
  } catch (err) {
    return { outcome: 'error', id: null, ref, error: (err as Error).message };
  }
}
