/**
 * scheduler:running — the live-execution view of BEE RUNS
 * (hybrid-bee-scheduler-work-stealing-2026-06-22, P-001 / D-007).
 *
 * "What is the fleet executing right now, under which scheduling spec?" Every live **bee
 * run** — a bee executing a claimed work-item — with its bee, current item, claimed-since,
 * lease, heartbeat, last progress, the derived idle/blocked reason, and the claim-spec
 * `specId@revision` the bee is running under (null ⇒ DEFAULT ordering / no spec set). Read
 * off the LIVE state (the canonical fleet_assignment view + the per-bee spec store), never a
 * separate store.
 *
 * "Bee run", not "workflow" (D-007): the name avoids the DBOS-workflow + harness-pipeline
 * collision. Distinct from fleet:assignments (the full roster / bee load / orphaned-claim
 * detection across all claim kinds): this is the scheduler slice that adds the per-run
 * claim-spec each bee is executing under.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { listBeeRuns, summarizeBeeRuns, applyHealthyLoopExemption } from '../../scheduler/bee-runs';
import { getLoopStatuses } from '../../harness/routines/loop';
import { deriveLoopMonitorState } from '../fleet/assignments';

/**
 * A busy fleet can have dozens of live runs. Keep the default agent-facing
 * view parseable and useful, while preserving the complete read for callers
 * that explicitly request payloadTier:'full' (or narrow with { harness/cup }).
 * The result door is a transport guard, not a safe place to discover that a
 * hand-built JSON body was cut in the middle of an array.
 */
export const RUNNING_PAYLOAD_TIER_CEILING_CHARS = 12_000;
const RUNNING_TIER_CAPS = { trimmed: 12, standard: 24 } as const;

const clipRunningText = (value: unknown, max: number): string | null =>
  typeof value === 'string' ? (value.length > max ? `${value.slice(0, max - 1)}…` : value) : null;

export function shapeSchedulerRunning(data: unknown, tier: keyof typeof RUNNING_TIER_CAPS): unknown {
  if (!data || typeof data !== 'object') return data;
  const source = data as { ok?: unknown; summary?: unknown; runs?: unknown };
  if (!Array.isArray(source.runs)) return data;

  const cap = RUNNING_TIER_CAPS[tier];
  const runs = source.runs.slice(0, cap).map((value) => {
    if (!value || typeof value !== 'object') return value;
    const run = { ...(value as Record<string, unknown>) };
    if ('title' in run) run.title = clipRunningText(run.title, 240);
    if ('idleReason' in run) run.idleReason = clipRunningText(run.idleReason, 180);
    return run;
  });

  return {
    ok: source.ok ?? true,
    summary: source.summary ?? null,
    runs,
    ...(source.runs.length > cap
      ? {
          runsTruncated: true,
          runsReturned: runs.length,
          runsHint: `showing ${runs.length} of ${source.runs.length} live runs — narrow with { harness }/{ cup }, or request payloadTier:'full'`,
        }
      : {}),
  };
}

