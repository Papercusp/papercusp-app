/**
 * live-bake-off.ts — the LIVE deps-binding for the framework bake-off (plan-implementation-
 * framework-2026-06-15 P-011, activation of P-007).
 *
 * Composes the pure `runFrameworkBakeOff`'s injected `BakeoffDeps` from the REAL machinery,
 * reusing — not reinventing — the existing scored pipeline:
 *   • runBattery → `runHiveEvalGeneration` (the judge-free battery + the un-gameable
 *     `computeHiveScore` per run), mapping each ScoredRun → ArmScore {composite, gatePassed}.
 *     The composite + gate come from the CANONICAL scorer; we never recompute metrics here.
 *   • getFlag / setFlag → `@papercusp/flags/server` getFlag + setFlagOverride (the flags-override
 *     write path) — so the bake-off toggles the bet flag for real around the two arms.
 *
 * The caller supplies the heavy generation config + deps (the InstanceManifest, the seeded
 * scenarios, the store, the live HiveRunPorts, the extractor) — the same objects the hive-eval
 * cadence already constructs (gen-loop.ts / live-ports.ts). This module only WIRES them to the
 * bake-off's seams.
 *
 * NOTE: a real bake-off run executes real hive runs (cost + time) and is OWNER-BUDGETED — this
 * module is the wiring; nothing here runs a generation. setFlag is an explicit flag override:
 * the bake-off's own finally-restore returns the bet flag to its original value.
 */
import { getFlag, setFlagOverride } from '@papercusp/flags/server';
import type { FlagKey } from '@papercusp/flags';
import { runHiveEvalGeneration } from './generation-runner';
import { runFrameworkBakeOff } from './framework-bake-off';
import type { BakeoffDeps, ArmScore, BakeoffResult } from './framework-bake-off';
import type { HiveScenario } from './scenario';
import { autoRevertOnRegression } from './bet-flag-reverter';

/** The heavy generation config + deps the caller already has (gen-loop.ts). Derived from the
 *  canonical runner's own parameters so we never drift from its shape. */
export interface LiveBakeoffConfig {
  battery: Parameters<typeof runHiveEvalGeneration>[0];
  deps: Parameters<typeof runHiveEvalGeneration>[1];
}

/** Build the real BakeoffDeps. Reuses the validated scored-generation pipeline + the flag-override
 *  write path; no scorer or metric is recomputed here. */
export function liveBakeoffDeps(cfg: LiveBakeoffConfig): BakeoffDeps {
  return {
    getFlag: (key: string) => getFlag(key as FlagKey, 'system'),
    setFlag: async (key: string, value: boolean): Promise<void> => {
      const r = await setFlagOverride(key as FlagKey, value);
      if (!r.ok) throw new Error(`setFlagOverride(${key}=${value}) failed: ${r.reason}`);
    },
    runBattery: async ({ scenarioIds, repeats, arm }): Promise<ArmScore[]> => {
      const scenarios = scenarioIds
        ? cfg.battery.scenarios.filter((s) => scenarioIds.includes(s.id))
        : cfg.battery.scenarios;
      // Per-arm instanceId so the two arms' runs don't collide on the deterministic run_id
      // (run_id = instance×scenario×repeat; a shared instance would let treatment RESET baseline's
      // run rows via startRun's ON CONFLICT). Each arm gets its own persisted run history.
      const instance = arm
        ? { ...cfg.battery.instance, instanceId: `${cfg.battery.instance.instanceId}-${arm}` }
        : cfg.battery.instance;
      const config = { ...cfg.battery, instance, scenarios, ...(repeats != null ? { repeats } : {}) };
      const result = await runHiveEvalGeneration(config, cfg.deps);
      // The composite + gate are the CANONICAL un-gameable scores (computeHiveScore) — taken
      // verbatim from the pipeline, never recomputed.
      return result.scores.map(
        (r): ArmScore => ({
          scenarioId: r.scenarioId,
          composite: r.score.composite,
          gatePassed: r.score.outcomeGatePassed,
        }),
      );
    },
  };
}

export interface BetBakeoffInput {
  workspaceId: string;
  /** The bet flag to A/B (e.g. 'papercusp-compiled-briefs'). */
  flagKey: string;
  /** Subset of the corpus (default: the whole corpus). */
  scenarioIds?: string[];
  /** Repeats per scenario per arm (variance control). Default 1. */
  repeats?: number;
  /** Per-run bee cap. */
  beeCap: number;
  /** Total budget across BOTH arms; recorded per-run as budgetUsdCap = capUsd/runs (SOFT — real
   *  spend is bounded by the per-run timeout + beeCap, not a hard meter). */
  capUsd: number;
  /** Auto-revert the bet flag off if the bake-off verdict is 'regressed' (default true). */
  autoRevert?: boolean;
}

