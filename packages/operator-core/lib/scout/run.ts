/**
 * `runScoutCycleTick` — the SHARED Scout autonomous-tick orchestration, the single
 * source of truth both the `system:scout-cycle` routine action AND the `blender:cycle`
 * deterministic blueprint step (deterministic-blueprints-migration-2026-06-13 P-121 /
 * D-004) run. Extracting it is what makes the migration provably behavior-neutral:
 * the blueprint path and the routine path build the SAME tick deps, run the SAME
 * self-gated `runScoutTick`, and mirror the SAME governor sub-budget.
 *
 * Scout is NOT a flag+governor-preflight loop (negative-space / regret / transfer /
 * ablation are). Its gate is STRUCTURAL and lives INSIDE the tick (`runScoutTick`):
 * cadence (idle-capacity OR friction) → the autoloop fire-gate (backoff/circuit) →
 * single-flight claim → budget. Most ticks no-op cheaply; a real (budgeted) cycle
 * fires only when the cadence gate says so. The cron heartbeat is the trigger, NOT
 * the cadence. The learning-governor here is a best-effort POST-tick MIRROR of the
 * per-cycle cap + reported spend (`recordScoutTickToGovernor`), never a preflight
 * refusal — so wrapping is behavior-neutral only when ALL of those gates carry over,
 * which they do because the op builds the SAME production deps the action does.
 *
 * IMPORTANT (D-009): Scout's ideator/critic legs run via the operator `llmCall`
 * client (register-scout-action wires the real llm-testing/llm-client into the cycle
 * deps), NOT fleet agent spawns via spawnInvokeOnce — there is NO spawnInvokeOnce
 * path anywhere in lib/scout. So Scout as a blueprint is a DETERMINISTIC pipeline (a
 * single step whose op runs the self-gated tick), not a `spawn-roles` hybrid, and
 * this migration is behavior-neutral — see D-009.
 *
 * Deps are injectable PARAMETERS — the action passes its own seams (the test pins a
 * fake runCycle + buildDeps; boot wires the production runner + governor recorder),
 * the op defaults to the SAME production runner + deps builder + governor recorder.
 */
import {
  buildScoutTickDeps,
  DEFAULT_SCOUT_CYCLE_TIMEOUT_MS,
  runScoutTick,
  type ScoutCycleLike,
  type ScoutTickDeps,
  type ScoutTickResult,
  type ScoutRevisionRequest,
} from './scheduler';
import type { ScoutTickRecord } from './tick-ledger';
import type { ScoutCyclePhase } from './cycle';
import { readHiveIdleRatio, readFrictionSignalCount } from './cadence-signals';
import type { ScoutCadenceOptions } from './cadence';
import { resolveScoutBudget, type ScoutBudget } from './budget';
import { parseScoutConfigBlock, resolveScoutConfig, type ScoutConfig } from './config';
import type { recordScoutTickToGovernor } from '../learning-governor/registrants';
import type { scoutWorkspaceCeilingGate } from '../learning-governor/scout-ceiling';
import type { WorkItemAdmissionProducerPressure } from '../work-items-admission-promoter';
import type { LlmCallOpts, LlmCallResult } from '@papercusp/testing-shell/llm';

/** Additional caller admission around the already model-resolved production transport. */
export type ScoutLlmAdmission = (opts: Readonly<LlmCallOpts>, invoke: () => Promise<LlmCallResult>) => Promise<LlmCallResult>;

