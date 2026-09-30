/**
 * CLIENT-SAFE half of goal-launch-settings: the launch-slot vocabulary.
 *
 * WHY THIS FILE EXISTS (WI-39514). `goal-launch-settings.ts` value-imports
 * `getOrgPg` from `@papercusp/db-org` for its async read/write/headcount
 * functions. On the SPA's Vite dev graph there is NO tree-shaking, so a client
 * component importing even ONE pure constant from that module dragged the whole
 * chain into the browser:
 *
 *   app/adv/hud/goal-launch-settings-model.ts
 *     -> operator-core/lib/goal-launch-settings
 *     -> @papercusp/db-org -> workspace-context -> connection
 *     -> operator-core/lib/resource-profile -> embedded-pg-discovery
 *     -> @papercusp/embedded-pg-discovery (imports `node:path`)
 *
 * `node:path` is externalized to a stub that THROWS on property access, so that
 * module threw at init inside a <Lazy> component, was swallowed by
 * CatchBoundaryImpl, and the entire /adv route never mounted its dock. It was
 * invisible for weeks because every e2e spec navigated to the shared standing
 * :3055 rather than an isolated server (fixed under EI-19917451944474469).
 *
 * The rule this file follows is the one in
 * `apps/operator-vite/src/__tests__/no-server-leak-in-client-graph.test.ts`:
 * client-needed types and PURE values live in a `*-shared.ts` with ZERO server
 * imports; the server module re-exports them so existing callers are unchanged.
 *
 * KEEP THIS FILE FREE OF IMPORTS. Anything added here ships to the browser.
 */

/**
 * The CLOSED set of launch SLOTS a goal can pin a profile for (D-016, WI-38048).
 *
 * A slot is a FUNCTION, not a persona. That distinction is the whole fix: a
 * plan-fleet leader and a drain-fleet member both run persona `su`, so keying
 * these profiles on psu `--role` (which is `su` for 121 of 124 live sessions)
 * could never express the contract — every profile the owner configured bound
 * nothing. `role` now means only "which persona prompt to load"; `goalRole`
 * means "which launch slot", and the two never share a spelling again.
 *
 * Keeping this closed is what makes a wrong key a WRITE-time refusal instead of
 * a stored setting that reads as configured and is silently ignored — the same
 * intent as `goalLaunchSettingsSchema`'s `.strict()`, one level up.
 *
 * The list is taken from the GOAL contract's own enumeration in
 * `modes/registry.ts` ("plan-fleet leader + member, drain-fleet leader +
 * member, grading, test, misc") PLUS `goal`, which `goals:start` already passes
 * for the goal's own agent. Note that is EIGHT: WI-38048's prose says "six",
 * and building to that number refuses two slots that are already in use.
 *
 * P-005 adds the four PAIRED slots. A paired fleet (FleetType 'paired') splits
 * each fleet into directors and implementers whose launch knobs are independent
 * by design (D-009) — that independence is the entire point of the shape, since
 * broadcasting one flat model to both roles is the failure
 * `fleet_registry/pair-launch-options.ts` was built to refuse. Without slots of
 * their own, a goal could declare `fleetType:'paired'` and then have nothing to
 * say about either half.
 *
 * They are ADDITIVE to a closed set, which is only safe because it was measured
 * first: of 20 goals in papercusp-workspace, 0 carry a `roles` key at all
 * (2026-08-26), so no stored document can collide with a new slot name. Same
 * check the `holder` key and D-016 shipped under.
 */
export const GOAL_LAUNCH_ROLES = [
  'goal',
  'plan-fleet-leader',
  'plan-fleet-member',
  'plan-fleet-director',
  'plan-fleet-implementer',
  'drain-fleet-leader',
  'drain-fleet-member',
  'drain-fleet-director',
  'drain-fleet-implementer',
  'grading',
  'test',
  'misc',
] as const;

export type GoalLaunchRole = (typeof GOAL_LAUNCH_ROLES)[number];

/** True for a string that is a real, bindable launch slot. */
export function isGoalLaunchRole(value: unknown): value is GoalLaunchRole {
  return typeof value === 'string' && (GOAL_LAUNCH_ROLES as readonly string[]).includes(value);
}

/**
 * Which FAMILY of fleet this is, in the goal's own terms.
 *
 * The goal's `metadata.drainFleet` declaration (written by `mintDrainFleetForGoal`)
 * is the canonical identity: that one fleet is the drain fleet, and every other
 * fleet attached to the goal is a plan fleet. Nothing on `AgentFleetRecord` or
 * `FleetHeadcountConfig` carries a family, which is why the declaration is read
 * rather than inferred from the fleet row.
 */
