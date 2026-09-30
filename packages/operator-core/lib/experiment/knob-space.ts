/**
 * The unified knob space (`experiment-registry-invocation-api-2026-06-14` P-020/P-021,
 * D-003) — the ONE addressable namespace of everything an experiment may vary. An
 * experiment arm is a set of `{address → value}` knobs; this module is the PURE algebra
 * that validates an arm against a test's declared slice + the safety-excluded set, and
 * partitions it into the per-axis deltas the runners consume.
 *
 * Three axes (the owner's "vary everything", D-003):
 *   - `genome.*`  — the ratified 5-dim system genome (`instance-spec/genome.ts`):
 *                   `genome.prompts.<path>` and `genome.config.<axis>.<key…>`.
 *   - `overlay.*` — the component overlay surface (the gym HarnessSubject variant):
 *                   per-role prompt / tool-guidance / policy-weight overlays.
 *   - `model.*`   — the NEW model-per-role axis: `model.<role>` → a model id.
 *
 * The never-auto safety-excluded set is structurally un-addressable: any arm touching
 * it is REJECTED, never applied — you cannot author an experiment that varies budgets,
 * deploy gates, auth, credentials, or the learning rails themselves. This is the
 * run-side complement to the genome surface's structural exclusion, extended to the
 * whole knob space and pinned by the recursion-safety invariants (P-060).
 */
import { knobInSlice } from '@papercusp/eval-battery';
import {
  GENOME_CONFIG_AXES,
  type Genome,
  type GenomeConfigAxis,
  type GenomeDelta,
  mergeGenome,
} from '../instance-spec/genome';

/** The three top-level knob axes, in canonical order. */
export const KNOB_AXES = ['genome', 'overlay', 'model'] as const;
export type KnobAxis = (typeof KNOB_AXES)[number];

/**
 * Address prefixes that can NEVER be varied by an experiment (D-003 / the recursion-
 * safety never-auto set). A knob whose address equals or is dot-nested under any of
 * these is rejected before it can reach a runner.
 */
export const SAFETY_EXCLUDED_PREFIXES = [
  'budget',
  'deploy',
  'auth',
  'credentials',
  'secrets',
  'governor',
  'learning-governor',
  'change-ledger',
  'graduation',
  'battery',
  'meta-eval',
  'release-gate',
] as const;

/** True when an address falls in the safety-excluded set (exact or dot-nested). */
export function isSafetyExcluded(address: string): boolean {
  return SAFETY_EXCLUDED_PREFIXES.some((p) => address === p || address.startsWith(`${p}.`));
}

/** One experiment arm — a labelled set of knob deltas. An empty `knobs` is the
 *  champion/baseline arm. */
export interface KnobArm {
  id: string;
  label?: string;
  knobs: Record<string, unknown>;
}

/** The per-axis partition a runner consumes. */
export interface PartitionedArm {
  /** The `genome.*` knobs folded into a genome delta (apply via {@link applyArmGenome}). */
  genomeDelta: GenomeDelta;
  /** Component overlay knobs, keyed by their post-`overlay.` path. */
  overlay: Record<string, unknown>;
  /** `model.<role>` → model id. */
  models: Record<string, string>;
}

/** The result of validating an arm against a test's slice + the safety set. */
export interface ArmValidation {
  ok: boolean;
  /** Knob addresses outside the test's declared slice. */
  outOfSlice: string[];
  /** Knob addresses in the safety-excluded set. */
  excluded: string[];
}

/** The axis of a knob address — its first dot-segment. */
export function knobAxis(address: string): string {
  const dot = address.indexOf('.');
  return dot === -1 ? address : address.slice(0, dot);
}

/**
 * Validate an arm against a test's declared knob slice + the safety set. Valid iff
 * every knob is within the slice AND none is safety-excluded. Pure — no apply. (P-021)
 */
export function validateArm(arm: KnobArm, knobSlice: readonly string[]): ArmValidation {
  const outOfSlice: string[] = [];
  const excluded: string[] = [];
  for (const address of Object.keys(arm.knobs)) {
    if (isSafetyExcluded(address)) excluded.push(address);
    else if (!knobInSlice(address, knobSlice)) outOfSlice.push(address);
  }
  return { ok: outOfSlice.length === 0 && excluded.length === 0, outOfSlice, excluded };
}

function applyGenomeKnob(delta: GenomeDelta, segments: string[], value: unknown): void {
  const [head, ...rest] = segments;
  if (head === 'prompts') {
    const path = rest.join('.');
    if (!path) throw new Error('genome.prompts knob needs a path: genome.prompts.<path>');
    if (value !== null && typeof value !== 'string') {
      throw new Error(`genome.prompts.${path} must be a string (overlay text) or null (remove)`);
    }
    (delta.prompts ??= {})[path] = value as string | null;
    return;
  }
  if (head === 'config') {
    const [axis, ...keyParts] = rest;
    if (!axis || !(GENOME_CONFIG_AXES as readonly string[]).includes(axis)) {
      throw new Error(`unknown genome.config axis: ${axis ?? '(missing)'}; known: ${GENOME_CONFIG_AXES.join(', ')}`);
    }
    const key = keyParts.join('.');
    if (!key) throw new Error(`genome.config.${axis} knob needs a key: genome.config.${axis}.<key>`);
    const config = (delta.config ??= {});
    const axisRecord = (config[axis as GenomeConfigAxis] ??= {}) as Record<string, unknown>;
    axisRecord[key] = value;
    return;
  }
  throw new Error(`unknown genome sub-axis: ${head ?? '(missing)'}; expected prompts|config`);
}

/**
 * Partition an arm into per-axis deltas. Throws on a safety-excluded or unknown-axis
 * knob (defense in depth — callers MUST {@link validateArm} first, but partitioning
 * must never silently apply an excluded knob). The `genome.*` axis folds into a
 * GenomeDelta; `overlay.*` / `model.*` return raw records for the runner. Pure.
 */
export function partitionArm(arm: KnobArm): PartitionedArm {
  const genomeDelta: GenomeDelta = {};
  const overlay: Record<string, unknown> = {};
  const models: Record<string, string> = {};

  for (const [address, value] of Object.entries(arm.knobs)) {
    if (isSafetyExcluded(address)) {
      throw new Error(`refusing to apply a safety-excluded knob: ${address}`);
    }
    const segments = address.split('.');
    const axis = segments[0];
    const tail = segments.slice(1).join('.');
    if (axis === 'genome') {
      applyGenomeKnob(genomeDelta, segments.slice(1), value);
    } else if (axis === 'overlay') {
      if (!tail) throw new Error('overlay knob needs a sub-path: overlay.<…>');
      overlay[tail] = value;
    } else if (axis === 'model') {
      if (!tail) throw new Error('model knob needs a role: model.<role>');
      if (typeof value !== 'string') throw new Error(`model knob ${address} must be a model-id string`);
      models[tail] = value;
    } else {
      throw new Error(`unknown knob axis: ${axis} (${address}); known axes: ${KNOB_AXES.join(', ')}`);
    }
  }
  return { genomeDelta, overlay, models };
}

/** Apply an arm's `genome.*` knobs onto a base genome → the varied genome. Pure. */
export function applyArmGenome(base: Genome, arm: KnobArm): Genome {
  return mergeGenome(base, partitionArm(arm).genomeDelta);
}
