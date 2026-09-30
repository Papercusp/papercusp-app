/**
 * goal-fleet-launch-options — the PURE mapper from a goal's role profiles to the
 * fleet layer's launch-option shape
 * (goal-launch-headless-and-fleet-type-2026-08-26 P-006, D-001/D-004/D-005/D-006).
 *
 * THE TWO SHAPES IT BRIDGES, and why they are deliberately different (D-001):
 *
 *   goal record  → `roles`, a partialRecord keyed by the CLOSED launch-slot
 *                  vocabulary (`plan-fleet-director`, `drain-fleet-member`, …).
 *                  One shape, hand-edited by an owner through the goal panel.
 *   fleet layer  → `resolveLaunchOptions`'s type-conditional input: FLAT knobs on
 *                  a single fleet, nested `directors`/`implementers` groups on a
 *                  paired one.
 *
 * Mirroring the nested groups onto the goal record would give one object two
 * competing ways to say the same thing, so the goal keeps its slot vocabulary and
 * the conversion happens HERE, at the boundary, in a pure function.
 *
 * Pure and side-effect free on purpose, exactly like `pair-launch-options.ts` next
 * door: this is the branch worth pinning with tests, and per D-003 a settings
 * change is proven by what a launch RECEIVES — which means the mapping has to be
 * provable without opening a terminal.
 */
import type { FleetType } from '../../agent-fleets-store';
import {
  foldLaunchProfile,
  type GoalLaunchSettings,
  type LaunchProfile,
} from '../../goal-launch-settings';
import {
  goalFleetFamily,
  goalFleetLeaderSlot,
  goalFleetLaunchSlots,
  goalFleetMemberSlot,
  type GoalFleetFamily,
  type GoalFleetSlots,
  type GoalLaunchRole,
} from '../../goal-launch-settings-shared';
import {
  PER_ROLE_KNOBS,
  type LaunchOptionInput,
  type RoleLaunchOptions,
} from './pair-launch-options';

/**
 * WHO chose the fleet shape (D-006).
 *
 * Carried rather than discarded because the launch door has to be able to SAY so:
 * once a goal can supply `type`, a caller who passed flat knobs and no `type` at
 * all can be refused for a shape they never declared, and a refusal that reads
 * "type:'paired' was declared" would be pointing at the wrong author.
 */
export type FleetTypeSource = 'caller' | 'goal' | 'default';

export { resolveGoalFleetLeadership, type GoalFleetLeadershipResolution } from './goal-fleet-leadership';

/** Bind the declared leader profile independently from member role profiles. */
export function goalFleetLeaderProfile(args: {
  settings: GoalLaunchSettings | null;
  family: GoalFleetFamily;
  requested?: LaunchProfile | null;
}): LaunchProfile {
  return foldLaunchProfile(args.settings, goalFleetLeaderSlot(args.family), args.requested);
}

/**
 * A goal knob that the goal accepted but this launch shape CANNOT bind.
 *
 * Surfaced rather than dropped silently. "Reads as configured while binding
 * nothing" is the exact failure D-016/WI-38048 was about — a panel inviting
 * owners to set six profiles that reached no launch — so anything this mapper
 * cannot deliver is named, not swallowed.
 */
export interface UnbindableGoalKnob {
  slot: string;
  knob: string;
  why: string;
}

export interface GoalFleetLaunchOverlay {
  /** The resolved fleet shape, and who chose it. */
  type: FleetType;
  typeSource: FleetTypeSource;
  /** The goal whose settings produced this, or null when no goal is in context. */
  goalId: string | null;
  family: GoalFleetFamily;
  /** The slot(s) consulted — a discriminated union, so a single fleet has no director. */
  slots: GoalFleetSlots;
  /** SINGLE arm: the flat per-member knobs the goal pins. `{}` on a paired fleet. */
  flat: RoleLaunchOptions;
  /** PAIRED arm: the two independent role groups. Both `{}` on a single fleet. */
  directors: RoleLaunchOptions;
  implementers: RoleLaunchOptions;
  /** True when the goal pinned at least one knob this launch will actually bind. */
  pinned: boolean;
  /** Knobs the goal set that this launch shape cannot deliver. Usually empty. */
  unbindable: UnbindableGoalKnob[];
}

/**
 * Narrow a goal `LaunchProfile` to the fleet layer's per-role knob set.
 *
 * The two vocabularies overlap but are not identical: `contextSize` is a real
 * goal knob and is NOT in `PER_ROLE_KNOBS`, because the fleet layer applies it
 * fleet-wide rather than per seat. Dropping it here is correct for the per-role
 * groups; `unbindableKnobs` below is what stops that drop from being silent.
 *
 * Empty string is treated as absent, matching `foldLaunchProfile`'s own rule —
 * a blank field in the goal panel means "unset", not "set to empty".
 */