export type GoalFleetFamily = 'plan' | 'drain';

/**
 * PURE: the family, from the goal's drain-fleet declaration.
 *
 * Extracted from `resolveFleetHeadcountLaunchRole` (EI-20219409083169975), which
 * now delegates here — the derivation had to be shared the moment a SECOND caller
 * (the fleet-launch boundary, P-006) needed it, or the governor and the launch
 * door would disagree about which fleet is the drain fleet.
 */
export function goalFleetFamily(args: {
  fleetSlug: string;
  drainFleetSlug: string | null;
}): GoalFleetFamily {
  return args.drainFleetSlug === args.fleetSlug ? 'drain' : 'plan';
}

/**
 * The launch SLOTS each family binds, per fleet shape.
 *
 * `satisfies` is doing real work here: it proves at COMPILE time that all six
 * strings are members of `GOAL_LAUNCH_ROLES`. Renaming a slot in that closed
 * vocabulary without updating this table is then a build failure rather than a
 * lookup that silently matches nothing — which is exactly the failure mode
 * D-016/WI-38048 was about (a profile the owner configured binding nothing, with
 * the panel still reporting it as set).
 */
const FAMILY_SLOTS = {
  plan: {
    leader: 'plan-fleet-leader',
    member: 'plan-fleet-member',
    director: 'plan-fleet-director',
    implementer: 'plan-fleet-implementer',
  },
  drain: {
    leader: 'drain-fleet-leader',
    member: 'drain-fleet-member',
    director: 'drain-fleet-director',
    implementer: 'drain-fleet-implementer',
  },
} as const satisfies Record<
  GoalFleetFamily,
  Record<'leader' | 'member' | 'director' | 'implementer', GoalLaunchRole>
>;

/**
 * Which slot(s) a launch of this family and shape binds.
 *
 * The shape is expressed as a DISCRIMINATED UNION rather than three optional
 * fields on one object, so a caller cannot read `.director` off a single fleet —
 * there is no such slot, and a `undefined` there would fold as "no role layer"
 * and look like a deliberate choice (D-005's trap, one level down).
 *
 * `fleetType` is taken as the narrow `'single' | 'paired'` union rather than
 * imported from the fleet store, only because this module must stay import-free
 * (see the header). `FleetType` is structurally that union and the fleet-boundary
 * caller passes a real `FleetType`, so the vocabulary is still owned in one place.
 */
export type GoalFleetSlots =
  | { type: 'single'; member: GoalLaunchRole }
  | { type: 'paired'; director: GoalLaunchRole; implementer: GoalLaunchRole };

export function goalFleetLaunchSlots(
  family: GoalFleetFamily,
  fleetType: 'single' | 'paired',
): GoalFleetSlots {
  const slots = FAMILY_SLOTS[family];
  return fleetType === 'paired'
    ? { type: 'paired', director: slots.director, implementer: slots.implementer }
    : { type: 'single', member: slots.member };
}

/**
 * The MEMBER slot for a family, named directly.
 *
 * The union above is the right shape for a caller that must handle both arms,
 * but the fleet-wide goal fold only ever wants the single-fleet member slot (on
 * a paired fleet it binds NO role layer at all — D-005), and narrowing the union
 * just to reach one field reads as if the paired case were being handled when it
 * is deliberately excluded elsewhere.
 */
export function goalFleetMemberSlot(family: GoalFleetFamily): GoalLaunchRole {
  return FAMILY_SLOTS[family].member;
}

/**
 * The independently spawned LEADER slot for a fleet family.
 *
 * Leaders sit outside the member count, so they are not part of
 * {@link GoalFleetSlots}. They still have a first-class launch profile on the
 * goal record, and returning it from the same family table prevents the
 * `plan-fleet-leader` / `drain-fleet-leader` profiles from becoming configured
 * but inert data.
 */
export function goalFleetLeaderSlot(family: GoalFleetFamily): GoalLaunchRole {
  return FAMILY_SLOTS[family].leader;
}

