/**
 * THE MEASURED-NESS INVARIANT — main-green-status-visible-2026-09-03 P-012.
 *
 * "MEASURED EMPTY" MUST NEVER RENDER AS "NOTHING FAILING".
 *
 * Every broken surface the D-001 audit found failed the same way. The code was
 * scrupulous about not OVERCLAIMING — it never invented a failure — and careless
 * about the resulting silence reading as good news: `candidateFailures` answered
 * `0 / none-failing` having judged zero files; `postSuiteMeasured` was permanently
 * null; `whyNot.failingLegs` was blanked during every repair; `freezeAndConverge`
 * was simply absent. Each instance was fixed on its own (P-003, P-004, P-005) and
 * each fix left the PATTERN armed for the next cell.
 *
 * This module is the pattern-level fix. It states one structural rule and gives the
 * registry a way to declare compliance that a build-time guard verifies against a
 * REAL payload:
 *
 *   A hoisted COUNT or LIST is never alone. Every headline / evidence path whose value
 *   is a number, an array, or a null standing where a count or list would be, is PAIRED
 *   — in the cell's own declaration (`assessment.measuredBy`) — with the same-payload
 *   path that says whether it was MEASURED, and that flag path is itself hoisted, so
 *   the pair travels together through every surface that carries the value
 *   (`state:read`, the assessment prose, the plane stamp).
 *
 * WHY A PAIRING AND NOT A CONVENTION. A naming convention ("the flag is the sibling
 * called `measured`") is exactly the kind of rule that holds until the fifth cell,
 * whose author never read it. A declaration is checkable: the guard rejects a count
 * with no pair, a pair whose flag is not hoisted, a flag that is itself a number or a
 * list (a count cannot vouch for a count), and a pair naming a path the cell does not
 * hoist at all. Nothing here interprets the flag — `measured: false`,
 * `provenance: 'carried'`, `unavailable: 'no-frozen-candidate'` and
 * `nonTestLegsMeasured: 'not-recorded'` all keep their own semantics, declared beside
 * their codes. The invariant is that the flag is PRESENT beside the value, never that
 * a generic reader knows how to read it.
 *
 * WHY THE GUARD CLASSIFIES BY TYPE, FROM A LIVE PAYLOAD. "Is this path a count or a
 * list" is a fact the resolver owns. Reading it off a real payload derives it (rung 1
 * of the derived-truth ladder) instead of restating it in a second hand-kept list. The
 * one place a name is consulted is a NULL value: a null cannot be typed, and a null AT
 * A COUNT PATH is precisely the unmeasured rendering this invariant exists to catch —
 * so `COUNT_OR_LIST_LEAF` decides whether a null is standing in for a count. It is
 * deliberately narrow and deliberately visible; widen it here, never by exempting a
 * cell.
 *
 * TWO STRUCTURAL EXEMPTIONS, both stated rather than implied:
 *   • The cell's `unknownHoist` is itself a measured-ness surface (D-039) — a list of
 *     what was NOT measured. It is never a subject of the invariant, and it MAY serve
 *     as the flag for another path even though it is array-shaped.
 *   • A `nullable: false` cell attests (`whyTotal`) that its resolver returns a value
 *     or throws, never a default — so its counts have no unmeasured rendering to pair
 *     against; the read layer's `status:'unknown'` carries the throw. Its counts are
 *     paired BY TOTALITY. The registry already refuses `nullable: false` without that
 *     attestation, so this is not a loophole an author reaches by omission.
 *
 * SPLIT IN TWO ON PURPOSE. `measurednessStructuralViolations` needs only the spec and
 * runs at REGISTRATION (cell-registry.ts validateCellSpec), so a malformed pairing is
 * refused before any read. `measurednessViolations` needs the cell's live payload and
 * runs in the P-012 guard (cell-assessment-reality.test.ts), which is where "a hoisted
 * count with no pair" can be decided at all. This file imports nothing that imports the
 * registry, so the registry can import it without a cycle.
 */
import type { CellSpec } from './cell-registry';

/**
 * Leaf names under which a NULL is read as "an unmeasured count or list" rather than
 * "a measured null of some other kind". Matched case-insensitively against the LAST
 * dotted segment only.
 */
export const COUNT_OR_LIST_LEAF =
  /(count|total|ids|files|legs|signatures|paths|failing|fixed|missing|unknown|stale|behind|ahead|reds|attempts|rounds|surfaces|below|evidenced|pct|percent|blockers|duplicates|competing)$/i;

