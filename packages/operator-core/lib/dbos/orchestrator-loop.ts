/**
 * The DBOS **orchestrator** — the global, deterministic cross-feature selector
 * (formerly "the dispatcher"; renamed per dbos-system-completion-2026-06-01 D-007
 * so there is exactly ONE "orchestrator" = this code component that selects work
 * globally, while the per-feature LLM decision-maker keeps its distinct name
 * `director`). Naming convention: the component is the **orchestrator**; "dispatch"
 * survives only as a *verb* — it dispatches a durable pipeline per feature.
 *
 * When durable orchestration is enabled, this periodically scans the opted-in
 * harnesses for features that need work and starts a durable pipeline per feature
 * (up to a concurrency cap) — the production counterpart to the manual
 * `POST /admin/dbos/pipeline/start` trigger.
 *
 * The dispatch policy is **blueprint-driven** (`autoloop-pot-operator-rebuild-2026-06-05`
 * D-005/D-009, P-006): each harness's *effective blueprint* (the PG cache
 * `harness_shared.blueprints`, lazily projected from the git-canonical
 * `.papercusp/blueprint.yaml`) declares a `dispatch:` section
 * `{ concurrency, priority, readiness, costCapUsd, safetyCeiling }` — so a
 * `coding` harness runs 4 pipelines while `research` runs 1, all declared.
 * Per-install config (`.papercusp/config.json` `parallelWorkers.*` /
 * `maxCostUsd`) overrides the blueprint (instance refines shape); a harness
 * with no blueprint (or no `dispatch:`) keeps the legacy config-only
 * resolution. Enablement is the harness's own blueprint — there is no
 * `director-config.json` / `autoLoop:true` coupling here.
 *
 * The env switches are OVERRIDES, not the policy source (D-009 demotion):
 *   - `PAPERCUSP_DBOS_ORCHESTRATOR=1` — registers the workflow (via bootstrap).
 *   - `PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES` — an override switch on WHICH
 *     harnesses are swept: unset/`'*'` → all (the default since P-009);
 *     `none`/`off` → explicit opt-out (e.g. the contended shared dev box); a
 *     comma list → a scoped allowlist. The legacy
 *     `PAPERCUSP_DBOS_DISPATCH_HARNESSES` is still accepted as an alias (D-007).
 *   - `PAPERCUSP_DBOS_MAX_PIPELINES` — OPTIONAL global concurrency ceiling that
 *     clamps every harness (e.g. the shared dev box); unset → each harness uses
 *     its blueprint/config cap up to a hard `SAFETY_CEILING` (#1, D-007: the
 *     ceiling stays imperative code a blueprint can tighten but never raise).
 *
 * Concurrency is per-harness, not a flat global (#1): each harness fills its own
 * slots up to `resolvePerHarnessCap` (from its `parallelWorkers.max` /
 * `maxFeaturesInFlight` config, falling back to the blueprint's declared
 * `dispatch.concurrency`). Two paths feed it: the periodic 30s tick (the backstop
 * that picks up newly-filed work) and `refillHarnessOnSettle` (a finished feature
 * immediately refills its freed slot — continuous dispatch rather than ≤30s lag).
 *
 * The frontier (P-042) reads the full plan-gated feature set + each feature's
 * `blocked_by` edges from the consolidated source of truth, and the carve-out
 * (`durableOwnedFeatureIdsPg`) excludes features a live pipeline owns from the
 * dispatch CANDIDATES (while keeping them in the dependency graph so an in-flight
 * blocker still blocks its dependents). So a re-scan only ever picks NEW, ready
 * work; combined with `ensureFeaturePipeline`'s dedup, the tick is idempotent and
 * safe to re-run wholesale on recovery (we WANT a fresh re-scan, not a cached
 * replay — hence the scheduled workflow calls the tick directly, not via steps).
 */
import { join } from 'node:path';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { idempotentRegisterWorkflow } from './idempotent-register-workflow';
import postgres from 'postgres';
import { isLocalDeployment } from '@papercusp/deployment-driver';
// Side-effect: register the cloud backends so the placement gate knows a
// `{target:'latitude'}` harness is REMOTE (skipped here — its frame's own loop owns it).
import '../deployment/configure';
import type { ProjectEntry } from '../harness-registry';
import { readEffectiveHarnessConfig } from '../harness-effective-config';
import {
  durableOwnedFeatureIdsPg,
  configGet,
  evaluateCostCap,
  parallelMaxWorkers,
  maxFeaturesInFlight,
  dispatchAuditorLane,
} from '@papercusp/orchestrator';
import type { AuditorSpawnFn, CreateEscalationFn, HarnessConfig } from '@papercusp/orchestrator';
import {
  blueprintRetirement,
  describeBlueprintRetirement,
  type BlueprintDispatch,
  type BlueprintRetirementInfo,
} from '@papercusp/orchestrator/blueprint';
import { getEffectiveBlueprint } from '../blueprint/project-to-pg';
import { getHarnessAdminUrl } from '../embedded-pg-discovery';
import { backgroundWorkspaceIds } from '../workspace-registry';
import { runWithWorkspace } from '../workspace-als';
import { listAllHarnesses } from '../dev-data';
import { listStartedPots } from '../pot/started';
import { resolveProject } from '../harness-core';
import { convertOpenIssuesToFeatures } from '../promote-issue';
import { loadIssuesOrSeed, saveIssues } from '../harness-issues';
import type { Issue } from '../harness/issue-types';
import { ensureFeaturePipeline } from './orchestrator-start';
import { adminClientForHarness } from './admin-pg-cache';
import {
  workItemClaimLeaseEnabled,
  leaseFeatureForExecutor,
  type WorkItemClaimLeaseHandle,
} from '../work-item-claim-lease-wiring';
import { defaultBlockingStore } from '../work-item-blocking';
import type { WorkItemBlockerRequirement } from './work-item-deps-store';
import { selectReady } from './frontier-readiness';
import { getCachedRateLimitConfig } from '../rate-limit-config';
import { getResourceProfile } from '../resource-profile';

// ─── G2 Auditor lane injection seam (P-007) ──────────────────────────────────
//
// The operator wires the real spawn + escalation functions via
// `setAuditorLaneFns`. Tests and the legacy path leave them null (no-op).
// Both are best-effort: a missing wiring means the auditor lane is skipped,
// which leaves remote features quarantined but never blocks dispatch.
let _auditorSpawn: AuditorSpawnFn | null = null;
let _createEscalation: CreateEscalationFn | null = null;

export function setAuditorLaneFns(
  spawnFn: AuditorSpawnFn,
  escalationFn: CreateEscalationFn,
): void {
  _auditorSpawn = spawnFn;
  _createEscalation = escalationFn;
}