export default defineTool({
  name: 'scheduler:running',
  profile: 'engineer',
  description:
    'The live-execution view of BEE RUNS: every live bee run (a bee executing a claimed work-item) with its bee, current item, claimed-since, lease, heartbeat, last progress, the derived idle/blocked reason, and the claim-spec specId@revision it runs under (null = DEFAULT ordering / no spec). Read off the live fleet state — "what is the fleet executing now, under which scheduling spec". A bee run, not a workflow (D-007).',
  guidance: {
    when: 'You (an agent or a human) want to see what the fleet is actively executing RIGHT NOW and under which scheduling spec — the live-execution view of the scheduler. Filter by { harness } or { bee }.',
    notWhen:
      'Full fleet roster / bee load / orphaned-claim detection across ALL claim kinds (plan-item leases, assignments, presence) — use fleet:assignments. Claiming work — scheduler:get_next. Steering a bee — scheduler:set_claim_spec.',
    chaining:
      'scheduler:running (what is executing) → fleet:assignments { agent } (drill into a bee) → scheduler:set_claim_spec (re-steer it).',
    seeAlso: [
      'fleet:assignments (full fleet roster / orphaned-claim detection)',
      'scheduler:get_next (claim work)',
      'scheduler:set_claim_spec (re-steer a bee)',
    ],
    // EI-21660575785894728 / EI-21499923447552385 / EI-21500049186436819 /
    // EI-21498247833790802 — four independent filings of ONE shape, all from the same
    // situation: an agent under a fleet-scoped monitor directive is told to produce a
    // fleet-scoped falsifier, reaches for the live-execution view, and passes `fleet`
    // (or `plan`). This tool filters by `harness`/`cup` only. The bare unrecognized-key
    // rejection lists the accepted keys and therefore reads as "the live view cannot be
    // fleet-scoped at all" — which sends the caller either to raw SQL or to reporting
    // the directive as unsatisfiable. It is not: fleet:assignments matches `fleet_slug`
    // on every row and is the fleet-scoped roster this caller actually wants.
    //
    // Object (corrective-call) form on purpose: a `harness — …` string would render
    // "pass it as `harness` instead" over a FLEET slug, which is rejected a second time
    // (a fleet is not a harness). The remedy is a different tool, so say so.
    argRedirects: {
      fleet: {
        tool: 'fleet:assignments',
        args: { fleet: '<fleet-slug>' },
        note:
          'this view is scoped by `harness` / `cup`, never by fleet — a fleet slug is not one of its selectors. fleet:assignments matches fleet_slug on EVERY row (presence + claims) and is the fleet-scoped roster; it is also the wider view (all claim kinds, orphan detection), where this tool sees bee RUNS only. If you already know the members, `cup` filters this view to one of them',
      },
      plan: {
        tool: 'fleet:assignments',
        args: { plan: '<plan-slug>' },
        note:
          'a bee run is addressed by WHO is executing (`harness` / `cup`), not by the plan its claimed item came from, so this view has no plan selector. fleet:assignments { plan } answers "who is on plan P"; for the plan\'s own item states use plans:items',
      },
    },
  },
  capability: 'work_items:read',
  // scheduler:running is model-facing, but its default view is deliberately
  // shaped below a finite ceiling. Skip the generic result door so an explicit
  // full-tier read is still a complete JSON envelope rather than a prefix plus
  // a truncation footer (the model can follow runsHint or narrow the query).
  skipResultDoor: 'oversize-by-design',
  payloadTierCeilingChars: RUNNING_PAYLOAD_TIER_CEILING_CHARS,
  shape: {
    standard: (data) => shapeSchedulerRunning(data, 'standard'),
    trimmed: (data) => shapeSchedulerRunning(data, 'trimmed'),
    // WI-2145871: retires this tool's `unclassified-baseline` debt entry. The
    // shaper rebuilds its envelope key-by-key (`{ ok, summary, runs, … }`), so
    // anything not named is dropped; `ok` and `summary` are unconditional and
    // `summary` is the qualifier that scopes the run rows. The truncation keys
    // (`runsTruncated`/`runsReturned`/`runsHint`) are emitted only past the cap
    // and so are deliberately not pinned.
    contract: { rows: 'runs', preserve: ['ok', 'summary'] },
  },
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().min(1).optional().describe('Filter to one harness (the cup runs executing there).'),
    cup: z.string().max(120).optional().describe('Filter to one cup (its ownerId).'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    // A READ — identity is used only to default the workspace scope, resolved SOFTLY so a
    // bare loopback caller (the dock, the IPC bridge) can read without a coord identity.
    let actorWorkspace: string | null = null;
    try {
      actorWorkspace = resolveAgentIdentity(ctx).workspaceId ?? null;
    } catch {
      actorWorkspace = null;
    }
    // EI-13820: ctx.workspaceId is the literal '*' sentinel for an unscoped su
    // session (EI-9013) — normalize through resolveConcreteWorkspaceId so '*'
    // never leaks into the workspace filter as if it were a real workspace id
    // (see fleet:assignments' handler for the full incident writeup).
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, actorWorkspace);
    const runs0 = await listBeeRuns({ harness: args.harness, bee: args.cup, workspaceId });
    // EI-12359: give `stalled` bee runs the SAME healthy-loop exemption fleet:assignments
    // already applies (decorateLoopMonitorStates) — a batch-claiming bee whose engine loop
    // is actively monitored is not "abandoned" just because it hasn't checkpointed every
    // held item. Presentation-layer only; the underlying `stalled` SQL truth is untouched.
    const stalledBees = [
      ...new Set(
        runs0
          .filter((r) => r.activity === 'stalled')
          .map((r) => r.bee)
          .filter(Boolean),
      ),
    ];
    let runs = runs0;
    if (stalledBees.length > 0) {
      const loopStatuses = await getLoopStatuses(stalledBees);
      const hasHealthyMonitor = new Set(
        stalledBees.filter((b) => deriveLoopMonitorState(loopStatuses.get(b) ?? null, []) !== null),
      );
      if (hasHealthyMonitor.size > 0) runs = applyHealthyLoopExemption(runs0, hasHealthyMonitor);
    }
    return {
      data: {
        ok: true,
        summary: summarizeBeeRuns(runs),
        runs: runs.map(({ bee, ...rest }) => ({ cup: bee, ...rest })),
      },
    };
  },
});