/**
 * Leaf names whose NUMERIC value is a timestamp, an age or a duration — an instant on
 * a clock, not a count of anything. A null there is "no instant recorded", which the
 * cell's own `stale` / `observedAtMs` handling already expresses; it is not the
 * false-empty this invariant guards. Matched against the last dotted segment.
 */
export const INSTANT_OR_DURATION_LEAF = /(ms|at|atms|epoch|sec|seconds|minutes|hours|days)$/i;

export type MeasurednessViolationKind =
  /** A hoisted count/list has no `measuredBy` pairing. */
  | 'unpaired-count-or-list'
  /** The pairing's flag path is not itself hoisted (headline, evidence or unknownHoist). */
  | 'flag-not-hoisted'
  /** The flag resolved, on the live payload, to a number, an array or an object — it
   *  cannot vouch for a count because it IS one. (The unknownHoist is the exception.) */
  | 'flag-not-a-flag'
  /** The flag path did not arrive in the live payload at all. */
  | 'flag-absent'
  /** A pairing names a count/list path the cell never hoists — a dangling declaration. */
  | 'pair-not-hoisted'
  /** A pairing maps a path to itself. */
  | 'self-paired'
  /** A pairing on the unknownHoist itself — the hoist IS the flag, it cannot need one. */
  | 'hoist-paired';

export interface MeasurednessViolation {
  cell: string;
  kind: MeasurednessViolationKind;
  /** The count/list path (or, for a flag problem, the flag path). */
  path: string;
  detail: string;
}

/** The slice of a spec the invariant reads. */
export type MeasurednessSpec = Pick<CellSpec, 'cell' | 'headline' | 'assessment' | 'unknownHoist' | 'nullable'>;

/** Every path a cell hoists: headline, assessment evidence, unknownHoist. Deduplicated. */
export function hoistedPaths(spec: Pick<CellSpec, 'headline' | 'assessment' | 'unknownHoist'>): string[] {
  const out = new Set<string>();
  out.add(spec.headline);
  for (const p of spec.assessment?.evidence ?? []) out.add(p);
  if (spec.unknownHoist) out.add(spec.unknownHoist);
  return [...out];
}

function leafOf(path: string): string {
  const i = path.lastIndexOf('.');
  return i === -1 ? path : path.slice(i + 1);
}

/**
 * Own-key dotted walk with the MISSING ≠ NULL split `pathExists` (state-plane-stamp.ts)
 * makes. Re-stated here rather than imported so this module stays cycle-free for the
 * registry; behaviourally identical for the cases the guard relies on.
 */
export function valueAtPath(obj: unknown, path: string): { exists: boolean; value: unknown; missingAt?: string } {
  let cur: unknown = obj;
  const segs = path.split('.');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (cur === null || cur === undefined || (typeof cur !== 'object' && typeof cur !== 'function')) {
      return { exists: false, value: undefined, missingAt: segs.slice(0, i + 1).join('.') };
    }
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) {
      return { exists: false, value: undefined, missingAt: segs.slice(0, i + 1).join('.') };
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return { exists: true, value: cur };
}

/**
 * Is the value at this path a COUNT or a LIST, for the purposes of the invariant?
 *   • a finite number, unless the leaf names an instant/duration      → count
 *   • an array                                                        → list
 *   • null at a leaf matching COUNT_OR_LIST_LEAF                      → count/list (unmeasured)
 * Everything else (booleans, strings, objects, undefined) is not this invariant's subject.
 */
export function isCountOrList(path: string, value: unknown): boolean {
  const leaf = leafOf(path);
  if (Array.isArray(value)) return true;
  if (typeof value === 'number') return Number.isFinite(value) && !INSTANT_OR_DURATION_LEAF.test(leaf);
  if (value === null) return COUNT_OR_LIST_LEAF.test(leaf) && !INSTANT_OR_DURATION_LEAF.test(leaf);
  return false;
}

/** A flag vouches for a count only if it is NOT itself a count/list/object — unless it
 *  is the cell's unknownHoist, which is a list of what was NOT measured by definition. */
export function isFlagShaped(value: unknown, opts: { isUnknownHoist: boolean }): boolean {
  if (opts.isUnknownHoist) return value === null || typeof value !== 'object' || Array.isArray(value);
  return value === null || typeof value === 'boolean' || typeof value === 'string';
}

/**
 * THE REGISTRATION-TIME HALF. Needs only the spec: every declared pair names two
 * distinct hoisted paths, and nothing pairs the unknownHoist as a subject.
 */
