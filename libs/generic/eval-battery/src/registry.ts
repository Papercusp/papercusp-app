/**
 * The test-descriptor registry — the discovery + invocation contract that exposes
 * many kinds of eval-battery Subjects through ONE uniform surface
 * (`experiment-registry-invocation-api-2026-06-14`).
 *
 * The engine already unifies EXECUTION (`runBattery`) behind the swappable
 * {@link Subject} port; what was missing is a CATALOG. A {@link TestDescriptor} is a
 * declarative record per registered test — its kind, its fidelity tier (cost/realism),
 * the slice of the knob space it can vary, what it measures, and an opaque `run`
 * adapter that DELEGATES to that test's existing battery runner (so no Subject is ever
 * reconstructed). The `experiment:catalog` / `experiment:run` tools read this registry.
 *
 * Pure + domain-free (`libs/generic`): it stores descriptors keyed by id and never
 * imports an operator/Subject implementation — the concrete descriptors are registered
 * by the host (operator-core) at boot. `run` and the knob-space vocabulary are opaque
 * here; the registry only stores and resolves.
 */

/** What a registered test evaluates — the realism axis. */
export type TestKind = 'component' | 'whole-instance' | 'whole-hive' | 'replay' | 'drill';

/**
 * The fidelity / cost tier a test runs at.
 *   - `offline` — no new agent spend (counterfactual replay, ~$0, deterministic);
 *   - `shadow`  — runs against live traffic without acting;
 *   - `live`    — real agent spend.
 * Callers default to `offline` and escalate only on a positive signal (D-004).
 */
export type FidelityTier = 'offline' | 'shadow' | 'live';

/** Coarse cost class surfaced in the catalog. The PRECISE budget gate is the
 *  learning-governor at run time, not this label. */
export type CostClass = 'free' | 'low' | 'high';

/** What a test measures: the deterministic guardrail signal names + the judge rubric
 *  dimensions. Declarative — for the catalog reader, not for execution. */
export interface TestMetrics {
  /** Deterministic guardrail signal names (e.g. gym signals). */
  signals: string[];
  /** Judge rubric dimension names. */
  rubricDimensions: string[];
  /** Store rubric used when a completed experiment emits a trendable scorecard. */
  rubricRef?: string;
}

/**
 * One registered test (Subject) — declarative metadata + an opaque invocation adapter.
 * The registry treats `run` as a black box: it delegates to the test's existing battery
 * runner (e.g. `runReplayBattery` / `runAbEvaluation`), so no Subject is reconstructed.
 * `TRequest` / `TResult` / `TCtx` are bound by the host that registers the concrete
 * descriptor; the registry stores them opaquely.
 */
export interface TestDescriptor<TRequest = unknown, TResult = unknown, TCtx = unknown> {
  /** Stable catalog id, e.g. `replay` / `gym` / `instance` / `hive`. */
  id: string;
  /** One-line human summary for the catalog. */
  summary: string;
  kind: TestKind;
  fidelityTier: FidelityTier;
  costClass: CostClass;
  /**
   * The slice of the knob space this test can vary, as address PREFIXES
   * (e.g. `['genome.prompts', 'genome.config.placement']` or `['overlay', 'model']`).
   * `experiment:run` rejects an arm addressing a knob outside this slice; the
   * safety-excluded set is never expressible here. The knob-space VOCABULARY is
   * host-defined (operator-core) — the registry only stores the strings.
   */
  knobSlice: string[];
  metrics: TestMetrics;
  /** The invocation adapter — delegates to the existing runner. Opaque here. */
  run(request: TRequest, ctx: TCtx): Promise<TResult>;
}

/** The catalog VIEW of a descriptor — everything except the opaque `run`. What
 *  `experiment:catalog` returns. */
export type TestCatalogEntry = Omit<TestDescriptor, 'run'>;

/**
 * True when a knob `address` falls within a descriptor's declared `knobSlice` — an
 * exact match or a dot-prefixed child (`genome.prompts` covers `genome.prompts.queen`).
 * Pure; the knob-space vocabulary is host-defined. Used by the run-side compatibility
 * gate (P-021).
 */
export function knobInSlice(address: string, knobSlice: readonly string[]): boolean {
  return knobSlice.some((prefix) => address === prefix || address.startsWith(`${prefix}.`));
}

/**
 * A registry of test descriptors. The host constructs/uses the module-level default
 * (below); tests construct their own instance or call {@link resetTestRegistry} to
 * avoid cross-test bleed.
 */
export class TestRegistry {
  private readonly tests = new Map<string, TestDescriptor>();

  /** Register a descriptor. Throws on a duplicate id — a double-register is a wiring
   *  bug, so fail loud (mirrors the gym signal registry's unknown-name boundary). */
  register<TRequest, TResult, TCtx>(descriptor: TestDescriptor<TRequest, TResult, TCtx>): void {
    if (this.tests.has(descriptor.id)) {
      throw new Error(`test descriptor already registered: ${descriptor.id}`);
    }
    this.tests.set(descriptor.id, descriptor as unknown as TestDescriptor);
  }

  /** Resolve a descriptor by id, or `undefined`. */
  get(id: string): TestDescriptor | undefined {
    return this.tests.get(id);
  }

  /** Resolve a descriptor by id or throw with the known ids (the `experiment:run`
   *  resolution path — an unknown id is a caller error, not a silent no-op). */
  require(id: string): TestDescriptor {
    const found = this.tests.get(id);
    if (!found) {
      const known = this.list()
        .map((t) => t.id)
        .join(', ');
      throw new Error(`unknown test descriptor: ${id} (registered: ${known || 'none'})`);
    }
    return found;
  }

  /** The catalog view — metadata only (no `run`), deterministic order (by id). */
  list(): TestCatalogEntry[] {
    return [...this.tests.values()]
      .map(
        (d): TestCatalogEntry => ({
          id: d.id,
          summary: d.summary,
          kind: d.kind,
          fidelityTier: d.fidelityTier,
          costClass: d.costClass,
          knobSlice: d.knobSlice,
          metrics: d.metrics,
        }),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Number of registered descriptors. */
  get size(): number {
    return this.tests.size;
  }

  /** Clear all registrations (test seam). */
  reset(): void {
    this.tests.clear();
  }
}

/**
 * The process-wide default registry: the host registers concrete descriptors into it
 * at boot and the `experiment:*` tools read it. Tests should construct their own
 * {@link TestRegistry} or call {@link resetTestRegistry} to avoid cross-test bleed.
 */
const defaultRegistry = new TestRegistry();

export function registerTest<TRequest, TResult, TCtx>(d: TestDescriptor<TRequest, TResult, TCtx>): void {
  defaultRegistry.register(d);
}
export function getTest(id: string): TestDescriptor | undefined {
  return defaultRegistry.get(id);
}
export function requireTest(id: string): TestDescriptor {
  return defaultRegistry.require(id);
}
export function listTests(): TestCatalogEntry[] {
  return defaultRegistry.list();
}
export function resetTestRegistry(): void {
  defaultRegistry.reset();
}
