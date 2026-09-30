/**
 * pot:list — the workspace-local hives (kind:'hive' harnesses) at a glance
 * (hive-tool-namespace-2026-06-08 P-002, D-001).
 *
 * The local-lifecycle counterpart to `discovery:pots` (the P2P directory of
 * joinable network hives). Returns each pot's `resolvePot` descriptor (slug +
 * deployment + wake) plus a single batched live-agent count — ONE fleet read for
 * all hives, never an N-per-pot fan-out. Rich per-pot detail (cups, frontier)
 * is `pot:get`.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { listFleetAssignments } from '../../fleet/assignments';
import { listPots, liveAgentCountByHarness, type PotDescriptor } from './_resolve';

export default defineTool({
  name: 'pot:list',
  profile: 'engineer',
  description:
    "The workspace-local pots (kind:'hive' harnesses — the Pots): each with its home slug, deployment target, wake (scheduled? next/last fire), and a live-agent count. The local-lifecycle view; for joinable network hives use discovery:pots, for per-cup placement detail use fleet:assignments, for one pot in depth use pot:get.",
  guidance: {
    when: 'You want the workspace-local pots (the Pots) and their wake/load at a glance.',
    notWhen:
      'Browsing joinable hives across the P2P network — that is discovery:pots. The raw per-agent fleet view — fleet:assignments. One pot in depth — pot:get.',
    chaining: 'pot:get { slug } to drill into one; pot:create to add one; pot:dissolve to tear one down.',
    seeAlso: [
      'pot:get (drill into one pot in depth)',
      'pot:create (stand up a new pot)',
      'fleet:assignments (the raw per-agent view across the workspace)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const hives = await listPots(workspaceId);

    // One batched fleet read → distinct live agents per pot harness (no N fan-out).
    const counts =
      hives.length > 0
        ? liveAgentCountByHarness(await listFleetAssignments({ workspaceId }))
        : new Map<string, number>();

    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(shapePotList(hives, counts)) },
      ],
    };
  },
});

/* hud-open-destinations-and-true-counts-2026-07-27 P-006 — hoist the wake
   SUBSCRIPTIONS out of the per-pot rows.

       `buildWakeView` fills every pot's `wake.subscriptions` from
       `readPotWakeState(workspaceId)`, which is keyed on the WORKSPACE and takes
       no pot argument — so the array is identical across every pot in the
       response by construction, not merely in practice. Repeating it per pot
       made this the single largest avoidable chat payload on the surface: 17
       pots × ~1KB of the same four long `note` strings = 19.4KB, of which the
       actual per-pot signal (slug, deployment, wake times, liveAgents) is a few
       hundred bytes.

       That is not hypothetical bloat. On 2026-07-27 the owner asked Papercup
       "whats the status of our pots?"; `pot:list` returned ok twice (19,400
       bytes each, inlined — `tool_invocations` confirms both) and the assistant
       turn that should have carried the answer persisted with EMPTY text
       (`operator_turns` seq 16456). Ambient curator cards filled the space, so
       it read as "the pot list did not return any results".

   Emitted once as `wakeSubscriptions`. Per-pot `wake` keeps its own live
   fields (active/nextFireAt/lastFiredAt/lastWakeAt) — those genuinely vary.
   `pot:get` is unchanged and still carries the full per-pot view.

   Pure + exported so the shaping is unit-testable without PG, the same reason
   `describePot` in `_resolve.ts` is. */
export function shapePotList(
  hives: readonly PotDescriptor[],
  counts: ReadonlyMap<string, number>,
) {
  const out = hives.map(({ wake, ...h }) => ({
    ...h,
    wake: {
      active: wake.active,
      nextFireAt: wake.nextFireAt,
      lastFiredAt: wake.lastFiredAt,
      lastWakeAt: wake.lastWakeAt,
    },
    liveAgents: counts.get(h.slug) ?? 0,
  }));

  return {
    ok: true as const,
    count: out.length,
    // Workspace-wide, shared by every pot above (see the note).
    wakeSubscriptions: hives[0]?.wake.subscriptions ?? [],
    hives: out,
  };
}