/** Runs ONE budgeted Scout cycle for a harness (wraps cb4b9's runScoutCycle + ports). */
export type ScoutCycleRunner = (ctx: {
  harnessSlug: string;
  workspaceId: string;
  budget: Required<ScoutBudget>;
  cycleId: string;
  /** Per-blueprint Scout tuning resolved from the blueprint `scout` block (P-009,
   *  domain-generic-hive-architecture-2026-06-18). Omitted ⇒ the runner uses
   *  DEFAULT_SCOUT_CONFIG (behavior-neutral). */
  scoutConfig?: ScoutConfig;
  /** Pending steward/reviewer→Scout revision requests this tick.
   *  Present only when the scheduler's cycle-start coord:inbox read found plan-keyed
   *  feedback for `scout:<hive>`; the runner then targets a REVISION of those draft
   *  plans (register-scout-action.ts) instead of fresh ideation. */
  revisionRequests?: ScoutRevisionRequest[];
  signal?: AbortSignal;
  /**
   * WI-4475 — absolute epoch-ms deadline the scheduler will kill this cycle at. `signal` says
   * "you're out of time" only AFTER the fact; the deadline lets the cycle bound its inner waits
   * BEFORE they overrun. Every LLM call made under it caps its governor ADMISSION wait at the
   * time actually remaining, so no single call queued behind a rate-limit pause can consume the
   * whole cycle. Absent ⇒ no bound (pre-WI-4475 behavior).
   */
  deadlineMs?: number;
  onPhase?: (phase: ScoutCyclePhase) => void;
  /** Optional stricter caller budget; cannot replace Scout's production transport or gates. */
  admitLlmCall?: ScoutLlmAdmission;
  /** Retain fresh proposals for evaluation without dispatching them or resuming older consultations. */
  deferDispatch?: boolean;
}) => Promise<ScoutCycleLike>;

export interface ScoutCycleActionConfig {
  cadence?: ScoutCadenceOptions;
  budget?: ScoutBudget;
  cycleTimeoutMs?: number;
}

/**
 * Queue-health scope is deliberately separate from the Scout tick identity.
 * Workspace coordination keys ticks/single-flight by the workspace sentinel, but
 * that sentinel is not a harness slug: the one workspace Scout must aggregate the
 * whole workspace queue. Legacy per-hive Scout instead filters to the real hive.
 */
export type ScoutAdmissionQueueScope = { kind: 'workspace' } | { kind: 'harness'; harnessSlug: string };

/** The normalized routine ctx the orchestration needs (action + op both supply it). */
export interface ScoutCycleInput {
  workspaceId: string;
  installSlug: string;
  admissionQueueScope: ScoutAdmissionQueueScope;
  payloadTemplate: Record<string, unknown> | null;
}

/**
 * Build the production {@link ScoutTickDeps} from the routine ctx + a cycle runner:
 * cadence signals (idle ratio + friction) + ledger persistence via
 * {@link buildScoutTickDeps}. Swapped for a fake in unit tests.
 */
export type ScoutTickDepsBuilder = (input: ScoutCycleInput, runCycle: ScoutCycleRunner) => ScoutTickDeps;

export const productionDepsBuilder: ScoutTickDepsBuilder = (input, runCycle) => {
  // P-009: resolve the per-blueprint Scout tuning from the routine/blueprint-step
  // payload's `scout` block (alongside cadence/budget). Absent or typo'd block ⇒
  // DEFAULT_SCOUT_CONFIG (behavior-neutral). Parsed once per tick and threaded into the
  // cycle runner's ctx (productionScoutRunner forwards it to buildScoutCycleDeps).
  const scoutConfig = resolveScoutConfig(parseScoutConfigBlock(scoutBlockOf(input.payloadTemplate)));
  return buildScoutTickDeps({
    harnessSlug: input.installSlug,
    workspaceId: input.workspaceId,
    // Migration 947 / learning-loop-backlog-triage-2026-08-22 P-010: stamp every
    // routed row this tick persists with the model that actually produced it.
    //
    // `scoutConfig` is the RESOLVED per-tick config (resolveScoutConfig above, from
    // this routine's blueprint payload) — the same object threaded into the cycle
    // runner on the next line, so the stamp and the run cannot disagree. That is the
    // whole point: reading DEFAULT_SCOUT_MODELS here instead would be a second copy
    // of a truth the config already owns, and would mis-attribute every row the day a
    // blueprint overrides the model without a deploy — which is exactly what the
    // `models` block exists to allow.
    modelSpec: scoutConfig.models.ideator,
    modelConfig: {
      // The ideator model is the headline, but a cycle's output quality is shaped by
      // the critic/recombine/revision lane too — record the whole resolved step map
      // so a later "which configuration produced good ideas?" question is answerable
      // without re-deriving anything.
      models: { ...scoutConfig.models },
      lensRoster: [...scoutConfig.lenses],
    },
    runCycle: ({ budget, cycleId, revisionRequests, signal, deadlineMs, onPhase }) =>
      runCycle({
        harnessSlug: input.installSlug,
        workspaceId: input.workspaceId,
        budget,
        cycleId,
        scoutConfig,
        ...(revisionRequests ? { revisionRequests } : {}),
        ...(signal ? { signal } : {}),
        // WI-4644 recurrence (2026-07-14): this bridge used to drop the absolute
        // deadline that runScoutTick calculated. The production runner therefore
        // saw `undefined`, ideators fell back to the legacy undifferentiated 180s
        // wall-clock timer, and an admission wait was recorded as transport death.
        ...(deadlineMs !== undefined ? { deadlineMs } : {}),
        ...(onPhase ? { onPhase } : {}),
      }),
    readIdleRatio: () => readHiveIdleRatio({ workspaceId: input.workspaceId }),
    readFrictionSignals: () => readFrictionSignalCount({ harnessSlug: input.installSlug }),
  });
};