/**
 * Feature statuses that warrant starting a durable pipeline. The live vocabulary
 * is `todo` (not started) / `failing` (failed validation, needs rework); the
 * `pending`/`failed` aliases from the FeatureRecord type are kept for safety.
 * `in_progress` is excluded (already being worked), as are `passed`/`blocked`/
 * `deprecated`/`proposed`.
 *
 * Since D-005 this is the DEFAULT readiness set — a harness blueprint's
 * `dispatch.readiness` overrides it (and the schema's own default for a declared
 * `dispatch:` is this exact set, so declared-but-unspecified stays equivalent).
 */
const NEEDS_WORK: ReadonlySet<string> = new Set(['todo', 'failing', 'pending', 'failed']);

/**
 * EI-203: hard ceiling on consecutive same-failure re-dispatches. Confirmed bug
 * (2026-07-17): NOTHING previously capped this — a feature that keeps landing
 * back in `failing` was re-selected by computeFrontier and handed a fresh DBOS
 * epoch by `ensureFeaturePipeline` every 30s tick (or immediately on
 * `refillHarnessOnSettle`) FOREVER, burning a full director+worker+curator run
 * each time. `harness_shared.work_items.attempts` already exists for exactly
 * this (and already drives the debugger-gate threshold in
 * orchestrator-runner.ts), but the legacy bump path
 * (`libs/papercusp/packages/orchestrator/src/state-pg.ts` `setFeatureStatusPg`)
 * writes the unqualified `harness_features` name, which is a READ-ONLY
 * fallback view on a consolidated-only operator (497-harness-features-shared-
 * fallback-view.sql) — verified empirically that every feature on this harness
 * reads `attempts = 0` regardless of status, so that path never actually
 * increments it here. This dispatch loop now owns bumping/resetting `attempts`
 * itself (writing the REAL base table `harness_shared.work_items` directly —
 * see `bumpOrResetAttempts` below) rather than depending on that dead path.
 * Deliberately higher than the debugger's default threshold (3) so the
 * debugger gets a shot at auto-recovery first. Env override for tuning.
 */
const DEFAULT_MAX_FAILING_ATTEMPTS = 6;
function resolveMaxFailingAttempts(): number {
  const raw = process.env.PAPERCUSP_MAX_FAILING_ATTEMPTS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_FAILING_ATTEMPTS;
}

/**
 * Check if a task deadline has passed. Correctly handles both ISO string and Date
 * object deadlines by converting them to the same type before comparison.
 *
 * @param deadline - The deadline to check, either as an ISO string or Date object
 * @returns true if the deadline has passed, false otherwise
 */
export function isOverdue(deadline: string | Date): boolean {
  // Convert deadline to Date object if it's a string
  const deadlineDate = typeof deadline === 'string' ? new Date(deadline) : deadline;
  // Compare with current time
  return deadlineDate < new Date();
}

/** Hard safety ceiling on per-harness pipeline concurrency (F-E2 of app-wide-load-traps).
    Scales with host resources: derived from maxSimultaneousAgents (the resource-profile's
    cores-scaled agent budget) with a 2× buffer to allow per-harness flexibility while
    still preventing runaway dispatch. A misconfigured harness (`parallelWorkers.max: 1000`)
    must not spawn 1000 pipelines; this caps the blast radius while honoring sane settings. */
export function getSafetyCeiling(): number {
  return Math.min(Math.ceil(getResourceProfile().maxSimultaneousAgents * 2), 64);
}

/**
 * Per-harness pipeline concurrency cap (#1 — concurrency-aware dispatch). DBOS
 * runs one pipeline per in-flight feature, so the cap on concurrent pipelines is
 * the harness's own feature-concurrency budget — NOT a flat global:
 *   - `parallelWorkers.max` (per-install config) is the worker budget; with one
 *     worker per feature (chunk-loop), that bounds how many features can run at
 *     once. Pass `null` when the config is SILENT — then the blueprint's
 *     declared `dispatch.concurrency` fills the budget (D-005), and 1 is the
 *     floor when neither declares.
 *   - `parallelWorkers.maxFeaturesInFlight`, when set, tightens that further
 *     (cap distinct features below the worker budget) but never widens past it.
 *   - `blueprintSafetyCeiling` (`dispatch.safetyCeiling`) tightens the default
 *     ceiling for this harness shape; it can never RAISE it past the imperative
 *     `SAFETY_CEILING` (D-007 — safety stays deterministic code).
 *   - `envCeiling` (`PAPERCUSP_DBOS_MAX_PIPELINES`) is an optional global clamp
 *     (e.g. the shared dev box) that replaces the resolved ceiling outright (the
 *     operator's explicit box-level override, as before).
 * Always at least 1 (a harness can never be dispatch-starved by config).
 */
export function resolvePerHarnessCap(opts: {
  /** Explicit per-install worker budget, or null when config doesn't set one. */
  parallelMax: number | null;
  maxFeaturesInFlight: number | null;
  envCeiling?: number;
  /** Blueprint-declared `dispatch.concurrency` — fills a silent config (D-005). */
  blueprintConcurrency?: number | null;
  /** Blueprint-declared `dispatch.safetyCeiling` — tighten-only (D-007). */
  blueprintSafetyCeiling?: number | null;
  /** The user's live fleet-wide `maxSimultaneousAgents` (rate-limit-layer-v2 D-004) — a
      per-harness cap can never exceed the whole fleet's budget. Omit/null = no fleet clamp. */
  fleetCap?: number | null;
}): number {
  const declared =
    opts.blueprintConcurrency != null &&
    Number.isFinite(opts.blueprintConcurrency) &&
    opts.blueprintConcurrency > 0
      ? Math.floor(opts.blueprintConcurrency)
      : null;
  const budget =
    opts.parallelMax != null && Number.isFinite(opts.parallelMax)
      ? opts.parallelMax
      : declared ?? 1;
  const base =
    opts.maxFeaturesInFlight != null && opts.maxFeaturesInFlight > 0
      ? Math.min(budget, opts.maxFeaturesInFlight)
      : budget;
  const declaredCeiling =
    opts.blueprintSafetyCeiling != null && opts.blueprintSafetyCeiling > 0
      ? Math.min(Math.floor(opts.blueprintSafetyCeiling), getSafetyCeiling())
      : getSafetyCeiling();
  const ceiling = opts.envCeiling && opts.envCeiling > 0 ? opts.envCeiling : declaredCeiling;
  // Fleet-wide clamp (D-004): the live maxSimultaneousAgents bounds every harness's cap (the
  // governor's global gate enforces the precise cross-harness total; this keeps the dispatcher
  // from even ENQUEUEING past the fleet budget). Floor of 1 below keeps dispatch alive.
  const fleetClamped =
    opts.fleetCap != null && Number.isFinite(opts.fleetCap) && opts.fleetCap > 0
      ? Math.min(ceiling, Math.floor(opts.fleetCap))
      : ceiling;
  return Math.max(1, Math.min(base, fleetClamped));
}

/** A feature as the frontier sees it (P-042): status + resolved blocked_by edges
 *  + which plan it belongs to + its within-plan order. */
