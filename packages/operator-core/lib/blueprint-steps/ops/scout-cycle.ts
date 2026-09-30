/**
 * `blender:cycle` — the Scout autonomous-ideation cadence as a DETERMINISTIC blueprint
 * step (deterministic-blueprints-migration-2026-06-13 P-121).
 *
 * Scout proposes → the Queen gates → agents build → the owner gets a report. One
 * tick gates STRUCTURALLY inside `runScoutTick`: cadence (idle-capacity OR friction)
 * → the autoloop fire-gate (backoff/circuit) → single-flight claim → budget; most
 * ticks no-op cheaply, a real (budgeted) cycle fires only when the cadence gate says
 * so. This op WRAPS the shared `runScoutCycleTick` orchestration (the SAME deps the
 * `system:scout-cycle` routine builds — the production cycle runner, signals, P-013
 * ledger, and the best-effort governor sub-budget mirror) so the migration is
 * behavior-neutral (D-004): same cadence gate, same budget, same governor mirror,
 * same tick.
 *
 * The cycle's ideator/critic legs run via the operator `llmCall` client (NOT a fleet
 * spawn via spawnInvokeOnce — there is NO spawnInvokeOnce path in lib/scout — D-009),
 * so Scout is structurally a DETERMINISTIC pipeline (a single step), NOT a
 * `spawn-roles` hybrid. Scout is NOT flag-gated: its arming is the routine `active`
 * bit + the cadence gate, NOT a frontier flag — so there is no flag-off skip path.
 */
import { z } from 'zod';
import type { CoordOp } from '../../coord-ops/types.js';
import { registerCoordOp } from '../../coord-ops/registry.js';
import { runScoutCycleTick, type ScoutCycleDeps } from '../../scout/run.js';