/**
 * Build the live battery config for a bet bake-off. PURE — the manifest + scenarios are injected,
 * so the instance-id / scenario-filter / budget-split logic is unit-tested with no git/PG. Mirrors
 * gen-loop.ts makeLiveRunBattery's construction, with a bake-off-scoped instanceId + slice.
 */
export function buildBakeoffBatteryConfig(
  input: BetBakeoffInput,
  scenarios: readonly HiveScenario[],
  manifest: { codeSha: string; createdAt: Date },
): LiveBakeoffConfig['battery'] {
  const ids = input.scenarioIds ?? [];
  const selected = ids.length > 0 ? scenarios.filter((s) => ids.includes(s.id)) : scenarios;
  const repeats = input.repeats ?? 1;
  // capUsd is the TOTAL across both arms; split it over every run the bake-off will do.
  const runsAcrossBothArms = Math.max(1, selected.length * repeats * 2);
  return {
    instance: {
      instanceId: `bakeoff-${input.flagKey}-${manifest.codeSha}-${input.workspaceId}`,
      workspaceId: input.workspaceId,
      codeSha: manifest.codeSha,
      genomeId: undefined,
      batterySliceId: 'framework-bakeoff',
      createdAt: manifest.createdAt,
    },
    scenarios: selected,
    repeats,
    seed: 1,
    budgetUsdCap: input.capUsd / runsAcrossBothArms,
    beeCap: input.beeCap,
  };
}

/**
 * Run a REAL bet bake-off (flag OFF vs ON over the live scored corpus) — the OWNER-ATTENDED entry
 * point (P-011 activation). Inert until called; calling it boots real throwaway hives + spawns real
 * bee agents (cost + time) — run it ATTENDED with an owner budget, NOT unattended. Mirrors gen-loop's
 * makeLiveRunBattery live wiring. Returns the BakeoffResult (verdict + delta).
 */
export async function runBetBakeoff(input: BetBakeoffInput): Promise<{ result: BakeoffResult; autoReverted: boolean }> {
  const [
    { makeLiveHivePorts },
    { liveHiveOps },
    { makeReplayExtractor },
    { createPgHiveEvalStore },
    { HIVE_EVAL_SCENARIOS },
    { buildManifest },
    { getOrgPg },
  ] = await Promise.all([
    import('./live-ports'),
    import('./live-ops'),
    import('./live-capture'),
    import('./store-pg'),
    import('./scenarios'),
    import('../iq-battery/beekeeper-gen0-runner'),
    import('@papercusp/db-org'),
  ]);
  const { manifest } = buildManifest(input.workspaceId);
  const { sql } = getOrgPg();
  const battery = buildBakeoffBatteryConfig(input, HIVE_EVAL_SCENARIOS, manifest);
  const deps = {
    store: createPgHiveEvalStore(sql),
    ports: makeLiveHivePorts(liveHiveOps({ workspaceId: input.workspaceId }), { workspaceId: input.workspaceId }),
    extractor: makeReplayExtractor(),
  };
  const result = await runFrameworkBakeOff(
    { flagKey: input.flagKey, scenarioIds: input.scenarioIds, repeats: input.repeats },
    liveBakeoffDeps({ battery, deps }),
  );
  // Immediate auto-revert (P-015): a regressed bet is flipped off NOW — the fitting mechanism for a
  // bake-off (the queen-autonomy tripwire route needs an autonomy decision + arming, a mis-fit).
  let autoReverted = false;
  if (input.autoRevert !== false) {
    const out = await autoRevertOnRegression(result, async (k) => {
      const r = await setFlagOverride(k as FlagKey, false);
      if (!r.ok) throw new Error(`setFlagOverride(${k}=false) failed: ${r.reason}`);
    });
    autoReverted = out.reverted;
  }
  // Persist the delta for the Learning/Benchmark-tab trend (P-014, migration 293) + refresh
  // subscribers. Best-effort: a missing table (pre-migration) or a persist hiccup must NOT fail an
  // already-computed bake-off. atMs is a normal Date.now() — this is not a deterministic workflow.
  try {
    const [{ persistBakeoffDelta }, { notifySyncInvalidate }] = await Promise.all([
      import('./bakeoff-store'),
      import('../sync-sse'),
    ]);
    await persistBakeoffDelta(sql, { workspaceId: input.workspaceId, result, atMs: Date.now() });
    await notifySyncInvalidate('learning.bakeoff');
  } catch (err) {
    console.warn('[bakeoff] persist/invalidate failed (non-fatal):', err instanceof Error ? err.message : err);
  }
  return { result, autoReverted };
}