export interface FrontierFeature {
  id: string;
  status: string;
  /** Resolved canonical blocker ids (P-046). Empty when unblocked. */
  blockedBy: readonly (string | WorkItemBlockerRequirement)[];
  /** metadata.source_plan — null for manual/legacy features. */
  sourcePlan: string | null;
  /** feature_order — null when unset (ordered last within its plan group). */
  order: number | null;
  /** EI-203: harness_shared.work_items.attempts — consecutive same-failure re-dispatch count. Optional (default 0) so an older caller that doesn't populate it is unaffected. */
  attempts?: number;
  /** EI-203: harness_shared.work_items.needs_human_review — already durably parked out of auto-dispatch. Optional (default false). */
  needsHumanReview?: boolean;
}

/**
 * The frontier dispatch selection (P-042 / D-012 / D-013), replacing the old
 * flat `eligible.filter(NEEDS_WORK).slice(slots)`. One pass, O(V+E):
 *   1. terminal = features that are passed/deprecated.
 *   2. ready    = needs-work, not already in-flight (`owned`), and every
 *                 blocked_by SATISFIED — a blocker is satisfied iff it is
 *                 terminal OR absent from the set (an absent id never deadlocks;
 *                 a `failing` blocker is non-terminal, so its dependents
 *                 correctly stay blocked).
 *   3. group ready by plan; order groups by `planPriority` (lower first; a plan
 *      with no resolved priority, and the manual/no-plan group, sort LAST),
 *      tie-break by plan slug; within a group by (order ASC NULLS LAST, id).
 *   4. fill greedily up to `slots`: a higher-priority plan monopolizes the
 *      harness until its ready features can't fill the cap, then the next plan
 *      fills the gap (owner's strict-priority spec) — the blocked_by frontier
 *      naturally lets a lower plan fill when a higher plan's features are all
 *      blocked. `slots <= 0` (cap full, or over the cost cap) → start nothing.
 * Also returns `stuck`: work remains but nothing is ready (all remaining are
 * blocked/failing) — the P-044 stuck-wave signal the retired sweep used to raise.
 *
 * `readiness` is the dispatchable-status set — the blueprint's declared
 * `dispatch.readiness` (D-005), defaulting to the legacy `NEEDS_WORK` set so an
 * undeclared policy is byte-equivalent to the pre-lift behavior.
 *
 * EI-203 attempts cap: a feature that is otherwise ready per status/blockers is
 * EXCLUDED from `toStart` (never occupies a dispatch slot, never re-enters the
 * pipeline) once it is already `needsHumanReview` OR its `attempts` has reached
 * `maxAttempts` — but it stays in the full `features` set fed to `selectReady`,
 * so it still correctly satisfies/blocks its own dependents (readiness is
 * status-based, unaffected by this split; only SELECTION is). `capped` returns
 * the ids that just NEWLY crossed the cap this call (not yet `needsHumanReview`)
 * so the caller can durably flag them — an already-flagged feature is silently
 * re-excluded every tick with no repeat write.
 */
