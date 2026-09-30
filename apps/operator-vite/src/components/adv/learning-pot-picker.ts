/**
 * The every-pot scope picker's model (learning-pot-scope-gate-2026-08-30, P-008).
 *
 * WHAT THIS SURFACE IS, AND WHY IT IS NOT THE RAIL. D-005 split the two
 * deliberately: the rail is the "pots that do learning" surface and summarises
 * the dormant tail into one counted chip, because a presence rail renders 54
 * identically-prominent chips and buries the 7 that are actually running. THIS
 * is the "every pot in the workspace" surface — the only one that enumerates
 * all of them, and therefore the only route to a dormant pot's controls.
 *
 * THE ONE RULE THAT MAKES THIS HONEST (D-007). The pot switch is a GATE, not an
 * arm: `learning:set-pot-scope`'s own contract is "true = release the gate (each
 * lane resumes at its own prior arming)". Releasing the gate on a pot whose
 * lanes are all disarmed therefore starts NOTHING, and a picker that reports
 * that pot as now-learning is lying to the person spending the money. So every
 * row carries a CONSEQUENCE — what arming it would actually do — and the
 * disarmed-but-configured case is the MAJORITY case here, not an edge one:
 * D-005 measured 54 pots with a learning presence, 7 with anything armed, 47
 * with a setup and nothing running.
 *
 * NULLISH DISCIPLINE (D-006). Every field below is declared required and every
 * one of them crosses a sync CACHE boundary, where the type describes the
 * current server and not the bytes this client actually holds. Iterating
 * `undefined` throws exactly as hard as a bad dereference — and that crash took
 * out the whole Learning tab once already (WI-1397883). Guard, never assume.
 */
import type {
  AutomationArming,
  AutomationLaneArm,
} from '@papercusp/operator-core/lib/automation/catalog';

import {
  learningPotSlugs,
  potArmingDetail,
  potMasterSwitch,
  type PotSegmentState,
} from './learning-pot-rail';

/**
 * The lane a pot that has NEVER learned would start.
 *
 * Gym is the per-pot learning lane (`gym_autoloop_config` is keyed by pot, one
 * row per pot) and `gym:arm` is its write, so it is the lane a fresh pot starts
 * with. Named as a constant because P-008 requires the row to NAME it rather
 * than leave "turn this on" meaning something the user has to guess.
 */
export const FIRST_LANE_FOR_NEW_POT = 'Gym';

/** What arming a row would ACTUALLY do — never assumed, always stated. */
export type PotPickerConsequence =
  /** Has armed lanes: releasing the gate resumes exactly these. */
  | { kind: 'resumes'; lanes: string[] }
  /** Configured, but every lane is disarmed — the gate alone starts nothing. */
  | { kind: 'starts-nothing'; needsLane: string }
  /** Never learned at all: no gym row, no governor lane. */
  | { kind: 'starts'; lane: string };

export interface PotPickerRow {
  potSlug: string;
  /** The pot's master gate: 'on' | 'off' | 'unknown' (never guessed — D-001 rule 2). */
  learning: PotSegmentState;
  /** How many of this pot's lanes (gym counted as one) are actually armed. */
  armedCount: number;
  /** Total configured lanes for this pot, gym included. 0 ⇒ never learned. */
  laneCount: number;
  /** True when nothing is configured at all — no gym row and no governor lane. */
  neverLearned: boolean;
  /** What arming this row would actually do. */
  consequence: PotPickerConsequence;
}

/**
 * The minimal shape the picker needs from a workspace pot listing. Structural
 * on purpose: the model must not import a component's type, and a test must be
 * able to build a pot without standing up `harnessProjects.lite`.
 */
export interface PickerPotRef {
  slug: string;
  /**
   * `'hive'` marks a POT. The listing this comes from (`harnessProjects.lite`)
   * is EVERY project in the workspace — repos and submodules included — and
   * only a pot can hold learning rows, so this is what separates the two.
   * Snake_case because it is the wire field, unmapped, straight off the sync
   * payload (`projects-lite.ts`).
   */
  harness_kind?: string | null;
}

/** Pots are the only projects that can learn — everything else cannot hold a lane. */
const POT_HARNESS_KIND = 'hive';

function laneLabel(lane: AutomationLaneArm): string {
  return lane.displayName ?? lane.loopId;
}