/**
 * What happens to a HOLDER-REQUIRED goal when its holder stops being live
 * (goal-live-holder-guarantee-2026-08-18 P-002, D-001).
 *
 * The closed set lives HERE, beside the launch slots, for two reasons. The first
 * is this file's original one: it is import-free, so a client surface can render
 * the choices without dragging `@papercusp/db-org` into the browser graph. The
 * second is new — `recovery-dependency-audit.ts` must enumerate these values to
 * assert that every one of them has a DECLARED disposition, and an audit that
 * had to value-import the server module to learn the set would be paying a PG
 * dependency to read two strings.
 *
 *  - `deactivate` — the goal stops reading `active`, derived at READ time from
 *    the holder resolver. No runtime actor: nothing polls, nothing sweeps, and
 *    there is no cached answer left to go stale. This is the whole thesis of the
 *    plan, which is why it is the default.
 *  - `respawn` — something relaunches a holder. That is a real actor spending
 *    real money unattended, so D-001 makes a goal EARN it by being named. The
 *    audit's disposition table is what stops the actor from being added without
 *    being declared.
 */
export const GOAL_HOLDER_ON_LOSS = ['deactivate', 'respawn'] as const;

export type GoalHolderOnLoss = (typeof GOAL_HOLDER_ON_LOSS)[number];

/** True for a string that is a real, bindable on-loss disposition. */
export function isGoalHolderOnLoss(value: unknown): value is GoalHolderOnLoss {
  return typeof value === 'string' && (GOAL_HOLDER_ON_LOSS as readonly string[]).includes(value);
}

/**
 * The holder policy a goal that has pinned nothing runs under (D-001, D-008).
 *
 * `requireLive: true` is the load-bearing default and the reason this resolves
 * at READ time rather than being stamped into the row by `goals:create`. A
 * default written at create time reaches only goals created after it ships —
 * i.e. none of the rows that were exposed — and the measured exposure is the
 * entire point: 4 of 6 `status='active'` goals had been dark for 2–5 days while
 * every surface called them held. A `false` default would cover none of them and
 * leave the bug in place for every goal that already exists. Same reasoning, and
 * the same shape, as `GOAL_LAUNCH_DEFAULTS` under D-015.
 *
 * `onLoss: 'deactivate'` is D-001, stated outright: most goals should not
 * resurrect themselves, and going quiet is often correct.
 *
 * A goal that genuinely runs unheld says so with an explicit
 * `holder: { requireLive: false }` — the opt-out has to be SAYABLE, or the
 * default becomes a trap for the goals it does not fit.
 */
export const GOAL_HOLDER_DEFAULTS = {
  requireLive: true,
  onLoss: 'deactivate',
} as const satisfies { requireLive: boolean; onLoss: GoalHolderOnLoss };

/**
 * The stored holder policy, typed STRUCTURALLY rather than as the zod-inferred
 * `GoalLaunchSettings`.
 *
 * That is what keeps this module dependency-free, which is the whole reason it
 * is split from `goal-launch-settings.ts`: that module statically imports
 * `@papercusp/db-org`, so anything importing it pays for the store's server
 * dependencies at load. `GoalLaunchSettings` is structurally assignable to this,
 * so callers pass it unchanged.
 */
export interface GoalHolderPolicyInput {
  holder?: { requireLive?: boolean | null; onLoss?: GoalHolderOnLoss | null } | null;
}

/** A holder policy with every field resolved — no absent, no null, no guessing. */
export interface ResolvedGoalHolderPolicy {
  requireLive: boolean;
  onLoss: GoalHolderOnLoss;
  /**
   * True when the goal pinned NOTHING and is running entirely on defaults.
   * P-003 refuses at the write boundary on this; a surface that wants to show
   * "inherited" vs "pinned" reads it rather than re-deriving it from absence.
   */
  isDefault: boolean;
}

/**
 * Resolve one goal's holder policy at READ time (D-008).
 *
 * This is `resolveCeiling`'s sibling and follows `goal-launch-settings.ts`'s
 * "WHY IN THE RESOLVER AND NOT AT CREATE TIME" rule exactly: resolving here
 * governs every goal that already exists, with no migration and no backfill,
 * and keeps an absent key meaning exactly one thing.
 *
 * Absent and null both mean unpinned. Only an EXPLICIT `false` opts a goal out
 * of the live-holder requirement.
 *
 * Lives HERE rather than beside the schema so the pure read-side fold
 * (`goals/activity.ts`, P-004) can reach it without dragging the store in.
 */
export function resolveGoalHolderPolicy(
  settings: GoalHolderPolicyInput | null | undefined,
): ResolvedGoalHolderPolicy {
  const stored = settings?.holder;
  const requireLive = stored?.requireLive;
  const onLoss = stored?.onLoss;
  return {
    requireLive: typeof requireLive === 'boolean' ? requireLive : GOAL_HOLDER_DEFAULTS.requireLive,
    onLoss: onLoss ?? GOAL_HOLDER_DEFAULTS.onLoss,
    isDefault: requireLive == null && onLoss == null,
  };
}