/** Pull the `scout` tuning block out of a routine/blueprint-step payload_template (if any). */
function scoutBlockOf(payload: Record<string, unknown> | null): unknown {
  return payload && typeof payload === 'object' ? normalizeScoutPayload(payload).scout : undefined;
}

/**
 * Parse a routine's payload_template into cadence + budget overrides. Unknown keys
 * are ignored; bad shapes fall back to the gate/budget defaults.
 */
export function parseScoutCycleConfig(payload: Record<string, unknown> | null): ScoutCycleActionConfig {
  if (!payload || typeof payload !== 'object') return {};
  const config = normalizeScoutPayload(payload);
  const cadence = isObj(config.cadence) ? (config.cadence as ScoutCadenceOptions) : undefined;
  const budget = isObj(config.budget) ? (config.budget as ScoutBudget) : undefined;
  const cycleTimeoutMs =
    typeof config.cycleTimeoutMs === 'number' && Number.isFinite(config.cycleTimeoutMs) && config.cycleTimeoutMs > 0
      ? config.cycleTimeoutMs
      : undefined;
  return {
    ...(cadence ? { cadence } : {}),
    ...(budget ? { budget } : {}),
    ...(cycleTimeoutMs != null ? { cycleTimeoutMs } : {}),
  };
}

function normalizeScoutPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const nested = isObj(payload.payload) ? payload.payload : null;
  return nested ? { ...payload, ...nested } : payload;
}