/**
 * Every pot in the workspace, armed first.
 *
 * POPULATION IS A UNION, NOT A LISTING. The workspace project list is the
 * obvious source and is not sufficient by itself: a pot carrying arming rows
 * but missing from that listing would be invisible here, and this is the only
 * surface that can switch it off — so it would keep spending with no route to
 * stop it. Taking the union with the pots the arming block itself names makes
 * that unreachable-but-spending state impossible to hide, at the cost of
 * occasionally showing a pot the listing has not caught up with. That is the
 * correct direction to fail in for a spend control.
 *
 * ...BUT THE LISTING HALF IS POTS ONLY. `harnessProjects.lite` is every PROJECT
 * in the workspace, and taking it whole made this surface list 116 rows against
 * 28 real pots — 38 of them `papercusp/libs/*` submodules that cannot hold a
 * learning row at all, and every one of them a row `learning:set-pot-scope`
 * would REFUSE as an unknown pot slug. So the listing is filtered to
 * `harness_kind:'hive'`.
 *
 * Filtering here is safe precisely BECAUSE of the union above: a pot the
 * listing mislabels or omits still enters through `learningPotSlugs(arming)`,
 * so the strict filter cannot hide a pot that is spending — and cannot empty
 * the picker either if an older cached payload predates the field.
 */
export function buildPotPickerRows(
  projects: readonly PickerPotRef[] | null | undefined,
  arming: AutomationArming | null | undefined,
): PotPickerRow[] {
  const slugs = new Set<string>();
  for (const p of projects ?? []) {
    if (p?.slug && p.harness_kind === POT_HARNESS_KIND) slugs.add(p.slug);
  }
  if (arming) for (const s of learningPotSlugs(arming)) slugs.add(s);

  const rows: PotPickerRow[] = [];
  for (const potSlug of slugs) {
    const detail = potArmingDetail(arming, potSlug);
    const gym = detail.gym;
    const lanes = detail.lanes ?? [];

    const armed: string[] = [];
    if (gym?.enabled) armed.push('Gym');
    for (const lane of lanes) if (lane?.enabled) armed.push(laneLabel(lane));

    const laneCount = (gym ? 1 : 0) + lanes.length;
    const neverLearned = laneCount === 0;

    let consequence: PotPickerConsequence;
    if (armed.length > 0) {
      consequence = { kind: 'resumes', lanes: armed };
    } else if (neverLearned) {
      consequence = { kind: 'starts', lane: FIRST_LANE_FOR_NEW_POT };
    } else {
      // Configured but everything disarmed — the majority case (D-005: 47 of
      // 54). Name the lane that has to be armed, so the row does not read as
      // "switch this on and it learns".
      consequence = {
        kind: 'starts-nothing',
        needsLane: gym ? 'Gym' : laneLabel(lanes[0]),
      };
    }

    rows.push({
      potSlug,
      learning: arming ? potMasterSwitch(arming, potSlug) : 'unknown',
      armedCount: armed.length,
      laneCount,
      neverLearned,
      consequence,
    });
  }

  // ARMED FIRST (P-008), then by slug. Deterministic on every axis so the list
  // cannot reshuffle under someone's cursor between polls — the same reasoning
  // that fixes the popover's lane order.
  return rows.sort((a, b) => {
    if ((a.armedCount > 0) !== (b.armedCount > 0)) return a.armedCount > 0 ? -1 : 1;
    return a.potSlug.localeCompare(b.potSlug);
  });
}

/**
 * Search. Matches the pot slug case-insensitively.
 *
 * A BLANK QUERY RETURNS EVERY ROW — it is not a filter that matches nothing.
 * Whitespace is trimmed first, so a stray space cannot empty the list and read
 * as "this workspace has no pots".
 */
export function filterPotPickerRows(
  rows: readonly PotPickerRow[],
  query: string | null | undefined,
): PotPickerRow[] {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((r) => r.potSlug.toLowerCase().includes(q));
}

/**
 * The footer's ONE write.
 *
 * `learning:set-pot-scope` takes `pots: string[]` (max 500) and is documented as
 * "a single atomic write and a single audit event", so the footer maps 1:1 onto
 * one existing call — no new bulk verb and no loop over pots (D-007).
 *
 * Returns null when the selection is empty, so the caller has nothing to send
 * rather than a call that would flip zero pots and still write an audit event.
 * Selected slugs are intersected with the VISIBLE rows: a selection left over
 * from a previous search must never silently flip a pot the user cannot see.
 */
export function potScopeWrite(
  rows: readonly PotPickerRow[],
  selected: ReadonlySet<string>,
  enabled: boolean,
): { pots: string[]; enabled: boolean } | null {
  const pots = rows.map((r) => r.potSlug).filter((s) => selected.has(s));
  if (pots.length === 0) return null;
  return { pots, enabled };
}
