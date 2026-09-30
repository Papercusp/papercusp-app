/**
 * The Learning tab's pot-chip rail model (plan learning-pot-scope-gate-2026-08-30, P-006).
 *
 * Pure and React-free so the rules below are testable without rendering: every
 * one of them is a rule this codebase has already been burned by getting
 * backwards somewhere, so each is asserted directly in learning-pot-rail.test.ts.
 *
 * THE THREE RULES THAT ARE EASY TO INVERT
 *
 * 1. FAIL-OPEN (R-5). `learning_pot_scope` ships EMPTY and an ABSENT row means
 *    ENABLED. A surface that re-derives this and gets it backwards renders every
 *    pot as switched off — which is why the catalog serves `disabledPots`
 *    explicitly rather than an enabled list, and why this module only ever asks
 *    "is it in disabledPots?".
 *
 * 2. `potScope: null` IS NOT AN EMPTY SCOPE. Null means the read FAILED. An
 *    empty scope means "every pot is learning" — a claim this rail must not make
 *    when it never read the table. Null therefore maps to 'unknown', never 'on'.
 *    (Same posture the resolver takes at catalog.ts's degrade path.)
 *
 * 3. A SEGMENT'S STATE IS ITS OWN ARMING, NOT THE EFFECTIVE OUTCOME. Switching a
 *    pot off deliberately leaves each lane's arming untouched so switching it
 *    back on restores exactly what was armed. So `gym`/`lanes` here report what
 *    the lane itself has armed; the master switch is reported separately as
 *    `learning`, and the effective answer is the AND of the two. Collapsing them
 *    would destroy the "restores what was armed" property the store relies on.
 *
 * WHY SCOUT HAS NO SPEND. Scout is gated per-pot (scoutPotGate resolves the
 * install's pot via resolveLearningPotSlug and asks the same switch), but it is
 * ARMED workspace-wide by the scout ceiling, and no per-pot scout spend exists
 * in this read model. Its segment therefore mirrors the master switch and
 * reports `spentUsd: null` — unknown — rather than a fabricated 0. A 0 here
 * would read as "this pot's scout has spent nothing", which we cannot know.
 */
import type {
  AutomationArming,
  AutomationGymArm,
  AutomationLaneArm,
} from '@papercusp/operator-core/lib/automation/catalog';

/**
 * 'absent' is deliberately distinct from 'off': a pot with no gym row has not
 * been switched off, it has never been configured. Collapsing the two would
 * report "gym off" for a pot whose gym was never set up, which invites someone
 * to go looking for a switch that does not exist.
 */
export type PotSegmentState = 'on' | 'off' | 'absent' | 'unknown';

export interface PotRailSegment {
  state: PotSegmentState;
  /** null = NOT MEASURABLE from this read. Never coerced to 0 — see module header. */
  spentUsd: number | null;
  /** Short human reason, safe to use as a title/tooltip. */
  detail: string;
}

export interface PotRailLaneSegment extends PotRailSegment {
  armed: number;
  total: number;
}

export interface LearningPotChip {
  potSlug: string;
  /** The per-pot master switch. 'unknown' when the scope read failed. */
  learning: PotSegmentState;
  scout: PotRailSegment;
  gym: PotRailSegment;
  lanes: PotRailLaneSegment;
  /**
   * Total of the spend we can actually attribute to this pot (gym + lanes).
   * Scout is excluded because it is not per-pot measurable, so this is a floor,
   * not a complete cost — `spendComplete` says so rather than leaving a caller
   * to assume the number is whole.
   */
  spentUsd: number;
  spendComplete: false;
}

function laneBelongsToPot(lane: AutomationLaneArm, potSlug: string): boolean {
  return lane.potSlug === potSlug;
}

/**
 * The pots the rail shows: those with a learning PRESENCE — a gym autoloop row
 * or at least one governor lane.
 *
 * NOTE ON "only pots that are learning" (P-006): this is read as presence, not
 * as master-switch-on. A pot that has been switched OFF still appears, dimmed,
 * because the rail chip is what opens the per-pot popover that can switch it
 * back on; dropping it from the rail the moment it is disabled would strand it
 * behind the separate every-pot picker. The picker is the "every pot in the
 * workspace" surface by its own definition; this rail is the "pots that do
 * learning" surface.
 */
export function learningPotSlugs(arming: AutomationArming): string[] {
  // Same cache-boundary reasoning as masterSwitch: every field here is declared
  // required, but a stale cached catalog can be missing any of them, and an
  // iteration over `undefined` throws exactly as hard as a bad dereference.
  const slugs = new Set<string>();
  for (const g of arming.gymPots ?? []) if (g?.harnessSlug) slugs.add(g.harnessSlug);
  for (const l of arming.lanes ?? []) if (l?.potSlug) slugs.add(l.potSlug);
  return [...slugs];
}

