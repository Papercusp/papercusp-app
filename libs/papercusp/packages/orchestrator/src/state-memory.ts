/**
 * In-memory feature store. Replaces the legacy filesystem fallback in
 * `state.ts` that used to read/write `.harness/features.json` (the per-project dir is now `.papercusp/`).
 *
 * Why this exists:
 *   - Postgres is the canonical store for `harness_features` at runtime.
 *   - Tests and standalone CLI mode often run without a PG connection.
 *     They used to fall through to `.papercusp/features.json` — that path
 *     is now gone (PG is the single source of truth for production).
 *   - This module gives those callers a process-local, deterministic
 *     store that satisfies the same API surface as the PG impl,
 *     without spawning Postgres for every test.
 *
 * Scope:
 *   - Keyed by `stateDir` string so multiple harness dirs can coexist
 *     in one process (e.g. multiple tests in the same vitest file).
 *   - Test isolation lives at the per-test level: call
 *     `_resetMemoryStateForTests()` in beforeEach. The test-context-
 *     builder does this automatically.
 *   - Not persisted. Crashing the process drops state — fine for tests,
 *     not fine for production. Production must provide a PG context.
 */
import type { FeatureRecord } from './types';

export interface MemoryStateContext {
  kind: 'memory';
  stateDir: string;
}

const _stores = new Map<string, FeatureRecord[]>();

function ensureStore(stateDir: string): FeatureRecord[] {
  let s = _stores.get(stateDir);
  if (!s) {
    s = [];
    _stores.set(stateDir, s);
  }
  return s;
}

export function readFeaturesMem(ctx: MemoryStateContext): FeatureRecord[] {
  return [...ensureStore(ctx.stateDir)];
}

export function featuresExistMem(ctx: MemoryStateContext): boolean {
  return ensureStore(ctx.stateDir).length > 0;
}

export function featureAttemptsMem(
  ctx: MemoryStateContext,
  featureId: string,
): number {
  const f = ensureStore(ctx.stateDir).find((x) => x.id === featureId);
  return f?.attempts ?? 0;
}

export function setFeatureStatusMem(
  ctx: MemoryStateContext,
  featureId: string,
  status: FeatureRecord['status'],
  options: { bumpAttempts?: boolean; resetAttempts?: boolean } = {},
): FeatureRecord[] {
  const features = ensureStore(ctx.stateDir);
  const idx = features.findIndex((f) => f.id === featureId);
  if (idx < 0) return [...features];
  const next: FeatureRecord = { ...features[idx], status };
  if (options.resetAttempts) next.attempts = 0;
  else if (options.bumpAttempts) next.attempts = (next.attempts ?? 0) + 1;
  features[idx] = next;
  return [...features];
}

/**
 * Test helper: seed the in-memory store with an initial set of features.
 * Overwrites any prior state for the given stateDir. Used by the
 * test-context-builder and by individual test files that want to set up
 * feature state before exercising the orchestrator.
 */
export function seedMemoryStore(
  stateDir: string,
  features: FeatureRecord[],
): void {
  _stores.set(stateDir, [...features]);
}

/**
 * Test helper: full reset across all stateDirs. Call from beforeEach
 * to guarantee per-test isolation.
 */
export function _resetMemoryStateForTests(): void {
  _stores.clear();
}
