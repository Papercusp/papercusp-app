/**
 * Blueprint retirement — the launch-eligibility read for `Blueprint.retired`
 * (WI-5645 — no-retirement-launch-guard, root-cause class behind
 * EI-18177667809538623: an autoloop spent real LLM cost against the RETIRED
 * `coding-factory` blueprint via `external-bench`, which `extends:
 * coding-factory` — nothing checked the ancestor chain before spending).
 *
 * `retired` deep-merges through `extends` like any other object field
 * (loader.ts `mergeRaw`: child wins on an explicit key, otherwise the parent's
 * value carries through), so by the time a raw blueprint has been resolved
 * (`resolveBlueprint` / `getEffectiveBlueprint`) `blueprint.retired` already
 * reflects the WHOLE ancestor chain — a descendant that never declares its own
 * `retired` inherits the nearest ancestor's. This module is intentionally the
 * ONE place that turns that resolved field into a launch-eligibility verdict;
 * callers should never hand-check `.retired` themselves (a schema-shape check
 * done ad-hoc at N call sites is exactly how this class of guard rots).
 */
import type { Blueprint } from './schema.js';

export interface BlueprintRetirementInfo {
  retired: true;
  /** When it was retired, if declared (free-form — a date or plan/decision ref). */
  at?: string;
  /** Why, and what (if anything) it takes to revive it, if declared. */
  reason?: string;
}

/**
 * Null when the RESOLVED blueprint (after `extends` inheritance) is not
 * retired. A blueprint (or any ancestor) declaring `retired: {...}` and no
 * descendant clearing it with an explicit `retired: null` is retired.
 */
export function blueprintRetirement(bp: Pick<Blueprint, 'retired'>): BlueprintRetirementInfo | null {
  if (!bp.retired) return null;
  return {
    retired: true,
    ...(bp.retired.at ? { at: bp.retired.at } : {}),
    ...(bp.retired.reason ? { reason: bp.retired.reason } : {}),
  };
}

/** One-line human-readable explanation, e.g. for a log line or a thrown error. */
export function describeBlueprintRetirement(info: BlueprintRetirementInfo, blueprintId: string): string {
  const bits = [`blueprint "${blueprintId}" is RETIRED`];
  if (info.at) bits.push(`(${info.at})`);
  if (info.reason) bits.push(`— ${info.reason}`);
  return bits.join(' ');
}

/** Thrown by `assertBlueprintLaunchEligible` — carries the machine-readable verdict. */
export class BlueprintRetiredError extends Error {
  readonly blueprintId: string;
  readonly info: BlueprintRetirementInfo;

  constructor(blueprintId: string, info: BlueprintRetirementInfo) {
    super(describeBlueprintRetirement(info, blueprintId));
    this.name = 'BlueprintRetiredError';
    this.blueprintId = blueprintId;
    this.info = info;
  }
}

/**
 * The launch-eligibility guard: throws `BlueprintRetiredError` when the
 * resolved blueprint (or any ancestor in its `extends` chain) is retired.
 *
 * Deliberately NOT wired into the pure loader (`resolveBlueprint`) itself —
 * that function is also the read path for browsing/catalog/authoring, where a
 * retired blueprint must still resolve (so it can be *shown* as retired, not
 * error out). Call this instead at an actual LAUNCH/SPEND chokepoint — e.g.
 * before starting a new pipeline run or firing an autoloop cycle against a
 * harness's effective blueprint.
 */
export function assertBlueprintLaunchEligible(bp: Blueprint): void {
  const info = blueprintRetirement(bp);
  if (info) throw new BlueprintRetiredError(bp.id, info);
}
