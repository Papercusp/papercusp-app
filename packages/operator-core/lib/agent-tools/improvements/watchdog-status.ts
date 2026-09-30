/**
 * improvements:watchdog-status — the observability surface over the improvement
 * watchdog's tick records (watchdog-audit-2026-06-09 P-010).
 *
 * Read-only. Before this the ONLY consumer of `harness_shared.watchdog_ticks`
 * was the watchdog itself (the self-escalation read) — diagnosing "is the
 * watchdog healthy / what did it see / why didn't X get filed?" took raw psql.
 * This returns the last N ticks in full (collector health, captured / declined /
 * pre-filtered / deferred keys, self-escalations) plus a rollup summary.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { readWatchdogStatus, rollupWatchdogTicks } from '../../harness/improvements/watchdog';
import {
  computeDispatchStats,
  readRecentDispatches,
  type DispatchStats,
  type ImprovementDispatchRow,
} from '../../harness/improvements/dispatch-ledger';
import {
  readOpenKeylessIssues,
  summarizeKeylessBacklog,
} from '../../harness/improvements/keyless-ei-policy';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';

export default defineTool({
  name: 'improvements:watchdog-status',
  profile: 'engineer',
  description:
    'Inspect the improvement watchdog: the last N tick records (collector health, signals, captured ids, known-open/stale-resolved pre-filter drops, deferred keys, self-escalations) plus a rollup summary AND the auto-implement dispatch ledger (counts by state + recent dispatches). Read-only — the diagnostic surface over harness_shared.watchdog_ticks + improvement_dispatches.',
  guidance: {
    when: 'To check whether the improvement watchdog is running and healthy — when it last ticked, which collectors failed, what it captured vs declined vs deferred, and which standing signals the key pre-filter is dropping. The first stop for "why did/didn\'t the watchdog file X?" — and for the auto-implement lane\'s dispatch ledger ("did the dispatch fire / is a worker on it / did it die?").',
    notWhen: 'You want the captured backlog itself — improvements:digest. You want one improvement — work_items:get { id }. You want to file one — improvements:capture.',
    chaining: 'improvements:watchdog-status → work_items:get on a captured/self-escalated/dispatched id → improvements:digest for the full backlog triage.',
    seeAlso: [
      'improvements:digest (the captured backlog itself)',
      'improvements:learning_loops (health of the broader learning machinery)',
      'improvements:set-watchdog-tunables (retune a noisy/quiet collector)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    limit: z.number().int().positive().max(200).optional().describe('how many recent ticks to return (default 10)'),
    workspace: z.string().min(1).max(120).optional().describe('workspace to inspect (default: the session/active workspace)'),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const ticks = await readWatchdogStatus(workspaceId, args.limit ?? 10);
    const lastRan = ticks.find((t) => t.status === 'ran');
    // The auto-implement dispatch ledger (consume-edges P-010 / B-04): counts by
    // state + the most recent rows, so "armed but never resolved" is visible
    // here instead of needing raw psql. Best-effort — a ledger read failure
    // (e.g. migration 238 not yet applied) degrades to null, never 500s.
    let dispatches: { stats: DispatchStats; recent: ImprovementDispatchRow[] } | null = null;
    try {
      const rows = await readRecentDispatches(workspaceId);
      dispatches = { stats: computeDispatchStats(rows), recent: rows.slice(0, 10) };
    } catch (e) {
      console.warn('[improvements:watchdog-status] dispatch ledger read failed:', e instanceof Error ? e.message : e);
    }
    // P-014: split the backlog headline into managed (keyed) vs UN-MANAGED (keyless).
    // Keyless EIs (no payload.watchdogKey) never dedup/age/auto-close, so they accrete
    // and dominate the headline; surfacing the rollup here makes the un-managed pile
    // visible (drain it via improvements:keyless-digest). Best-effort — fail-soft like
    // the dispatch read above, never 500s the status surface.
    let keyless: ReturnType<typeof summarizeKeylessBacklog> | null = null;
    try {
      const k = await readOpenKeylessIssues(500);
      keyless = summarizeKeylessBacklog(k.rows, k.total, Date.now());
    } catch (e) {
      console.warn('[improvements:watchdog-status] keyless backlog read failed:', e instanceof Error ? e.message : e);
    }
    const summary = {
      workspaceId,
      ticks: ticks.length,
      lastTickAt: ticks[0]?.tickAt ?? null,
      lastRanTickAt: lastRan?.tickAt ?? null,
      failingCollectors: (lastRan?.collectors ?? []).filter((c) => !c.ok).map((c) => c.name),
      captured: ticks.reduce((n, t) => n + t.captured.length, 0),
      declinedDuplicates: ticks.reduce((n, t) => n + t.declinedDuplicates, 0),
      knownOpenPrefiltered: ticks.reduce((n, t) => n + t.knownOpenKeys.length, 0),
      staleResolvedPrefiltered: ticks.reduce((n, t) => n + t.staleResolvedKeys.length, 0),
      // P-003/D-001 delta-gate suppression (EI-18638773146465036): a key showing up as
      // "standing" on most/every tick in this window is a live-state condition the watchdog
      // keeps re-detecting but is correctly NOT re-filing — normal for a real unresolved
      // condition, but `standingHotKeys` surfaces it so "one watchdogKey churning" is
      // visible at a glance instead of requiring a raw psql group-by (the exact gap that let
      // one key mint 32 work-items over 4 days before this gate existed).
      standingSuppressed: ticks.reduce((n, t) => n + t.standingKeys.length, 0),
      standingHotKeys: Object.entries(
        ticks.reduce<Record<string, number>>((acc, t) => {
          for (const k of t.standingKeys) acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {}),
      )
        .filter(([, count]) => count >= 3)
        .sort((a, b) => b[1] - a[1])
        .map(([key, count]) => ({ key, count })),
      deferred: ticks.reduce((n, t) => n + t.deferred, 0),
      selfEscalations: ticks.flatMap((t) => t.selfEscalations),
      // P-013: signal-to-noise rollup — how much the ephemeral-benchmark filter dropped
      // (P-006/P-008) + the per-class repeated-tool-error spread, so a classification
      // regression or noise spike is visible at a glance, not buried in the raw ticks.
      rollup: rollupWatchdogTicks(ticks),
      // P-014: the un-managed (keyless) backlog headline split — null if the read failed.
      keyless,
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, summary, dispatches, ticks }) }] };
  },
});
