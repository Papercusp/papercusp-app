/**
 * harness:overview — the COMPOUND "state of X" read (tool-call-batching-wrappers P-006).
 * The operator's "what's the state of things" in ONE call instead of the measured
 * harness:list → harness:status → work_items:list → harness:escalation sequence.
 *
 *   - with `harness`: that harness's status + escalations (the deep view)
 *   - without `harness`: the harness index (harness:list, summary)
 *   - always: the cross-cutting open-issues snapshot (engineer-issues store) — the operator's
 *     "what's broken right now"
 *
 * Composition is the in-process re-dispatch pattern (see `_compound-dispatch.ts`) — each
 * sub-read is independently gated + telemetry-logged like a direct call, run SEQUENTIALLY.
 * Folds are BEST-EFFORT (a denied/failed sub-call degrades to a null field rather than
 * failing the whole overview) and the result is bounded/COMPACT (D-008): the unbounded
 * lists (issues, the harness index) are capped so the wrapper never dumps a large payload
 * back into context — the very token cost it exists to remove.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { inProcessCall, type InnerCall } from '../_compound-dispatch';
import { listIssues, countIssues, type ListIssuesFilter } from '../../issues-engineer';

const ISSUES_FOLD_DEFAULT = 25;
const ISSUES_FOLD_MAX = 100;
const HARNESS_INDEX_DEFAULT = 50;
const HARNESS_INDEX_MAX = 200;

export interface HarnessOverviewArgs {
  harness?: string;
  phase?: string;
  issueState?: 'open' | 'resolved' | 'closed';
  issueScope?: string;
  issuesLimit?: number;
  harnessLimit?: number;
}

export interface HarnessOverviewResult {
  ok: boolean;
  /** The harness the deep view is for (present when `harness` was passed). */
  harness?: string;
  /** harness:status for `harness` — null if the read failed; absent in index mode. */
  status?: unknown | null;
  /** harness:escalation for `harness` — null if it failed; absent in index mode. */
  escalations?: unknown | null;
  /** harness:list (summary) — the index; present only when no `harness` was passed. */
  harnesses?: unknown | null;
  /** open-issues snapshot (cross-cutting open problems) — bounded; null on failure. */
  issues?: { count: number; recent: unknown[] } | null;
}

/**
 * The cross-cutting open-issues snapshot reader. Defaults to the engineer-issues store
 * directly (listIssues + countIssues) — overview is already coord:read-gated, so the
 * fold doesn't need to round-trip a tool; this also gives the TRUE total via countIssues.
 * Injectable so composeHarnessOverview stays a pure, unit-testable composition.
 * (coordination-unification-2026-06-23 P-009 — reads the store directly for the TRUE
 * total instead of round-tripping a tool — the issues:list tool it used to fold was
 * retired onto work_items:* in P-015.)
 */
export type IssuesSnapshotReader = (
  filter: ListIssuesFilter,
  limit: number,
) => Promise<{ count: number; recent: unknown[] }>;

const defaultReadIssues: IssuesSnapshotReader = async (filter, limit) => {
  const [arr, count] = await Promise.all([listIssues({ ...filter, limit }), countIssues(filter)]);
  return { count, recent: arr.slice(0, limit) };
};

/**
 * Pure composition over an injected `call` (+ issues reader), run SEQUENTIALLY. With a
 * `harness` it folds that harness's status + escalations; without one it folds the harness
 * index. The cross-cutting open-issues snapshot is always folded. Every fold is BEST-EFFORT.
 */
export async function composeHarnessOverview(
  args: HarnessOverviewArgs,
  call: InnerCall,
  readIssues: IssuesSnapshotReader = defaultReadIssues,
): Promise<HarnessOverviewResult> {
  const result: HarnessOverviewResult = { ok: true };

  if (args.harness) {
    result.harness = args.harness;
    try {
      result.status = await call('harness:status', { slug: args.harness });
    } catch {
      result.status = null;
    }
    try {
      result.escalations = await call('harness:escalation', {
        slug: args.harness,
        ...(args.phase ? { phase: args.phase } : {}),
      });
    } catch {
      result.escalations = null;
    }
  } else {
    try {
      result.harnesses = await call('harness:list', {
        detail: 'summary',
        limit: Math.min(args.harnessLimit ?? HARNESS_INDEX_DEFAULT, HARNESS_INDEX_MAX),
      });
    } catch {
      result.harnesses = null;
    }
  }

  // Cross-cutting open-issues snapshot — the operator's "what's broken". Not per-harness
  // (it rides the coordination substrate); folded bounded via the injected issues reader.
  const issuesLimit = Math.min(args.issuesLimit ?? ISSUES_FOLD_DEFAULT, ISSUES_FOLD_MAX);
  try {
    const filter: ListIssuesFilter = {
      state: args.issueState ?? 'open',
      ...(args.issueScope ? { scope: args.issueScope } : {}),
    };
    result.issues = await readIssues(filter, issuesLimit);
  } catch {
    result.issues = null;
  }

  return result;
}

export default defineTool({
  name: 'harness:overview',
  profile: 'engineer',
  description:
    "One COMPOUND 'state of X' read: a harness's status + escalations (with `harness`) or the " +
    'harness index (without), PLUS the cross-cutting open-issues snapshot — harness:list / ' +
    'harness:status / work_items:list / harness:escalation in ONE round-trip instead of four. ' +
    'Use it for a multi-part/full-picture request; a single fact such as active/current phase is ' +
    'one direct harness:status call.',
  guidance: {
    when:
      'Answering a multi-part "full picture / state of X" request that needs status PLUS ' +
      'escalations and open issues — pass `harness` for one harness, or omit it for the harness ' +
      'index + open issues, in one round-trip instead of harness:list + harness:status + ' +
      'work_items:list + harness:escalation.',
    notWhen:
      'You need a single harness status fact such as active/current phase — call harness:status ' +
      'directly. For one harness in full detail use harness:get; for one issue use work_items:get; ' +
      'for a topic-filtered issue sweep use work_items:list { topic }. Do NOT call it in a loop over ' +
      'every harness — pass the one slug you care about.',
    chaining:
      'Bundles: harness:status + harness:escalation [+ harness:list] + work_items:list — prefer this ' +
      'over calling them separately. → work_items:get / work_items:claim a problem it surfaces.',
    seeAlso: [
      'work_items:claim (take a problem the overview surfaces)',
      'harness:status (live phase + activity)',
      'harness:health (the harness health rollup)',
    ],
  },
  capability: 'coord:read',
  // tool-call-batching-wrappers P-010 — composite marker (drives composition + the
  // bounded back-pointer on these primitives' catalog entries).
  replaces: ['harness:list', 'harness:status', 'work_items:list', 'harness:escalation'],
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z
      .string()
      .max(120)
      .optional()
      .describe('Harness slug — fold its status + escalations (the deep view). Omit for the harness index.'),
    phase: z.string().max(40).optional().describe('Phase for the escalation read (used with `harness`).'),
    issueState: z.enum(['open', 'resolved', 'closed']).optional().describe("Open-issues snapshot state filter (default 'open')."),
    issueScope: z.string().max(120).optional().describe('Filter the open-issues snapshot to this scope/area.'),
    issuesLimit: z.number().int().positive().max(100).optional().describe('Max issues to fold (default 25).'),
    harnessLimit: z.number().int().positive().max(200).optional().describe('Max harnesses in the index (default 50).'),
  }),
  async handler(args, ctx) {
    const result = await composeHarnessOverview(args, inProcessCall(ctx));
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
});
