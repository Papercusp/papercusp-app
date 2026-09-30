/**
 * package-constructor.ts — the P-022 CONSTRUCTOR runtime
 * (work-on-everything-goal-2026-08-23; owner spec on WI-41064 [owner 2026-08-23]).
 *
 * A goal package MAY carry `construct.js` beside its goal.json — a PURE
 * `(typedInputs) => spec` that BUILDS the package's content deterministically
 * instead of static-content-plus-substitution. Each clause is load-bearing:
 *
 *   RUN AT START, NEVER INSTALL — install stays inert (D-002; P-006's
 *   install-is-inert discipline). This module is invoked only from the start
 *   door (start-from-package.ts), after typed inputs (P-021) validated.
 *
 *   PURE + SANDBOXED — executes in the existing code:run worker sandbox
 *   (@papercusp/tooldef runOrchestrationScript) with an EMPTY tool facade:
 *   Cupboard-distributed code is third-party code, so no network, no db, no
 *   secrets, no tools. The script sees exactly the deeply-frozen ambient
 *   `inputs` value and RETURNS its spec. Time-boxed + heap-capped; a sync
 *   `while(true)` is hard-killed at the wall clock.
 *
 *   DETERMINISM IS ENFORCED, not assumed: the script runs TWICE with the same
 *   inputs and both outputs must serialize identically under stable key order.
 *   Anything live the construct needs must be resolved INTO the typed inputs
 *   by the start door (pickers → values), never read ambiently — which is what
 *   makes a dry-run PREVIEW possible at the start door before anything is
 *   created, and what the double-run check makes cheap to police.
 *
 *   STRICT OUTPUT — a plain JSON object, only CONSTRUCTIBLE keys, each
 *   type-checked, bounded in size. `inputSchema` is deliberately NOT
 *   constructible: it is the contract the typed inputs were already validated
 *   against; letting the output rewrite it would let a package move its own
 *   goalposts after the gate. Tripwires are the package shape (threshold
 *   defaults) — a `current` reading is live state and is refused, same rule as
 *   the package reader (goal-package-store).
 *
 * The output spec is PARTIAL: constructed fields override the static package
 * content, unspecified fields fall through — and the merged content then flows
 * through the SAME create seam as hand-authored content (effectiveGoalContent
 * fold → insertGoalRow / property-schema validation; one writer seam, no
 * drift — D-005 §1).
 */
import { runOrchestrationScript, type OrchestrationInputs, type ToolFacade } from '@papercusp/tooldef';
import type { GoalPackageTripwire } from '../cupboard/goal-package-store';

/** Wall-clock budget for ONE constructor run (two runs happen per start). A
 *  constructor is pure compute over its inputs; 10s is generous. */
export const CONSTRUCT_TIMEOUT_MS = 10_000;

/** V8 old-gen heap cap for the constructor worker. */
export const CONSTRUCT_MAX_HEAP_MB = 64;

/** Cap on the stable-serialized output spec. A goal row's content is prose +
 *  small JSON schemas; 64KB is far above any honest spec. */
export const CONSTRUCT_OUTPUT_MAX_CHARS = 65_536;

/**
 * The fields a constructor may produce — the package content surface MINUS
 * `inputSchema` (see header: the gate's contract is not constructible).
 * Structurally a subset of start-from-package's GoalPackageContent; kept
 * standalone so the dependency points start-door → runtime, never back.
 */
export interface GoalConstructSpec {
  title?: string;
  body?: string | null;
  standing?: boolean;
  killCriterion?: string | null;
  tripwires?: GoalPackageTripwire[] | null;
  budgetCents?: number | null;
  budgetWindowSec?: number | null;
  launchSettings?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
  propertySchema?: Record<string, unknown> | null;
}

const CONSTRUCTIBLE_KEYS = new Set<keyof GoalConstructSpec>([
  'title',
  'body',
  'standing',
  'killCriterion',
  'tripwires',
  'budgetCents',
  'budgetWindowSec',
  'launchSettings',
  'outputSchema',
  'propertySchema',
]);

export type PackageConstructorFailureReason =
  | 'construct-error'
  | 'construct-timeout'
  | 'construct-invalid-output'
  | 'construct-nondeterministic'
  | 'construct-output-too-large';

export type PackageConstructorResult =
  | {
      ok: true;
      spec: GoalConstructSpec;
      /** The keys the spec sets, sorted — the start door's disclosure line. */
      overriddenKeys: string[];
    }
  | { ok: false; reason: PackageConstructorFailureReason; detail: string };