function toRoleOptions(profile: Record<string, unknown>): RoleLaunchOptions {
  const out: RoleLaunchOptions = {};
  for (const k of PER_ROLE_KNOBS) {
    const v = profile[k];
    if (v !== undefined && v !== null && v !== '') (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Knobs present in the folded profile that the per-role groups cannot carry. */
function unbindableKnobs(
  profile: Record<string, unknown>,
  slot: string,
  why: string,
): UnbindableGoalKnob[] {
  const perRole = new Set<string>(PER_ROLE_KNOBS);
  return Object.entries(profile)
    .filter(([k, v]) => !perRole.has(k) && v !== undefined && v !== null && v !== '')
    .map(([knob]) => ({ slot, knob, why }));
}

const hasAny = (o: RoleLaunchOptions): boolean => Object.keys(o).length > 0;

/**
 * Fold the goal's settings into the launch shape this fleet will open with.
 *
 * `callerType` is what the caller EXPLICITLY passed (undefined when they passed
 * nothing) — it outranks the goal's `fleetType`, because the settings are the
 * goal's standing policy and not an override of a decision the caller just made
 * deliberately. That is the same precedence `foldLaunchProfile` applies one level
 * down, stated once more here so the two layers cannot disagree.
 */
export function goalFleetLaunchOverlay(args: {
  goalId: string | null;
  settings: GoalLaunchSettings | null;
  fleetSlug: string;
  drainFleetSlug: string | null;
  /** The caller's EXPLICIT `type`, or undefined when they passed none. */
  callerType?: FleetType;
}): GoalFleetLaunchOverlay {
  const goalType = args.settings?.fleetType;
  const type: FleetType = args.callerType ?? goalType ?? 'single';
  const typeSource: FleetTypeSource =
    args.callerType !== undefined ? 'caller' : goalType !== undefined ? 'goal' : 'default';

  const family = goalFleetFamily({
    fleetSlug: args.fleetSlug,
    drainFleetSlug: args.drainFleetSlug,
  });
  const slots = goalFleetLaunchSlots(family, type);

  // No goal in context ⇒ nothing to overlay. Returned as a fully-formed overlay
  // rather than null so the call site has one shape to handle: the difference
  // between "no goal" and "a goal that pinned nothing" is `goalId`, and neither
  // needs a branch at the boundary.
  if (!args.goalId) {
    return {
      type,
      typeSource,
      goalId: null,
      family,
      slots,
      flat: {},
      directors: {},
      implementers: {},
      pinned: false,
      unbindable: [],
    };
  }

  const unbindable: UnbindableGoalKnob[] = [];
  const foldFor = (slot: string): Record<string, unknown> =>
    foldLaunchProfile(args.settings, slot as never, null) as Record<string, unknown>;

  if (slots.type === 'paired') {
    // D-005/D-009: the two roles are folded INDEPENDENTLY. Each gets the goal's
    // `defaults` layer plus its OWN slot layer and nothing from the other — a
    // director's model must never be able to reach an implementer's seat, which
    // is the whole reason the paired shape exists.
    const directorProfile = foldFor(slots.director);
    const implementerProfile = foldFor(slots.implementer);
    const directors = toRoleOptions(directorProfile);
    const implementers = toRoleOptions(implementerProfile);
    const why =
      'not a per-role knob at the fleet layer (PER_ROLE_KNOBS); it is applied fleet-wide, ' +
      'so a per-role value cannot be delivered to one half of a pair';
    unbindable.push(
      ...unbindableKnobs(directorProfile, slots.director, why),
      ...unbindableKnobs(implementerProfile, slots.implementer, why),
    );
    return {
      type,
      typeSource,
      goalId: args.goalId,
      family,
      slots,
      flat: {},
      directors,
      implementers,
      pinned: hasAny(directors) || hasAny(implementers),
      unbindable,
    };
  }

  // SINGLE: one member slot, folded flat. `contextSize` is deliberately NOT
  // reported unbindable here — the single arm's fleet-wide fold at the launch
  // door still delivers it, so it binds; it is only the paired arm that cannot.
  const memberProfile = foldFor(slots.member);
  const flat = toRoleOptions(memberProfile);
  return {
    type,
    typeSource,
    goalId: args.goalId,
    family,
    slots,
    flat,
    directors: {},
    implementers: {},
    pinned: hasAny(flat),
    unbindable,
  };
}

/**
 * Merge the overlay UNDER a caller's launch-option input.
 *
 * Caller-supplied values win knob by knob (D-006), so a goal's standing policy
 * fills the gaps a caller left rather than overriding what they asked for.
 *
 * ⚠ THE SINGLE ARM TAKES ONLY `type`, AND THAT IS NOT AN OVERSIGHT. Verified
 * against the launch door: `resolveLaunchOptions`'s `flat` is read by NOTHING
 * (the handler consumes only `.ok`, `.message`, `.type` and `.pairs`), because a
 * single fleet's goal profile already binds through the goal fold at the launch
 * door — the `plan-fleet-member` / `drain-fleet-member` slot resolved with the
 * true post-clamp count. Pushing those same knobs in here would write a SECOND,
 * inert copy: it would read as configured on this object and reach no member,
 * which is precisely the class of bug this plan exists to remove. So the single
 * arm's knobs stay on `overlay.flat` for disclosure, and bind where they already
 * bound. The PAIRED arm is different and load-bearing: its groups become
 * `members[]` entries via `expandPairedMembers`, which really do reach seats.
 *
 * NOTE WHAT THIS ALSO DELIBERATELY DOES NOT DO: it never strips the caller's flat
 * knobs to make a paired launch legal. `resolveLaunchOptions` refuses flat knobs
 * on a paired fleet on purpose — coercing them would broadcast one value to both
 * roles — and that refusal is preserved here rather than pre-empted. The caller
 * is expected to enrich the refusal with `goalPairedTypeNote` when the goal is
 * what made the launch paired.
 */
export function applyGoalLaunchOverlay(
  caller: LaunchOptionInput,
  overlay: GoalFleetLaunchOverlay,
): LaunchOptionInput {
  if (overlay.type !== 'paired') return { ...caller, type: overlay.type };

  const merge = (
    over: RoleLaunchOptions | undefined,
    under: RoleLaunchOptions,
  ): RoleLaunchOptions => {
    const out: RoleLaunchOptions = { ...under };
    for (const k of PER_ROLE_KNOBS) {
      const v = over?.[k];
      if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
    return out;
  };

  // A group is emitted when EITHER side configured it. `pair-launch-options`
  // reads PRESENCE, not emptiness — `directors:{}` means "this role runs on the
  // defaults" — so a goal that pins only implementers still yields a legal
  // paired launch with an explicitly-defaulted director half, rather than the
  // `no_roles_configured` refusal an omitted pair of groups would earn.
  const directors = merge(caller.directors, overlay.directors);
  const implementers = merge(caller.implementers, overlay.implementers);
  const emit =
    caller.directors !== undefined ||
    caller.implementers !== undefined ||
    overlay.pinned ||
    overlay.typeSource === 'goal';
  return {
    ...caller,
    type: overlay.type,
    ...(emit ? { directors, implementers } : {}),
  };
}

/**
 * The slot the FLEET-WIDE goal fold binds — the D-005 rule, as a pure function.
 *
 * That fold feeds `fleetDefaults`, which EVERY member of the fleet inherits.
 *
 *   single → this family's member slot. Correct: one homogeneous fleet, one
 *            profile, exactly as it worked before paired fleets existed.
 *   paired → NULL, deliberately. Folding either the director or the implementer
 *            profile into a fleet-wide default would broadcast one role's
 *            model/account/carry to BOTH roles — the precise coercion
 *            `pair-launch-options` refuses one layer down, smuggled back in one
 *            layer up where that module cannot see it. The per-role profiles
 *            reach their seats through `members[]` instead, where the
 *            member > fleet precedence keeps them apart.
 *
 * Extracted rather than left inline at the call site so the rule is provable
 * without opening a terminal — the same discipline the rest of this module and
 * `pair-launch-options` hold themselves to.
 *
 * ⚠ Pass the AUTHORITATIVE fleet type (the one re-read off the registry row
 * after `createFleetIfAbsent`), not the provisional one: a top-up joins an
 * existing fleet whose stored type wins over whatever this call asked for.
 */
export function goalFleetWideFoldSlot(
  family: GoalFleetFamily,
  authoritativeFleetType: FleetType,
): GoalLaunchRole | null {
  return authoritativeFleetType === 'paired' ? null : goalFleetMemberSlot(family);
}

/**
 * The extra sentence a `flat_knobs_on_paired_fleet` refusal owes the caller when
 * the GOAL, not the caller, is what made this launch paired (D-006).
 *
 * Empty string when the caller declared the type themselves — the stock message
 * is already accurate then, and appending "the goal chose this" would be false.
 */
export function goalPairedTypeNote(overlay: GoalFleetLaunchOverlay): string {
  if (overlay.typeSource !== 'goal' || overlay.type !== 'paired') return '';
  return (
    ` NOTE: you did not pass \`type\` — this launch is paired because goal ${overlay.goalId} ` +
    `pins fleetType:'paired' in its launch settings. Configure the roles with directors:{…} / ` +
    `implementers:{…}, or pass type:'single' explicitly to override the goal's policy for this launch.`
  );
}