export function computeFrontier(
  features: readonly FrontierFeature[],
  planPriority: ReadonlyMap<string, number>,
  owned: ReadonlySet<string>,
  slots: number,
  readiness: ReadonlySet<string> = NEEDS_WORK,
  maxAttempts: number = resolveMaxFailingAttempts(),
): { toStart: string[]; stuck: boolean; capped: string[] } {
  // Readiness is the SHARED predicate (frontier-readiness.ts) the Queen's
  // placement survey reuses verbatim (W-01/D-002) — a feature is ready iff its
  // status is dispatchable, it isn't owned (in-flight), and every blocked_by is
  // satisfied (terminal or absent). ORDERING below stays orchestrator-specific.
  const { ready: readyRaw, blocked } = selectReady(features, owned, readiness);

  // EI-203: split off attempts-capped / already-flagged features BEFORE grouping,
  // so they never fill a dispatch slot. `capped` (the return value) carries only
  // the NEWLY-crossed ones — already-`needsHumanReview` features are excluded
  // here too but omitted from the return (no repeat flag-write needed).
  const capped: string[] = [];
  const ready: FrontierFeature[] = [];
  for (const f of readyRaw) {
    if (f.needsHumanReview === true) continue; // already parked in an earlier tick
    if ((f.attempts ?? 0) >= maxAttempts) {
      capped.push(f.id);
      continue;
    }
    ready.push(f);
  }

  // Group ready by plan ('' = manual / no source_plan).
  const groups = new Map<string, FrontierFeature[]>();
  for (const f of ready) {
    const key = f.sourcePlan ?? '';
    const g = groups.get(key);
    if (g) g.push(f);
    else groups.set(key, [f]);
  }
  const prioOf = (key: string): number =>
    key === '' ? Number.POSITIVE_INFINITY : planPriority.get(key) ?? Number.POSITIVE_INFINITY;
  const orderedGroups = [...groups.keys()].sort((a, b) => {
    const pa = prioOf(a);
    const pb = prioOf(b);
    if (pa !== pb) return pa - pb;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const ordered: string[] = [];
  for (const key of orderedGroups) {
    const g = groups.get(key)!.slice().sort((x, y) => {
      const ox = x.order ?? Number.POSITIVE_INFINITY;
      const oy = y.order ?? Number.POSITIVE_INFINITY;
      if (ox !== oy) return ox - oy;
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
    });
    for (const f of g) ordered.push(f.id);
  }

  const toStart = slots > 0 ? ordered.slice(0, slots) : [];
  // stuck = dispatchable, non-owned work remains (ready+blocked+capped) but none is
  // actually startable — the P-044 stuck-wave signal. EI-203: a capped feature
  // counts toward "remains" the same way a blocked one does (it needs a human, not
  // another automatic retry) so the frontier doesn't read as falsely idle.
  return { toStart, stuck: ready.length === 0 && (blocked.length > 0 || capped.length > 0), capped };
}

/** Explicit opt-out sentinels (e.g. the shared dev box, to avoid flooding it). */
const DISPATCH_OFF = new Set(['none', 'off']);

/**
 * The harness-scope OVERRIDE switch (D-009: demoted from policy source — the
 * per-harness dispatch policy itself lives on the blueprint). Primary env is
 * `PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES`; the legacy `PAPERCUSP_DBOS_DISPATCH_HARNESSES`
 * is still honored as a back-compat alias (D-007 rename). Same grammar either way.
 */
function orchestratorHarnessesEnv(): string | undefined {
  return (
    process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES ??
    process.env.PAPERCUSP_DBOS_DISPATCH_HARNESSES
  );
}

/**
 * Resolve which harnesses the orchestrator serves from the env value + the full
 * workspace harness list (P-006/P-009). Pure (testable). Since P-009, DBOS is the
 * DEFAULT orchestrator for every harness:
 *   - empty / unset / `'*'` → ALL harnesses in the workspace (the default);
 *   - `'none'` / `'off'` → disabled (explicit opt-out — the legacy path is retired,
 *     so this just means "don't auto-dispatch here", e.g. a contended shared box);
 *   - an explicit comma list → that allowlist (scoped override).
 */
export function resolveOrchestratorHarnesses(
  envRaw: string | undefined,
  allSlugs: string[],
): string[] {
  const v = (envRaw ?? '').trim();
  if (DISPATCH_OFF.has(v.toLowerCase())) return [];
  if (v === '' || v === '*') return allSlugs;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Whether to arm the 30s scheduled tick: anything but an explicit opt-out (P-009). */
export function shouldScheduleOrchestrator(envRaw: string | undefined): boolean {
  const v = (envRaw ?? '').trim();
  return !DISPATCH_OFF.has(v.toLowerCase());
}

/**
 * The concrete harness slugs to sweep this tick. In all-mode (`'*'`) enumerate
 * every harness in the active workspace; otherwise use the explicit allowlist —
 * then GATE the result on the Start-Hive bit so a STOPPED / never-started hive's
 * backlog (and non-hive legacy harnesses) is never placed. The Start-Hive KV
 * (`hive/started.ts`) is the one lever that governs waking AND placement — before
 * this, placement sept every harness regardless of started-state (the gap the
 * owner flagged: "the Queen shouldn't be able to pick up a stopped hive's work").
 * Fail-safe: an unreadable started-set places nothing. Exported for tests.
 */
export async function resolveTickHarnesses(workspaceId: string): Promise<string[]> {
  const envRaw = orchestratorHarnessesEnv();
  let candidates: string[];
  if ((envRaw ?? '').trim() !== '*') {
    candidates = resolveOrchestratorHarnesses(envRaw, []);
  } else {
    try {
      const { harnesses } = await listAllHarnesses([workspaceId]);
      candidates = harnesses.map((h) => h.slug);
    } catch {
      return [];
    }
  }
  // Only STARTED hives get their work placed. A stopped hive, or a harness that
  // was never started, is filtered out — placement means the same thing start/stop
  // does. Fail-safe on an unreadable started-set (place nothing).
  //
  // Per-hive start-stop (2026-06-30): the gate is the candidate's OWN per-hive
  // started row. The old WORKSPACE_COORDINATION "widening" (the workspace sentinel
  // resolving started for EVERY hive) is gone — start/stop is now genuinely
  // per-hive. `listStartedPots()` reads the raw per-hive rows; the workspace Queen
  // LOOP liveness stays on the sentinel (watchdog/wake), unchanged.
  try {
    const startedRows = (await listStartedPots()).filter((h) => h.workspaceId === workspaceId);
    const startedSlugs = new Set(startedRows.map((h) => h.installSlug));
    return candidates.filter((slug) => startedSlugs.has(slug));
  } catch {
    return [];
  }
}

/** Optional global concurrency ceiling (`PAPERCUSP_DBOS_MAX_PIPELINES`). When set
 * it clamps every harness's resolved cap (e.g. on the shared dev box); unset →
 * `undefined`, so `resolvePerHarnessCap` falls back to its `SAFETY_CEILING`. */
function pipelineEnvCeiling(): number | undefined {
  const n = Number(process.env.PAPERCUSP_DBOS_MAX_PIPELINES);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export interface HarnessDispatchGate {
  /** Per-harness pipeline concurrency cap (config, else `dispatch.concurrency`). */
  cap: number;
  /** Whether the harness is over its cost cap (config `maxCostUsd`, else `dispatch.costCapUsd`). */
  overCostCap: boolean;
  /** Dispatchable statuses (`dispatch.readiness`; legacy NEEDS_WORK when undeclared). */
  readiness: ReadonlySet<string>;
  /**
   * WI-5645 (no-retirement-launch-guard): non-null when the harness's effective
   * blueprint (or any ancestor in its `extends` chain) is retired — the launch
   * eligibility verdict `blueprintRetirement()` reads off the resolved blueprint.
   * A retired harness gets ZERO new-pipeline slots (same lever as `overCostCap`),
   * so no autoloop (gym or otherwise) can spend against it. `null` when eligible
   * or when the blueprint couldn't be resolved (fail-open — matches every other
   * gate in this function; a bad slug must never strand work).
   */
  blueprintRetirement: BlueprintRetirementInfo | null;
  /** The resolved blueprint id `blueprintRetirement` (when non-null) applies to. */
  blueprintId: string | null;
}

/**
 * Merge the blueprint-declared `dispatch:` policy with the per-install config
 * (D-005 / P-006). Pure — the IO half (`resolveHarnessDispatchGate`) feeds it.
 * Precedence: per-install config overrides the blueprint (instance refines
 * shape); the blueprint fills where config is silent; imperative clamps
 * (`SAFETY_CEILING`, env ceiling) apply on top (D-007).
 *
 * Returns the cap + readiness plus the `effectiveCfg` the cost-cap evaluator
 * should run against: when config has no `maxCostUsd` and the blueprint
 * declares `dispatch.costCapUsd`, the cap is overlaid so `evaluateCostCap`'s
 * whole warn/pause machinery sees one consistent value.
 */
export function resolveDispatchPolicy(opts: {
  dispatch: BlueprintDispatch | null | undefined;
  cfg: HarnessConfig;
  envCeiling?: number;
  /** Live fleet-wide maxSimultaneousAgents (D-004); the IO half passes the cached config. */
  fleetCap?: number | null;
}): { cap: number; readiness: ReadonlySet<string>; effectiveCfg: HarnessConfig } {
  const { dispatch, cfg } = opts;
  // Explicitness matters: `parallelMaxWorkers(cfg)` returns 1 for BOTH "unset"
  // and "set to 1", but only an unset config should defer to the blueprint.
  const explicitParallelMax =
    configGet<number | string | null>(cfg, 'parallelWorkers.max', null) != null
      ? parallelMaxWorkers(cfg)
      : null;
  const cap = resolvePerHarnessCap({
    parallelMax: explicitParallelMax,
    maxFeaturesInFlight: maxFeaturesInFlight(cfg),
    envCeiling: opts.envCeiling,
    blueprintConcurrency: dispatch?.concurrency ?? null,
    blueprintSafetyCeiling: dispatch?.safetyCeiling ?? null,
    fleetCap: opts.fleetCap ?? null,
  });
  const effectiveCfg =
    dispatch?.costCapUsd != null && configGet<number | null>(cfg, 'maxCostUsd', null) == null
      ? ({ ...cfg, maxCostUsd: dispatch.costCapUsd } as HarnessConfig)
      : cfg;
  const readiness: ReadonlySet<string> = dispatch ? new Set(dispatch.readiness) : NEEDS_WORK;
  return { cap, readiness, effectiveCfg };
}

/**
 * Resolve a harness's dispatch gates for one tick (P-006): the harness's
 * EFFECTIVE BLUEPRINT (the PG cache `harness_shared.blueprints`, lazily
 * projected from the git-canonical `.papercusp/blueprint.yaml`) declares the
 * `dispatch:` policy; the per-install `.papercusp/config.json` refines it
 * (`resolveDispatchPolicy`); `evaluateCostCap` checks run-log spend against the
 * effective cost cap. Best-effort at every layer: a missing/corrupt blueprint →
 * the legacy config-only resolution (a non-blueprint harness behaves exactly as
 * before the lift); any resolution/read failure → the safe defaults (`cap: 1`,
 * `overCostCap: false`, legacy readiness) so a bad slug never strands work or
 * floods the box.
 */
async function resolveHarnessDispatchGate(
  pg: ReturnType<typeof postgres>,
  slug: string,
  workspaceId: string,
): Promise<HarnessDispatchGate> {
  try {
    const project = await resolveProject(slug, workspaceId);
    if (!project) return { cap: 1, overCostCap: false, readiness: NEEDS_WORK, blueprintRetirement: null, blueprintId: null };
    const stateDir = join(project.path, '.papercusp');
    const logDir = join(stateDir, 'logs');
    // Effective config from the blueprint (⊕ workspace-PG instance overrides), not
    // config.json (deprecate-harness-config-json-2026-06-06).
    const cfg = await readEffectiveHarnessConfig(slug, workspaceId, project.path);
    const effectiveBlueprint = await getEffectiveBlueprint(pg as never, {
      workspaceId,
      harnessSlug: slug,
      blueprintPath: join(stateDir, 'blueprint.yaml'),
    }).catch((error) => {
      console.warn(
        `[dbos-orchestrator] effective-blueprint resolve failed (${slug}): ` +
          `${error instanceof Error ? error.message : error}`,
      );
      return null;
    });
    const dispatch = effectiveBlueprint?.dispatch ?? null;
    // WI-5645: the resolved blueprint already carries its ancestor chain's
    // `retired` (extends deep-merges it), so one read here covers every
    // extends-derived harness (e.g. external-bench ⟶ coding-factory) too.
    const retirement = effectiveBlueprint ? blueprintRetirement(effectiveBlueprint) : null;
    const { cap, readiness, effectiveCfg } = resolveDispatchPolicy({
      dispatch,
      cfg,
      envCeiling: pipelineEnvCeiling(),
      // Live fleet cap (D-004): the user's maxSimultaneousAgents bounds dispatch fleet-wide.
      fleetCap: getCachedRateLimitConfig().maxSimultaneousAgents,
    });
    const overCostCap = evaluateCostCap(effectiveCfg, logDir, stateDir).overCap;
    return { cap, overCostCap, readiness, blueprintRetirement: retirement, blueprintId: effectiveBlueprint?.id ?? null };
  } catch {
    return { cap: 1, overCostCap: false, readiness: NEEDS_WORK, blueprintRetirement: null, blueprintId: null };
  }
}

/** Count live (PENDING/ENQUEUED) pipelines for one harness. */
async function liveCountFor(harnessSlug: string): Promise<number> {
  const live = await DBOS.listWorkflows({
    workflow_id_prefix: `pipeline:${harnessSlug}:`,
    status: ['PENDING', 'ENQUEUED'],
  });
  return live.length;
}

export interface OrchestratorTickResult {
  harness: string;
  started: string[];
}

/**
 * P-011 (D-004 / D-016): the automated CONVERT_ISSUES sweep. Promote every open
 * `critical`/`major` issue with no linked feature to an `F-FIX` feature so the
 * substrate fixes it under DBOS (the legacy `CONVERTED` verb was just an
 * agent-side receipt; this is deterministic code). Best-effort and isolated —
 * any failure is swallowed so it can never sink the dispatch path — and the
 * sweep's own per-`(workspace, harness)` in-process mutex makes the 30s-tick +
 * on-settle-refill double-fire idempotent (no double-mint).
 */
async function convertIssuesForHarness(slug: string, workspaceId: string): Promise<void> {
  const project = await resolveProject(slug, workspaceId);
  if (!project) return;
  const { promoted } = await convertOpenIssuesToFeatures(project, { workspaceId });
  if (promoted.length > 0) {
    console.log(
      `[dbos-orchestrator] ${slug} converted ${promoted.length} issue(s) → F-FIX: ` +
        promoted.map((p) => `${p.issueId}→${p.featureId}`).join(', '),
    );
  }
}

/** The persistent stuck-frontier issue id (one per harness; idempotent). */
const STUCK_ISSUE_ID = 'I-STUCK';
const OPEN_STATUSES = new Set(['open', 'acknowledged', 'fixing']);

/**
 * P-044: surface the frontier `stuck` state as a persistent harness issue — the
 * observability the retired wave-advance sweep's `onBlocked` (I-WAVE-*) provided.
 * Idempotent: raises one open `I-STUCK` while stuck (no re-save if already open),
 * and auto-closes it when work becomes ready again. Best-effort.
 */
async function raiseOrClearStuckSignal(slug: string, workspaceId: string, stuck: boolean): Promise<void> {
  const project = await resolveProject(slug, workspaceId);
  if (!project) return;
  const file = await loadIssuesOrSeed(project);
  const existing = file.issues.find((i) => i.id === STUCK_ISSUE_ID);
  const isOpen = !!existing && OPEN_STATUSES.has(existing.status);
  const now = new Date().toISOString();
  if (stuck) {
    if (isOpen) return; // already raised — idempotent, no write
    if (existing) {
      existing.status = 'open';
      existing.notes.push({ ts: now, by: 'orchestrator', text: 'Frontier stuck again — work remains but nothing is ready.' });
    } else {
      file.issues.unshift({
        id: STUCK_ISSUE_ID,
        title: 'Dispatch frontier stuck — work remains but nothing is ready',
        severity: 'major',
        source: 'system',
        foundAt: now,
        status: 'open',
        evidence:
          `Harness "${slug}" has features needing work, but every remaining one is blocked ` +
          `(its blocked_by isn't satisfied) or failing, so the dependency frontier can't advance. ` +
          `Resolve a failing/blocking feature (or deprecate it), or fix a dependency cycle.`,
        attempts: 0,
        notes: [],
      } as Issue);
    }
    await saveIssues(project, file);
  } else {
    if (!isOpen) return; // nothing to clear
    existing!.status = 'closed';
    existing!.notes.push({ ts: now, by: 'orchestrator', text: 'Frontier no longer stuck — work became ready.' });
    await saveIssues(project, file);
  }
}

/**
 * P-004 (cloud-deployment-layer-2026-06-06): does the LOCAL orchestrator dispatch
 * this harness, or does its execution plane run on a remote frame (so the frame's
 * own co-located orchestrator loop owns dispatch — D-006)? Consults the deployment
 * driver's placement. Pure + testable. A null project (slug not in this workspace)
 * and every local harness → `true`, so the gate is a NO-OP for all existing
 * harnesses (none carry a non-local deployment); only a harness pinned to a
 * registered REMOTE driver returns `false`.
 */
export function harnessDispatchesLocally(project: Pick<ProjectEntry, 'deployment'> | null): boolean {
  return project == null || isLocalDeployment(project.deployment);
}

/**
 * EI-203: durably flag newly attempts-capped features `needs_human_review = true`
 * on the REAL base table (`harness_shared.work_items` — see the DEFAULT_MAX_
 * FAILING_ATTEMPTS doc comment for why NOT the legacy `harness_features` name).
 * Idempotent (WHERE excludes already-true rows) and best-effort — a write
 * failure here must never sink dispatch; the feature just gets re-evaluated
 * (and re-excluded, since computeFrontier already dropped it this tick) next
 * time regardless.
 */
async function flagNeedsHumanReview(
  pg: ReturnType<typeof postgres>,
  workspaceId: string,
  slug: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  try {
    await pg`
      UPDATE harness_shared.work_items
         SET needs_human_review = true, updated_ts = ${Date.now()}
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${slug}
         AND feature_id = ANY(${ids})
         AND needs_human_review IS NOT TRUE
    `;
    console.warn(
      `[dbos-orchestrator] ${slug} EI-203: ${ids.length} feature(s) hit the failing-attempts cap ` +
        `(${resolveMaxFailingAttempts()}) — flagged needs_human_review, excluded from auto-dispatch: ${ids.join(', ')}`,
    );
  } catch (err) {
    console.warn(`[dbos-orchestrator] ${slug} EI-203 flagNeedsHumanReview failed (non-fatal):`, (err as Error).message);
  }
}

/**
 * EI-203: bump or reset a feature's `attempts` counter around a genuine NEW
 * pipeline start (never on a `reuse` of an already-live pipeline — no new
 * attempt occurred). `wasFailing` = the feature's status at candidate-select
 * time this tick: still `failing` → this is another consecutive same-failure
 * retry, bump; anything else (a fresh `todo`/reopened dispatch) → reset to 0
 * so an unrelated past failing streak doesn't count against a feature that has
 * since moved on. Best-effort, never sinks dispatch.
 */
async function bumpOrResetAttempts(
  pg: ReturnType<typeof postgres>,
  workspaceId: string,
  slug: string,
  featureId: string,
  wasFailing: boolean,
): Promise<void> {
  try {
    if (wasFailing) {
      await pg`
        UPDATE harness_shared.work_items
           SET attempts = COALESCE(attempts, 0) + 1, updated_ts = ${Date.now()}
         WHERE workspace_id = ${workspaceId} AND harness_slug = ${slug} AND feature_id = ${featureId}
      `;
    } else {
      await pg`
        UPDATE harness_shared.work_items
           SET attempts = 0, updated_ts = ${Date.now()}
         WHERE workspace_id = ${workspaceId} AND harness_slug = ${slug} AND feature_id = ${featureId}
           AND COALESCE(attempts, 0) <> 0
      `;
    }
  } catch (err) {
    console.warn(`[dbos-orchestrator] ${slug}/${featureId} EI-203 bumpOrResetAttempts failed (non-fatal):`, (err as Error).message);
  }
}

/**
 * Dispatch for ONE harness: read eligible (non-owned) features, fill the free
 * slots up to the harness's own concurrency `cap`, and `ensureFeaturePipeline`
 * each. Used by both the periodic sweep and the on-completion refill seam (#1).
 * A failure is isolated (returns `started: []`, never throws).
 */
export async function dispatchOneHarness(
  slug: string,
  workspaceId: string,
  adminUrl: string = getHarnessAdminUrl(),
): Promise<OrchestratorTickResult> {
  // P-004: consult the deployment driver for placement BEFORE touching PG. A
  // remote-frame harness is dispatched by THAT frame's own orchestrator loop, so
  // the local orchestrator skips it here (the single choke point both the 30s
  // tick and refillHarnessOnSettle funnel through). LocalDriver → local → no
  // change for every existing harness.
  const placementProject = await resolveProject(slug, workspaceId).catch(() => null);
  if (!harnessDispatchesLocally(placementProject)) {
    return { harness: slug, started: [] };
  }
  // P4-1 (operator-scalability-event-loop) / F-B1 (app-wide-load-traps): reuse a
  // cached admin client per (url, harness) rather than opening + ending a fresh
  // postgres(max:1) pool every 30s tick AND every pipeline settle — the per-tick
  // pool churn this plan targets. Same LRU the debugger gate uses (admin-pg-cache),
  // so dispatch + debugger share ONE connection per harness. The client is owned by
  // the cache, NOT this call — do not `.end()` it in `finally`.
  const pg = adminClientForHarness(slug, adminUrl);
  try {
    // P-011: auto-promote qualifying open issues → F-FIX features BEFORE the
    // feature read, so a freshly-minted fix is eligible this same tick. Its own
    // try/catch guarantees a convert failure never sinks dispatch.
    await convertIssuesForHarness(slug, workspaceId).catch(() => {});
    // G2 P-007: screen any remote+pending features through the auditor BEFORE the
    // pick loop considers them. The P-008 gate already blocks them from being
    // picked while pending; this lane resolves the verdict so admitted features
    // become eligible this same tick. Best-effort: a missing wiring or failure
    // leaves features quarantined (fail-safe) and never sinks dispatch.
    if (_auditorSpawn && _createEscalation) {
      await dispatchAuditorLane(
        {
          pg: pg as never,
          workspaceId,
          spawnAuditor: _auditorSpawn,
          createEscalation: _createEscalation,
          log: (m) => console.log(m),
        },
        slug,
      ).catch((err) => {
        console.warn(`[dbos-orchestrator] ${slug} auditor lane error (non-fatal):`, (err as Error).message);
      });
    }
    // P-042: the frontier reads the FULL gated feature set (incl. its blocked_by
    // edges + plan + order) from the consolidated source of truth — NOT the
    // carved-out view set — so an in-flight blocker correctly still blocks its
    // dependents. The carve-out (`owned`) is applied to dispatch CANDIDATES, not
    // to the dependency graph.
    const [features, owned, planPriority] = await Promise.all([
      readFrontierFeatures(pg, workspaceId, slug),
      durableOwnedFeatureIdsPg({ pg: pg as never, workspaceId, harnessSlug: slug }),
      readPlanPriority(pg, workspaceId, slug),
    ]);
    const liveCount = await liveCountFor(slug);
    // P-006 (D-005): the gate is blueprint-driven — cap/costCap/readiness come
    // from the harness's effective blueprint `dispatch:` policy, refined by the
    // per-install config.
    const {
      cap,
      overCostCap,
      readiness,
      blueprintRetirement: retirement,
      blueprintId: dispatchBlueprintId,
    } = await resolveHarnessDispatchGate(pg, slug, workspaceId);
    const slots = overCostCap || retirement ? 0 : Math.max(0, cap - liveCount);
    const { toStart, stuck, capped } = computeFrontier(features, planPriority, owned, slots, readiness);
    if (overCostCap) console.log(`[dbos-orchestrator] ${slug} over maxCostUsd — skipping new pipelines`);
    // WI-5645: refuse new pipeline starts against a retired blueprint (or a
    // blueprint extending one) — the launch-eligibility guard that stops an
    // autoloop (gym or otherwise) from spending on it.
    if (retirement) {
      console.warn(
        `[dbos-orchestrator] ${slug} skipping new pipelines — ` +
          describeBlueprintRetirement(retirement, dispatchBlueprintId ?? slug),
      );
    }
    if (stuck) {
      console.warn(
        `[dbos-orchestrator] ${slug} frontier STUCK — work remains but nothing is ready ` +
          `(all remaining features are blocked or failing)`,
      );
    }
    // EI-203: durably park the newly attempts-capped features so they stay
    // excluded on every future tick too (computeFrontier already dropped them
    // THIS tick from `features`' own needsHumanReview/attempts fields — this
    // just makes that exclusion durable). Best-effort; never sinks dispatch.
    await flagNeedsHumanReview(pg, workspaceId, slug, capped);
    // P-044: the retired wave-advance sweep used to raise an I-WAVE-* issue when a
    // wave couldn't drain. Preserve that observability in the frontier model — a
    // persistent (idempotent) I-STUCK issue while stuck, auto-cleared when work
    // becomes ready again. Best-effort; never sinks dispatch.
    if (!overCostCap) await raiseOrClearStuckSignal(slug, workspaceId, stuck).catch(() => {});
    // EI-203: lookup for bumpOrResetAttempts below — the feature's status AT
    // CANDIDATE-SELECT time this tick (before any pipeline runs and possibly
    // changes it).
    const statusById = new Map(features.map((f) => [f.id, f.status] as const));
    const started: string[] = [];
    // P-007/P-008 (decentralized-dispatch-scaling, flag-gated default-OFF): demote the
    // orchestrator from SOLE global dispatcher to one Swarm's executor — computeFrontier
    // still decides ELIGIBILITY (blocked-by/priority/readiness), but each ready feature is
    // gated on the per-Hive lease so cross-Swarm exactly ONE Swarm runs it (DBOS
    // workflow-id dedup stays the LOCAL exactly-once guard, D-006). Flag-off → no gate
    // (this loop is byte-identical to before). The gate is fail-open (helper never throws).
    const executorLeaseOn = workItemClaimLeaseEnabled();
    // NOTE (shared-hive-loop-e2e-testing D-007): the old keep-alive re-acquire of every
    // `owned` feature's lease was RETIRED here. It was the INTERIM renewal mechanism
    // (P-007/P-008) for "a long pipeline's lease doesn't lapse mid-run" — explicitly the
    // job D-007 moves INTO the pipeline. A running pipeline now heartbeats its OWN lease
    // each dispatching turn (renew + steal-detect → self-abort, orchestrator-workflow.ts),
    // so a second acquirer here would only churn `claim_id` out from under it. Enqueued
    // (not-yet-running) features are covered by the generous 2h acquire TTL below until
    // their pipeline starts heartbeating.
    for (const fid of toStart) {
      let claim: WorkItemClaimLeaseHandle | undefined;
      if (executorLeaseOn) {
        const lease = await leaseFeatureForExecutor({ workspaceId, harness: slug, featureId: fid });
        if (!lease.ok) continue; // another Swarm holds the Hive lease for this feature — it runs it
        // Thread the lease into the pipeline so it can renew + self-abort on a steal (D-007).
        claim = lease.claim;
      }
      // Pass the tick's own workspaceId so the pipeline pins THIS workspace rather
      // than the volatile active one (which can differ from the harness's home).
      const r = await ensureFeaturePipeline(slug, fid, workspaceId, claim);
      if (r.started) {
        started.push(fid);
        // EI-203: count this genuine new epoch only when it's another consecutive
        // same-failure retry; reset otherwise (a `reuse` of an already-live
        // pipeline is not a new attempt, so this only fires under `r.started`).
        await bumpOrResetAttempts(pg, workspaceId, slug, fid, statusById.get(fid) === 'failing');
      }
    }
    return { harness: slug, started };
  } catch (err) {
    // Per-harness isolation: a bad slug / unreachable schema doesn't sink the sweep —
    // but say WHY this tick produced nothing (audit P-035: the silent empty result
    // made real faults — dropped schemas, bad SQL — look like "no work to start").
    console.warn(
      `[dbos-dispatch] ${slug} tick failed (non-fatal):`,
      err instanceof Error ? err.message : err,
    );
    return { harness: slug, started: [] };
  }
}

/**
 * Read the full plan-gated feature set for the frontier (P-042) from the
 * consolidated source of truth: each feature's status + `feature_order` +
 * `source_plan` (from the `work_items` view, scoped to kind=feature), and its
 * blocker set from the coord_links rel='blocks' edges (EI-1 / D-027 — the legacy
 * `blocked_by` column is dropped). Reads the consolidated surface directly (not the
 * SELECT*-frozen per-harness view, which doesn't expose feature_order — D-017),
 * applying the same started-plan gate `readFeaturesPg` uses (features with no plan
 * are always eligible; plan features only when their plan is 'started'). No
 * carve-out here — the caller passes `owned` to the frontier.
 */
export async function readFrontierFeatures(
  pg: ReturnType<typeof postgres>,
  workspaceId: string,
  slug: string,
): Promise<FrontierFeature[]> {
  const rows = await pg<
    Array<{
      feature_id: string;
      status: string;
      feature_order: number | null;
      source_plan: string | null;
      attempts: number | bigint | null;
      needs_human_review: boolean | null;
    }>
  >`
    SELECT feature_id, status, feature_order,
           -- ledger P-004: the plan slug a work-item belongs to now lives in the
           -- first-class source_plan_slug COLUMN (written by plan-to-work-item
           -- promotion + convert-at-pickup), with the legacy metadata->>'source_plan'
           -- JSONB key kept only for pre-promotion features. Read both, column-first.
           -- harness_shared.work_items is the qualified consolidated surface, which
           -- always exposes source_plan_slug, so this is robust even for harnesses
           -- whose SELECT*-frozen per-harness view predates the column.
           COALESCE(source_plan_slug, metadata->>'source_plan') AS source_plan,
           -- EI-203: read straight off the base table so computeFrontier can cap
           -- consecutive same-failure re-dispatch — see bumpOrResetAttempts below
           -- for who writes these.
           attempts, needs_human_review
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${slug}
       -- work_items unification (unify-work-items-2026-06-04, D-005): the feature
       -- pipeline frontier reads the canonical work_items surface, scoped to
       -- kind=feature. Other kinds (bug/change run inline, research-task/chunk run
       -- their own blueprint) are NOT dispatched onto the feature pipeline. The
       -- work_items view is SELECT * over harness_features_consolidated, so this is
       -- view-transparent (same columns, same indexes) — a pure surface repoint.
       AND item_kind = 'feature'
       AND (
         -- ledger P-004: gate on source_plan_slug (column) with the legacy
         -- metadata fallback. Before this, promoted work-items (source_plan_slug
         -- set, metadata->>'source_plan' NULL) hit the IS-NULL leg and were treated
         -- as plan-less "always eligible", so a promoted item from a STOPPED /
         -- never-started plan was wrongly dispatchable. Now they are gated by their
         -- plan's started-state exactly like legacy plan features.
         COALESCE(source_plan_slug, metadata->>'source_plan') IS NULL
         OR COALESCE(source_plan_slug, metadata->>'source_plan') IN (
           SELECT plan_slug
             FROM harness_shared.harness_plans
            WHERE workspace_id = ${workspaceId}
              AND harness_slug = ${slug}
              AND op_status = 'started'
         )
       )
       -- Auditor gate (G2 / P-008): a remote-authored feature is NOT pickable
       -- until the auditor admits it. This MUST be enforced here on the live
       -- DBOS frontier read (not only in the legacy readFeaturesPg) so the
       -- pick path independently quarantines un-admitted remote features even
       -- if the auditor dispatch lane is unwired/errors/lags — fail-safe.
       -- (origin NULL = local, for pre-G1 back-compat; mirrors isAutoPickable.)
       AND (origin = 'local' OR origin IS NULL OR audit_verdict = 'admit')
       -- P-002 born-pending: DBOS is a dispatch door too; it must not outrun the
       -- same duplicate-screening promoter the scheduler and Mug placement use.
       AND admission IS DISTINCT FROM 'pending'
  `;
  // EI-1 (D-027/D-028): feature→feature blocking IS the coord_links rel='blocks'
  // edge — the single source of truth. The legacy `blocked_by` column + its GIN
  // index were dropped (migration 155); getFeatureBlockers reads the harness's
  // blocker sets in one indexed query (the cheap dispatch read D-027 specifies).
  // computeFrontier is unaffected — only the data source for `blockedBy` changed.
  const edgeBlockers = await defaultBlockingStore.blockersFor(slug);
  return rows.map((r) => ({
    id: r.feature_id,
    status: r.status,
    blockedBy: edgeBlockers.get(r.feature_id) ?? [],
    sourcePlan: r.source_plan,
    order: r.feature_order,
    attempts: Number(r.attempts ?? 0),
    needsHumanReview: r.needs_human_review === true,
  }));
}

/**
 * Resolve each started plan's effective cross-plan dispatch priority (P-042 step
 * 4 / D-013): the explicit `priority` column (P-045's drag order) when set, else
 * a large base + a `started_at` rank so unset plans fall AFTER all explicit ones
 * in started-order. Lower number = dispatched first.
 */
async function readPlanPriority(
  pg: ReturnType<typeof postgres>,
  workspaceId: string,
  slug: string,
): Promise<Map<string, number>> {
  const rows = await pg<Array<{ plan_slug: string; eff_priority: number | bigint }>>`
    SELECT plan_slug,
           COALESCE(
             op_priority,
             1000000 + (ROW_NUMBER() OVER (ORDER BY op_started_at ASC NULLS LAST, plan_slug))::int
           ) AS eff_priority
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${slug}
       AND op_status = 'started'
  `;
  return new Map(rows.map((r) => [r.plan_slug, Number(r.eff_priority)]));
}

/**
 * The workspace(s) a single sweep covers (Phase E, P-020).
 *
 * One shared operator serves every workspace (D-008), so the single background
 * orchestrator must decide which workspaces to sweep. The pin → shared-all →
 * global-active policy now lives in `backgroundWorkspaceIds()`
 * (workspace-registry.ts) — the canonical helper every background reader
 * shares (this dispatcher, the await-event sweeper, pot wake-rule boot
 * registration). Each harness is still gated by its own concurrency +
 * `maxCostUsd` caps, so cost scales with opted-in harnesses, not
 * workspace/window count.
 */
export function orchestratorWorkspaceIds(): string[] {
  return backgroundWorkspaceIds();
}

/**
 * One dispatch sweep over the opted-in harnesses (the periodic backstop). In the
 * shared-operator model this sweeps EVERY workspace (P-020); each workspace's
 * harnesses fill their own slots via `dispatchOneHarness`, run inside that
 * workspace's ALS scope so any internal `activeWorkspaceId()` read (e.g.
 * `ensureFeaturePipeline` → `orchestrator-start`) resolves correctly. Returns
 * what was newly started (for logging / tests).
 */
export async function runOrchestratorTick(): Promise<OrchestratorTickResult[]> {
  const adminUrl = getHarnessAdminUrl();
  const out: OrchestratorTickResult[] = [];
  for (const workspaceId of orchestratorWorkspaceIds()) {
    await runWithWorkspace(workspaceId, async () => {
      const slugs = await resolveTickHarnesses(workspaceId);
      for (const slug of slugs) {
        out.push(await dispatchOneHarness(slug, workspaceId, adminUrl));
      }
    });
  }
  return out;
}

/**
 * On-completion refill seam (#1 — continuous dispatch). When a feature pipeline
 * settles, the freed concurrency slot should be filled IMMEDIATELY rather than
 * waiting up to 30s for the next periodic tick. The pipeline workflow calls
 * `setPipelineSettledHook` → this, which re-dispatches just that harness on a
 * fresh event-loop turn (`setImmediate` escapes the completing workflow's
 * async-context so the new pipeline starts as a normal top-level workflow, not a
 * child). Fire-and-forget; the 30s tick remains the backstop if this is missed.
 */
export function refillHarnessOnSettle(slug: string, workspaceId: string): void {
  setImmediate(() => {
    void dispatchOneHarness(slug, workspaceId).catch(() => {});
  });
}

// ── Scheduled workflow ────────────────────────────────────────────────────────
// Registered only when bootstrap imports this module (PAPERCUSP_DBOS_ORCHESTRATOR=1).
// Called directly (no steps): a crashed tick should re-scan fresh on recovery,
// and ensureFeaturePipeline's dedup makes the wholesale re-run safe.
async function orchestratorTickImpl(): Promise<void> {
  const results = await runOrchestratorTick();
  const started = results.flatMap((r) => r.started.map((f) => `${r.harness}:${f}`));
  if (started.length > 0) {
    console.log(`[dbos-orchestrator] started ${started.length} pipeline(s): ${started.join(', ')}`);
  }
}

export const orchestratorTickWorkflow = idempotentRegisterWorkflow('orchestratorTick', () =>
  DBOS.registerWorkflow(orchestratorTickImpl, {
    name: 'orchestratorTick',
    maxRecoveryAttempts: 2,
  }),
);

// Every 30s (6-field crontab with seconds). Skip-missed by default — a closed
// desktop doesn't stampede a backlog of ticks on reboot.
//
// Only SCHEDULE the tick in all-mode (`'*'`) or when an explicit allowlist is set
// — otherwise the no-op tick would still record a SUCCESS workflow row every 30s,
// cluttering the DBOS system DB / `/admin/dbos`. With the orchestrator flag on but
// no harnesses opted in, the workflow stays registered (so the manual trigger +
// recovery work) but nothing fires on a timer.
if (shouldScheduleOrchestrator(orchestratorHarnessesEnv())) {
  DBOS.registerScheduled(orchestratorTickWorkflow, {
    name: 'orchestratorTick',
    crontab: '*/30 * * * * *',
  });
}