export interface ScoutCycleDeps {
  /** The per-harness cycle runner (built from cb4b9's runScoutCycle + ports). Required. */
  runCycle: ScoutCycleRunner;
  /** Tick-deps builder (default = the production wiring). */
  buildDeps?: ScoutTickDepsBuilder;
  /** Best-effort governor sub-budget mirror (boot wires recordScoutTickToGovernor). */
  recordGovernor?: typeof recordScoutTickToGovernor;
  /**
   * P-051 workspace-wide scout spend ceiling PREFLIGHT (boot wires
   * scoutWorkspaceCeilingGate). Consulted BEFORE the tick: when it refuses
   * (aggregate `scout:<hive>` spend ≥ the workspace ceiling, D-005) the tick
   * is short-circuited as a no-op cycle so per-hive scout in aggregate can't
   * saturate the shared rate limit. Unwired ⇒ no ceiling check (the hermetic
   * unit-test contract — runScoutTick's structural self-gates still bound it).
   */
  workspaceCeilingGate?: typeof scoutWorkspaceCeilingGate;
  /**
   * P-010 work-queue pressure preflight. Production reads the P-005 queue-health
   * writer and returns an ideator cap; unavailable data fails open.
   */
  admissionPressureGate?: (input: {
    workspaceId: string;
    harnessSlug?: string;
  }) => Promise<WorkItemAdmissionProducerPressure>;
  /**
   * P-019 cross-node SINGLE-RUNNER gate (boot wires checkHiveSingleRunner).
   * Consulted FIRST — before any cadence/budget work: in a SHARED Hive scout's
   * single-flight claim (autoloop.claimFire) is per-NODE only, so each node's
   * embedded PG wins its own claim and N nodes run N scout loops. This gate makes
   * only the per-Hive ELECTED authority (lowest-live-pubkey, lockAuthorityForHive)
   * run the cycle; non-runner nodes stand down with reason 'not-hive-runner'.
   * Unwired ⇒ no gate (the hermetic unit-test contract); at N=1 / standalone the
   * gate resolves to run:true (authority / not-in-hive), so behaviour is unchanged.
   */
  hiveRunnerGate?: (input: { workspaceId: string; installSlug: string }) => Promise<{ run: boolean; reason?: string }>;
  /**
   * The per-pot learning master switch (learning-pot-scope-gate-2026-08-30
   * D-001). Consulted FIRST — before every other gate — because it is the
   * outermost control: when the owner switches a pot off, no Scout cycle for
   * that pot may fire, whatever the cadence, ceiling or fire-gate say.
   *
   * This is a NEW refusal, not a parameter on an existing one. Scout has never
   * had a preflight (see this file's header: "per-cycle cap + reported spend,
   * never a preflight"); its only gate was the `scout-cycle` routine's `active`
   * flag, which is workspace-wide and therefore cannot express "this pot only".
   *
   * Unwired ⇒ no gate (the hermetic unit-test contract, same as the two gates
   * above), and the production wiring fails OPEN on a read error — R-5: an
   * unreadable pot gate must not become a fleet-wide learning outage.
   */
  potGate?: (input: { workspaceId: string; installSlug: string }) => Promise<{ enabled: boolean }>;
  /**
   * The pot's settings-resident `scout` / `cadence` / `budget` deltas — the
   * per-pot tuning the owner sets in the learning drawer (D-005) — shallow-merged
   * per section over `payloadTemplate` before ANY consumer parses it.
   *
   * A SEAM rather than a direct read, for the same reason `potGate` is one: this
   * file does no I/O, so both entry points wire the SAME production resolver
   * (learning/pot-gate/gates.ts) and neither can drift from the other.
   *
   * It lives HERE, on the shared tick, because putting it in one entry point's
   * body is precisely how it went missing (WI-1664060): the merge existed only
   * in the `system:scout-cycle` routine action, while the `blender:cycle` op is
   * the path that actually runs Scout in production — so the owner's per-pot
   * tuning was written to hive_settings and never read. That is the third
   * instance of this exact shape here (P-051's ceiling and the pot gate were the
   * first two), which is why the layering is applied once, centrally, instead of
   * being remembered a fourth time.
   *
   * Unwired ⇒ no layering (the hermetic unit-test contract), and the production
   * wiring fails OPEN: an unreadable settings row leaves the routine payload
   * untouched rather than stopping a tick.
   */
  resolveConfigDelta?: (input: {
    workspaceId: string;
    installSlug: string;
  }) => Promise<Record<string, Record<string, unknown>> | null>;
}

/**
 * Layer the pot's settings-resident deltas over the routine payload — the ONE
 * place that happens, for either entry point.
 *
 * Shallow PER SECTION (a delta section overrides the payload's same-named block,
 * key by key), matching the semantics this had while it lived in the routine
 * action. Fails OPEN in both directions: no resolver, a throwing resolver, or a
 * null result all yield the input unchanged, so layering can never fail a tick.
 */