export function measurednessStructuralViolations(spec: MeasurednessSpec): MeasurednessViolation[] {
  const out: MeasurednessViolation[] = [];
  const hoistedSet = new Set(hoistedPaths(spec));
  const pairs = spec.assessment?.measuredBy ?? {};
  for (const [countPath, flagPath] of Object.entries(pairs)) {
    if (countPath === flagPath) {
      out.push({ cell: spec.cell, kind: 'self-paired', path: countPath, detail: `"${countPath}" is paired with itself — a path cannot be its own measured-ness flag` });
      continue;
    }
    if (spec.unknownHoist && countPath === spec.unknownHoist) {
      out.push({
        cell: spec.cell,
        kind: 'hoist-paired',
        path: countPath,
        detail: `"${countPath}" is this cell's unknownHoist — it IS the measured-ness surface and cannot be paired as a subject`,
      });
    }
    if (!hoistedSet.has(countPath)) {
      out.push({
        cell: spec.cell,
        kind: 'pair-not-hoisted',
        path: countPath,
        detail: `measuredBy names "${countPath}", which is neither the headline nor an evidence path nor the unknownHoist of this cell`,
      });
    }
    if (!hoistedSet.has(flagPath)) {
      out.push({
        cell: spec.cell,
        kind: 'flag-not-hoisted',
        path: flagPath,
        detail: `"${countPath}" is paired with "${flagPath}", but that flag is not hoisted — the pair would not travel together. Add it to assessment.evidence.`,
      });
    }
  }
  return out;
}

/**
 * THE GUARD PREDICATE. Pure, so it can be falsified with deliberately-broken specs
 * against a real payload (the controls in cell-assessment-reality.test.ts).
 *
 * `payload` is the cell's own resolver result. Pass `undefined` for a cell whose
 * payload is not obtainable in the guard's context: the structural checks still run;
 * the type-based checks (unpaired counts, flag shape, flag presence) need a payload and
 * are skipped — which is why the guard also pins WHICH cells run payload-less.
 */
export function measurednessViolations(spec: MeasurednessSpec, payload: unknown): MeasurednessViolation[] {
  const out = measurednessStructuralViolations(spec);
  if (payload === undefined) return out;

  const pairs = spec.assessment?.measuredBy ?? {};
  for (const p of hoistedPaths(spec)) {
    if (spec.unknownHoist && p === spec.unknownHoist) continue; // the hoist is a flag, not a subject
    const r = valueAtPath(payload, p);
    if (!r.exists) continue; // registration drift is the P-004 walk's finding, not this one's
    if (!isCountOrList(p, r.value)) continue;
    const flag = pairs[p];
    if (!flag) {
      if (spec.nullable === false) continue; // paired by totality — see the header
      const shape = Array.isArray(r.value)
        ? `a list (${r.value.length} entries)`
        : r.value === null
          ? 'null at a count/list leaf'
          : `a number (${String(r.value)})`;
      out.push({
        cell: spec.cell,
        kind: 'unpaired-count-or-list',
        path: p,
        detail:
          `hoisted path "${p}" is ${shape} with NO measured-ness pairing. An empty list or a zero here is ` +
          `indistinguishable from "nothing was measured". Declare assessment.measuredBy["${p}"] = <the same-payload ` +
          `path that says whether it was measured>, and hoist that path in assessment.evidence.`,
      });
      continue;
    }
    const f = valueAtPath(payload, flag);
    if (!f.exists) {
      out.push({
        cell: spec.cell,
        kind: 'flag-absent',
        path: flag,
        detail: `the flag for "${p}" did not arrive in the payload (missing at "${f.missingAt}")`,
      });
    } else if (!isFlagShaped(f.value, { isUnknownHoist: flag === spec.unknownHoist })) {
      out.push({
        cell: spec.cell,
        kind: 'flag-not-a-flag',
        path: flag,
        detail: `the flag for "${p}" resolved to ${Array.isArray(f.value) ? 'a list' : typeof f.value} — a flag must be a boolean, a string or null (or the cell's unknownHoist); a count cannot vouch for a count`,
      });
    }
  }
  return out;
}

/** Render violations as one message a failing assertion can carry. */
export function formatMeasurednessViolations(v: readonly MeasurednessViolation[]): string {
  return v.map((x) => `[${x.cell}] ${x.kind} @ ${x.path}: ${x.detail}`).join('\n');
}