/** Declared input I/O — the cadence + budget overrides (the routine's payload knobs). */
const args = z
  .object({
    /** Cadence overrides (minIntervalSec / idleThreshold / frictionThreshold). */
    cadence: z
      .object({
        minIntervalSec: z.number().nonnegative().optional(),
        idleThreshold: z.number().optional(),
        frictionThreshold: z.number().optional(),
      })
      .passthrough()
      .optional(),
    /** Per-cycle budget overrides (maxCostUsd / maxIdeators / maxCriticsPerIdea). */
    budget: z
      .object({
        maxCostUsd: z.number().nonnegative().optional(),
        maxIdeators: z.number().int().nonnegative().optional(),
        maxCriticsPerIdea: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    /** Optional wall-clock cap for the cycle body; env/default applies when omitted. */
    cycleTimeoutMs: z.number().positive().optional(),
  })
  .passthrough();

/** Declared output I/O — the tick result (a fired cycle or the self-gate that withheld it). */
const result = z.object({
  /** True iff a budgeted cycle fired (all self-gates passed). */
  fired: z.boolean(),
  /** Cadence reason when fired/withheld, or 'circuit'/'claim-lost'/'cycle-error'. */
  reason: z.string(),
  cycleId: z.string().optional(),
  routedCount: z.number().int().optional(),
  costUsd: z.number().optional(),
  retryAfterSec: z.number().optional(),
  error: z.string().optional(),
});

/**
 * Test seam — inject the cycle runner / deps-builder / governor recorder (mirrors the
 * action's seams). `null` ⇒ the production wiring (the same runner the boot path
 * registers + recordScoutTickToGovernor), resolved lazily so a hermetic process that
 * only loads this op never pulls the llm/cycle graph.
 */
let _deps: ScoutCycleDeps | null = null;
export function setScoutCycleDeps(deps: ScoutCycleDeps | null): void {
  _deps = deps;
}

export const scoutCycleOp: CoordOp<z.infer<typeof args>, z.infer<typeof result>> = {
  name: 'blender:cycle',
  description:
    'Deterministic step: run one cadence-gated, budgeted Scout ideation cycle (idle/friction-gated; ideator → critic → route to plans/gym/improvements) — the autonomous-ideation cadence primitive.',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) throw new Error('blender:cycle requires ctx.workspaceId');
    const perHiveInstall = ctx.harnessSlug ?? 'op';
    // workspace-scoped-coordination-2026-06-20 P-002 / D-006: when
    // WORKSPACE_COORDINATION is ON, the Scout consolidates to ONE workspace cycle.
    // Every per-hive routine tick resolves its scope to the workspace sentinel
    // (= workspaceId), so the downstream single-flight claim (autoloop.claimFire,
    // keyed by this slug) lets EXACTLY ONE cycle fire per cadence window across all
    // the workspace's hives — N→1, which REDUCES the per-window LLM burst rather
    // than multiplying it (preserves P-050's anti-burst intent). The winning cycle
    // reads the workspace-wide corpus (already hive-agnostic) and keys its ticks +
    // lens-weights under the sentinel. OFF ⇒ the per-hive install slug,
    // byte-identical to today.
    const { isWorkspaceCoordinationOn, workspaceBrainScopeKey } = await import('../../workspace-brain-scope.js');
    const workspaceCoordinationOn = await isWorkspaceCoordinationOn();
    const installSlug = workspaceBrainScopeKey(workspaceId, perHiveInstall, workspaceCoordinationOn);
    // D-019: the workspace sentinel is the tick/single-flight identity, not a
    // harness_slug. A workspace Scout aggregates queue health across the workspace;
    // only legacy per-hive Scout filters to the real hive.
    const admissionQueueScope = workspaceCoordinationOn
      ? ({ kind: 'workspace' } as const)
      : ({ kind: 'harness', harnessSlug: perHiveInstall } as const);

    // Default to the SAME production wiring the boot path registers
    // (register-scout-action.ts): the real llmCall-backed cycle runner + the
    // governor sub-budget mirror — so the blueprint path is byte-for-byte the
    // routine path (behavior-neutral, D-004). Lazy: only when no test deps wired.
    let deps = _deps;
    if (!deps) {
      const [
        { productionScoutRunner },
        { recordScoutTickToGovernor },
        { checkHiveSingleRunner },
        { scoutWorkspaceCeilingGate },
        { readWorkItemAdmissionProducerPressure },
        { scoutPotGate, scoutConfigDelta },
      ] = await Promise.all([
        import('../../scout/register-scout-action.js'),
        import('../../learning-governor/registrants.js'),
        import('../../hive-single-runner.js'),
        // WI-5785 (P-051 regression): this deterministic blueprint step is the
        // path that ACTUALLY runs Scout in production (the `system:scout-cycle`
        // routine action in scout-cycle-action.ts wires the same gate, but that
        // path was superseded by this op — deterministic-blueprints-migration
        // P-121 — without carrying the ceiling wire over). Its absence here let
        // the workspace-wide aggregate cap silently no-op forever: every cycle
        // still passed its own per-cycle cap, so nothing ever refused, and
        // blender spend compounded past the $10 default ceiling into the
        // hundreds of dollars with no aggregate stop. Wiring it restores the
        // "byte-for-byte the routine path" contract this file's header claims.
        import('../../learning-governor/scout-ceiling.js'),
        import('../../work-items-admission-promoter.js'),
        import('../../learning/pot-gate/gates.js'),
      ]);
      deps = {
        runCycle: productionScoutRunner,
        recordGovernor: recordScoutTickToGovernor,
        // P-019: stand down on a SHARED-Hive node that is not the elected per-Hive
        // single runner, so only ONE node's scout loop fires across the Hive. At
        // N=1 / standalone this always resolves run:true (authority / not-in-hive).
        hiveRunnerGate: ({ workspaceId: ws, installSlug }) => checkHiveSingleRunner(ws, installSlug),
        // P-051: the workspace-wide scout spend ceiling preflight — sums every
        // `blender:<hive>` registrant's ledgered spend and refuses a new cycle
        // once the aggregate crosses the (owner-tunable) ceiling.
        workspaceCeilingGate: scoutWorkspaceCeilingGate,
        // learning-pot-scope-gate D-001: the per-pot learning master switch.
        // Wired in BOTH scout entrypoints deliberately — the ceiling gate above
        // was once wired only in the routine path and silently refused nothing
        // here for months, which is the failure this line is copying the fix of.
        potGate: scoutPotGate,
        // WI-1664060: the pot's settings-resident scout/cadence/budget deltas.
        // THIS op is where the layering was missing: it lived inside the
        // `system:scout-cycle` routine action's body, and this — the path that
        // actually runs Scout in production — never applied it, so the tuning the
        // owner sets in the learning drawer was written and never read. Third
        // instance of the shape the P-051 comment above describes; the merge now
        // happens once, inside runScoutCycleTick, for whichever path runs.
        resolveConfigDelta: scoutConfigDelta,
        // P-010: preserve routine/blueprint parity for queue-health throttling.
        admissionPressureGate: readWorkItemAdmissionProducerPressure,
      };
    }

    const tick = await runScoutCycleTick(
      {
        workspaceId,
        installSlug,
        admissionQueueScope,
        payloadTemplate: (a as Record<string, unknown>) ?? null,
      },
      deps,
    );
    ctx.log?.(
      `blender:cycle fired=${tick.fired} reason=${tick.reason}` +
        (tick.cycleId ? ` cycle=${tick.cycleId}` : '') +
        (tick.routedCount != null ? ` routed=${tick.routedCount}` : ''),
    );
    return {
      fired: tick.fired,
      reason: tick.reason,
      cycleId: tick.cycleId,
      routedCount: tick.routedCount,
      costUsd: tick.costUsd,
      retryAfterSec: tick.retryAfterSec,
      error: tick.error,
    };
  },
};

registerCoordOp(scoutCycleOp);