/**
 * The individual arming rows behind ONE pot's chip — what the P-007 popover
 * needs in order to offer a switch per lane rather than the aggregate the chip
 * shows.
 *
 * WHY THIS IS IN THE MODEL AND NOT THE COMPONENT. `LearningPotChip.lanes` is
 * deliberately an AGGREGATE (`3/4 armed`), which is right for a chip and
 * useless for a control surface — you cannot arm "3/4". The popover therefore
 * needs the rows themselves, and the temptation is to reach past the model into
 * the raw `arming` inside the component. That is exactly how the pot-scope rule
 * gets re-derived and inverted somewhere new (see the module header), so the
 * second read lives here too, under the same nullish discipline (D-006).
 *
 * ORDER IS DETERMINISTIC — armed first, then by display name — matching the
 * chip's own `enabled DESC, slug ASC` ordering so the popover does not reshuffle
 * its switches between polls while someone is reaching for one.
 */
export interface PotArmingDetail {
  potSlug: string;
  /** null = this pot has no gym autoloop row at all (never configured). */
  gym: AutomationGymArm | null;
  lanes: AutomationLaneArm[];
}

export function potArmingDetail(
  arming: AutomationArming | null | undefined,
  potSlug: string,
): PotArmingDetail {
  if (!arming) return { potSlug, gym: null, lanes: [] };

  let gym: AutomationGymArm | null = null;
  for (const g of arming.gymPots ?? []) {
    if (g?.harnessSlug === potSlug) {
      gym = g;
      break;
    }
  }

  const lanes = (arming.lanes ?? [])
    .filter((l) => l != null && laneBelongsToPot(l, potSlug))
    .slice()
    .sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return (a.displayName ?? a.loopId).localeCompare(b.displayName ?? b.loopId);
    });

  return { potSlug, gym, lanes };
}

/**
 * The pot-level master switch (D-001's gate), read under rules 1 and 2 below.
 *
 * EXPORTED for the P-008 picker. The picker needs this same verdict for all 54
 * pots, and the one thing it must not do is re-derive it: this module's header
 * and D-006 both name re-deriving the pot-scope rule as how it gets inverted
 * somewhere new. One reader, two surfaces.
 */
export function potMasterSwitch(arming: AutomationArming, potSlug: string): PotSegmentState {
  // Rule 2: a failed read is 'unknown', never 'on'.
  // NULLISH, not `=== null`. The type says `AutomationPotScope | null`, which
  // makes a strict null check look exhaustive — but this value crosses a sync
  // CACHE boundary, where the type describes the current server and not the
  // bytes the client actually holds. `potScope` was added by P-005, so any
  // catalog payload cached before it has no such key, and `=== null` waved
  // `undefined` straight through to the dereference below. That crashed the
  // whole Learning tab via the error boundary (WI-1397883, owner-reported).
  // A scope object whose `disabledPots` did not survive the cache boundary is
  // unreadable for the same reason, and defaulting it to `[]` would be the
  // fail-open mistake in rule 1's clothing: it would report every pot 'on' off
  // a payload we could not actually read.
  if (arming.potScope == null || !Array.isArray(arming.potScope.disabledPots)) return 'unknown';
  // Rule 1: ask only about ABSENCE from disabledPots.
  return arming.potScope.disabledPots.includes(potSlug) ? 'off' : 'on';
}

function gymSegment(row: AutomationGymArm | undefined): PotRailSegment {
  if (!row) {
    return { state: 'absent', spentUsd: null, detail: 'No gym autoloop configured for this pot' };
  }
  return {
    state: row.enabled ? 'on' : 'off',
    spentUsd: row.spentUsd,
    detail: row.enabled
      ? `Gym armed — status ${row.status}`
      : `Gym disarmed — status ${row.status}`,
  };
}

function laneSegment(lanes: AutomationLaneArm[]): PotRailLaneSegment {
  if (lanes.length === 0) {
    return { state: 'absent', spentUsd: null, detail: 'No governor lanes for this pot', armed: 0, total: 0 };
  }
  const armed = lanes.filter((l) => l.enabled).length;
  const spentUsd = lanes.reduce((sum, l) => sum + (Number.isFinite(l.spentUsd) ? l.spentUsd : 0), 0);
  return {
    state: armed > 0 ? 'on' : 'off',
    spentUsd,
    detail: `${armed} of ${lanes.length} governor ${lanes.length === 1 ? 'lane' : 'lanes'} armed`,
    armed,
    total: lanes.length,
  };
}

function scoutSegment(master: PotSegmentState): PotRailSegment {
  if (master === 'unknown') {
    return { state: 'unknown', spentUsd: null, detail: 'Pot switch unreadable — scout state unknown' };
  }
  return {
    state: master,
    spentUsd: null,
    detail:
      master === 'on'
        ? 'Scout runs for this pot; it is armed workspace-wide by the scout ceiling, so no per-pot scout spend is attributable here'
        : 'Scout is gated off for this pot by the pot switch',
  };
}