async function layerPotConfigDelta(
  input: ScoutCycleInput,
  deps: ScoutCycleDeps,
): Promise<ScoutCycleInput> {
  if (!deps.resolveConfigDelta) return input;
  let delta: Record<string, Record<string, unknown>> | null;
  try {
    delta = await deps.resolveConfigDelta({
      workspaceId: input.workspaceId,
      installSlug: input.installSlug,
    });
  } catch {
    return input;
  }
  if (!delta || typeof delta !== 'object') return input;

  let payloadTemplate = input.payloadTemplate;
  let changed = false;
  for (const [section, sectionDelta] of Object.entries(delta)) {
    if (!sectionDelta || typeof sectionDelta !== 'object' || Array.isArray(sectionDelta)) continue;
    const base = (payloadTemplate ?? {}) as Record<string, unknown>;
    const prior = base[section];
    const baseSection =
      prior && typeof prior === 'object' && !Array.isArray(prior)
        ? (prior as Record<string, unknown>)
        : {};
    payloadTemplate = { ...base, [section]: { ...baseSection, ...sectionDelta } };
    changed = true;
  }
  return changed ? { ...input, payloadTemplate } : input;
}

/**
 * One autonomous Scout tick behind its structural self-gates (cadence → fire-gate →
 * claim → budget, all inside {@link runScoutTick}), then a best-effort governor
 * sub-budget mirror. Returns the tick result so the caller can log. Never depends on
 * a flag or a governor preflight — Scout's gate is the cadence (D-009).
 */
