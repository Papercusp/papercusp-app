/**
 * GET /api/tui/goals — the goals read path for `pui` (apps/tui), P-032 of
 * pui-agent-context-cockpit-2026-08-26 (D-010: the GOALS → PLANS → ITEMS spine).
 *
 * A thin HTTP seam over the settled GOAL-mode sync read (`resolveGoalsList`,
 * sync-resolver/goals.ts) — the SAME audited query the GUI goals surfaces use,
 * so the TUI can never disagree with the HUD about a goal's state. Read-only;
 * `auth: 'public'` mirrors the sibling /api/tui/* routes (loopback-protected
 * by the host bind).
 *
 * The DTO is a flattening for a terminal column: enough to render the goals
 * column (status, holder liveness, pot chips — the goals→plans join key —
 * open/needs-human counters) and nothing the TUI does not render.
 * `totalGoals` / `truncatedByLimit` ride through verbatim: the list is capped,
 * and a capped length rendered as a total is the repeat-offender class the
 * resolver already defends against — never render `goals.length` as the total.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { resolveGoalsList, type GoalSummaryRow } from '../../../sync-resolver/goals';
import { activeWorkspaceId } from '../../../workspace-registry';

const GOALS_LIMIT = 100;

/**
 * The subset of the resolver row the TUI consumes — structural (`Pick`), so the
 * shaper is unit-testable without fabricating the resolver's whole row.
 */
export type TuiGoalSource = Pick<
  GoalSummaryRow,
  | 'id'
  | 'title'
  | 'status'
  | 'effectiveStatus'
  | 'deactivated'
  | 'holderLiveness'
  | 'parentId'
  | 'potCount'
  | 'pots'
  | 'openWorkItems'
  | 'needsHuman'
  | 'spendUsd'
  | 'budgetCents'
  | 'lastActivityAt'
>;

/** One goals-column row as the TUI consumes it. */
export interface TuiGoalDto {
  id: string;
  title: string;
  status: string;
  /** The status a reader should USE (server-derived dormancy fold), or null. */
  effectiveStatus: string | null;
  deactivated: boolean;
  /** held | unheld | lost | unknown — the server's holder verdict. */
  holderLiveness: string;
  parentId: string | null;
  /** The TRUE pot count — `pots` below is a bounded sample, never a total. */
  potCount: number;
  pots: Array<{ harnessSlug: string; role: string | null; servesGoals: number }>;
  openWorkItems: number;
  needsHuman: number;
  spendUsd: number;
  budgetCents: number | null;
  lastActivityAt: string | null;
}

/** Pure shaper: resolver rows → the flat TUI DTO (mirrors plan-item-states). */
export function shapeTuiGoals(rows: readonly TuiGoalSource[]): TuiGoalDto[] {
  return rows.map((g) => ({
    id: g.id,
    title: g.title,
    status: g.status,
    effectiveStatus: g.effectiveStatus,
    deactivated: g.deactivated,
    holderLiveness: g.holderLiveness,
    parentId: g.parentId,
    potCount: g.potCount,
    pots: g.pots.map((p) => ({
      harnessSlug: p.harnessSlug,
      role: p.role,
      servesGoals: p.servesGoals,
    })),
    openWorkItems: g.openWorkItems,
    needsHuman: g.needsHuman,
    spendUsd: g.spendUsd,
    budgetCents: g.budgetCents,
    lastActivityAt: g.lastActivityAt,
  }));
}

export default defineTool({
  method: 'GET',
  path: '/tui/goals',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const status = url.searchParams.get('status')?.trim() || null;
    const workspaceId = activeWorkspaceId();
    const { goals, totalGoals, truncatedByLimit } = await resolveGoalsList({
      workspaceId,
      status,
      limit: GOALS_LIMIT,
    });
    return Response.json({
      goals: shapeTuiGoals(goals),
      totalGoals,
      truncatedByLimit,
    });
  },
});