/**
 * Build the rail. Ordering is deterministic — enabled first, then heaviest
 * spend, then slug — mirroring the `enabled DESC, slug ASC` the arming reads
 * already use, so the rail does not reshuffle between polls.
 */
export function buildLearningPotRail(arming: AutomationArming | null | undefined): LearningPotChip[] {
  if (!arming) return [];
  // Every collection here is declared required and is read nullish anyway: the
  // arming crosses a sync CACHE boundary, so the type describes the current
  // server rather than the bytes this client holds. See masterSwitch.
  const gymBySlug = new Map<string, AutomationGymArm>();
  for (const g of arming.gymPots ?? []) if (g?.harnessSlug) gymBySlug.set(g.harnessSlug, g);
  const chips = learningPotSlugs(arming).map<LearningPotChip>((potSlug) => {
    const learning = potMasterSwitch(arming, potSlug);
    const gym = gymSegment(gymBySlug.get(potSlug));
    const lanes = laneSegment(
      (arming.lanes ?? []).filter((l) => l != null && laneBelongsToPot(l, potSlug)),
    );
    return {
      potSlug,
      learning,
      scout: scoutSegment(learning),
      gym,
      lanes,
      spentUsd: (gym.spentUsd ?? 0) + (lanes.spentUsd ?? 0),
      spendComplete: false,
    };
  });
  return chips.sort((a, b) => {
    const rank = (c: LearningPotChip) => (c.learning === 'off' ? 1 : 0);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (b.spentUsd !== a.spentUsd) return b.spentUsd - a.spentUsd;
    return a.potSlug.localeCompare(b.potSlug);
  });
}

/**
 * DORMANT: a pot with a learning SETUP but nothing armed and no decision ever
 * recorded about it — a gym row that was configured and disarmed, or governor
 * lanes that all sit off. It is genuinely "not learning" right now.
 *
 * WHY THIS EXISTS. Presence alone is far too wide to be a rail. Measured
 * against the live workspace on 2026-08-30: 54 pots have a learning presence
 * and exactly 7 have anything armed, with learning_pot_scope empty — so a rail
 * built on presence renders 54 identical chips (every one 'on', since an absent
 * scope row fails open) in a wrapping wall under the stage stepper. That is the
 * every-pot picker's job, not the rail's.
 *
 * WHAT KEEPS A DORMANT POT REACHABLE. It is partitioned, never dropped:
 * `dormant` is returned alongside `active` so the rail can account for all of
 * them in one affordance and hand them to the picker.
 *
 *   - `learning === 'off'` — switched off deliberately, and dormant ONLY when
 *     nothing is armed under it. An off pot with a live gym or lane keeps its
 *     chip, because that pot is still spending.
 *
 *     ⚠ THIS BECAME SAFE ONLY WHEN P-012 LANDED — do not port the rule back.
 *     Two earlier narrowings were both falsified by LearningPotRail.test.tsx —
 *     first "off is always dormant", then "off with nothing armed is dormant" —
 *     and the second was falsified for a reason that still holds: arming a lane
 *     on a switched-off pot is MEANINGFUL (it pre-stages what switching the pot
 *     on will restore), so a fully-idle off pot still owns live switches. The
 *     picker cannot host them either — D-007 keeps per-lane control off that
 *     surface, so it restores the GATE only. What changed is P-012's per-pot
 *     drawer: it opens from the picker BY SLUG, needs no chip, and carries
 *     every per-lane switch. The switches did not go away; they moved, which is
 *     why the falsifying test moved to LearningPotDrawer.test.tsx rather than
 *     being deleted. Removing the drawer re-strands them — this rule depends on
 *     it. The width this buys back is the owner's "gigantic" complaint: with
 *     all 28 pots off the rail rendered 26 chips at 522px, clipped.
 *   - `learning === 'unknown'` — the scope read failed, and this case is
 *     UNCHANGED: still never dormant. Hiding a pot whose state we could not
 *     read would silently under-report the rail, which is the same fail-open
 *     mistake the module header exists to prevent. Note the asymmetry is
 *     deliberate — 'off' is a fact we read, 'unknown' is the absence of one.
 */
export function isPotChipDormant(chip: LearningPotChip): boolean {
  if (chip.learning === 'unknown') return false;
  return chip.gym.state !== 'on' && chip.lanes.state !== 'on';
}

export interface LearningPotRailPartition {
  /** Chips the rail renders: something armed, switched off, or unreadable. */
  active: LearningPotChip[];
  /** Setup-but-idle pots, summarised behind one affordance rather than dropped. */
  dormant: LearningPotChip[];
}

/** Split a built rail into what it renders and what it summarises. Order-preserving. */
export function partitionLearningPotRail(chips: LearningPotChip[]): LearningPotRailPartition {
  const active: LearningPotChip[] = [];
  const dormant: LearningPotChip[] = [];
  for (const chip of chips) (isPotChipDormant(chip) ? dormant : active).push(chip);
  return { active, dormant };
}