export async function runScoutCycleTick(input: ScoutCycleInput, deps: ScoutCycleDeps): Promise<ScoutTickResult> {
  // Layer the pot's settings-resident deltas FIRST: both consumers below read
  // payloadTemplate (parseScoutCycleConfig for cadence/budget/timeout, and the
  // deps builder for the `scout` block), so merging here — rather than in either
  // caller — is what keeps the two entry points identical (WI-1664060).
  const layered = await layerPotConfigDelta(input, deps);
  const cfg = parseScoutCycleConfig(layered.payloadTemplate);
  const tickDeps = (deps.buildDeps ?? productionDepsBuilder)(layered, deps.runCycle);
  const note = async (rec: ScoutTickRecord): Promise<void> => {
    try {
      await tickDeps.recordTick?.(rec);
    } catch {
      /* best-effort — observability never fails the tick */
    }
  };

  // learning-pot-scope-gate D-001: the per-pot learning master switch, consulted
  // BEFORE every other gate — it is the outermost control, and a pot the owner
  // switched off must not spend a cycle for any reason. Unlike the ceiling gate
  // below, a refusal here does NOT mirror the per-cycle cap to the governor: the
  // pot is off, so there is no live sub-budget to keep current, and writing one
  // would make a switched-off pot look like an active learner in the ledger.
  if (deps.potGate) {
    const pot = await deps.potGate({ workspaceId: input.workspaceId, installSlug: input.installSlug });
    if (!pot.enabled) {
      await note({ status: 'gated', gate: 'pot-disabled', detail: { reason: 'pot-disabled' } });
      return { fired: false, reason: 'pot-disabled' };
    }
  }

  // P-019 (I3): the cross-node SINGLE-RUNNER gate — consulted FIRST, before any
  // cadence/budget/ceiling work. Scout's single-flight (autoloop.claimFire) is a
  // per-NODE CAS, so in a SHARED Hive every node's embedded PG wins its own claim
  // and N nodes run N scout loops (duplicate ideation + duplicate routed backlog +
  // divergent learning). This gate stands a non-runner node down so only the
  // elected per-Hive authority (lowest-live-pubkey) fires the cycle. Fail-open by
  // contract (checkHiveSingleRunner never throws → run:true on any resolution
  // error); unwired ⇒ no gate (hermetic unit tests); at N=1 / standalone it always
  // resolves run:true, so the standalone path is byte-for-byte unchanged.
  if (deps.hiveRunnerGate) {
    const gate = await deps.hiveRunnerGate({ workspaceId: input.workspaceId, installSlug: input.installSlug });
    if (!gate.run) {
      await note({ status: 'gated', gate: 'not-hive-runner', detail: { reason: gate.reason ?? 'not-hive-runner' } });
      return { fired: false, reason: 'not-hive-runner' };
    }
  }

  // P-051 (D-005): the WORKSPACE-WIDE scout spend ceiling — consulted BEFORE the
  // tick. The per-hive per-cycle cap bounds ONE cycle but cannot see the fleet;
  // this aggregate gate refuses a new cycle once Σ `scout:<hive>` spend across the
  // workspace crosses the ceiling, so per-hive scout in aggregate can't saturate
  // the shared Anthropic rate limit / operator daily budget. Flag-gated +
  // fail-open by contract (scout-ceiling.ts), so it never hard-fails a tick; only
  // wired at boot ⇒ the hermetic unit-test path skips it entirely.
  if (deps.workspaceCeilingGate) {
    const ceiling = await deps.workspaceCeilingGate({ workspaceId: input.workspaceId });
    if (!ceiling.allow) {
      // Refused before fanning out — still MIRROR the per-cycle cap (fired:null)
      // so the governor's scout sub-budget stays current even on a held cycle.
      if (deps.recordGovernor) {
        await deps.recordGovernor({
          workspaceId: input.workspaceId,
          harnessSlug: input.installSlug,
          perCycleBudgetUsd: resolveScoutBudget(cfg.budget).maxCostUsd,
          fired: null,
        });
      }
      await note({
        status: 'gated',
        gate: 'workspace-ceiling',
        detail: {
          reason: 'workspace-ceiling',
          totalScoutSpentUsd: ceiling.totalScoutSpentUsd,
          ceilingUsd: ceiling.ceilingUsd,
          scoutLoopCount: ceiling.scoutLoopCount,
        },
      });
      return { fired: false, reason: 'workspace-ceiling' };
    }
  }

  let admissionPressure: WorkItemAdmissionProducerPressure | undefined;
  if (deps.admissionPressureGate) {
    try {
      const admissionScope =
        input.admissionQueueScope.kind === 'workspace'
          ? { workspaceId: input.workspaceId }
          : { workspaceId: input.workspaceId, harnessSlug: input.admissionQueueScope.harnessSlug };
      admissionPressure = await deps.admissionPressureGate(admissionScope);
    } catch {
      // A queue-health read is a throttle hint, never authority to silence the
      // producer. The production reader also returns an explicit unavailable
      // verdict; this keeps injected/legacy seams equally fail-open.
    }
  }
  let governedBudget = cfg.budget;
  if (admissionPressure?.maxIdeators != null) {
    const resolved = resolveScoutBudget(cfg.budget);
    governedBudget = {
      ...resolved,
      maxIdeators: Math.min(resolved.maxIdeators, admissionPressure.maxIdeators),
    };
  }
  const governedTickDeps =
    admissionPressure && tickDeps.recordTick
      ? {
          ...tickDeps,
          recordTick: (record: ScoutTickRecord) =>
            tickDeps.recordTick!({
              ...record,
              detail: { ...(record.detail ?? {}), admissionThrottle: admissionPressure },
            }),
        }
      : tickDeps;

  const result = await runScoutTick(governedTickDeps, {
    ...(cfg.cadence ? { cadence: cfg.cadence } : {}),
    ...(governedBudget ? { budget: governedBudget } : {}),
    ...(cfg.cycleTimeoutMs != null ? { cycleTimeoutMs: cfg.cycleTimeoutMs } : {}),
  });

  // FB-01 (self-learning-frontier P-003): mirror scout's per-cycle cap onto the
  // shared learning-governor ledger as its sub-budget + accumulate a fired cycle's
  // reported spend. Flag-gated (papercusp-learning-governor — the kill-switch) and
  // best-effort by contract — it never throws, so governor bookkeeping can never
  // fail (or replay) the tick. No recorder wired ⇒ hermetic (no governor IO).
  if (deps.recordGovernor) {
    await deps.recordGovernor({
      workspaceId: input.workspaceId,
      harnessSlug: input.installSlug,
      perCycleBudgetUsd: resolveScoutBudget(cfg.budget).maxCostUsd,
      fired:
        result.fired && result.costUsd != null
          ? { costUsd: result.costUsd, ...(result.cycleId ? { cycleId: result.cycleId } : {}) }
          : null,
    });
  }

  return result;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
