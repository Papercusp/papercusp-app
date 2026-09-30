/**
 * Feature state reader/writer. Maps to bash run.sh's `features_json`,
 * `features_exist`, `feature_attempts`, `feature_set_status`.
 *
 * Storage backends (chosen by the StateContext shape):
 *   - PG (canonical, production): `harness_features` table in the
 *     per-harness schema. Pass `{ pg, workspaceId, harnessSlug? }`.
 *   - In-memory (tests, CLI standalone without PG): process-local Map
 *     keyed by stateDir. See `state-memory.ts`.
 *
 * Filesystem (`.papercusp/features.json`) is NO LONGER supported. PG is
 * the single source of truth in production. Tests use the in-memory
 * backend via `seedMemoryStore`/`_resetMemoryStateForTests` (the
 * test-context-builder wires this automatically).
 *
 * Callers always provide a `StateContext`. `stateCtx(invokeCtx)`
 * derives the right backend from an `InvokeContext`-shaped object —
 * PG when both `pg` and `workspaceId` are set, memory otherwise.
 */
import { basename } from 'node:path';
import {
  readFeaturesPg,
  featuresExistPg,
  featureAttemptsPg,
  setFeatureStatusPg,
  type PgStateContext,
} from './state-pg';
import {
  readFeaturesMem,
  featuresExistMem,
  featureAttemptsMem,
  setFeatureStatusMem,
  type MemoryStateContext,
} from './state-memory';
import type { FeatureRecord } from './types';

/**
 * The runtime state backend. PG in production, memory in tests / CLI
 * standalone. Always non-optional — every caller must provide one.
 */
export type StateContext = PgStateContext | MemoryStateContext;

function isPg(ctx: StateContext): ctx is PgStateContext {
  return (ctx as PgStateContext).pg !== undefined;
}

/**
 * Derive the right state backend from an `InvokeContext`-shaped object.
 * When PG (`pg` + `workspaceId`) is wired, returns a PG context.
 * Otherwise returns an in-memory context keyed by `stateDir`.
 */
export function stateCtx(ctx: {
  pg?: PgStateContext['pg'];
  workspaceId?: string;
  harnessSlug?: string;
  projectDir?: string;
  stateDir: string;
}): StateContext {
  if (ctx.pg && ctx.workspaceId) {
    // harnessSlug is optional; threaded so setFeatureStatusPg can apply
    // the design-phase gate (PAPERCUSP_DESIGN_GATE=1). Falls back to
    // basename(projectDir) when not explicitly set — matches the existing
    // harnessSlug() helper's default-derivation, but without the
    // synchronous registry round-trip.
    const slug =
      ctx.harnessSlug ??
      (ctx.projectDir ? ctx.projectDir.split(/[/\\]/).filter(Boolean).pop() : undefined);
    return { pg: ctx.pg, workspaceId: ctx.workspaceId, harnessSlug: slug };
  }
  return { kind: 'memory', stateDir: ctx.stateDir };
}

/** Read and normalize features. */
export async function readFeatures(
  _stateDir: string,
  ctx: StateContext,
): Promise<FeatureRecord[]> {
  if (isPg(ctx)) return readFeaturesPg(ctx);
  return readFeaturesMem(ctx);
}

/** Whether features exist AND there is at least one feature record. */
export async function featuresExist(
  _stateDir: string,
  ctx: StateContext,
): Promise<boolean> {
  if (isPg(ctx)) return featuresExistPg(ctx);
  return featuresExistMem(ctx);
}

/** Number of times a feature has been worked on (zero if not found). */
export async function featureAttempts(
  _stateDir: string,
  featureId: string,
  ctx: StateContext,
): Promise<number> {
  if (isPg(ctx)) return featureAttemptsPg(ctx, featureId);
  return featureAttemptsMem(ctx, featureId);
}

/**
 * Update a feature's status. Preserves all other fields. Mirrors bash
 * `feature_set_status <fid> <status>` plus the python-inline mutations
 * (architect's reset-to-todo with attempts=0).
 */
export async function setFeatureStatus(
  _stateDir: string,
  featureId: string,
  status: FeatureRecord['status'],
  options: { bumpAttempts?: boolean; resetAttempts?: boolean; ctx: StateContext },
): Promise<FeatureRecord[]> {
  if (isPg(options.ctx)) {
    return setFeatureStatusPg(options.ctx, featureId, status, options);
  }
  return setFeatureStatusMem(options.ctx, featureId, status, options);
}

/**
 * Compute the harness slug. Resolution order:
 *   1. HARNESS_SLUG / PAPERCUSP_HARNESS_SLUG env (caller-set; fastest —
 *      always present on pipeline spawns via buildPipelineExtraEnv)
 *   2. cached operator-registry value (canonical — handles
 *      basename(projectDir) ≠ registered slug, e.g. sheets-clone → sheets;
 *      warmed in the BACKGROUND, never awaited — audit P-038)
 *   3. basename(projectDir) — the immediate cold-call answer
 *
 * Memoized per projectDir; callers bear no perf cost across multiple
 * invocations.
 *
 * Bash equivalent:
 *   harness_slug() { basename "$PROJECT_DIR"; }
 */
const _slugCache = new Map<string, string>();
export function harnessSlug(projectDir: string): string {
  const fromEnv = process.env.HARNESS_SLUG ?? process.env.PAPERCUSP_HARNESS_SLUG;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const cached = _slugCache.get(projectDir);
  if (cached) return cached;
  // Cold call: answer with the basename NOW and let the registry warm the
  // cache in the background (P-038 — the old synchronous curl blocked the
  // event loop up to 4s here).
  void warmSlugFromRegistry(projectDir);
  const fromBasename = basename(projectDir);
  _slugCache.set(projectDir, fromBasename);
  return fromBasename;
}

// Audit P-038 (EI-113): the registry reverse-lookup used execFileSync(curl) — a
// SYNCHRONOUS subprocess that blocked the event loop up to 4s per cold call —
// and defaulted to :3055 (the Vite content port; the operator API is :3070).
// It now warms the cache in the BACKGROUND: pipeline spawns always carry
// HARNESS_SLUG via env (buildPipelineExtraEnv), so this fallback only serves
// ad-hoc contexts, where a corrected value (sheets-clone → sheets) landing on
// the next call beats stalling this one.
const _registryWarmKicked = new Set<string>();
async function warmSlugFromRegistry(projectDir: string): Promise<void> {
  if (_registryWarmKicked.has(projectDir)) return;
  _registryWarmKicked.add(projectDir);
  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3070';
  try {
    const res = await fetch(`${operatorBase}/api/harness/projects`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { projects?: Array<{ slug?: string; path?: string }> };
    const norm = projectDir.replace(/\/+$/, '');
    const hit = data.projects?.find((p) => (p.path ?? '').replace(/\/+$/, '') === norm)?.slug;
    if (hit && hit.length > 0) _slugCache.set(projectDir, hit);
  } catch {
    /* registry unreachable — the basename derivation stands */
  }
}

/** Pass-rate as a fraction (0..1). 0 if no features. */
export function passedFraction(features: FeatureRecord[]): number {
  if (features.length === 0) return 0;
  const passed = features.filter((f) => f.status === 'passed').length;
  return passed / features.length;
}