export interface RunPackageConstructorOptions {
  /** Test seam; production callers keep {@link CONSTRUCT_TIMEOUT_MS}. */
  timeoutMs?: number;
  maxOldGenerationSizeMb?: number;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Recursive key-sorted clone — makes JSON.stringify order-stable so the
 *  double-run determinism compare cannot false-negative on key order. (A
 *  private comparator, not a durable surface — seed-bundle's stableStringify
 *  serves manifests; pulling that lib in for one compare wasn't warranted.) */
const sortKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
};
export const stableConstructJson = (v: unknown): string => JSON.stringify(sortKeys(v));

const TRIPWIRE_KEYS = new Set(['metric', 'label', 'threshold', 'unit']);

function tripwireIssues(v: unknown, path: string): string[] {
  if (!isPlainObject(v)) return [`${path} must be an object`];
  const issues: string[] = [];
  for (const k of Object.keys(v)) {
    if (!TRIPWIRE_KEYS.has(k)) {
      issues.push(
        `${path}.${k} is not a tripwire package field (a 'current' reading is live state — packages ship thresholds only)`,
      );
    }
  }
  if (typeof v.metric !== 'string' || v.metric === '') issues.push(`${path}.metric must be a non-empty string`);
  if (typeof v.label !== 'string' || v.label === '') issues.push(`${path}.label must be a non-empty string`);
  if (typeof v.threshold !== 'number' || !Number.isFinite(v.threshold))
    issues.push(`${path}.threshold must be a finite number`);
  if (v.unit !== undefined && (typeof v.unit !== 'string' || v.unit === ''))
    issues.push(`${path}.unit must be a non-empty string when present`);
  return issues;
}

/** Strict shape check of a constructor's returned spec. Exported for tests. */
export function validateConstructSpec(
  value: unknown,
): { ok: true; spec: GoalConstructSpec } | { ok: false; issues: string[] } {
  if (!isPlainObject(value)) {
    return { ok: false, issues: ['construct must return a plain JSON object (the partial content spec)'] };
  }
  const issues: string[] = [];
  for (const key of Object.keys(value)) {
    if (!CONSTRUCTIBLE_KEYS.has(key as keyof GoalConstructSpec)) {
      issues.push(
        key === 'inputSchema'
          ? `'inputSchema' is not constructible — it is the contract the typed inputs were validated against; a constructor cannot move its own goalposts`
          : `'${key}' is not a constructible field`,
      );
    }
  }
  const v = value as GoalConstructSpec & Record<string, unknown>;
  if ('title' in value && (typeof v.title !== 'string' || v.title.trim() === ''))
    issues.push(`'title' must be a non-empty string`);
  if ('body' in value && v.body !== null && typeof v.body !== 'string')
    issues.push(`'body' must be a string or null`);
  if ('standing' in value && typeof v.standing !== 'boolean') issues.push(`'standing' must be a boolean`);
  if ('killCriterion' in value && v.killCriterion !== null && typeof v.killCriterion !== 'string')
    issues.push(`'killCriterion' must be a string or null`);
  if ('tripwires' in value && v.tripwires !== null) {
    if (!Array.isArray(v.tripwires)) issues.push(`'tripwires' must be an array or null`);
    else v.tripwires.forEach((t, i) => issues.push(...tripwireIssues(t, `tripwires[${i}]`)));
  }
  if ('budgetCents' in value && v.budgetCents !== null) {
    if (typeof v.budgetCents !== 'number' || !Number.isInteger(v.budgetCents) || v.budgetCents < 0)
      issues.push(`'budgetCents' must be a non-negative integer or null`);
  }
  if ('budgetWindowSec' in value && v.budgetWindowSec !== null) {
    if (
      typeof v.budgetWindowSec !== 'number' ||
      !Number.isInteger(v.budgetWindowSec) ||
      v.budgetWindowSec <= 0
    )
      issues.push(`'budgetWindowSec' must be a positive integer or null`);
  }
  for (const key of ['launchSettings', 'outputSchema', 'propertySchema'] as const) {
    if (key in value && v[key] !== null && !isPlainObject(v[key]))
      issues.push(`'${key}' must be a plain object or null`);
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, spec: value as GoalConstructSpec };
}

/**
 * Run a package's construct script, sandboxed, twice, strictly validated.
 * Never throws for script-authored failure — every refusal is a typed result
 * the start door surfaces verbatim.
 */
export async function runPackageConstructor(
  script: string,
  typedInputs: Record<string, unknown> | null,
  opts: RunPackageConstructorOptions = {},
): Promise<PackageConstructorResult> {
  if (script.trim() === '') {
    return { ok: false, reason: 'construct-error', detail: 'construct.js is present but empty' };
  }
  const timeoutMs = opts.timeoutMs ?? CONSTRUCT_TIMEOUT_MS;
  // EMPTY facade: any `tools.*` access in the script throws inside the sandbox,
  // which is exactly the purity contract — a constructor computes, it never calls.
  const facade = {} as ToolFacade;
  const runOnce = () =>
    runOrchestrationScript(script, facade, {
      timeoutMs,
      maxOldGenerationSizeMb: opts.maxOldGenerationSizeMb ?? CONSTRUCT_MAX_HEAP_MB,
      maxLogLines: 20,
      // Safe narrowing: typed inputs already passed the P-021 JSON-schema gate,
      // and the runner re-verifies JSON-purity (jsonInputError) at the boundary.
      inputs: (typedInputs ?? {}) as OrchestrationInputs,
    });

  const first = await runOnce();
  if (!first.ok) {
    const detail = first.error ?? 'construct script failed';
    return {
      ok: false,
      reason: detail.includes('script_timeout') ? 'construct-timeout' : 'construct-error',
      detail,
    };
  }
  const validated = validateConstructSpec(first.result);
  if (!validated.ok) {
    return { ok: false, reason: 'construct-invalid-output', detail: validated.issues.join('; ') };
  }
  const serialized = stableConstructJson(validated.spec);
  if (serialized.length > CONSTRUCT_OUTPUT_MAX_CHARS) {
    return {
      ok: false,
      reason: 'construct-output-too-large',
      detail: `spec serializes to ${serialized.length} chars (cap ${CONSTRUCT_OUTPUT_MAX_CHARS})`,
    };
  }

  // The determinism double-run (see header). Same inputs, fresh worker.
  const second = await runOnce();
  const secondValidated = second.ok ? validateConstructSpec(second.result) : null;
  if (!second.ok || !secondValidated?.ok || stableConstructJson(secondValidated.spec) !== serialized) {
    return {
      ok: false,
      reason: 'construct-nondeterministic',
      detail: second.ok
        ? 'two runs over identical inputs produced different specs — a constructor must be a pure function of (package content, typed inputs); resolve anything live INTO the inputs at the start door'
        : `second determinism run failed where the first succeeded: ${second.error ?? 'unknown'}`,
    };
  }

  return { ok: true, spec: validated.spec, overriddenKeys: Object.keys(validated.spec).sort() };
}
