/**
 * goal-launch-settings — the ONE resolution of "how should this goal launch an
 * agent, and may it launch another one at all?"
 * (goal-mode-hardening-2026-08-10 P-004, D-009.)
 *
 * D-004 removed the GOAL contract's "capacity preflight, ramp one at a time"
 * clause and made maximal parallelism the instruction instead. That is only safe
 * because D-005 replaced the preflight with two BINDING ceilings — a per-goal cap
 * over every session associated with the goal, and a per-fleet cap — enforced by
 * the machine rather than by an agent's judgement. This module is those ceilings
 * plus the per-role launch profile (model/effort/account/carry) the goal agent
 * hands down with them, and D-006 is why those numbers are editable DATA here
 * rather than prose an owner would have to rewrite the contract to change.
 *
 * THE RESOLVER RESOLVES THE GOAL; IT DOES NOT ACCEPT ONE. `resolveGoalLaunch`
 * takes the LAUNCHER's owner id and derives the goal through
 * `resolveGoalContext` (D-008). A door cannot forget to pass what it never
 * passes — the same structural move P-002 made when it put goal inheritance on
 * the existing `--launched-by` seam instead of minting a `--goal` flag that a
 * future spawn site could omit. This is what makes D-008's closing constraint
 * ("P-004's resolver must carry goal-context inheritance rather than composing
 * argv that silently drops it") a property of the shape rather than a rule
 * someone has to remember.
 *
 * THE CEILINGS HAVE SYSTEM DEFAULTS (D-015). They did not, originally, and the
 * gap was not "the numbers are unset" — it was that an unset pair DISABLED
 * enforcement outright: with both null, `needsCount` was false, the headcount was
 * never taken, and nothing could be refused. So D-004's removal of the capacity
 * preflight left maximal parallelism running against no governor at all on every
 * goal nobody had hand-edited (9 of 11 when this was found, including all three
 * active ones). Migration 786's column comment had promised "NULL = none declared
 * = system defaults" from the start; {@link GOAL_LAUNCH_DEFAULTS} is the first
 * thing to actually supply them.
 *
 * WHY IN THE RESOLVER AND NOT AT CREATE TIME. A default written into the row by
 * `goals:create` reaches only goals created after it ships — i.e. none of the
 * rows that were exposed, which is the entire point of having one. Resolving here
 * governs every goal on the next launch, and keeps a NULL column meaning exactly
 * one thing ("the owner has not pinned this") rather than two. Same shape as
 * DEFAULT_RATE_LIMIT_CONFIG: a seeded default that any stored value overrides.
 *
 * WHY THE CEILINGS FAIL OPEN. A ceiling that cannot be READ does not refuse the
 * launch; it reports itself degraded and lets the launch through. This is a
 * governor over the owner's own fleet, not a security boundary, and the failure
 * modes are not symmetric: failing closed on a transient read error would brick
 * every launch in the workspace at once — including the launches needed to fix
 * whatever broke the read. The degraded reason is returned rather than swallowed
 * so a caller surfaces "the ceiling was not enforced" instead of quietly
 * reporting success. A ceiling that IS read and IS exceeded refuses, hard.
 *
 * THE BUDGET IS A THIRD CEILING (goal-mode-design-intent-hardening-2026-08-16
 * P-006, flag GOAL_BUDGET_LAUNCH_GATE). `goals.budget_cents` binds against
 * goal-attributed priced usage in its declared window (D-011). A fresh
 * platform snapshot may supply that figure; absent, stale, or untrusted
 * snapshots trigger a live rollup. An unmeasured rollup refuses launch and per-turn inference,
 * with a per-goal-deduped owner escalation for launch refusal. It lives in
 * this resolver because every launch door already honors `refusal`.
 */
import { z } from 'zod';
import type { Sql } from 'postgres';
import { getOrgPg, GOAL_SPEND_SNAPSHOT_SOURCE } from '@papercusp/db-org';
// Pure plan-status grammar (zero I/O) — the one definition of "terminal plan",
// shared with plans:set-plan-status. Used by the pot-owner worklist count.
import { TERMINAL_PLAN_STATUSES, resolveEffectiveStatusForItems, type ItemStatus } from '@papercusp/plan-parser';
// Re-exported below for the public surface; imported here because this module
// uses both internally (the schema's role enum + the resolver signatures).
import {
  GOAL_LAUNCH_ROLES,
  type GoalLaunchRole,
  GOAL_HOLDER_ON_LOSS,
  GOAL_HOLDER_DEFAULTS,
  type GoalHolderOnLoss,
} from './goal-launch-settings-shared';
import {
  isGoalHolderAuthorityError,
  resolveGoalContext,
} from './modes/goal-context';
// The fleet-shape vocabulary is owned by the fleet store; `fleetType` below
// derives its accepted values from it rather than declaring them a second time.
import { FLEET_TYPES } from './agent-fleets-store';
import { GOAL_KICKOFF_REQUIRED_READS } from './goals/kickoff-evidence';
import {
  evaluateInteractiveUsageFreshness,
  isInteractiveUsageUnmeasuredReason,
} from './interactive-usage/freshness';
import {
  buildGoalOwnerReportDraft,
  GOAL_OWNER_REPORT_HEADING_LIST,
  type GoalOwnerReportDraft,
  type GoalOwnerReportDraftInput,
} from './goal-owner-report';
import { openOwnerWallPredicateSql, ownerWallActionSql } from './goal-owner-report-truth';
import type { GoalOwnerReportObligation } from './system-health/goal-owner-report-watchdog';
import { claimSpecFilterAdmitsTarget, claimSpecFilterPositivelyTargets, validateClaimSpec } from './scheduler/claim-spec';
// Type-only: the placement compiler reads a closure VERDICT, it never resolves
// one. Keeping this erased leaves the acceptance gate out of the portfolio
// read's runtime graph.
import type { PlanClosureState, PlanClosureVerdict } from './goals/plan-closure';
import type { GoalHolderFirstTurnAttestation } from './goals/holder-attestation';
// Type-only: erased at runtime, so it cannot close the cycle REFUSAL_SCOPES
// documents. The value is reached through a dynamic import at launch time.
import type { GoalSpendRollup } from './goals/spend-rollup';

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

/**
 * How long a presence heartbeat may be stale before its session stops counting
 * against a ceiling. Mirrors the coord store's own window; a copy rather than an
 * import because this module must not drag the presence tool's dependency graph
 * into every launch path.
 */
export const GOAL_HEADCOUNT_STALE_MS = 10 * 60_000;

/**
 * A session that has been launched but has not yet written its first presence
 * row still counts for this long. Without it a burst of launches all read a
 * headcount of zero and every one of them is admitted — the exact overshoot the
 * ceiling exists to prevent. Mirrors `SEAT_BOOT_GRACE_MS` in
 * fleet/seat-accounting.ts, which solved the identical race for slot allotments.
 */
export const GOAL_HEADCOUNT_BOOT_GRACE_MS = 10 * 60_000;

/**
 * The closed sets a launch profile may name, as CONSTANTS the schema is then
 * built from — not as literals inside `z.enum(...)`.
 *
 * The editor (P-005) has to offer exactly the values this schema accepts, and a
 * hand-spelled option list in the UI is the drift D-011 is about: the panel and
 * the validator would be two declarations of one set, and the panel's copy would
 * fall behind silently — offering a value the write refuses, or hiding one it
 * accepts. Exporting the arrays lets the read path SHIP them (goals.detail's
 * `launchSettingsOptions`), so the editor renders what the validator enforces by
 * construction rather than by someone remembering to update both.
 */
export const LAUNCH_PROFILE_AGENTS = ['claude', 'codex', 'omp'] as const;
export const LAUNCH_PROFILE_CARRY = ['warm', 'cold'] as const;
// WI-2140338: 'steward' is the explicit opt-in intermediate tool seed (core
// spine + steward verb families — see STEWARD_MCP_TOOL_FAMILIES in
// role-launch-spec.ts) for goal-holder roles. 'trimmed' stays the default;
// 'full' stays retired (WI-4608) and is deliberately NOT in this set.
export const LAUNCH_PROFILE_CONTEXT_SIZES = ['trimmed', 'steward'] as const;

/**
 * Headed vs headless, as the EDITOR's three states (P-001, D-002).
 *
 * The stored key is a real `boolean` — that is the spelling the fleet layer
 * already uses (`PER_ROLE_KNOBS` in fleet_registry/pair-launch-options.ts), and
 * a goal profile that said `'true'` where a fleet role says `true` would be two
 * spellings of one concept, which is the drift the closed-set constants exist to
 * prevent. These strings are the editor's rendering of that boolean, converted at
 * the form boundary — never what lands in the document.
 *
 * ABSENT is the third state and it is not in this list: an unpinned `headless`
 * resolves to `true` (today's hardcoded behaviour), so blank must stay
 * distinguishable from an explicit `false` exactly as it is for the ceilings.
 *
 * The members are the WORDS, not `'true'`/`'false'`, because the editor renders
 * a closed set by mapping each member straight to its own label. Stringly
 * booleans would put "true" in a dropdown whose field reads "Window", and would
 * need a per-field label table to fix — a second declaration of this same set,
 * which is the drift these constants exist to prevent.
 */
export const LAUNCH_PROFILE_HEADLESS = ['headless', 'headed'] as const;

/** The option lists an editor must render, in one payload-shaped object. */
export const LAUNCH_PROFILE_OPTIONS = {
  agent: LAUNCH_PROFILE_AGENTS,
  carry: LAUNCH_PROFILE_CARRY,
  contextSize: LAUNCH_PROFILE_CONTEXT_SIZES,
  headless: LAUNCH_PROFILE_HEADLESS,
} as const;

/**
 * The system ceilings a goal that has pinned nothing launches under (D-015).
 *
 * These are not round numbers; they are what the GOAL contract in modes/registry
 * obliges a goal to be running, added up:
 *
 *   1  the goal agent itself
 *   4  the standing drain fleet (leader + 3) the contract requires per goal,
 *      "always maintained, not spun up on demand"
 *   3  a plan fleet (leader + 2)
 *   3  a SECOND plan fleet, concurrent — the row that makes "parallelize hard"
 *      true rather than merely permitted
 *   1  one judge: a GRADE or TEST agent
 *  ──
 *  12
 *
 * The floor matters more than the number. A goal cannot satisfy its own contract
 * below EIGHT (goal agent + drain fleet + one plan fleet), so a default under
 * that would make the default itself a bug — the goal agent refused while
 * establishing the standing drain fleet it was ordered to maintain. 12 is that
 * floor plus one more concurrent plan fleet.
 *
 * `maxPerFleet` is a leader + 4. Past that, members on one plan increasingly
 * touch the same files and serialize on the locks, so the fan-out buys
 * contention rather than throughput. It also composes: 12 over 5 means a goal
 * CANNOT pile everything into one fleet and must spread across two or three,
 * which is what D-004 asks for in prose.
 */
export const GOAL_LAUNCH_DEFAULTS = {
  maxAgents: 12,
  maxPerFleet: 5,
} as const;

/**
 * The explicit "no ceiling" a goal may declare (D-015, owner-directed).
 *
 * Once absent means "use the system default", ungoverned has to be SAYABLE — and
 * as a self-describing literal rather than a sentinel number, because the value
 * an owner reads back has to distinguish "deliberately unlimited" from "nobody
 * set this". `0` was never available (it parses as "forbid every launch") and a
 * magic 1000 would be indistinguishable from a very large deliberate ceiling.
 */
export const UNLIMITED_CEILING = 'unlimited' as const;

/** A stored ceiling: a hard number, or the explicit opt-out. */
export type GoalCeiling = number | typeof UNLIMITED_CEILING;

/**
 * The smallest ceilings under which an auto-minted drain fleet can hold a WORKER
 * (EI-24556293106348130).
 *
 * A started goal with a drain fleet runs three agents before any work is claimed:
 * the goal holder, the fleet's delegated leader, and one drain worker. All three
 * carry the goal's `session_briefs.goal_id`, so `goalHeadcount` counts all three
 * toward `maxAgents`; the leader's presence carries the fleet slug, so it counts
 * toward `maxPerFleet` too. The worker is launched LAST, so a ceiling below this
 * floor refuses exactly the one agent that does the work, and the fleet runs with
 * a live leader and zero workers. The watchdog then reports `drain-fleet-dead`
 * while the leader is visibly live, and its own replacement launch is refused by
 * the same ceiling.
 *
 * Measured before this floor existed: every goal-drain fleet started with
 * `maxAgents: 2, maxPerFleet: 1` (4 of 4, 2026-09-26 and 2026-09-29) ran with
 * zero workers; every fleet started at or above this floor (16 of 16) got its
 * worker within 16s.
 */
export const DRAIN_FLEET_MIN_CEILINGS = {
  maxAgents: 3,
  maxPerFleet: 2,
} as const;

/**
 * The start-door refusal for ceilings that cannot hold a drain fleet's worker, or
 * null when they can. A MESSAGE, not a boolean, for the same reason as
 * `goalHolderPolicyProblem`: every door surfaces it verbatim, and two doors with
 * their own copies would drift until the looser one became the way in.
 *
 * Call it ONLY where a drain fleet will be minted — a sole-member goal runs the
 * goal agent alone and is not bound by this floor. A door that offers another way
 * out (goals:start's sole-member contract) appends it; this text names only the
 * remedy every door shares. `unlimited` always passes, and an unset ceiling
 * resolves to `GOAL_LAUNCH_DEFAULTS`, which clears it.
 */
export function drainFleetTopologyProblem(
  // Structural, not `GoalLaunchSettings`: goals:start-from-package carries a
  // package's settings as an untyped record, and the floor must bind there too.
  settings: { maxAgents?: unknown; maxPerFleet?: unknown } | null | undefined,
): string | null {
  const asCeiling = (v: unknown): GoalCeiling | undefined =>
    v === UNLIMITED_CEILING || (typeof v === 'number' && Number.isFinite(v)) ? (v as GoalCeiling) : undefined;
  const maxAgents = resolveCeiling(asCeiling(settings?.maxAgents), GOAL_LAUNCH_DEFAULTS.maxAgents);
  const maxPerFleet = resolveCeiling(asCeiling(settings?.maxPerFleet), GOAL_LAUNCH_DEFAULTS.maxPerFleet);
  const short: string[] = [];
  if (maxAgents != null && maxAgents < DRAIN_FLEET_MIN_CEILINGS.maxAgents) {
    short.push(
      `maxAgents=${maxAgents} (needs at least ${DRAIN_FLEET_MIN_CEILINGS.maxAgents}: holder + drain leader + one drain worker)`,
    );
  }
  if (maxPerFleet != null && maxPerFleet < DRAIN_FLEET_MIN_CEILINGS.maxPerFleet) {
    short.push(
      `maxPerFleet=${maxPerFleet} (needs at least ${DRAIN_FLEET_MIN_CEILINGS.maxPerFleet}: drain leader + one drain worker)`,
    );
  }
  if (short.length === 0) return null;
  return (
    `launch ceilings too low for this goal's drain fleet: ${short.join('; ')}. ` +
    `The holder and the drain leader launch first, so these ceilings would refuse the only agent that ` +
    `claims work, leaving a leader-only fleet the watchdog reports dead. Nothing was created or saved. ` +
    `Raise the ceiling(s), or set them to '${UNLIMITED_CEILING}'.`
  );
}

const ceilingSchema = z
  .union([z.number().int().positive().max(1000), z.literal(UNLIMITED_CEILING)])
  .nullable()
  .optional();

/**
 * One stored ceiling → the number to enforce, or null for genuinely no ceiling.
 *
 * The three-way distinction is the whole point, and collapsing any two of them
 * reintroduces the bug this replaced:
 *   absent / null  → the owner has not pinned one  → the system default
 *   'unlimited'    → the owner pinned "no ceiling" → null (nothing enforced)
 *   a number       → that number
 */
export function resolveCeiling(stored: GoalCeiling | null | undefined, fallback: number): number | null {
  if (stored === UNLIMITED_CEILING) return null;
  if (typeof stored === 'number') return stored;
  return fallback;
}

/**
 * The launch-slot vocabulary now lives in `goal-launch-settings-shared.ts` and is
 * re-exported here so every existing caller keeps working unchanged.
 *
 * WHY IT MOVED (WI-39514): this module value-imports `getOrgPg` from
 * `@papercusp/db-org`, whose chain reaches `embedded-pg-discovery` ->
 * `node:path`. With no tree-shaking on the SPA's Vite dev graph, a client
 * component importing just `GOAL_LAUNCH_ROLES` from here dragged all of that
 * into the browser, where `node:path` is a stub that throws on property access —
 * white-screening the whole /adv route via its error boundary. Client code must
 * import these three from the shared file; see that file's docblock and
 * `apps/operator-vite/src/__tests__/no-server-leak-in-client-graph.test.ts`.
 */
export {
  GOAL_LAUNCH_ROLES,
  isGoalLaunchRole,
  type GoalLaunchRole,
  GOAL_HOLDER_ON_LOSS,
  isGoalHolderOnLoss,
  GOAL_HOLDER_DEFAULTS,
  type GoalHolderOnLoss,
} from './goal-launch-settings-shared';

// A re-export creates no LOCAL binding, and `goalHolderPolicyProblem` below
// calls the resolver — so it is imported as well as re-exported.
import { resolveGoalHolderPolicy } from './goal-launch-settings-shared';

/**
 * The holder policy a goal declares (P-002 of
 * goal-live-holder-guarantee-2026-08-18).
 *
 * `requireLive` — must this goal be held by a LIVE agent to count as active?
 * `onLoss`      — what happens when it is not.
 *
 * Both are `.nullable().optional()` for the same reason `ceilingSchema` is: the
 * P-005 panel clears a field by writing `null`, and a cleared field means "the
 * owner has not pinned this" — which must resolve to the system default rather
 * than to `false`. Collapsing absent into `false` would silently opt a goal OUT
 * of the guarantee at exactly the moment its owner tried to reset it.
 */
export const goalHolderPolicySchema = z
  .object({
    requireLive: z.boolean().nullable().optional(),
    onLoss: z.enum(GOAL_HOLDER_ON_LOSS).nullable().optional(),
  })
  .strict();

export type GoalHolderPolicy = z.infer<typeof goalHolderPolicySchema>;

/**
 * `resolveGoalHolderPolicy` and its result type MOVED to
 * `goal-launch-settings-shared.ts` (P-004) and are re-exported here so every
 * existing importer is unaffected.
 *
 * WHY THE MOVE: the resolver is pure, but THIS module statically imports
 * `@papercusp/db-org`, so importing it costs the store's server dependencies at
 * load — which is why `resolveGoalDetail` reaches for it via `await import`.
 * The read-side activity fold (`goals/activity.ts`) is pure and SYNCHRONOUS, so
 * a dynamic import was not open to it; putting the resolver beside the defaults
 * it applies, in the module that already has no dependencies, is the fix that
 * keeps one definition rather than two.
 */
export {
  resolveGoalHolderPolicy,
  type GoalHolderPolicyInput,
  type ResolvedGoalHolderPolicy,
} from './goal-launch-settings-shared';

/**
 * The write-boundary refusal message, or null when the policy is acceptable
 * (P-003 of goal-live-holder-guarantee-2026-08-18).
 *
 * WHY A SHARED PREDICATE AND NOT A LINE AT EACH DOOR. Three doors install a
 * goal's holder policy — `goals:create`, `goals:start`, and GOAL-mode attach
 * (`mode:set { mode:'goal', subject }`) — and `killCriterionProblem`'s docblock
 * already records what happens when each writes its own copy: the door with the
 * looser copy quietly becomes the way to install what the others would have
 * refused. Same rule, same shape (a MESSAGE, not a boolean, because every
 * caller surfaces it verbatim).
 *
 * WHAT IT REFUSES, AND WHY THAT IS NOT THE SAME AS "REFUSE EVERY GOAL". D-008
 * makes `requireLive` default TRUE at READ time, which is what covers the 18
 * goals that already exist with no migration. That default is a rescue for the
 * legacy population, NOT a licence for the population to keep growing: this
 * refuses a NEW holder-required goal whose creator declared nothing, so the set
 * of goals whose holder semantics nobody chose can only shrink from here.
 *
 * The predicate is written as `requireLive && isDefault` rather than the
 * equivalent-today `isDefault` on purpose. They coincide only because the
 * default is true; stating both keeps the rule honest ("a goal that WILL require
 * a live holder, whose owner never said so") if D-008's default is ever revisited.
 *
 * Pinning EITHER field counts as declaring. A goal that pins only
 * `onLoss:'respawn'` has engaged with the policy deliberately and gets the
 * `requireLive` default knowingly — which is exactly the distinction `isDefault`
 * was added to carry, so it is read here rather than re-derived from absence.
 */
export function goalHolderPolicyProblem(settings: GoalLaunchSettings | null | undefined): string | null {
  const policy = resolveGoalHolderPolicy(settings);
  if (!policy.requireLive || !policy.isDefault) return null;
  return (
    'this goal would require a LIVE holder but declares no holder policy — ' +
    `it is inheriting the default (requireLive: ${GOAL_HOLDER_DEFAULTS.requireLive}, ` +
    `onLoss: '${GOAL_HOLDER_DEFAULTS.onLoss}') rather than stating one. ` +
    'Declare it: holder: { requireLive: true } if a live holder is what you mean, ' +
    'or holder: { requireLive: false } for a goal driven by routines rather than a held session.'
  );
}

/** The launch knobs a goal can pin, per slot or as its across-the-board default. */
export const launchProfileSchema = z
  .object({
    agent: z.enum(LAUNCH_PROFILE_AGENTS).optional(),
    model: z.string().min(1).max(120).optional(),
    effort: z.string().min(1).max(40).optional(),
    account: z.string().min(1).max(120).optional(),
    carry: z.enum(LAUNCH_PROFILE_CARRY).optional(),
    contextSize: z.enum(LAUNCH_PROFILE_CONTEXT_SIZES).optional(),
    /**
     * WI-2140338 [owner 2026-09-01]: the session's compaction ceiling in TOKENS,
     * threaded to the spawn as `--compaction-limit` (the same argv seam fleet
     * MemberSpec.compactionLimit rides). Lets a goal pin its holder to the model's
     * full window (e.g. 1_000_000 on a ~1M-window model) instead of the tier
     * default. Absent = unpinned = the tier/system default, per this schema's
     * absent-stays-absent rule. Distinct from `contextSize`, which sizes the
     * initial TOOL surface, not the token window.
     */
    compactionLimit: z.number().int().min(50_000).max(2_000_000).optional(),
    /**
     * D-002: ABSENT means UNPINNED, not `false`.
     *
     * Every existing goal document omits this key, and the one activation door
     * (harness/routines/goal-holder-launch-action.ts) hardcoded `headless: true`
     * before this landed. So unpinned MUST resolve to `true` or adding the key
     * would silently re-point every stored goal at a visible terminal — a
     * behaviour change wearing a schema addition's clothes. Only an explicit
     * `false` asks for a headed launch.
     */
    headless: z.boolean().optional(),
  })
  .strict();

export type LaunchProfile = z.infer<typeof launchProfileSchema>;

/**
 * The document stored in `harness_shared.goals.launch_settings`.
 *
 * `.strict()` on both levels is deliberate: these are hand-edited by an owner
 * through the P-005 panel, and a typo'd key that is silently accepted reads back
 * as "the setting is there" while the launch ignores it.
 */
/** R-4 / D-032: the closed behaviour-experiment arm vocabulary. */
export const GOAL_BEHAVIOR_ARMS = ['baseline', 'brief-only', 'full'] as const;
export type GoalBehaviorArm = (typeof GOAL_BEHAVIOR_ARMS)[number];

export const goalLaunchSettingsSchema = z
  .object({
    maxAgents: ceilingSchema.describe(
      `D-005: ceiling over EVERY live session associated with this goal, fleet members included. ` +
        `Omit for the system default (${GOAL_LAUNCH_DEFAULTS.maxAgents}); '${UNLIMITED_CEILING}' for no ceiling at all`,
    ),
    maxPerFleet: ceilingSchema.describe(
      `D-005: ceiling on any ONE fleet pursuing this goal; composes with maxAgents. ` +
        `Omit for the system default (${GOAL_LAUNCH_DEFAULTS.maxPerFleet}); '${UNLIMITED_CEILING}' for no ceiling at all`,
    ),
    /** D-004/P-020: the holder's intended concurrent PLAN fleets, not an agent ceiling. */
    intendedParallelPlanFleets: z.number().int().positive().max(100).optional(),
    defaults: launchProfileSchema.optional(),
    /**
     * D-016: keyed by the CLOSED launch-slot vocabulary, never by psu `--role`.
     * Free-text keys were accepted before and bound nothing, which is precisely
     * the "reads as configured while doing nothing" state `.strict()` exists to
     * prevent. Measured before narrowing: 0 of 12 goals carried a `roles` key,
     * so no stored document is invalidated by closing this set.
     */
    roles: z.partialRecord(z.enum(GOAL_LAUNCH_ROLES), launchProfileSchema).optional(),
    /**
     * P-004: which SHAPE of fleet this goal's plan fleets are launched as.
     *
     * The accepted values are DERIVED from `FLEET_TYPES` (agent-fleets-store),
     * never re-spelled here — the fleet layer already owns this vocabulary, and
     * a second copy is the D-011 drift one level up: the goal panel would offer
     * a type the launch surface does not branch on.
     *
     * ABSENT ⇒ 'single', matching `asFleetType`'s defensive narrowing and
     * `resolveLaunchOptions`'s own rule that an omitted type is single. The
     * default must stay INVISIBLE so no existing goal has to learn the field
     * exists.
     */
    fleetType: z.enum(FLEET_TYPES).optional(),
    /**
     * P-002 (goal-live-holder-guarantee-2026-08-18): the goal's HOLDER policy.
     *
     * Purely additive, and measured so before shipping: of 18 goals in
     * papercusp-workspace, 3 carry any launch_settings at all and 0 carry a
     * `holder` key — so no stored document is invalidated by adding it, and no
     * migration is needed (this column is jsonb).
     *
     * Absent means UNPINNED, not "not required" — see
     * {@link resolveGoalHolderPolicy}, which supplies the defaults at read time
     * so goals that already exist are covered.
     */
    holder: goalHolderPolicySchema.nullable().optional(),
    /**
     * P-020 (work-on-everything-goal-2026-08-23, D-006): opt this goal INTO
     * automatic activation when its DAG becomes ready.
     *
     * Absent / null / false preserves D-003: readiness at goal level is a
     * surfaced OFFER, never a dispatch. With `autoStart: true`, the
     * goal-liveness watchdog's readiness leg dispatches the one
     * goal-activation primitive (`startGoalById`) when the goal BECOMES READY
     * with no live holder. The primitive still owns every guard (not-active /
     * already-held / readiness re-check under its own reads), so this flag can
     * never resurrect a closed goal or double-start a held one — a stale
     * classification costs a refusal, not a duplicate agent.
     *
     * `.nullable()` for the same reason as `holder`: the panel clears a field
     * by writing `null`, which must mean "unpinned", never a third state.
     */
    autoStart: z.boolean().nullable().optional(),
    /**
     * R-4 / D-032 (goal-agent-behavior-feedback-2026-09-06): the behaviour-
     * experiment ARM this goal's agents run under. It withholds TEXT only —
     * modes, code-enforced gates, budget ceilings and the tool surface are
     * identical in every arm, so a measured difference is attributable to the
     * withheld text. Absent / null ⇒ 'full' (today's behaviour), so no stored
     * goal has to learn the field exists. See {@link resolveGoalBehaviorArm}.
     */
    behaviorArm: z.enum(GOAL_BEHAVIOR_ARMS).nullable().optional(),
  })
  .strict();

export type GoalLaunchSettings = z.infer<typeof goalLaunchSettingsSchema>;

/** Resolve a goal's experiment arm; anything unset or unknown reads as 'full'. */
export function resolveGoalBehaviorArm(settings: { behaviorArm?: unknown } | null | undefined): GoalBehaviorArm {
  const arm = settings?.behaviorArm;
  return typeof arm === 'string' && (GOAL_BEHAVIOR_ARMS as readonly string[]).includes(arm)
    ? (arm as GoalBehaviorArm)
    : 'full';
}

/** 'brief-only' and 'baseline' withhold the per-turn obligation agenda and its reminders. */
export function goalArmWithholdsReminders(arm: GoalBehaviorArm): boolean {
  return arm !== 'full';
}

/** 'baseline' also withholds the goal-mode stewardship brief at launch. */
export function goalArmWithholdsBrief(arm: GoalBehaviorArm): boolean {
  return arm === 'baseline';
}

/**
 * R-4 / D-032: does this goal's arm withhold the per-turn obligation agenda?
 * Fail-soft toward 'full' (today's behaviour): an unreadable goal row must
 * never silently strip reminders from a production goal.
 */
export async function goalWithholdsTurnStartReminders(
  goalId: string,
  read: (goalId: string) => Promise<{ settings: GoalLaunchSettings | null }> = readGoalLaunchSettings,
): Promise<boolean> {
  try {
    const { settings } = await read(goalId);
    return goalArmWithholdsReminders(resolveGoalBehaviorArm(settings));
  } catch {
    return false;
  }
}

export interface GoalHeadcount {
  /** Live sessions whose resolved goal context is this goal. */
  total: number;
  /** Live sessions of this goal within `fleetSlug`, or null when no fleet was named. */
  fleet: number | null;
}

export interface GoalLaunchRefusal {
  reason: 'goal_max_agents' | 'fleet_max_agents' | 'goal_budget_exceeded' | 'goal_budget_unmeasurable';
  limit: number;
  /**
   * What the gate actually MEASURED — or null when it could not measure at all.
   *
   * WI-10002052 (plan decision D-004 clause 1): an unmeasurable input is an
   * in-band state to branch on, never a zero. `goal_budget_unmeasurable`
   * refuses precisely BECAUSE the spend is unknown, so writing 0 here would
   * assert the very number the gate is refusing over not having — and an
   * unmeasured zero is indistinguishable downstream from a goal that genuinely
   * spent nothing. Nullable is the type making that distinction unskippable.
   */
  current: number | null;
  requested: number;
  message: string;
  /**
   * What POPULATION `current` measured (spend-attribution…-2026-09-04 P-004).
   *
   * A ceiling refusal is a readout attached to a REFUSAL, so it is among the
   * worst places for a bare number. `has spent 6200 of its 10000 cent budget`
   * reads as a fact about what the goal cost; it is a fact about the goal's POT
   * SUBSET, which in this workspace is a small minority of the real figure.
   *
   * REQUIRED, not optional: a refusal that cannot say what it counted is the
   * defect, so a new refusal reason must choose a label rather than inherit a
   * silent default.
   */
  currentScope: string;
}

/**
 * Population labels for {@link GoalLaunchRefusal.currentScope}.
 *
 * ⚠ `BUDGET_LINEAGE` deliberately DUPLICATES `GOAL_SPEND_LINEAGE_SCOPE` from
 * `./goals/spend-rollup` rather than importing it. That module reaches
 * `@papercusp/agent-mcp`, which imports THIS file, so the import would close a
 * runtime cycle. Duplication is the lesser evil here, but only because it is
 * PINNED: `goal-launch-refusal-scopes.test.ts` fails if the two literals ever
 * diverge, which is the repo's rule for code-describing metadata that cannot be
 * derived.
 */
export const REFUSAL_SCOPES = {
  /**
   * Mirrors GOAL_SPEND_LINEAGE_SCOPE — see the cycle note above. The goal's
   * write-time-attributed spend over its budget window (D-011), the one figure
   * the snapshot, this gate and the breach check share.
   */
  BUDGET_LINEAGE: 'attributed-by-lineage:authoritative',
  /**
   * The value carried no provenance marker, so its population is UNKNOWN. Not a
   * synonym for the pot scope: the gate's SELECT filters on nothing, so an
   * unmarked legacy figure reaches this ceiling identically to a rollup-written
   * one. Labelling it as pot-scoped would assert provenance nothing verified —
   * the precise error this plan exists to stop.
   */
  BUDGET_UNVERIFIED: 'unverified-provenance:unmarked-snapshot',
  /**
   * NOTHING could be measured (WI-10002052). Distinct from BUDGET_UNVERIFIED,
   * which labels a number whose POPULATION is unknown: here there is no number at
   * all, because the goal's window holds attributed samples the ledger could not
   * price, so any total would be a floor. The refusal carries `current: null`
   * and this label says why — so a reader is never invited to infer that the
   * goal spent nothing.
   */
  BUDGET_UNMEASURABLE: 'unmeasurable:unpriced-lineage-samples',
  /**
   * NOTHING could be measured because the authoritative stream is EMPTY while
   * the goal's diagnostic legs (its pots, its holder sessions) carry usage in the
   * same window: spend happened that write-time attribution never stamped. The
   * exact failure the stewardship-remediation plan was opened for (0 attributed
   * samples beside 21,444 cents on the session ledger), so it is refused, never
   * read as "nothing spent".
   */
  BUDGET_UNATTRIBUTED: 'unmeasurable:unattributed-goal-samples',
  /** No priced goal spend can be inferred from an empty measurement (D-011). */
  BUDGET_NO_SAMPLES: 'unmeasurable:no-lineage-samples',
  /** The launch-time measurement itself failed, so there is no figure to judge. */
  BUDGET_MEASUREMENT_FAILED: 'unmeasurable:measurement-failed',
  LIVE_AGENTS_IN_GOAL: 'live-agents-in-goal',
  LIVE_AGENTS_IN_FLEET: 'live-agents-in-fleet',
} as const;

/**
 * WI-10002052 / D-011: does the snapshot say this goal SPENT in its window but
 * the spend could not be measured?
 *
 * The rollup writes `spentCents: null` for two different reasons and names
 * which one in `spentCentsUnmeasuredReason`. Only `unpriced-lineage-samples` is
 * a hole: attributed samples exist but some carry no price, so the true total is
 * unknown and failing open would let a launch past a ceiling nobody can check.
 * `no-lineage-samples` only says the write-time-attributed stream is empty. That
 * is not proof nothing was spent (attribution can miss a goal's sessions), so the
 * launch gate does not admit on it: it measures every leg at launch and refuses
 * while the authoritative spend remains unmeasured (D-011 clause 3).
 *
 * Returns false whenever `spentCents` is non-null, so a stale reason can never
 * contradict a live measurement.
 */
export function hasUnmeasuredPricedSpend(unmeasuredReason: unknown, spentCents: number | null): boolean {
  if (spentCents != null) return false;
  return unmeasuredReason === 'unpriced-lineage-samples';
}

/**
 * The population a stored `spentCents` actually describes, judged from the
 * marker beside it rather than assumed. The spend-rollup tick is the only
 * writer (D-003) and stamps GOAL_SPEND_SNAPSHOT_SOURCE; anything else, including
 * the retired pot-rollup markers, is reported as unverified instead of being
 * granted its standing.
 */
export function budgetSpendScope(source: string | null): string {
  return source === GOAL_SPEND_SNAPSHOT_SOURCE ? REFUSAL_SCOPES.BUDGET_LINEAGE : REFUSAL_SCOPES.BUDGET_UNVERIFIED;
}

/**
 * P-006 (goal-mode-design-intent-hardening-2026-08-16): the budget truth read
 * beside the settings. `budgetCents` is the owner's declared ceiling
 * (`goals.budget_cents`, NULL = no budget declared = nothing enforced);
 * `spentCents` is the PLATFORM snapshot (`goals.metadata.spentCents`, written
 * only by the goal-spend-rollup tick — D-003: agents never hand-write it, and
 * this gate never trusts any other figure). A declared budget with no snapshot
 * is reported degraded rather than guessed at: a null from a careful platform
 * outranks an invented number.
 */
export interface GoalBudgetTruth {
  budgetCents: number | null;
  spentCents: number | null;
  /**
   * WI-10002052 / D-011: did this goal spend in its window in a way that could
   * not be priced?
   *
   * An EXISTENCE signal. It exists because a null `spentCents` covers two
   * populations the gate must treat oppositely:
   *   - nothing attributed in the window (or no tick yet): failing open is
   *     harmless, nothing is being let past a ceiling; and
   *   - attributed samples WITHOUT a price: the total is unknown, so failing
   *     open would let launches past a ceiling that cannot be checked.
   *
   * ⚠ DELIBERATELY A BOOLEAN, NOT THE PRICED FLOOR. A floor below the ceiling
   * says nothing about headroom, so carrying it here would invite exactly the
   * comparison that makes a partial measurement look like a pass.
   */
  unmeasuredPricedSpend: boolean;
  spentCentsAt: string | null;
  /**
   * The provenance marker actually stored beside the number
   * (`goals.metadata.spentCentsSource`), or null when the value predates the
   * marker or was written by something that did not set one.
   *
   * Read (spend-attribution…-2026-09-04 P-004) so the ceiling refusal can NAME
   * the population its number measured instead of asserting one. The doc above
   * says this gate "never trusts any other figure", but the SELECT that feeds it
   * filters on nothing — so an unmarked legacy value reaches the ceiling exactly
   * like a rollup-written one, and the two are indistinguishable downstream
   * unless the marker travels with the cents. It now does.
   */
  spentCentsSource: string | null;
  /** Freshness recorded with the snapshot, re-evaluated against the current clock. */
  interactiveUsageFreshnessStatus: 'fresh' | 'stale' | 'unavailable' | null;
  interactiveUsageLastIngestedAtMs: number | null;
}

export type GoalPlanPlacementState =
  | 'unplaced'
  | 'admitting'
  | 'independently-led'
  | 'working'
  | 'blocked'
  /**
   * WI-10005657: every remaining dependency-free item of the plan is `needs-human`
   * (the structural exit a plan Decision / steward uses to reserve work to the
   * owner or a solo route). Nothing is launchable — a fleet cannot resolve an
   * owner wall — so this is a CONSISTENT, no-action state, never `blocked`.
   *
   * ⚠ Do not fold this back into `blocked`/`resolve-plan-blockers`: that
   * collapse is what made the obligation re-mandate `fleet:launch-on-plan` (and
   * its watchdog twin re-wake the holder) for a plan only the owner can advance.
   */
  | 'owner-walled'
  /**
   * Administratively complete — every item done/dropped, or the status says so —
   * but closure is NOT evidenced (P-026 / D-012). The plan STAYS in the worklist.
   *
   * ⚠ Do not widen this to fall through to `terminal`. That collapse IS the
   * defect: 258 unarchived plans on this harness satisfy the administrative
   * predicate while unshipped, 205 of them sitting in `awaiting-acceptance`.
   */
  | 'awaiting-closure'
  | 'terminal';

export type GoalPlanPlacementRepairAction =
  | 'none'
  | 'launch-plan-fleet'
  | 'launch-spawned-leader'
  | 'resume-partial-launch'
  | 'restore-spawned-leader'
  | 'reconcile-plan-lane-holder'
  | 'resolve-plan-identity'
  | 'resolve-plan-blockers'
  /** Drive the plan to evidenced closure; never a fleet launch — no execution is owed. */
  | 'close-plan';

export interface GoalPlanPlacementToolCall {
  tool: 'fleet:launch-on-plan';
  args: {
    name: string;
    plan: string;
    harness: string;
    leader: 'spawn';
    headless: true;
  };
}

/**
 * The compiled placement truth for one worklist plan. This is deliberately a
 * receipt over the existing plan-item lease + fleet launch ledgers, not a new
 * placement store. `reconciliation.action` is the one idempotent next repair a
 * GOAL holder should perform after refreshing the named canonical records.
 */
export interface GoalPlanPlacement {
  state: GoalPlanPlacementState;
  /**
   * WI-10005657: present exactly when `state === 'owner-walled'` — the
   * needs-human frontier items the plan is waiting on. Omitted otherwise.
   */
  wall?: { kind: 'owner'; itemIds: string[] };
  fleet: {
    slug: string;
    controlState: string | null;
    leaderOwnerId: string | null;
    leaderLive: boolean;
    liveMembers: number;
    target: number | null;
    /** Measured positive plan/plan_item targeting, not ownership authority. */
    planScoped?: boolean;
    /** Some OR arm admits the plan/plan_item (D-033); gates placement, never credits pickup on its own. */
    planAdmitted?: boolean;
  } | null;
  activeLane: {
    itemId: string;
    ownerId: string;
    ownerFleet: string | null;
    holderLive: boolean;
    expiresAt: string | null;
    /** Matching non-terminal work item actually claimed by this lease holder. */
    workItemId?: string | null;
  } | null;
  launchTransaction: {
    transactionId: string | null;
    state: 'launching' | 'partial' | 'verified' | null;
    retryOwnerIds: string[];
    nextAction: string | null;
  } | null;
  reconciliation: {
    consistent: boolean;
    action: GoalPlanPlacementRepairAction;
    reason: string;
    toolCall: GoalPlanPlacementToolCall | null;
  };
  /**
   * P-026 / D-012: the closure reading, when one was resolved for this plan.
   *
   * `null` means closure was NOT resolved — which happens for every plan that is
   * not administratively complete, where the question does not yet arise. It is
   * NEVER a way to read "closed".
   */
  closure: {
    state: PlanClosureState;
    evidenceSatisfied: boolean;
    /** True when the ONLY outstanding leg is the holder's measured report. */
    reportOutstandingOnly: boolean;
    reason: string;
  } | null;
}

/**
 * P-012 (goal-mode-hardening-2026-08-10): the ONE compact portfolio snapshot
 * handed to a GOAL holder at launch and on every coord:orient. It is a read
 * projection over the canonical goal/plan/pot/fleet/work-item/learning stores;
 * none of these fields is a second ledger.
 */
export interface GoalPortfolioBrief {
  schemaVersion: 1;
  assembledAt: string;
  goal: {
    id: string;
    title: string;
    status: string | null;
    body: string | null;
    killCriterion: string | null;
    standing: boolean;
    parentId: string | null;
  };
  worklist: Array<{
    ref: string;
    ordinal: number;
    harness: string | null;
    slug: string;
    title: string | null;
    status: string | null;
    next: { id: string; text: string; phase: string | null; blockedBy: string[] } | null;
    counts: { todo: number; wip: number; blocked: number; needsHuman: number; done: number };
    ambiguousMatches: number;
    placement: GoalPlanPlacement;
  }>;
  pots: Array<{
    harness: string;
    role: 'owner' | 'contributing';
    note: string | null;
    killCriterion: string | null;
    /** The live goal_pots edge, not an inferred plan or work-item owner. */
    linkId: string | null;
  }>;
  /** P-019: one deterministic read of the goal → pot → plan → work-item ladder. */
  attribution?: GoalLadderHealth;
  drainFleet: {
    slug: string | null;
    exists: boolean | null;
    controlState: string | null;
    leaderOwnerId: string | null;
    live: number | null;
    working: number | null;
  };
  queue: {
    total: number;
    terminal: number;
    inFlight: number;
    blocked: number;
    needsHuman: number;
    claimable: number | null;
    /** 'not-requested' = the caller opted out of the per-id floor count
     *  (`claimability: 'skip'`); claimable is null, never a measured 0. */
    claimabilityScope: 'issue-family' | 'none' | 'unknown' | 'not-requested';
  };
  launch: {
    settings: GoalLaunchSettings | null;
    /** Null is a visible missing holder decision, never inferred from a ceiling. */
    intendedParallelPlanFleets?: number | null;
    ceilings: { maxAgents: number | null; maxPerFleet: number | null };
    headcount: GoalHeadcount;
  };
  budget: GoalBudgetTruth & { budgetWindowSec: number | null };
  tripwires: Array<{ metric: string; label?: string; threshold?: number; current?: number; unit?: string }>;
  /** P-015: explicit operating-input verdict. Optional for stored pre-P-015 snapshots. */
  operatingInputs?: GoalOperatingInputs;
  pending: {
    blenderIdeas: number | null;
    acceptanceRubric: { id: string; status: string | null; latestScorecardAt: string | null } | null;
  };
  continuity: {
    checkpoint: { workItemId: string; updatedAt: string; note: string } | null;
    lastOwnerReportAt: string | null;
  };
  /** P-021: one evidence-backed draft from this read, never a second report ledger. */
  reporting?: {
    cadence: GoalOwnerReportObligation | null;
    draft: GoalOwnerReportDraft;
    /** More than 100 changed records requires a targeted follow-up read. */
    movementTruncated: boolean;
    killedTruncated: boolean;
  };
  /** P-018: live, typed evidence for the session receiving this snapshot. */
  holderAttestation?: GoalHolderFirstTurnAttestation | null;
  priorities: string[];
  degradedReasons: string[];
}

export interface GoalOperatingInputs {
  status: 'ready' | 'incomplete' | 'blocked';
  canExecute: boolean;
  budgetWindow: 'undeclared' | 'lifetime' | 'rolling';
  spendCoverage: 'no-ceiling' | 'measured' | 'not-yet-measured' | 'unmeasurable' | 'unverified';
  issues: Array<{
    code:
      | 'missing-kill-criterion'
      | 'missing-budget-ceiling'
      | 'missing-budget-window'
      | 'tripwire-coverage-unassessed'
      | 'tripwire-missing-threshold'
      | 'tripwires-unreadable'
      | 'spend-not-yet-measured'
      | 'spend-unmeasurable'
      | 'spend-provenance-unverified'
      | 'portfolio-unreadable';
    required: boolean;
    action: string;
  }>;
}

export interface GoalLadderHealth {
  status: 'healthy' | 'incomplete' | 'unknown';
  issues: Array<{
    code:
      | 'missing-pot-link' | 'missing-pot-owner' | 'missing-link-kill-criterion'
      | 'missing-plan' | 'plan-goal-mismatch' | 'unstamped-plan'
      | 'unstamped-work-item' | 'work-item-goal-mismatch' | 'ladder-unreadable';
    ref: string;
    action: string;
  }>;
  checked: { pots: number; plans: number; workItems: number };
  /**
   * Worklist work-items that carry no `goal_id` stamp but are owned by another machine
   * (`origin = 'remote'`). Federation owns those rows: a local field edit is refused and the
   * attribution backfill deliberately skips them, so NO local verb can stamp one. Counting them as
   * `unstamped-work-item` made the ladder `incomplete` forever for a defect the local goal holder
   * cannot repair (WI-10005269). They are surfaced here as an explicit, non-blocking note — the
   * owning machine stamps them — never silently dropped and never an actionable issue.
   */
  remoteOwned: string[];
}

/** Compile only from the canonical goal, tripwire and spend fields already read. */
export function evaluateGoalOperatingInputs(args: {
  standing: boolean;
  killCriterion: string | null;
  budgetCents: number | null;
  budgetWindowSec: number | null;
  spentCents: number | null;
  spentCentsSource: string | null;
  unmeasuredPricedSpend: boolean;
  tripwires: GoalPortfolioBrief['tripwires'] | null;
  portfolioReadFailed?: boolean;
}): GoalOperatingInputs {
  const issues: GoalOperatingInputs['issues'] = [];
  const add = (code: GoalOperatingInputs['issues'][number]['code'], required: boolean, action: string) =>
    issues.push({ code, required, action });
  const requiredForOutcome = !args.standing;
  if (!args.killCriterion?.trim()) {
    add('missing-kill-criterion', requiredForOutcome,
      args.standing ? 'Declare the standing duty\'s stop polarity or explicit retirement condition.' : 'Set a checkable kill criterion on the goal.');
  }
  if (args.budgetCents == null) {
    add('missing-budget-ceiling', requiredForOutcome, 'Set a budget ceiling on the goal.');
  }
  if (args.standing && args.budgetCents != null && args.budgetWindowSec == null) {
    add('missing-budget-window', false, 'Choose a rolling budget window or explicitly retain a lifetime ceiling.');
  }
  if (args.tripwires === null) {
    add('tripwires-unreadable', requiredForOutcome, 'Re-read the goal tripwires before holder execution.');
  } else if (args.tripwires.length === 0) {
    add('tripwire-coverage-unassessed', false, 'Review countable limits in the goal and declare a tripwire for each one.');
  } else if (args.tripwires.some((tripwire) => tripwire.threshold == null)) {
    add('tripwire-missing-threshold', requiredForOutcome, 'Give every declared countable tripwire a threshold.');
  }
  let spendCoverage: GoalOperatingInputs['spendCoverage'] = 'no-ceiling';
  if (args.budgetCents != null) {
    if (args.unmeasuredPricedSpend) {
      spendCoverage = 'unmeasurable';
      add('spend-unmeasurable', requiredForOutcome, 'Repair authoritative goal spend measurement; do not infer zero spend.');
    } else if (args.spentCents == null) {
      spendCoverage = 'not-yet-measured';
      add('spend-not-yet-measured', false, 'Check the first goal spend rollup before claiming measured headroom.');
    } else if (budgetSpendScope(args.spentCentsSource) === REFUSAL_SCOPES.BUDGET_LINEAGE) {
      spendCoverage = 'measured';
    } else {
      spendCoverage = 'unverified';
      add('spend-provenance-unverified', requiredForOutcome, 'Repair the spend provenance marker before relying on the ceiling.');
    }
  }
  if (args.portfolioReadFailed) {
    add('portfolio-unreadable', requiredForOutcome, 'Re-read the canonical goal portfolio before any placement.');
  }
  const canExecute = !issues.some((issue) => issue.required);
  return {
    status: issues.length === 0 ? 'ready' : canExecute ? 'incomplete' : 'blocked',
    canExecute,
    budgetWindow: args.budgetCents == null ? 'undeclared' : args.budgetWindowSec == null ? 'lifetime' : 'rolling',
    spendCoverage,
    issues,
  };
}

/** One recovery message for each holder start door; no prose-only readiness fork. */
export function goalHolderInputRefusal(readiness: GoalOperatingInputs | null | undefined): string | null {
  if (!readiness || readiness.canExecute) return null;
  return `goal_operating_inputs_missing: ${readiness.issues
    .filter((issue) => issue.required)
    .map((issue) => `${issue.code} — ${issue.action}`)
    .join('; ')}. Nothing was spawned; repair the goal and retry its holder start.`;
}

type GoalPortfolioSourceRow = {
  status?: unknown;
  parent_id?: unknown;
  tripwires?: unknown;
  properties?: unknown;
  metadata?: unknown;
  pots?: unknown;
  plans?: unknown;
  ladder_work_items?: unknown;
  queue?: unknown;
  drain_fleet?: unknown;
  checkpoint?: unknown;
  report_movements?: unknown;
  owner_walls?: unknown;
  killed_work?: unknown;
  blender_pending?: unknown;
  acceptance_rubric?: unknown;
};

const portfolioObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const portfolioArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const portfolioString = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);
const portfolioBoolean = (value: unknown): boolean => value === true;
const portfolioNumber = (value: unknown): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  return Number.isFinite(n) ? n : 0;
};

/** Pure fold so fixture, live read and prompt render share one attribution rule. */
export function evaluateGoalLadderHealth(args: {
  goalId: string;
  pots: GoalPortfolioBrief['pots'];
  plans: Array<{ ref: string; harness: string | null; goalId: string | null; exists: boolean }>;
  workItems: Array<{
    id: string; harness: string | null; planSlug: string | null; goalId: string | null;
    /** `harness_shared.work_items.origin`; `'remote'` rows are federation-owned (see `remoteOwned`). */
    origin?: string | null;
  }>;
  unreadable?: boolean;
}): GoalLadderHealth {
  const issues: GoalLadderHealth['issues'] = [];
  const remoteOwned: string[] = [];
  const add = (code: GoalLadderHealth['issues'][number]['code'], ref: string, action: string) =>
    issues.push({ code, ref, action });
  if (args.unreadable) {
    add('ladder-unreadable', args.goalId, 'Re-read the canonical goal, pot, plan and work-item records.');
    return { status: 'unknown', issues, checked: { pots: 0, plans: 0, workItems: 0 }, remoteOwned };
  }
  if (args.pots.length === 0) add('missing-pot-link', args.goalId, 'Attach a pot with goals:attach-pot.');
  if (args.pots.length > 0 && !args.pots.some((pot) => pot.role === 'owner')) {
    add('missing-pot-owner', args.goalId, 'Elect one owned pot link with goals:attach-pot { role: "owner" }.');
  }
  for (const pot of args.pots) {
    if (!pot.linkId) add('missing-pot-link', pot.harness, 'Restore the live goal_pots edge.');
    if (!pot.killCriterion?.trim()) {
      add('missing-link-kill-criterion', pot.harness, 'Set this edge\'s stop condition with goals:attach-pot { killCriterion }.');
    }
  }
  for (const plan of args.plans) {
    if (!plan.exists) add('missing-plan', plan.ref, 'Repair the worklist ref or create the missing plan.');
    else if (!plan.goalId) add('unstamped-plan', plan.ref, 'Stamp this plan through its goal-scoped creator or launcher.');
    else if (plan.goalId !== args.goalId) add('plan-goal-mismatch', plan.ref, 'Review the plan attribution; do not reparent it silently.');
    if (plan.exists && plan.harness && !args.pots.some((pot) => pot.harness === plan.harness)) {
      add('missing-pot-link', plan.ref, 'Attach the plan pot to this goal before placing work.');
    }
  }
  for (const item of args.workItems) {
    if (!item.goalId && item.origin === 'remote') remoteOwned.push(item.id);
    else if (!item.goalId) add('unstamped-work-item', item.id, 'Repair the canonical work-item goal_id stamp.');
    else if (item.goalId !== args.goalId) add('work-item-goal-mismatch', item.id, 'Review the item attribution; do not reparent it silently.');
    if (item.harness && !args.pots.some((pot) => pot.harness === item.harness)) {
      add('missing-pot-link', item.id, 'Attach the work-item pot to this goal.');
    }
  }
  return {
    status: issues.length ? 'incomplete' : 'healthy', issues,
    checked: { pots: args.pots.length, plans: args.plans.length, workItems: args.workItems.length },
    remoteOwned,
  };
}

const portfolioJsonObject = (value: unknown): Record<string, unknown> | null => {
  const direct = portfolioObject(value);
  if (direct) return direct;
  if (typeof value !== 'string') return null;
  try {
    return portfolioObject(JSON.parse(value));
  } catch {
    return null;
  }
};

/** Pure compiler over the canonical records already assembled by the portfolio read. */
export function compileGoalPlanPlacement(args: {
  plan: { harness: string | null; slug: string; ambiguousMatches: number };
  status: string | null;
  itemStatuses: readonly string[];
  actionableItemId: string | null;
  source: unknown;
  now?: Date;
  /**
   * P-026 / D-012. Administrative completion alone no longer makes a plan
   * terminal; `closure.evidenceSatisfied` does. OMITTING this is NOT a way to
   * get the old behaviour back: an administratively complete plan with no
   * closure reading is `awaiting-closure`, because "we never looked" and "it
   * closed" are the two readings this item exists to keep apart.
   */
  closure?: Pick<PlanClosureVerdict, 'state' | 'evidenceSatisfied' | 'reason' | 'legs'> | null;
  /**
   * WI-10005657: the plan's dependency-free frontier, when it consists ONLY of
   * `needs-human` items. The caller (parsePortfolioWorklist) owns the frontier
   * derivation; empty/omitted means "not owner-walled". Consulted only when the
   * plan would otherwise compile as `blocked` for lack of a launchable item, so
   * it can never hide a live lane, a fleet, or a startable todo.
   */
  ownerWalledItemIds?: readonly string[];
}): GoalPlanPlacement {
  const source = portfolioObject(args.source) ?? {};
  const nowMs = (args.now ?? new Date()).getTime();
  const claims = portfolioArray(source.claims)
    .map(portfolioObject)
    .filter((claim): claim is Record<string, unknown> => claim !== null)
    .filter((claim) => {
      const expiresAt = portfolioString(claim.expiresAt);
      return !expiresAt || Date.parse(expiresAt) > nowMs;
    });
  const laneRaw = args.actionableItemId
    ? (claims.find((claim) => portfolioString(claim.itemId) === args.actionableItemId) ?? null)
    : null;
  const activeLane = laneRaw
    ? {
        itemId: portfolioString(laneRaw.itemId)!,
        ownerId: portfolioString(laneRaw.ownerId) ?? 'unknown',
        ownerFleet: portfolioString(laneRaw.fleetSlug),
        holderLive: portfolioBoolean(laneRaw.holderLive),
        expiresAt: portfolioString(laneRaw.expiresAt),
        workItemId: portfolioString(laneRaw.workItemId),
      }
    : null;
  const fleetRaw = portfolioObject(source.fleet);
  const fleetSlug = portfolioString(fleetRaw?.slug);
  const claimSpec = validateClaimSpec(portfolioJsonObject(fleetRaw?.claimSpec));
  const planScoped = claimSpec.ok && Boolean(claimSpec.spec) && (
    claimSpecFilterPositivelyTargets(claimSpec.spec!.view.filter, 'plan', args.plan.slug) ||
    (args.actionableItemId !== null && claimSpecFilterPositivelyTargets(claimSpec.spec!.view.filter, 'plan_item', args.actionableItemId))
  );
  const planAdmitted = claimSpec.ok && Boolean(claimSpec.spec) && (
    claimSpecFilterAdmitsTarget(claimSpec.spec!.view.filter, 'plan', args.plan.slug) ||
    (args.actionableItemId !== null && claimSpecFilterAdmitsTarget(claimSpec.spec!.view.filter, 'plan_item', args.actionableItemId))
  );
  const holderIdentityMeasured = Array.isArray(source.goalHolderOwnerIds);
  const goalHolderOwnerIds = portfolioArray(source.goalHolderOwnerIds).map(String);
  const fleet =
    fleetRaw && fleetSlug
      ? {
          slug: fleetSlug,
          controlState: portfolioString(fleetRaw.controlState),
          leaderOwnerId: portfolioString(fleetRaw.leaderOwnerId),
          leaderLive: portfolioBoolean(fleetRaw.leaderLive),
          liveMembers: portfolioNumber(fleetRaw.liveMembers),
            target: fleetRaw.target == null ? null : portfolioNumber(fleetRaw.target),
            planScoped,
            planAdmitted,
        }
      : null;
  const transactionRaw = portfolioJsonObject(fleetRaw?.launchTransaction);
  const transactionState = portfolioString(transactionRaw?.state);
  const recoveryRaw = portfolioObject(transactionRaw?.recovery);
  const launchTransaction: GoalPlanPlacement['launchTransaction'] = transactionRaw
    ? {
        transactionId: portfolioString(transactionRaw.transactionId),
        state:
          transactionState === 'launching' || transactionState === 'partial' || transactionState === 'verified'
            ? transactionState
            : null,
        retryOwnerIds: portfolioArray(recoveryRaw?.retryOwnerIds).map(String).filter(Boolean),
        nextAction: portfolioString(recoveryRaw?.nextAction),
      }
    : null;

  // EI-25157449632977265: a partial receipt can describe historical worker
  // attestation gaps after every requested process was opened and verified.
  // Measured empty physical recovery lets CURRENT leadership/admission/member
  // claim evidence below decide placement; it never upgrades the immutable
  // transaction or treats live-member count as worker accountability. Inspect
  // the raw arrays: portfolioArray would turn an absent measurement into [].
  const requestedMemberIds = transactionRaw?.requestedMemberIds;
  const openedMemberIds = transactionRaw?.openedMemberIds;
  const verifiedMemberIds = transactionRaw?.verifiedMemberIds;
  const partialLaunchPhysicallyComplete =
    transactionState === 'partial' &&
    Array.isArray(recoveryRaw?.retryOwnerIds) && recoveryRaw.retryOwnerIds.length === 0 &&
    Array.isArray(transactionRaw?.failed) && transactionRaw.failed.length === 0 &&
    (transactionRaw.unconfirmedMemberIds === undefined ||
      (Array.isArray(transactionRaw.unconfirmedMemberIds) && transactionRaw.unconfirmedMemberIds.length === 0)) &&
    Array.isArray(requestedMemberIds) && requestedMemberIds.length > 0 &&
    Array.isArray(openedMemberIds) && Array.isArray(verifiedMemberIds) &&
    requestedMemberIds.every((ownerId) =>
      typeof ownerId === 'string' && ownerId.trim().length > 0 &&
      openedMemberIds.includes(ownerId) && verifiedMemberIds.includes(ownerId));

  const normalizedStatus = args.status?.trim().toLowerCase() ?? '';
  const normalizedItems = args.itemStatuses.map((status) => status.trim().toLowerCase());
  // What the ADMINISTRATIVE records say. Historically this was the whole of
  // terminality; P-026 demotes it to one input, because none of these three
  // clauses observes whether the delegated execution produced any evidence.
  const administrativelyComplete =
    normalizedStatus === 'done' ||
    normalizedStatus === 'shipped' ||
    normalizedStatus === 'superseded' ||
    (normalizedItems.length > 0 && normalizedItems.every((status) => status === 'done' || status === 'dropped'));
  // A plan leaves the worklist only when its closure EVIDENCE legs are satisfied
  // — terminal evidence, read-back verification and an independent regrade. An
  // absent closure reading is not evidence, so it does not terminate the plan.
  const terminal = administrativelyComplete && args.closure?.evidenceSatisfied === true;
  // A draft plan may contain dependency-free todo items, but the plan start
  // oracle still refuses it until the owner approves the plan and supplies all
  // declared inputs. Treating that row as `unplaced` produced a launch action
  // that could never succeed and, worse, kept it as the first mandatory action
  // on every GOAL wake, starving later eligible worklist plans. Draft (and
  // paused/unknown operational) plans are therefore blocked at the portfolio
  // compiler; only an approved/active plan may emit a fleet launch call.
  const planStartable = normalizedStatus === 'ready' || normalizedStatus === 'active' || normalizedStatus === 'started';
  const blocked = !administrativelyComplete && args.actionableItemId == null;
  const ownerWalledItemIds = args.ownerWalledItemIds ?? [];
  const planHarness = args.plan.harness?.trim() || null;
  const planSlug = args.plan.slug.trim();
  const planIdentityProblem =
    args.plan.ambiguousMatches > 1
      ? `The worklist plan ${planSlug} is ambiguous across ${args.plan.ambiguousMatches} harnesses; qualify its plan ref before launch.`
      : !planHarness
        ? `The worklist plan ${planSlug} has no resolved harness; repair its plan ref before launch.`
        : !planSlug
          ? 'The worklist entry has no resolved plan slug; repair it before launch.'
          : null;
  const planFleetToolCall: GoalPlanPlacementToolCall | null =
    planIdentityProblem || !planHarness
      ? null
      : {
          tool: 'fleet:launch-on-plan',
          args: {
            // Initial placement gets one deterministic name. Recovery must use
            // the correlated fleet row's actual slug: launch-on-plan keys its
            // durable transaction/idempotency guard by that name-derived slug,
            // so synthesizing a new name here would fork a second fleet.
            name: fleet?.slug ?? `${planHarness}-${planSlug}-plan-fleet`,
            plan: planSlug,
            harness: planHarness,
            leader: 'spawn',
            headless: true,
          },
        };

  let state: GoalPlanPlacementState;
  let action: GoalPlanPlacementRepairAction;
  let reason: string;
  if (terminal) {
    state = 'terminal';
    action = 'none';
    reason = 'The plan is terminal; no placement repair is required.';
  } else if (administrativelyComplete) {
    // The plan claims to be finished and its closure is not evidenced. Keep it
    // in the worklist and name the repair — but never `launch-plan-fleet`: the
    // execution already happened, what is missing is evidence of its closure.
    state = 'awaiting-closure';
    action = 'close-plan';
    reason = args.closure
      ? `The plan is administratively complete but closure is ${args.closure.state}: ${args.closure.reason}`
      : 'The plan is administratively complete but no closure evidence was read; placement is not progress until it is.';
  } else if (planIdentityProblem) {
    state = 'blocked';
    action = 'resolve-plan-identity';
    reason = planIdentityProblem;
  } else if (!planStartable) {
    state = 'blocked';
    action = 'resolve-plan-blockers';
    reason = `The plan is ${normalizedStatus || 'unresolved'} and cannot launch until its lifecycle/start gate is satisfied.`;
  } else if (blocked && ownerWalledItemIds.length > 0) {
    // Not `blocked`: no agent can resolve it, so reporting it as a repairable
    // blocker is what kept re-mandating a fleet launch the plan cannot accept.
    state = 'owner-walled';
    action = 'none';
    reason =
      `Every remaining dependency-free item (${ownerWalledItemIds.join(', ')}) is needs-human: ` +
      'only the owner can advance this plan. Do not launch a fleet or spawn a leader for it; ' +
      'report the wall in the owner report and move on to launchable plans.';
  } else if (blocked) {
    state = 'blocked';
    action = 'resolve-plan-blockers';
    reason = 'The plan has non-terminal work but no dependency-free todo item.';
  } else if (!fleet && activeLane && !goalHolderOwnerIds.includes(activeLane.ownerId)) {
    state = 'blocked';
    action = 'reconcile-plan-lane-holder';
    const holder = activeLane.ownerFleet
      ? `${activeLane.ownerId} in fleet ${activeLane.ownerFleet}`
      : activeLane.ownerId;
    reason =
      `The ${activeLane.itemId} lease is held by ${holder}, outside the GOAL holders, and no plan-scoped fleet ` +
      `exists for ${args.plan.slug}; reconcile that lease and do not launch a duplicate fleet.`;
  } else if (!activeLane && !fleet) {
    state = 'unplaced';
    action = 'launch-plan-fleet';
    reason =
      `Launch the independently led plan fleet in one call. fleet:launch-on-plan owns promotion, ` +
      `plan-lane admission, the scheduler claim spec, and spawned leadership for ${args.actionableItemId}; ` +
      'the GOAL holder must not claim the plan item itself.';
  } else if (!fleet) {
    state = 'admitting';
    action = 'launch-spawned-leader';
    reason = `The ${activeLane!.itemId} lease is held; launch its independently led fleet with leader:'spawn'.`;
  } else if (launchTransaction?.state === 'launching' ||
    (launchTransaction?.state === 'partial' && !partialLaunchPhysicallyComplete)) {
    state = 'admitting';
    action = 'resume-partial-launch';
    reason =
      launchTransaction.nextAction ?? 'Resume the durable fleet launch transaction without replaying verified members.';
  } else if (!fleet.leaderLive) {
    state = 'admitting';
    action = 'restore-spawned-leader';
    reason = `Fleet ${fleet.slug} has no live delegated leader; restore one without moving the GOAL steward.`;
  } else if (fleet.controlState !== 'active' || !holderIdentityMeasured || !fleet.leaderOwnerId || goalHolderOwnerIds.includes(fleet.leaderOwnerId)) {
    state = 'blocked';
    action = 'reconcile-plan-lane-holder';
    reason = `Verify active, independent leadership for ${fleet.slug}; a GOAL steward or unmeasured holder identity cannot certify delegated execution. Preserve any fleet pause and repair through its existing authority.`;
  } else if (!planAdmitted) {
    state = 'blocked';
    action = 'reconcile-plan-lane-holder';
    reason = `Restore a valid positive plan/plan_item claim filter for ${fleet.slug} before crediting member pickup; do not create a replacement fleet.`;
  } else if (!activeLane) {
    state = 'admitting';
    action = 'reconcile-plan-lane-holder';
    reason = `Fleet ${fleet.slug} already exists. Have its leader advance a member claim on ${args.actionableItemId} through the existing scheduler/lease rails; a launch receipt is not pickup and does not warrant a duplicate fleet.`;
  } else if (!activeLane.holderLive) {
    state = 'blocked';
    action = 'reconcile-plan-lane-holder';
    reason = `The ${activeLane.itemId} lease holder is not live; restore it or reclaim the lane through the canonical lease authority.`;
  } else if (activeLane.ownerFleet !== fleet.slug || activeLane.ownerId === fleet.leaderOwnerId ||
    goalHolderOwnerIds.includes(activeLane.ownerId) || !activeLane.workItemId || !activeLane.expiresAt) {
    state = 'admitting';
    action = 'reconcile-plan-lane-holder';
    reason = `Verify an actual live ${fleet.slug} member claim, matching work item and unexpired ${activeLane.itemId} lease. Leader-only, steward, or other-fleet leases and WIP labels are not productive member pickup. Reconcile through the existing scheduler; do not launch a duplicate fleet.`;
  } else {
    const hasWip = normalizedItems.some((status) => status === 'wip');
    state = hasWip ? 'working' : 'independently-led';
    action = 'none';
    reason =
      state === 'working'
        ? `Fleet ${fleet.slug} has live delegated leadership and is working the leased plan lane.`
        : `Fleet ${fleet.slug} has live delegated leadership; the plan lane is ready for its next work transition.`;
  }

  return {
    state,
    ...(state === 'owner-walled' ? { wall: { kind: 'owner' as const, itemIds: [...ownerWalledItemIds] } } : {}),
    fleet,
    activeLane,
    launchTransaction,
    closure: args.closure
      ? {
          state: args.closure.state,
          evidenceSatisfied: args.closure.evidenceSatisfied,
          // "Only the report is missing" is the one gap a fleet launch cannot
          // repair, so the obligation needs it apart from every other gap.
          reportOutstandingOnly:
            args.closure.evidenceSatisfied && args.closure.legs.measuredReport !== 'pass',
          reason: args.closure.reason,
        }
      : null,
    reconciliation: {
      consistent: action === 'none',
      action,
      reason,
      toolCall:
        action === 'launch-plan-fleet' ||
        action === 'launch-spawned-leader' ||
        action === 'resume-partial-launch' ||
        action === 'restore-spawned-leader'
          ? planFleetToolCall
          : null,
    },
  };
}

function parsePortfolioWorklist(
  raw: unknown,
  now: Date,
  /**
   * Closure verdicts by plan SLUG, for the second pass. Absent on the first pass
   * by design: the parser cannot know which plans are administratively complete
   * until it has compiled them, and resolving closure for a plan that still has
   * open work would pay for the acceptance gate to tell us nothing.
   */
  closures?: ReadonlyMap<string, PlanClosureVerdict>,
): GoalPortfolioBrief['worklist'] {
  return portfolioArray(raw).flatMap((value) => {
    const row = portfolioObject(value);
    const ref = portfolioString(row?.ref);
    const slug = portfolioString(row?.slug);
    if (!row || !ref || !slug) return [];
    const harness = portfolioString(row.harness);
    const ambiguousMatches = portfolioNumber(row.ambiguousMatches);
    const items = portfolioArray(row.items)
      .map(portfolioObject)
      .filter((item): item is Record<string, unknown> => item !== null)
      .sort((a, b) => portfolioNumber(a.seq) - portfolioNumber(b.seq));
    const counts = { todo: 0, wip: 0, blocked: 0, needsHuman: 0, done: 0 };
    for (const item of items) {
      const status = portfolioString(item.status) ?? 'todo';
      if (status === 'wip') counts.wip += 1;
      else if (status === 'blocked') counts.blocked += 1;
      else if (status === 'needs-human' || status === 'needs_human') counts.needsHuman += 1;
      else if (status === 'done' || status === 'dropped') counts.done += 1;
      else counts.todo += 1;
    }
    // Dependency-free means every blocked-by edge has RESOLVED (done/dropped), the
    // same rule promotion and the claim floor apply. Reading the raw edge list
    // instead kept a plan whose next todo waited only on finished work compiling
    // as `blocked` forever, so placement could never offer it.
    const { items: resolvedItems } = resolveEffectiveStatusForItems(items.map((item, index) => ({
      id: portfolioString(item.id) ?? `#${index}`,
      text: portfolioString(item.text) ?? '',
      storedStatus: (portfolioString(item.status) ?? 'todo') as ItemStatus,
      importance: 'normal',
      blockedBy: portfolioArray(item.blockedBy).map(String).filter(Boolean),
      decisionRefs: [],
      phase: portfolioString(item.phase),
      lineNumber: 0,
      rawLine: '',
    })));
    const nextIndex = resolvedItems.findIndex((item) =>
      item.effectiveStatus === 'todo' && item.unresolvedBlockers.length === 0 && !item.needsHuman);
    const nextRow = nextIndex >= 0 ? items[nextIndex] : undefined;
    // WI-10005657: the dependency-free frontier — every non-terminal item whose
    // blockers have all resolved. When it is NON-EMPTY and made ONLY of
    // needs-human items, nothing an agent or fleet can do advances the plan; it
    // is owner-walled. A frontier that also holds a todo/wip/stored-blocked item
    // is NOT a wall (`needsHuman` items beside it are merely one of several
    // open fronts), so only the all-needs-human case is passed through.
    const frontier = resolvedItems.filter((item) =>
      item.storedStatus !== 'done' && item.storedStatus !== 'dropped' && item.unresolvedBlockers.length === 0);
    const ownerWalledItemIds =
      frontier.length > 0 && frontier.every((item) => item.needsHuman) ? frontier.map((item) => item.id) : [];
    // A WIP item is the fleet's current lane. Only fall through to the next
    // dependency-free todo when nothing is already underway; otherwise a live
    // WIP lease would be hidden behind the subsequent todo and compile as a
    // false `unplaced` state.
    const laneRow = items.find((item) => (portfolioString(item.status) ?? 'todo') === 'wip') ?? nextRow;
    const next = nextRow
      ? {
          id: portfolioString(nextRow.id) ?? 'unknown',
          text: portfolioString(nextRow.text) ?? '',
          phase: portfolioString(nextRow.phase),
          blockedBy: resolvedItems[nextIndex].unresolvedBlockers,
        }
      : null;
    return [
      {
        ref,
        ordinal: portfolioNumber(row.ordinal),
        harness,
        slug,
        title: portfolioString(row.title),
        status: portfolioString(row.status),
        next,
        counts,
        ambiguousMatches,
        placement: compileGoalPlanPlacement({
          plan: { harness, slug, ambiguousMatches },
          status: portfolioString(row.status),
          itemStatuses: items.map((item) => portfolioString(item.status) ?? 'todo'),
          actionableItemId: laneRow ? (portfolioString(laneRow.id) ?? 'unknown') : null,
          source: row.placement,
          now,
          closure: closures?.get(slug) ?? null,
          ownerWalledItemIds,
        }),
      },
    ];
  });
}

/** Render the compact snapshot for a prompt without creating a second prose contract. */
export function renderGoalPortfolioBrief(brief: GoalPortfolioBrief): string {
  const operatingInputs = brief.operatingInputs ?? evaluateGoalOperatingInputs({
    standing: brief.goal.standing,
    killCriterion: brief.goal.killCriterion,
    budgetCents: brief.budget.budgetCents,
    budgetWindowSec: brief.budget.budgetWindowSec,
    spentCents: brief.budget.spentCents,
    spentCentsSource: brief.budget.spentCentsSource,
    unmeasuredPricedSpend: brief.budget.unmeasuredPricedSpend,
    tripwires: brief.tripwires,
  });
  const plans = brief.worklist.length
    ? brief.worklist
        .map(
          (p) =>
            `${p.ordinal}. ${p.ref} [${p.status ?? 'missing'}; placement=${p.placement.state}]${p.next ? ` next=${p.next.id}` : ''}`,
        )
        .join('; ')
    : 'none declared';
  const priorities = brief.priorities.length
    ? brief.priorities.map((p, i) => `${i + 1}. ${p}`).join('\n')
    : '1. Re-read the goal before any write.';
  const ownerWalledPlans = brief.worklist.filter((plan) => plan.placement.state === 'owner-walled');
  const mandatoryPlacement = brief.worklist.find((plan) => plan.placement.reconciliation.toolCall !== null);
  const mandatoryToolCall = mandatoryPlacement?.placement.reconciliation.toolCall ?? null;
  return [
    `GOAL PORTFOLIO SNAPSHOT — assembled ${brief.assembledAt} (schema v${brief.schemaVersion})`,
    `Goal: ${brief.goal.status ?? 'unknown'}; worklist: ${plans}`,
    `Pots: ${brief.pots.map((p) => `${p.harness}:${p.role}[kill=${p.killCriterion ?? 'missing'}]`).join(', ') || 'none'}`,
    ...(brief.attribution
      ? [`Attribution ladder: ${brief.attribution.status}; checked=${brief.attribution.checked.pots} pot links/${brief.attribution.checked.plans} plans/${brief.attribution.checked.workItems} work items; issues=${brief.attribution.issues.map((issue) => `${issue.code}(${issue.ref})`).join(', ') || 'none'}${brief.attribution.remoteOwned.length ? `; remote-owned (non-blocking, owning machine stamps)=${brief.attribution.remoteOwned.join(', ')}` : ''}`]
      : []),
    `Drain fleet: ${brief.drainFleet.slug ?? 'not declared'}; live=${brief.drainFleet.live ?? 'unknown'}; working=${brief.drainFleet.working ?? 'unknown'}; control=${brief.drainFleet.controlState ?? 'unknown'}`,
    `Queue: total=${brief.queue.total}; terminal=${brief.queue.terminal}; in-flight=${brief.queue.inFlight}; blocked=${brief.queue.blocked}; needs-human=${brief.queue.needsHuman}; claimable=${brief.queue.claimable ?? 'unknown'} (${brief.queue.claimabilityScope})`,
    `Launch: intendedParallelPlanFleets=${brief.launch.intendedParallelPlanFleets ?? brief.launch.settings?.intendedParallelPlanFleets ?? 'undeclared'}; headcount=${brief.launch.headcount.total}; maxAgents=${brief.launch.ceilings.maxAgents ?? 'unlimited'}; maxPerFleet=${brief.launch.ceilings.maxPerFleet ?? 'unlimited'}`,
    `Independent plan-lane placement candidates: ${brief.worklist.filter((p) => p.placement.reconciliation.action === 'launch-plan-fleet').map((p) => p.ref).join(', ') || 'none'}. Verify exact admission, then place admissible lanes concurrently to the chosen width; ceilings are limits, not targets.`,
    // WI-10005657: a plan only the owner can advance is named explicitly rather
    // than left to read as an unplaced/blocked plan awaiting a launch.
    ...(ownerWalledPlans.length
      ? [`OWNER-WALLED placement (not launchable — a fleet cannot resolve it; carry into the owner report, never launch): ${ownerWalledPlans.map((p) => `${p.ref} (${p.placement.wall?.itemIds.join(', ') ?? 'needs-human'})`).join('; ')}.`]
      : []),
    // P-004: NAME THE POPULATION. This line lands in the kickoff of every agent
    // that works the goal, which makes it the most-read rendering of this number
    // anywhere — and `spent=` unqualified reads as what the goal has cost. It is
    // the POT leg only. The scope is omitted when there is no figure to mislabel.
    `Budget: spent=${brief.budget.spentCents ?? 'unknown'}c${
      brief.budget.spentCents == null ? '' : ` [${budgetSpendScope(brief.budget.spentCentsSource)}]`
    } / ${brief.budget.budgetCents ?? 'undeclared'}c${brief.budget.spentCentsAt ? ` at ${brief.budget.spentCentsAt}` : ''}`,
    `Operating inputs: ${operatingInputs.status}; execution=${operatingInputs.canExecute ? 'allowed' : 'blocked'}; budget-window=${operatingInputs.budgetWindow}; spend-coverage=${operatingInputs.spendCoverage}`,
    ...(operatingInputs.issues.length
      ? [`Recover inputs: ${operatingInputs.issues.map((issue) => `${issue.code}${issue.required ? ' [required]' : ''}: ${issue.action}`).join('; ')}`]
      : []),
    `Pending: Blender=${brief.pending.blenderIdeas ?? 'unknown'}; rubric=${brief.pending.acceptanceRubric ? `${brief.pending.acceptanceRubric.id}:${brief.pending.acceptanceRubric.status ?? 'unknown'}` : 'none'}`,
    `Continuity: checkpoint=${brief.continuity.checkpoint ? `${brief.continuity.checkpoint.workItemId}@${brief.continuity.checkpoint.updatedAt}` : 'none'}; last-owner-report=${brief.continuity.lastOwnerReportAt ?? 'none'}`,
    ...(brief.reporting
      ? [
          `Owner report cadence: ${brief.reporting.cadence?.obligation ?? 'unknown'}; due=${brief.reporting.cadence?.dueAt ?? 'unknown'}.`,
          `Owner report evidence: movement-truncated=${brief.reporting.movementTruncated}; killed-truncated=${brief.reporting.killedTruncated}; unread terminal artifacts=${brief.reporting.draft.unreadArtifacts.join(', ') || 'none'}.`,
          'OWNER REPORT DRAFT — provisional snapshot, not a send-ready report; read each named terminal artifact after its recorded update, then refresh after this pass’s actions before sending:',
          brief.reporting.draft.text,
        ]
      : ['Owner report evidence unavailable; re-read the canonical goal portfolio before reporting.']),
    ...(brief.holderAttestation
      ? [`Holder first-turn attestation: ${brief.holderAttestation.status}; missing=${brief.holderAttestation.missing.join(', ') || 'none'}; unavailable=${brief.holderAttestation.unavailable.join(', ') || 'none'}; act=${brief.holderAttestation.portfolioAct?.tool ?? 'none'}`]
      : []),
    ...(brief.degradedReasons.length ? [`DEGRADED — ${brief.degradedReasons.join('; ')}`] : []),
    'GOAL KICKOFF EVIDENCE — REQUIRED BEFORE ANY PORTFOLIO MUTATION',
    `Before any portfolio mutation, successfully run ${GOAL_KICKOFF_REQUIRED_READS.join(', ')} against goal "${brief.goal.id}" and use those current reads to choose this pass’s actions.`,
    'This portfolio snapshot and its owner-report draft predate this pass’s actions; do not send them as the final report.',
    ...(mandatoryPlacement && mandatoryToolCall
      ? [
          'MANDATORY NEXT PLAN PLACEMENT',
          `${mandatoryPlacement.ref} is the highest-priority eligible worklist plan; placement=${mandatoryPlacement.placement.state}; repair=${mandatoryPlacement.placement.reconciliation.action}.`,
          'Before launching, YOU select the plan allocation: fleet count and leader/member model + effort from the live portfolio, executable plan dependencies, available goal headroom, budget, and owner settings. Record the decision and its rationale.',
          `Use ${mandatoryToolCall.tool} with this plan/leader identity: ${JSON.stringify(mandatoryToolCall.args)}. Add your chosen count and role configuration; these identity arguments are incomplete until you make that resource decision.`,
          'The separately launched fleet leader executes this allocation. It may request a change, but the GOAL steward owns plan priority, fleet size, and model choice.',
          'Do not claim its plan item from the GOAL session; the one-call fleet door owns promotion, admission, scheduler custody, and spawned leadership.',
        ]
      : []),
    'CURRENT ACTION PRIORITIES',
    priorities,
    'POST-ACTION OWNER REPORT — REQUIRED AFTER THE PASS ACTIONS',
    `After all selected actions have returned, fetch goals:get again for exact goal id "${brief.goal.id}". Send the report from that post-action response’s reporting.draft and use its assembledAt as the portfolio read time.`,
    'MOVED must include only actions with a successful result already returned, plus every goal-scoped work item that reached a terminal state after the previous report watermark. Do not report planned, queued, admission-pending, refused, or not-yet-run actions as moved.',
    'Read every named terminal artifact after its recorded update. If movement or killed evidence is truncated, degraded, or still unread, finish the missing reads or state the exact coverage gap.',
    'COST comes from the refreshed canonical spend evidence: preserve its figure, coverage, source, measured-at timestamp, and assembled/read-at timestamp. When refreshed evidence says coverage=measured, do not describe spend as unmeasured; when it is unknown or unmeasured, preserve that uncertainty and never infer zero.',
    `Only after that final refresh, send ${GOAL_OWNER_REPORT_HEADING_LIST} to ["human"] with coord:send or use coord:escalate, naming exact goal id "${brief.goal.id}".`,
    'This snapshot is orientation, not write authority: refresh the targeted canonical read immediately before each mutation.',
  ].join('\n');
}

/**
 * Assemble the authoritative GOAL portfolio projection. The launch-policy row is
 * supplied by resolveGoalLaunchForGoal so a holder launch does not re-read it;
 * coord:orient omits it and pays the same canonical read here.
 */
/**
 * Resolve closure for the plans that CLAIM to be finished (P-026 / D-012).
 *
 * The acceptance gate is dynamically imported so the portfolio read — which runs
 * on every GOAL `coord:orient` — does not pull it in for the common case where
 * no worklist plan is administratively complete.
 *
 * ⚠ A gate that THROWS yields an `unreadable` closure, never an absent one. The
 * difference decides the plan's placement: an unreadable closure keeps it at
 * `awaiting-closure`, whereas dropping the entry would hand `compileGoalPlanPlacement`
 * a `null` that reads the same as "never looked" — which is the same verdict, but
 * arrived at without recording that a measurement was attempted and failed.
 */
async function resolveWorklistClosures(
  slugs: readonly string[],
  degradedReasons: string[],
  scope: { workspaceId: string; sql: Sql; now?: Date },
): Promise<Map<string, PlanClosureVerdict>> {
  const closures = new Map<string, PlanClosureVerdict>();
  if (slugs.length === 0) return closures;

  const [{ readPlanClosureObservations, refreshPlanClosureObservations }, { resolvePlanClosure }] = await Promise.all([
    import('./goals/plan-closure-observations'),
    import('./goals/plan-closure'),
  ]);

  // D-032: this read serves the gate's PERSISTED verdict and never runs the gate
  // inline. A stale or absent verdict is `gate-not-evaluated` — the plan stays at
  // awaiting-closure, exactly as before it was measured — and a background
  // re-evaluation refreshes it. That is an expected transition, not a degraded read.
  let observations: Awaited<ReturnType<typeof readPlanClosureObservations>>;
  try {
    observations = await readPlanClosureObservations({ workspaceId: scope.workspaceId, planSlugs: slugs, sql: scope.sql, now: scope.now });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    for (const planSlug of slugs) {
      degradedReasons.push(`closure read failed for ${planSlug}: ${detail}`);
      closures.set(
        planSlug,
        resolvePlanClosure({ planSlug, status: 'unreadable', failure: { code: 'gate-unreadable', detail } }),
      );
    }
    return closures;
  }
  const refresh: string[] = [];
  for (const planSlug of slugs) {
    const observation = observations.get(planSlug);
    if (observation?.status === 'fresh') {
      closures.set(planSlug, resolvePlanClosure({ planSlug, status: 'read', gate: observation.gate }));
      continue;
    }
    const detail = observation?.detail ?? `no closure observation was read for '${planSlug}'`;
    if (observation?.status !== 'ambiguous') refresh.push(planSlug);
    closures.set(
      planSlug,
      resolvePlanClosure({ planSlug, status: 'unreadable', failure: { code: 'gate-not-evaluated', detail } }),
    );
  }
  refreshPlanClosureObservations(refresh);
  return closures;
}

/**
 * The claim-floor stage of a portfolio read. `assembleGoalPortfolioBrief` always
 * returns the UNCOUNTED snapshot and records here what counting needs, so the
 * count can run after the snapshot is already delivered (EI-25191349922959563).
 */
interface GoalPortfolioClaimStage {
  /** False when the queue had no issue candidates (claimable is already a measured 0). */
  countable: boolean;
  claimCandidates: Array<{ id: string; harness: string }>;
  /** Rebuilds the priority list with a measured claimable count. */
  buildPriorities: ((claimable: number | null) => string[]) | null;
}

type ReadGoalPortfolioArgs = Parameters<typeof assembleGoalPortfolioBrief>[0];

async function countGoalPortfolioClaimability(
  brief: GoalPortfolioBrief,
  stage: GoalPortfolioClaimStage,
): Promise<GoalPortfolioBrief> {
  if (!stage.countable) return brief;
  const reasons = [...brief.degradedReasons];
  let claimable: number | null = null;
  let claimabilityScope: GoalPortfolioBrief['queue']['claimabilityScope'] = 'unknown';
  try {
    const { explainIssueClaimFloors } = await import('./work-items');
    const byHarness = new Map<string, string[]>();
    for (const { id, harness } of stage.claimCandidates) byHarness.set(harness, [...(byHarness.get(harness) ?? []), id]);
    const admissible = await Promise.all(
      [...byHarness].map(async ([harness, ids]) =>
        (await explainIssueClaimFloors(harness, ids)).filter((floor) => floor.admissible).length),
    );
    claimable = admissible.reduce((sum, count) => sum + count, 0);
    claimabilityScope = 'issue-family';
  } catch (error) {
    reasons.push(`goal-scoped claimability unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    ...brief,
    queue: { ...brief.queue, claimable, claimabilityScope },
    priorities: stage.buildPriorities ? stage.buildPriorities(claimable) : brief.priorities,
    degradedReasons: [...new Set(reasons)],
  };
}

/**
 * One portfolio snapshot, delivered in two stages. `snapshot` is the brief WITHOUT
 * the per-id claim-floor count (claimabilityScope 'not-requested'); `counted` is
 * the same snapshot with `queue.claimable` measured over the same candidate rows.
 * A caller that needs one consistent snapshot for both an obligation fold (which
 * never reads queue.claimable and runs under AGENT_OBLIGATION_OPTIONAL_READ_TIMEOUT_MS)
 * and a display fold must use this instead of sharing one counted read: the count
 * alone took ~0.9s on goal 60d3a8 and timed the obligation fold out every wake
 * (EI-25191349922959563).
 */
export function readGoalPortfolioBriefStaged(args: Omit<ReadGoalPortfolioArgs, 'claimability'>): {
  snapshot: Promise<GoalPortfolioBrief | null>;
  counted: Promise<GoalPortfolioBrief | null>;
} {
  const stage: GoalPortfolioClaimStage = { countable: false, claimCandidates: [], buildPriorities: null };
  const assembled = assembleGoalPortfolioBrief(args, stage);
  const snapshot = assembled;
  const counted = assembled.then((brief) => (brief ? countGoalPortfolioClaimability(brief, stage) : null));
  // Either stage may go unread; a rejection must never surface as unhandled.
  void snapshot.catch(() => undefined);
  void counted.catch(() => undefined);
  return { snapshot, counted };
}

export async function readGoalPortfolioBrief(args: ReadGoalPortfolioArgs): Promise<GoalPortfolioBrief | null> {
  const stage: GoalPortfolioClaimStage = { countable: false, claimCandidates: [], buildPriorities: null };
  const brief = await assembleGoalPortfolioBrief(args, stage);
  if (!brief || args.claimability === 'skip') return brief;
  return countGoalPortfolioClaimability(brief, stage);
}

async function assembleGoalPortfolioBrief(args: {
  workspaceId: string;
  goalId: string;
  /** Only attest the elected holder when composing that holder's orient. */
  attestOwnerId?: string;
  sql?: Sql;
  now?: Date;
  /** Exact full-artifact reads from the caller's current session, never inferred from this projection. */
  reportArtifactReads?: GoalOwnerReportDraftInput['artifactReads'];
  /**
   * 'skip' omits the per-id claim-floor count behind `queue.claimable`. That
   * count scales with the goal's open issue rows (333 on 60d3a8 cost ~1.1s)
   * and alone pushed this read past the obligation reader's 900ms budget, so
   * a caller that never reads the count must not pay for it. Default 'count'.
   */
  claimability?: 'count' | 'skip';
  launch?: {
    goalBrief: GoalLaunchBrief;
    settings: GoalLaunchSettings | null;
    budget: GoalBudgetTruth | null;
    ceilings: { maxAgents: number | null; maxPerFleet: number | null };
    headcount: GoalHeadcount;
    degradedReasons?: string[];
  };
}, stage: GoalPortfolioClaimStage): Promise<GoalPortfolioBrief | null> {
  const degradedReasons = [...(args.launch?.degradedReasons ?? [])];
  let launch = args.launch;
  if (!launch) {
    const policy = await readGoalLaunchSettings(args.goalId, args.sql);
    if (!policy.brief) return null;
    if (policy.error) degradedReasons.push(`launch policy read degraded: ${policy.error}`);
    const ceilings = {
      maxAgents: resolveCeiling(policy.settings?.maxAgents, GOAL_LAUNCH_DEFAULTS.maxAgents),
      maxPerFleet: resolveCeiling(policy.settings?.maxPerFleet, GOAL_LAUNCH_DEFAULTS.maxPerFleet),
    };
    const counted = await goalHeadcount({
      workspaceId: args.workspaceId,
      goalId: args.goalId,
      fleetSlug: policy.drainFleetSlug,
      sql: args.sql,
    });
    if (counted.error) degradedReasons.push(`headcount degraded: ${counted.error}`);
    launch = {
      goalBrief: policy.brief,
      settings: policy.settings,
      budget: policy.budget,
      ceilings,
      headcount: counted.headcount,
    };
  }
  const sql = pg(args.sql);
  let liveHolderOwnerIds: string[] = [];
  let goalHolderOwnerIds: string[] | null = null;
  let holderAttestation: GoalHolderFirstTurnAttestation | null = null;
  let reportCadence: GoalOwnerReportObligation | null = null;
  try {
    // A durable GOAL mode row is not evidence that its session is still alive.
    // Reuse the canonical holder+liveness fold before attributing current
    // reports or Blender work; otherwise a dead holder's stale row keeps both
    // counters attached to it indefinitely.
    const { resolveGoalHolders } = await import('./goals/holder');
    const holders = await resolveGoalHolders(sql, {
      workspaceId: args.workspaceId,
      goalId: args.goalId,
    });
    liveHolderOwnerIds = holders.live.map((holder) => holder.ownerId);
    // Independence uses the elected identity even if its liveness is unknown;
    // presence is not authority. A failed read remains null, not a known empty set.
    goalHolderOwnerIds = holders.elected ? [holders.elected.ownerId] : [];
    if (args.attestOwnerId) {
      const { readGoalHolderFirstTurnAttestation } = await import('./goals/holder-attestation');
      holderAttestation = await readGoalHolderFirstTurnAttestation(sql, {
        workspaceId: args.workspaceId,
        goalId: args.goalId,
        holder: holders.elected?.ownerId === args.attestOwnerId ? holders.elected : null,
      });
    }
    if (holders.liveness === 'unknown') {
      degradedReasons.push(
        'goal holder liveness unavailable; holder-scoped report and Blender counts may be incomplete',
      );
    }
  } catch (error) {
    degradedReasons.push(`goal holder liveness read failed: ${error instanceof Error ? error.message : String(error)}`);
    if (args.attestOwnerId) {
      holderAttestation = {
        status: 'unknown', workspaceId: args.workspaceId, goalId: args.goalId,
        ownerId: args.attestOwnerId, modeSetAt: null, loopActive: null,
        checkpointAt: null, portfolioAct: null, missing: [],
        unavailable: ['goal-declaration'],
      };
    }
  }
  if (goalHolderOwnerIds?.[0]) {
    try {
      // The watchdog's exact three-rail, goal-stamped predicate is the cadence
      // authority. An arbitrary escalation or attention ping is not a report.
      const { readGoalOwnerReportObligation } = await import('./system-health/goal-owner-report-watchdog');
      reportCadence = await readGoalOwnerReportObligation(sql, {
        workspaceId: args.workspaceId, goalId: args.goalId, ownerId: goalHolderOwnerIds[0],
      }, (args.now ?? new Date()).getTime());
    } catch (error) {
      degradedReasons.push(`goal owner report cadence read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const reportCutoffMs = reportCadence?.lastReportAt
    ? Date.parse(reportCadence.lastReportAt)
    : (args.now ?? new Date()).getTime();
  const killCutoffMs = reportCadence?.lastReportAt ? reportCutoffMs : 0;
  try {
    const rows = await sql<GoalPortfolioSourceRow[]>`
      WITH goal_row AS (
        SELECT * FROM harness_shared.goals
         WHERE workspace_id = ${args.workspaceId} AND id = ${args.goalId}
         LIMIT 1
      )
      SELECT g.status, g.parent_id, g.tripwires, g.properties, g.metadata,
             (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'id', gp.id, 'harness', gp.harness_slug, 'role', gp.role,
                       'note', gp.note, 'killCriterion', gp.kill_criterion
                     ) ORDER BY (gp.role = 'owner') DESC, gp.added_at), '[]'::jsonb)
                FROM harness_shared.goal_pots gp
               WHERE gp.workspace_id = g.workspace_id AND gp.goal_id = g.id AND gp.removed_at IS NULL) AS pots,
             (SELECT COALESCE(jsonb_agg(plan_row ORDER BY (plan_row->>'ordinal')::int), '[]'::jsonb)
                FROM (
                  SELECT jsonb_build_object(
                           'ref', wr.ref, 'ordinal', wr.ordinality,
                           'harness', p.harness_slug,
                           'slug', regexp_replace(wr.ref, '^plan:(?:[^/]+/)?', ''),
                           'title', p.title, 'status', COALESCE(p.op_status, p.status),
                           'goalId', p.goal_id,
                           'ambiguousMatches', (
                             SELECT count(*) FROM harness_shared.harness_plans matches
                              WHERE matches.workspace_id = g.workspace_id
                                AND matches.plan_slug = regexp_replace(wr.ref, '^plan:(?:[^/]+/)?', '')
                           ),
                           'items', COALESCE((
                             SELECT jsonb_agg(jsonb_build_object(
                                      'id', pi.item_id, 'text', pi.item_text, 'status', pi.status,
                                      'phase', pi.phase, 'blockedBy', pi.blocked_by, 'seq', pi.seq
                                    ) ORDER BY pi.seq)
                               FROM harness_shared.plan_items pi
                              WHERE pi.workspace_id = p.workspace_id
                                AND pi.harness_slug = p.harness_slug
                                AND pi.plan_slug = p.plan_slug
                           ), '[]'::jsonb),
                           'placement', jsonb_build_object(
                             'goalHolderOwnerIds', ${goalHolderOwnerIds}::text[],
                             'claims', COALESCE((
                               SELECT jsonb_agg(jsonb_build_object(
                                        'itemId', pic.item_id,
                                        'ownerId', pic.owner,
                                        'expiresAt', pic.expires_ts,
                                        'workItemId', (
                                          SELECT wi.feature_id FROM harness_shared.work_items wi
                                           WHERE wi.workspace_id = g.workspace_id
                                             AND wi.harness_slug = p.harness_slug
                                             AND wi.taken_by = pic.owner
                                             AND wi.status <> ALL(ARRAY['done','passed','resolved','closed','deprecated','dropped']::text[])
                                             AND COALESCE(wi.source_plan_slug, wi.payload->'plan_item'->>'plan_slug') = p.plan_slug
                                             AND (CASE WHEN wi.source_plan_item_ids IS NOT NULL
                                               THEN pic.item_id = ANY(wi.source_plan_item_ids)
                                               ELSE wi.payload->'plan_item'->>'item_id' = pic.item_id END)
                                           ORDER BY wi.feature_id LIMIT 1
                                        ),
                                        'fleetSlug', claim_presence.fleet_slug,
                                        'holderLive', claim_presence.heartbeat_at >= now() - interval '10 minutes'
                                      ) ORDER BY pic.item_id)
                                 FROM harness_shared.plan_item_claims pic
                                 LEFT JOIN LATERAL (
                                   SELECT cp.fleet_slug, cp.heartbeat_at
                                     FROM harness_shared.coord_presence cp
                                    WHERE cp.workspace_id = ANY(ARRAY[g.workspace_id, 'default', '*']::text[])
                                      AND cp.owner_id = pic.owner
                                    ORDER BY cp.heartbeat_at DESC
                                    LIMIT 1
                                 ) claim_presence ON true
                                WHERE pic.workspace_id = ANY(ARRAY[g.workspace_id, 'default', '*']::text[])
                                  AND pic.harness_slug = p.harness_slug
                                  AND pic.plan_slug = p.plan_slug
                                  AND pic.expires_ts > now()
                             ), '[]'::jsonb),
                             'fleet', (
                               SELECT jsonb_build_object(
                                        'slug', af.fleet_slug,
                                        'controlState', af.control_state,
                                        'leaderOwnerId', af.leader_owner_id,
                                        'leaderLive', leader_presence.heartbeat_at >= now() - interval '10 minutes',
                                        'liveMembers', (
                                          SELECT count(DISTINCT member_presence.owner_id)
                                            FROM harness_shared.coord_presence member_presence
                                           WHERE member_presence.workspace_id = ANY(ARRAY[g.workspace_id, 'default', '*']::text[])
                                             AND member_presence.fleet_slug = af.fleet_slug
                                             AND member_presence.heartbeat_at >= now() - interval '10 minutes'
                                        ),
                                        'target', af.headcount_target,
                                        'claimSpec', (
                                          SELECT cs.spec FROM harness_shared.cup_claim_specs cs
                                           WHERE cs.workspace_id = g.workspace_id
                                             AND cs.bee_id = 'fleet:' || af.fleet_slug
                                           LIMIT 1
                                        ),
                                        'launchTransaction', af.last_launch_transaction
                                      )
                                 FROM harness_shared.agent_fleets af
                                 LEFT JOIN LATERAL (
                                   SELECT cp.heartbeat_at
                                     FROM harness_shared.coord_presence cp
                                    WHERE cp.workspace_id = ANY(ARRAY[g.workspace_id, 'default', '*']::text[])
                                      AND cp.owner_id = af.leader_owner_id
                                    ORDER BY cp.heartbeat_at DESC
                                    LIMIT 1
                                 ) leader_presence ON true
                                WHERE af.workspace_id = g.workspace_id
                                  AND (CASE jsonb_typeof(af.headcount_config)
                                         WHEN 'string' THEN (af.headcount_config #>> '{}')::jsonb
                                         ELSE af.headcount_config
                                       END)->>'plan' = p.plan_slug
                                  AND (CASE jsonb_typeof(af.headcount_config)
                                         WHEN 'string' THEN (af.headcount_config #>> '{}')::jsonb
                                         ELSE af.headcount_config
                                       END)->>'harness' = p.harness_slug
                                ORDER BY af.updated_at DESC
                                LIMIT 1
                             )
                           )
                         ) AS plan_row
                    FROM jsonb_array_elements_text(COALESCE(g.properties->'worklist'->'value', '[]'::jsonb))
                         WITH ORDINALITY AS wr(ref, ordinality)
                    LEFT JOIN LATERAL (
                      SELECT hp.* FROM harness_shared.harness_plans hp
                       WHERE hp.workspace_id = g.workspace_id
                         AND hp.plan_slug = regexp_replace(wr.ref, '^plan:(?:[^/]+/)?', '')
                         AND (
                           position('/' in regexp_replace(wr.ref, '^plan:', '')) = 0
                           OR hp.harness_slug = split_part(regexp_replace(wr.ref, '^plan:', ''), '/', 1)
                         )
                       ORDER BY hp.updated_at DESC NULLS LAST
                       LIMIT 1
                    ) p ON true
                ) plans) AS plans,
             (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'id', wi.feature_id, 'harness', wi.harness_slug,
                       'planSlug', wi.source_plan_slug, 'goalId', wi.goal_id,
                       'origin', wi.origin
                     ) ORDER BY wi.feature_id), '[]'::jsonb)
                FROM harness_shared.work_items wi
               WHERE wi.workspace_id = g.workspace_id
                 AND EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements_text(COALESCE(g.properties->'worklist'->'value', '[]'::jsonb)) wr(ref)
                    WHERE wi.source_plan_slug = regexp_replace(wr.ref, '^plan:(?:[^/]+/)?', '')
                      AND (
                        position('/' in regexp_replace(wr.ref, '^plan:', '')) = 0
                        OR wi.harness_slug = split_part(regexp_replace(wr.ref, '^plan:', ''), '/', 1)
                      )
                 )) AS ladder_work_items,
             (SELECT jsonb_build_object(
                       'total', count(*),
                       'terminal', count(*) FILTER (WHERE wi.status = ANY(ARRAY['done','passed','resolved','closed','deprecated','dropped']::text[])),
                       'inFlight', count(*) FILTER (WHERE wi.taken_by IS NOT NULL AND wi.status <> ALL(ARRAY['done','passed','resolved','closed','deprecated','dropped']::text[])),
                       'blocked', count(*) FILTER (WHERE wi.status IN ('blocked','cursed')),
                       'needsHuman', count(*) FILTER (WHERE wi.status <> ALL(ARRAY['done','passed','resolved','closed','deprecated','dropped']::text[])
                         AND (wi.status IN ('needs-human','needs_human')
                           OR wi.needs_human_review
                           OR COALESCE((wi.payload->>'needsOwnerAction')::boolean, false)
                           OR COALESCE((wi.payload->>'needsHuman')::boolean, false))),
                       'issueCandidates', COALESCE(jsonb_agg(jsonb_build_object('id', wi.feature_id, 'harness', wi.harness_slug))
                         FILTER (WHERE wi.item_kind IN ('bug','change','task') AND wi.taken_by IS NULL AND wi.status IN ('open','failing','todo')), '[]'::jsonb)
                     )
                FROM harness_shared.work_items wi
               WHERE wi.workspace_id = g.workspace_id AND wi.goal_id = g.id) AS queue,
             (SELECT jsonb_build_object(
                       'slug', af.fleet_slug, 'controlState', af.control_state,
                       'leaderOwnerId', af.leader_owner_id,
                       'live', count(cp.owner_id) FILTER (WHERE cp.heartbeat_at >= now() - interval '10 minutes'),
                       'working', count(cp.owner_id) FILTER (WHERE cp.heartbeat_at >= now() - interval '10 minutes' AND EXISTS (
                         SELECT 1 FROM harness_shared.work_items wi2 WHERE wi2.workspace_id = g.workspace_id AND wi2.goal_id = g.id AND wi2.taken_by = cp.owner_id
                       ))
                     )
                FROM harness_shared.agent_fleets af
                LEFT JOIN harness_shared.coord_presence cp
                  ON cp.workspace_id = af.workspace_id AND cp.fleet_slug = af.fleet_slug
               WHERE af.workspace_id = g.workspace_id AND af.fleet_slug = g.metadata->>'drainFleet'
               GROUP BY af.fleet_slug, af.control_state, af.leader_owner_id) AS drain_fleet,
             (SELECT jsonb_build_object(
                       'workItemId', wi3.feature_id, 'updatedAtMs', cn.updated_ts, 'note', cn.note
                     )
                FROM harness_shared.work_items wi3
                JOIN harness_shared.carry_notes cn
                  ON cn.workspace_id = wi3.workspace_id
                 AND cn.scope = 'workitem:' || COALESCE(NULLIF(wi3.harness_slug, ''), '*') || ':' || wi3.feature_id
               WHERE wi3.workspace_id = g.workspace_id AND wi3.goal_id = g.id
               ORDER BY cn.updated_ts DESC LIMIT 1) AS checkpoint,
             (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'ref', movement.ref, 'state', movement.state,
                       'updatedMs', movement.updated_ms) ORDER BY movement.updated_ms DESC), '[]'::jsonb)
                FROM (
                  SELECT 'plan:' || hp.harness_slug || '/' || hp.plan_slug AS ref,
                         COALESCE(hp.op_status, hp.status) AS state,
                         (extract(epoch FROM hp.updated_at) * 1000)::bigint AS updated_ms
                    FROM harness_shared.harness_plans hp
                   WHERE hp.workspace_id = g.workspace_id AND hp.goal_id = g.id
                     AND hp.updated_at IS NOT NULL
                     AND (extract(epoch FROM hp.updated_at) * 1000)::bigint > ${reportCutoffMs}
                     AND EXISTS (
                       SELECT 1 FROM jsonb_array_elements_text(COALESCE(g.properties->'worklist'->'value', '[]'::jsonb)) wr(ref)
                        WHERE hp.plan_slug = regexp_replace(wr.ref, '^plan:(?:[^/]+/)?', '')
                          AND (position('/' in regexp_replace(wr.ref, '^plan:', '')) = 0
                            OR hp.harness_slug = split_part(regexp_replace(wr.ref, '^plan:', ''), '/', 1))
                     )
                  UNION ALL
                  SELECT 'work-item:' || wi.feature_id, wi.status, wi.updated_ts
                    FROM harness_shared.work_items wi
                   WHERE wi.workspace_id = g.workspace_id AND wi.goal_id = g.id
                     AND wi.updated_ts > ${reportCutoffMs}
                   ORDER BY updated_ms DESC LIMIT 101
                ) movement) AS report_movements,
             (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'ref', wall.feature_id,
                       -- P-005: the owner ask lives on the set_blocker record for every
                       -- live wall; ownerAction/ownerAsk alone left all of them unnamed.
                       'action', COALESCE(${ownerWallActionSql(sql)}, 'open this work item for the exact owner action'))
                       ORDER BY wall.feature_id), '[]'::jsonb)
               FROM harness_shared.work_items wall
               WHERE wall.workspace_id = g.workspace_id AND wall.goal_id = g.id
                 AND ${openOwnerWallPredicateSql(sql)}) AS owner_walls,
             (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'ref', stopped.ref, 'criterion', stopped.criterion,
                       'atMs', stopped.at_ms) ORDER BY stopped.at_ms DESC), '[]'::jsonb)
                FROM (
                  SELECT 'pot:' || gp.harness_slug AS ref, gp.kill_criterion AS criterion,
                         (extract(epoch FROM gp.removed_at) * 1000)::bigint AS at_ms
                    FROM harness_shared.goal_pots gp
                   WHERE gp.workspace_id = g.workspace_id AND gp.goal_id = g.id
                     AND gp.removed_at IS NOT NULL
                     AND (extract(epoch FROM gp.removed_at) * 1000)::bigint > ${killCutoffMs}
                  UNION ALL
                  SELECT 'work-item:' || wi.feature_id, wi.deprecation_reason,
                         COALESCE(wi.closed_ts, wi.updated_ts)
                    FROM harness_shared.work_items wi
                   WHERE wi.workspace_id = g.workspace_id AND wi.goal_id = g.id
                     AND wi.status IN ('dropped', 'deprecated', 'closed')
                     AND COALESCE(wi.closed_ts, wi.updated_ts) > ${killCutoffMs}
                   ORDER BY at_ms DESC LIMIT 101
                ) stopped) AS killed_work,
             (SELECT count(*) FROM harness_shared.scout_routed_ideas sri
               WHERE sri.workspace_id = g.workspace_id AND sri.origin = 'su-ideate'
                 AND sri.created_by = ANY(${liveHolderOwnerIds}::text[])
                 AND (sri.outcome IS NULL OR sri.outcome = 'pending')) AS blender_pending,
             (SELECT jsonb_build_object(
                       'id', hp.plan_slug, 'status', hp.status,
                       'latestScorecardAt', (
                         SELECT to_char(max(sc.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                           FROM harness_shared.engineer_issues sc
                          WHERE sc.workspace_id = g.workspace_id
                            AND sc.payload->'observation'->>'rubricRef' = hp.plan_slug
                            AND sc.payload->'observation'->'subject'->>'ref' = g.id
                       )
                     )
                FROM harness_shared.harness_plans hp
               WHERE hp.workspace_id = g.workspace_id AND hp.template = 'rubric'
                 AND hp.template_slug IS NULL
                 AND hp.template_data->>'kind' = 'acceptance'
                 AND hp.template_data->>'subjectGoal' = g.id
               ORDER BY hp.updated_at DESC LIMIT 1) AS acceptance_rubric
        FROM goal_row g`;
    const row = rows[0];
    if (!row) return null;

    const queueRaw = portfolioObject(row.queue) ?? {};
    const candidates = portfolioArray(queueRaw.issueCandidates)
      .map(portfolioObject)
      .filter((candidate): candidate is Record<string, unknown> => candidate !== null);
    // The per-id claim-floor count is NOT run here: it is the slow stage
    // (EI-25191349922959563) and runs afterwards in countGoalPortfolioClaimability
    // over exactly these candidate rows, so a staged caller can deliver this
    // snapshot first. Until counted, a non-empty queue reads 'not-requested'.
    const claimable: number | null = candidates.length === 0 ? 0 : null;
    const claimabilityScope: GoalPortfolioBrief['queue']['claimabilityScope'] =
      candidates.length === 0 ? 'none' : 'not-requested';
    stage.countable = candidates.length > 0;
    stage.claimCandidates = candidates.flatMap((candidate) => {
      const id = portfolioString(candidate.id);
      const harness = portfolioString(candidate.harness);
      return id && harness ? [{ id, harness }] : [];
    });

    const assembledAt = args.now ?? new Date();
    // TWO PASSES (P-026 / D-012). The first compiles placement with no closure
    // evidence, which parks every administratively-complete plan at
    // `awaiting-closure`. The second resolves closure for exactly those plans —
    // the at-risk set, and nothing else — and recompiles. Cost is therefore
    // proportional to plans that CLAIM to be finished, not to the worklist.
    const firstPass = parsePortfolioWorklist(row.plans, assembledAt);
    const closures = await resolveWorklistClosures(
      firstPass.filter((plan) => plan.placement.state === 'awaiting-closure').map((plan) => plan.slug),
      degradedReasons,
      { workspaceId: args.workspaceId, sql, now: args.now },
    );
    const worklist = closures.size > 0 ? parsePortfolioWorklist(row.plans, assembledAt, closures) : firstPass;
    for (const plan of worklist) {
      if (!plan.title) degradedReasons.push(`worklist ref ${plan.ref} does not resolve`);
      if (plan.ambiguousMatches > 1 && !plan.ref.slice('plan:'.length).includes('/')) {
        degradedReasons.push(`worklist ref ${plan.ref} is ambiguous across ${plan.ambiguousMatches} harnesses`);
      }
    }
    const pots = portfolioArray(row.pots).flatMap((value) => {
      const pot = portfolioObject(value);
      const harness = portfolioString(pot?.harness);
      if (!pot || !harness) return [];
      return [
        {
          harness,
          role: pot.role === 'owner' ? ('owner' as const) : ('contributing' as const),
          note: portfolioString(pot.note),
          killCriterion: portfolioString(pot.killCriterion),
          linkId: pot.id == null ? null : String(pot.id),
        },
      ];
    });
    const fleetRaw = portfolioObject(row.drain_fleet);
    const declaredFleet = portfolioString(portfolioObject(row.metadata)?.drainFleet);
    const checkpointRaw = portfolioObject(row.checkpoint);
    const rubricRaw = portfolioObject(row.acceptance_rubric);
    const tripwires = portfolioArray(row.tripwires).flatMap((value) => {
      const tripwire = portfolioObject(value);
      const metric = portfolioString(tripwire?.metric);
      if (!tripwire || !metric) return [];
      return [
        {
          metric,
          ...(portfolioString(tripwire.label) ? { label: portfolioString(tripwire.label)! } : {}),
          ...(tripwire.threshold != null ? { threshold: portfolioNumber(tripwire.threshold) } : {}),
          ...(tripwire.current != null ? { current: portfolioNumber(tripwire.current) } : {}),
          ...(portfolioString(tripwire.unit) ? { unit: portfolioString(tripwire.unit)! } : {}),
        },
      ];
    });
    const operatingInputs = evaluateGoalOperatingInputs({
      standing: launch.goalBrief.standing,
      killCriterion: launch.goalBrief.killCriterion,
      budgetCents: launch.budget?.budgetCents ?? launch.goalBrief.budgetCents,
      budgetWindowSec: launch.goalBrief.budgetWindowSec,
      spentCents: launch.budget?.spentCents ?? null,
      spentCentsSource: launch.budget?.spentCentsSource ?? null,
      unmeasuredPricedSpend: launch.budget?.unmeasuredPricedSpend ?? false,
      tripwires,
    });
    const reportMovementRows = portfolioArray(row.report_movements);
    const movementTruncated = reportMovementRows.length > 100;
    if (movementTruncated) degradedReasons.push('owner report movement list exceeds 100 records; read the remaining records before claiming complete coverage');
    const reportIso = (value: unknown): string | null => {
      const ms = portfolioNumber(value);
      return ms > 0 && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    };
    const movements: GoalOwnerReportDraftInput['movements'] = reportMovementRows.slice(0, 100).flatMap((value) => {
      const movement = portfolioObject(value);
      const ref = portfolioString(movement?.ref);
      const state = portfolioString(movement?.state);
      const updatedAt = reportIso(movement?.updatedMs);
      return ref && state && updatedAt
        ? [{ ref, state, updatedAt, artifact: { ref, updatedAt } }]
        : [];
    });
    const ownerWalls: GoalOwnerReportDraftInput['ownerWalls'] = portfolioArray(row.owner_walls).flatMap((value) => {
      const wall = portfolioObject(value);
      const ref = portfolioString(wall?.ref);
      return ref ? [{ ref: `work-item:${ref}`, action: portfolioString(wall?.action) ?? 'open this work item for the exact owner action' }] : [];
    });
    const killedRows = portfolioArray(row.killed_work);
    const killedTruncated = killedRows.length > 100;
    const killed: GoalOwnerReportDraftInput['killed'] = killedRows.slice(0, 100).flatMap((value) => {
      const stopped = portfolioObject(value);
      const ref = portfolioString(stopped?.ref);
      const at = reportIso(stopped?.atMs);
      return ref && at ? [{ ref, criterion: portfolioString(stopped?.criterion), at }] : [];
    });
    if (killedTruncated) degradedReasons.push('owner report killed-work list exceeds 100 records; read the remaining records before claiming complete coverage');
    const reportDraft = buildGoalOwnerReportDraft({
      goalId: args.goalId,
      observedAt: assembledAt.toISOString(),
      previousReportAt: reportCadence?.lastReportAt ?? null,
      movements,
      cost: {
        spentCents: launch.budget?.spentCents ?? null,
        budgetCents: launch.budget?.budgetCents ?? launch.goalBrief.budgetCents,
        source: launch.budget?.spentCentsSource ?? null,
        coverage: operatingInputs.spendCoverage,
        measuredAt: launch.budget?.spentCentsAt ?? null,
        unmeasuredPricedSpend: launch.budget?.unmeasuredPricedSpend ?? false,
      },
      ownerWalls,
      killed,
      artifactReads: args.reportArtifactReads ?? [],
      movementTruncated,
      killedTruncated,
    });
    const queue = {
      total: portfolioNumber(queueRaw.total),
      terminal: portfolioNumber(queueRaw.terminal),
      inFlight: portfolioNumber(queueRaw.inFlight),
      blocked: portfolioNumber(queueRaw.blocked),
      needsHuman: portfolioNumber(queueRaw.needsHuman),
      claimable,
      claimabilityScope,
    };
    const attribution = evaluateGoalLadderHealth({
      goalId: args.goalId,
      pots,
      plans: portfolioArray(row.plans).flatMap((value) => {
        const plan = portfolioObject(value);
        const ref = portfolioString(plan?.ref);
        if (!plan || !ref) return [];
        return [{ ref, harness: portfolioString(plan.harness),
          goalId: portfolioString(plan.goalId), exists: Boolean(portfolioString(plan.title)) }];
      }),
      workItems: portfolioArray(row.ladder_work_items).flatMap((value) => {
        const item = portfolioObject(value);
        const id = portfolioString(item?.id);
        if (!item || !id) return [];
        return [{ id, harness: portfolioString(item.harness),
          planSlug: portfolioString(item.planSlug), goalId: portfolioString(item.goalId),
          origin: portfolioString(item.origin) }];
      }),
    });
    const buildPriorities = (claimableCount: number | null): string[] => {
    const priorities: string[] = [];
    if (attribution.status !== 'healthy') {
      priorities.push(`Repair attribution ladder: ${attribution.issues.map((issue) => `${issue.code}(${issue.ref})`).join(', ')}.`);
    }
    if (operatingInputs.status !== 'ready') {
      priorities.push(`Repair goal operating inputs: ${operatingInputs.issues.map((issue) => issue.code).join(', ')}.`);
    }
    if (!declaredFleet) priorities.push('Declare and delegate the standing drain fleet.');
    else if (!fleetRaw || portfolioNumber(fleetRaw.live) === 0)
      priorities.push(`Restore delegated leadership and live coverage for drain fleet ${declaredFleet}.`);
    if (queue.needsHuman > 0) priorities.push(`Report ${queue.needsHuman} owner-walled queue item(s) with exact asks.`);
    const executablePlacement = worklist.find((plan) => plan.placement.reconciliation.toolCall !== null);
    const repairPlan =
      executablePlacement ?? worklist.find((plan) => plan.placement.reconciliation.action !== 'none');
    if (repairPlan) priorities.push(`Reconcile ${repairPlan.ref}: ${repairPlan.placement.reconciliation.reason}`);
    if ((claimableCount ?? 0) > 0)
      priorities.push(`Place ${claimableCount} goal-scoped claimable issue(s) without implementing them yourself.`);
    if (queue.blocked > 0)
      priorities.push(`Triage ${queue.blocked} blocked/cursed queue item(s) and remove stranded blockers.`);
    if (portfolioNumber(row.blender_pending) > 0)
      priorities.push(`Grade or route ${portfolioNumber(row.blender_pending)} pending Blender idea(s).`);
    if (priorities.length === 0)
      priorities.push('Refresh the worklist and queue, then continue supervision; do not self-implement.');
    return priorities.slice(0, 6);
    };
    stage.buildPriorities = buildPriorities;

    return {
      schemaVersion: 1,
      assembledAt: assembledAt.toISOString(),
      goal: {
        id: args.goalId,
        title: launch.goalBrief.title,
        status: portfolioString(row.status),
        body: launch.goalBrief.body,
        killCriterion: launch.goalBrief.killCriterion,
        standing: launch.goalBrief.standing,
        parentId: portfolioString(row.parent_id),
      },
      worklist,
      pots,
      attribution,
      drainFleet: {
        slug: declaredFleet,
        exists: declaredFleet ? Boolean(fleetRaw) : null,
        controlState: portfolioString(fleetRaw?.controlState),
        leaderOwnerId: portfolioString(fleetRaw?.leaderOwnerId),
        live: fleetRaw ? portfolioNumber(fleetRaw.live) : null,
        working: fleetRaw ? portfolioNumber(fleetRaw.working) : null,
      },
      queue,
      launch: { settings: launch.settings, intendedParallelPlanFleets: launch.settings?.intendedParallelPlanFleets ?? null, ceilings: launch.ceilings, headcount: launch.headcount },
      budget: {
        budgetCents: launch.budget?.budgetCents ?? launch.goalBrief.budgetCents,
        spentCents: launch.budget?.spentCents ?? null,
        // WI-10002052: the unmeasured-spend signal travels WITH the cents. Drop
        // it here and a consumer of this brief reads `undefined` — falsy, and so
        // silently back to the fail-open reading this change exists to remove.
        unmeasuredPricedSpend: launch.budget?.unmeasuredPricedSpend ?? false,
        spentCentsAt: launch.budget?.spentCentsAt ?? null,
        spentCentsSource: launch.budget?.spentCentsSource ?? null,
        interactiveUsageFreshnessStatus: launch.budget?.interactiveUsageFreshnessStatus ?? null,
        interactiveUsageLastIngestedAtMs: launch.budget?.interactiveUsageLastIngestedAtMs ?? null,
        budgetWindowSec: launch.goalBrief.budgetWindowSec,
      },
      tripwires,
      operatingInputs,
      pending: {
        blenderIdeas: row.blender_pending == null ? null : portfolioNumber(row.blender_pending),
        acceptanceRubric:
          rubricRaw && portfolioString(rubricRaw.id)
            ? {
                id: portfolioString(rubricRaw.id)!,
                status: portfolioString(rubricRaw.status),
                latestScorecardAt: portfolioString(rubricRaw.latestScorecardAt),
              }
            : null,
      },
      continuity: {
        checkpoint:
          checkpointRaw && portfolioString(checkpointRaw.workItemId)
            ? {
                workItemId: portfolioString(checkpointRaw.workItemId)!,
                updatedAt: new Date(portfolioNumber(checkpointRaw.updatedAtMs)).toISOString(),
                note: portfolioString(checkpointRaw.note) ?? '',
              }
            : null,
        lastOwnerReportAt: reportCadence?.lastReportAt ?? null,
      },
      reporting: { cadence: reportCadence, draft: reportDraft, movementTruncated, killedTruncated },
      ...(args.attestOwnerId ? { holderAttestation } : {}),
      priorities: buildPriorities(claimable),
      degradedReasons: [...new Set(degradedReasons)],
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      assembledAt: (args.now ?? new Date()).toISOString(),
      goal: {
        id: args.goalId,
        title: launch.goalBrief.title,
        status: null,
        body: launch.goalBrief.body,
        killCriterion: launch.goalBrief.killCriterion,
        standing: launch.goalBrief.standing,
        parentId: null,
      },
      worklist: [],
      pots: [],
      attribution: evaluateGoalLadderHealth({ goalId: args.goalId, pots: [], plans: [], workItems: [], unreadable: true }),
      drainFleet: { slug: null, exists: null, controlState: null, leaderOwnerId: null, live: null, working: null },
      queue: {
        total: 0,
        terminal: 0,
        inFlight: 0,
        blocked: 0,
        needsHuman: 0,
        claimable: null,
        claimabilityScope: 'unknown',
      },
      launch: { settings: launch.settings, intendedParallelPlanFleets: launch.settings?.intendedParallelPlanFleets ?? null, ceilings: launch.ceilings, headcount: launch.headcount },
      budget: {
        budgetCents: launch.budget?.budgetCents ?? launch.goalBrief.budgetCents,
        spentCents: launch.budget?.spentCents ?? null,
        // WI-10002052: the unmeasured-spend signal travels WITH the cents. Drop
        // it here and a consumer of this brief reads `undefined` — falsy, and so
        // silently back to the fail-open reading this change exists to remove.
        unmeasuredPricedSpend: launch.budget?.unmeasuredPricedSpend ?? false,
        spentCentsAt: launch.budget?.spentCentsAt ?? null,
        spentCentsSource: launch.budget?.spentCentsSource ?? null,
        interactiveUsageFreshnessStatus: launch.budget?.interactiveUsageFreshnessStatus ?? null,
        interactiveUsageLastIngestedAtMs: launch.budget?.interactiveUsageLastIngestedAtMs ?? null,
        budgetWindowSec: launch.goalBrief.budgetWindowSec,
      },
      tripwires: [],
      operatingInputs: evaluateGoalOperatingInputs({
        standing: launch.goalBrief.standing,
        killCriterion: launch.goalBrief.killCriterion,
        budgetCents: launch.budget?.budgetCents ?? launch.goalBrief.budgetCents,
        budgetWindowSec: launch.goalBrief.budgetWindowSec,
        spentCents: launch.budget?.spentCents ?? null,
        spentCentsSource: launch.budget?.spentCentsSource ?? null,
        unmeasuredPricedSpend: launch.budget?.unmeasuredPricedSpend ?? false,
        tripwires: null,
        portfolioReadFailed: true,
      }),
      pending: { blenderIdeas: null, acceptanceRubric: null },
      continuity: { checkpoint: null, lastOwnerReportAt: null },
      ...(args.attestOwnerId ? { holderAttestation } : {}),
      priorities: ['Re-read the goal portfolio before any placement or write.'],
      degradedReasons: [
        ...new Set([
          ...degradedReasons,
          `portfolio read failed: ${error instanceof Error ? error.message : String(error)}`,
        ]),
      ],
    };
  }
}

/**
 * The goal-owned fields needed to brief a freshly launched holder.
 *
 * This rides the SAME row read as launch settings and budget truth. A holder
 * launch already pays for that read, and keeping the brief there prevents a
 * recovery caller from opening a generic AUTO session before the later GOAL
 * attachment tells it which goal it owns (EI-21640746714079700).
 */
export interface GoalLaunchBrief {
  title: string;
  body: string | null;
  killCriterion: string | null;
  budgetCents: number | null;
  budgetWindowSec: number | null;
  standing: boolean;
  /** P-012: the same authoritative snapshot coord:orient folds on every wake. */
  portfolio?: GoalPortfolioBrief | null;
}

export interface GoalLaunchResolution {
  /** The goal this launch serves, resolved from the LAUNCHER (D-008). Null = no goal in scope. */
  goalId: string | null;
  settings: GoalLaunchSettings | null;
  /** Canonical source fields for the holder's first-turn brief. */
  goalBrief: GoalLaunchBrief | null;
  /** Holder-only P-015 gate; descendants never inherit this start requirement. */
  holderReadiness?: GoalOperatingInputs | null;
  /** Merged profile: caller request > per-role > goal defaults. Absent keys stay absent. */
  effective: LaunchProfile;
  ceilings: { maxAgents: number | null; maxPerFleet: number | null };
  headcount: GoalHeadcount;
  /** The exact count used for admission, including owners and boot-grace rows. Never re-read after spawn. */
  headcountMeasurement?: GoalHeadcountMeasurement | null;
  /** P-006: the goal's budget ceiling + platform spend snapshot. Null = no goal in scope. */
  budget: GoalBudgetTruth | null;
  /** Non-null when this launch would breach a ceiling. The caller MUST NOT launch. */
  refusal: GoalLaunchRefusal | null;
  /** True when a ceiling could not be read or counted, so it was NOT enforced. */
  degraded: boolean;
  degradedReasons: string[];
}

export interface ParsedGoalLaunchSettings {
  /** The document with every KNOWN key in force; null only when it is truly invalid or absent. */
  settings: GoalLaunchSettings | null;
  /** Non-null ⇒ `settings` is null and NOTHING the owner declared is in force. */
  error: string | null;
  /**
   * WI-2140573: dotted paths of keys the strict schema did not recognise, which
   * the lenient READ stripped before re-parsing (`roles.goal.contextSize`).
   * Non-empty with `settings` non-null means every OTHER key IS in force and the
   * caller must surface these LOUDLY (the watchdog escalates, the panel shows
   * them) — never silently, which is the state `.strict()` exists to prevent.
   */
  unknownKeys: string[];
}

/**
 * How many strip-and-re-parse passes the lenient read may take. One pass strips
 * every key zod reported unrecognised at every level it reported; a second is
 * needed only when stripping exposes a strict object underneath, so 3 is
 * generous. A document still failing after that is invalid, not merely newer.
 */
const UNKNOWN_KEY_STRIP_PASSES = 3;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Delete, in place, every key zod reported as `unrecognized_keys`, at the path
 * it reported it. Returns the dotted paths removed. Only ever called on a CLONE
 * of the caller's document — a row's jsonb value is never mutated under it.
 */
function stripUnrecognizedKeys(doc: Record<string, unknown>, issues: readonly z.ZodIssue[]): string[] {
  const stripped: string[] = [];
  for (const issue of issues) {
    if (issue.code !== 'unrecognized_keys') continue;
    let target: unknown = doc;
    for (const seg of issue.path) {
      target = isPlainObject(target) ? target[String(seg)] : undefined;
    }
    if (!isPlainObject(target)) continue;
    for (const key of issue.keys) {
      if (!Object.hasOwn(target, key)) continue;
      delete target[key];
      stripped.push([...issue.path.map(String), key].join('.'));
    }
  }
  return stripped;
}

/**
 * Validate one stored `launch_settings` value, however it was fetched.
 *
 * Split out from the reader below because there are two legitimate ways to hold
 * that value — this module SELECTs it, and goals.detail already has it on a row
 * it selected for other reasons (P-005) — and only one of them should own what
 * "valid" means. A second `safeParse` at the other call site would be a second
 * place for the definition to move.
 *
 * `null` in, `null` out and NO error: "none declared" is the common case and the
 * correct launch default, not a fault.
 *
 * READ-LENIENT on unknown keys, STRICT on everything else (WI-2140573). The
 * schema's `.strict()` is the WRITE boundary (`writeGoalLaunchSettings`), where
 * refusing a typo is right. On READ the same refusal was a safety-net kill:
 * a key written by a NEWER schema than the reading host runs — measured live
 * when `roles.goal.compactionLimit` landed before bg-host's bundle knew it —
 * made the whole document parse to null, so `holder.onLoss='respawn'` silently
 * stopped being in force on the one goal it protected. So: on failure, strip
 * exactly the keys zod reported unrecognised, re-parse, and REPORT the stripped
 * paths in `unknownKeys`. A document that still fails after stripping (a bad
 * VALUE, not merely a new key) is invalid as before.
 */
export function parseGoalLaunchSettings(raw: unknown, label = 'launch_settings'): ParsedGoalLaunchSettings {
  if (raw == null) return { settings: null, error: null, unknownKeys: [] };
  let doc: unknown;
  try {
    doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    // A string that is not JSON at all lands here rather than in safeParse.
    return {
      settings: null,
      error: `${label} is unreadable: ${e instanceof Error ? e.message : String(e)}`,
      unknownKeys: [],
    };
  }
  const unknownKeys: string[] = [];
  let working: unknown = doc;
  for (let pass = 0; ; pass++) {
    const parsed = goalLaunchSettingsSchema.safeParse(working);
    if (parsed.success) return { settings: parsed.data, error: null, unknownKeys };
    const invalid = `${label} is invalid: ${parsed.error.message}`;
    if (pass >= UNKNOWN_KEY_STRIP_PASSES || !isPlainObject(working)) {
      return { settings: null, error: invalid, unknownKeys };
    }
    // Never mutate the caller's value: it is usually a row still in use.
    if (pass === 0) working = structuredClone(working);
    const stripped = stripUnrecognizedKeys(working as Record<string, unknown>, parsed.error.issues);
    if (!stripped.length) return { settings: null, error: invalid, unknownKeys };
    unknownKeys.push(...stripped);
  }
}

/**
 * Read + validate one goal's launch settings, plus its budget truth (P-006) —
 * one row read for both, because every launch resolution needs both and a
 * second round-trip per launch would be pure overhead. Returns null settings
 * for "none declared" (the common case, and the correct default), and reports
 * invalid stored JSON as an error rather than silently treating a malformed
 * document as absent — a settings blob that fails to parse means the owner's
 * ceiling is NOT in force, which they must hear about.
 */
export async function readGoalLaunchSettings(
  goalId: string,
  sql?: Sql,
): Promise<{
  settings: GoalLaunchSettings | null;
  budget: GoalBudgetTruth | null;
  /** Goal-owned first-turn context, read atomically with its launch policy. */
  brief: GoalLaunchBrief | null;
  /**
   * P-006: the goal's declared drain fleet, for `goalFleetFamily`. Read from the
   * SAME row for the same reason the budget is — the launch boundary needs the
   * family to pick a slot, and a second round-trip per launch to fetch one jsonb
   * key would be pure overhead.
   */
  drainFleetSlug: string | null;
  error: string | null;
  /** WI-2140573: keys the lenient read stripped — see {@link ParsedGoalLaunchSettings.unknownKeys}. */
  unknownKeys: string[];
}> {
  if (!goalId) return { settings: null, budget: null, brief: null, drainFleetSlug: null, error: null, unknownKeys: [] };
  try {
    const rows = await pg(sql)`
      SELECT title, body, kill_criterion, standing,
             launch_settings, budget_cents, budget_window_sec,
             metadata->'spentCents' AS spent_cents,
             -- WI-10002052 / D-011: the rollup names WHY spentCents is null, so the gate
             -- can tell "nothing attributed in the window" from "spent, but unpriced".
             metadata->>'spentCentsUnmeasuredReason' AS spent_cents_unmeasured_reason,
             metadata->>'spentCentsAt' AS spent_cents_at,
             metadata->>'spentCentsSource' AS spent_cents_source,
             metadata->'spentCentsFreshness'->>'status' AS interactive_usage_freshness_status,
             metadata->'spentCentsFreshness'->>'lastIngestedAtMs' AS interactive_usage_last_ingested_at_ms,
             metadata->>'drainFleet' AS drain_fleet
        FROM harness_shared.goals WHERE id = ${goalId} LIMIT 1`;
    if (!rows.length) {
      return { settings: null, budget: null, brief: null, drainFleetSlug: null, error: null, unknownKeys: [] };
    }
    const row = rows[0] as {
      title?: unknown;
      body?: unknown;
      kill_criterion?: unknown;
      standing?: unknown;
      launch_settings?: unknown;
      budget_cents?: unknown;
      budget_window_sec?: unknown;
      spent_cents?: unknown;
      spent_cents_unmeasured_reason?: unknown;
      spent_cents_at?: unknown;
      spent_cents_source?: unknown;
      interactive_usage_freshness_status?: unknown;
      interactive_usage_last_ingested_at_ms?: unknown;
      drain_fleet?: unknown;
    };
    const parsed = parseGoalLaunchSettings(row.launch_settings, `goal ${goalId} launch_settings`);
    const title = typeof row.title === 'string' && row.title.trim() ? row.title : null;
    const briefError = title ? null : `goal ${goalId} has no usable title for its holder kickoff`;
    const rawFreshnessStatus = row.interactive_usage_freshness_status;
    const interactiveUsageFreshnessStatus =
      rawFreshnessStatus === 'fresh' || rawFreshnessStatus === 'stale' || rawFreshnessStatus === 'unavailable'
        ? rawFreshnessStatus
        : null;
    return {
      settings: parsed.settings,
      budget: {
        budgetCents: asFiniteCents(row.budget_cents),
        spentCents: asFiniteCents(row.spent_cents),
        unmeasuredPricedSpend: hasUnmeasuredPricedSpend(
          row.spent_cents_unmeasured_reason,
          asFiniteCents(row.spent_cents),
        ),
        spentCentsAt: typeof row.spent_cents_at === 'string' ? row.spent_cents_at : null,
        spentCentsSource: typeof row.spent_cents_source === 'string' ? row.spent_cents_source : null,
        interactiveUsageFreshnessStatus,
        interactiveUsageLastIngestedAtMs: asFiniteNumber(row.interactive_usage_last_ingested_at_ms),
      },
      brief: title
        ? {
            title,
            body: typeof row.body === 'string' ? row.body : null,
            killCriterion: typeof row.kill_criterion === 'string' ? row.kill_criterion : null,
            budgetCents: asFiniteCents(row.budget_cents),
            budgetWindowSec: asFiniteNumber(row.budget_window_sec),
            standing: row.standing === true,
          }
        : null,
      drainFleetSlug: typeof row.drain_fleet === 'string' ? row.drain_fleet : null,
      error: [parsed.error, briefError].filter(Boolean).join('; ') || null,
      unknownKeys: parsed.unknownKeys,
    };
  } catch (e) {
    return {
      settings: null,
      budget: null,
      brief: null,
      drainFleetSlug: null,
      error: e instanceof Error ? e.message : String(e),
      unknownKeys: [],
    };
  }
}

/** What the fleet-launch boundary needs from a goal BEFORE any headcount is known. */
export interface GoalLaunchSettingsRead {
  goalId: string | null;
  settings: GoalLaunchSettings | null;
  /** The goal's declared drain fleet, for `goalFleetFamily`. */
  drainFleetSlug: string | null;
  degraded: boolean;
  degradedReasons: string[];
}

/**
 * The goal's SETTINGS ONLY — no ceilings, no budget gate, no side effects (D-004).
 *
 * WHY THIS EXISTS RATHER THAN A SECOND `resolveGoalLaunch` CALL. The fleet-launch
 * door has to know the goal's `fleetType` and per-role profiles at the OPTION
 * boundary, which runs before the capacity clamp — so before `openCount`, the
 * number the D-005 ceilings are checked against, exists at all. `resolveGoalLaunch`
 * cannot be called there:
 *
 *   - it refuses on `count`, so calling it early with a provisional count would
 *     either double-count the fleet's headcount or refuse a launch that fits;
 *   - it has a live SIDE EFFECT — `escalateBudgetRefusal` opens an owner
 *     escalation — so a speculative second call can page the owner about a launch
 *     that was never actually attempted.
 *
 * So the two reads are split by PURPOSE, not duplicated: this one answers "what
 * shape did the goal ask for", early and freely; `resolveGoalLaunch` still answers
 * "may this many agents start", once, late, with the true count. Both derive the
 * goal from the LAUNCHER (D-008/D-009) rather than taking a `goalId` argument a
 * door could forget to pass.
 *
 * Fail-soft like every other read here: a goal that cannot be resolved yields no
 * settings and a degraded reason, never a thrown launch.
 */
/**
 * Is this an authority error that a FAIL-SOFT launch READ must still refuse?
 *
 * `GoalHolderAuthorityError` has covered two very different conditions since
 * 02d9c38d1f: a `superseded` VERDICT — the authority store spoke, and said this
 * owner is not the holder — and an `unreadable` STORE, which could not speak at
 * all. Only the verdict is an authority violation.
 *
 * The read doors below are documented fail-soft ("never a thrown launch"), so
 * rethrowing the storage failure there turns a transient DB blip into a hard
 * launch failure — and, because `pg()` refuses a real connection under Vitest,
 * it red-ed 94 launch-on-plan unit tests (WI-1195329).
 *
 * The MUTATION fence in `assertGoalHolderMutationAuthority` still refuses BOTH,
 * which is correct and deliberately untouched: on a write path, absence of
 * evidence must not become authority.
 */
function isFatalGoalHolderVerdict(e: unknown): boolean {
  return isGoalHolderAuthorityError(e) && e.code === 'goal_holder_superseded';
}

export async function readGoalLaunchSettingsForLauncher(args: {
  workspaceId: string;
  launcherOwnerId: string;
  sql?: Sql;
}): Promise<GoalLaunchSettingsRead> {
  const degradedReasons: string[] = [];
  let goalId: string | null = null;
  try {
    goalId = await resolveGoalContext(args.workspaceId, args.launcherOwnerId, args.sql);
  } catch (e) {
    if (isFatalGoalHolderVerdict(e)) throw e;
    degradedReasons.push(`goal context unresolved: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!goalId) {
    return {
      goalId: null,
      settings: null,
      drainFleetSlug: null,
      degraded: degradedReasons.length > 0,
      degradedReasons,
    };
  }
  const { settings, drainFleetSlug, error } = await readGoalLaunchSettings(goalId, args.sql);
  if (error) degradedReasons.push(`launch settings not applied: ${error}`);
  return {
    goalId,
    settings,
    drainFleetSlug,
    degraded: degradedReasons.length > 0,
    degradedReasons,
  };
}

/**
 * May a goal-scoped launcher place work in this harness?
 *
 * A `goal_pots.role='owner'` row is not sufficient on its own: terminal goals
 * intentionally retain their relationship history, so a killed owner's live
 * edge must not make the primary harness look permanently occupied.  The
 * authority question is therefore the intersection of the live edge and an
 * ACTIVE goal.  This is the shared read behind launch-time sovereignty checks;
 * callers must not reimplement it against `goal_pots` alone.
 */
export interface GoalPotPlacementAuthority {
  allowed: boolean;
  reason:
    | 'no-active-owner'
    | 'caller-goal-owns-pot'
    | 'different-active-goal-owns-pot'
    /** An `owner` edge exists for another ACTIVE goal, but that goal has outlived
     *  its executable worklist (WI-10004524) — the edge is read as VACANT. */
    | 'stale-owner-edge-vacant';
  ownerGoalId: string | null;
  ownerGoalTitle: string | null;
  /**
   * What the sovereignty read measured about ANOTHER goal's owner edge — present
   * on the refusal AND on the stale-edge allow, so a steward can tell a stale
   * owner from a live one without a second query (WI-10004524 acceptance 2).
   * Absent when there is no other-goal owner to describe.
   */
  ownerState?: GoalPotOwnerState;
}

/**
 * What decides whether an `owner` edge still confers placement sovereignty.
 * `holderLiveness` is `'not-checked'` when an earlier leg already settled the
 * verdict (a live worklist plan keeps the edge; a releasing disposition drops
 * it) so the presence oracle is only paid for when it can change the answer.
 */
export interface GoalPotOwnerState {
  /** `goals.metadata.disposition`, e.g. `handoff` | `killed` | `achieved`. */
  disposition: string | null;
  /** Standing goals pursue an ongoing duty: a recorded disposition alone never
   *  releases their edge — only a lost holder with no worklist does. */
  standing: boolean;
  /** Non-archived, non-terminal plans stamped to the goal or named in its
   *  `worklist` property. `null` = the count was not read (never read as 0). */
  liveWorklistPlans: number | null;
  holderLiveness: 'held' | 'unheld' | 'lost' | 'unknown' | 'not-checked';
}

/** Dispositions that mean the owner goal has stopped pursuing its pot. `handoff`
 *  is the one that leaves `status='active'` by design, which is why status alone
 *  cannot release the edge. */
export const POT_OWNER_RELEASING_DISPOSITIONS: readonly string[] = ['handoff', 'killed', 'achieved'];

/**
 * PURE: does this owner edge still hold the pot? An edge is STALE — vacant for
 * every other goal — only when the owning goal has NO executable worklist AND is
 * demonstrably not working it: it declared a releasing disposition, or every
 * holder row it has resolves dead (`lost`).
 *
 * CONSERVATIVE on every unknown, because the status quo (refuse) is the safe
 * failure: an unread worklist count, an unresolved/`unknown` oracle verdict and
 * `unheld` (a goal created but not yet started has no holder row yet and must
 * keep the pot it was just given) all leave the edge LIVE.
 */
export function potOwnerEdgeIsStale(state: GoalPotOwnerState): boolean {
  if (state.liveWorklistPlans === null || state.liveWorklistPlans > 0) return false;
  if (!state.standing && state.disposition && POT_OWNER_RELEASING_DISPOSITIONS.includes(state.disposition)) {
    return true;
  }
  return state.holderLiveness === 'lost';
}

export async function resolveGoalPotPlacementAuthority(args: {
  workspaceId: string;
  launcherGoalId: string;
  harnessSlug: string;
  sql?: Sql;
}): Promise<GoalPotPlacementAuthority> {
  const sql = pg(args.sql);
  // The worklist count mirrors the portfolio brief's definition of a goal's
  // worklist — plans stamped `goal_id` plus the refs in the goal's `worklist`
  // property (same ref grammar as readGoalPortfolioBrief) — narrowed to plans
  // that are not archived and not terminal. `TERMINAL_PLAN_STATUSES` comes from
  // the plan grammar so the vocabulary cannot drift from plans:set-plan-status.
  const rows = await sql<
    Array<{
      owner_goal_id: string;
      owner_goal_title: string | null;
      owner_disposition?: string | null;
      owner_standing?: boolean | null;
      live_worklist_plans?: number | string | null;
    }>
  >`
    SELECT gp.goal_id AS owner_goal_id, g.title AS owner_goal_title,
           g.metadata->>'disposition' AS owner_disposition,
           g.standing AS owner_standing,
           (SELECT count(*)::int
              FROM harness_shared.harness_plans hp
             WHERE hp.workspace_id = g.workspace_id
               AND NOT COALESCE(hp.archived, false)
               AND COALESCE(hp.status, '') <> ALL(${[...TERMINAL_PLAN_STATUSES]}::text[])
               AND (
                 hp.goal_id = g.id
                 OR EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements_text(
                            CASE WHEN jsonb_typeof(g.properties->'worklist'->'value') = 'array'
                                 THEN g.properties->'worklist'->'value' ELSE '[]'::jsonb END
                          ) wr(ref)
                    WHERE hp.plan_slug = regexp_replace(wr.ref, '^plan:(?:[^/]+/)?', '')
                      AND (
                        position('/' in regexp_replace(wr.ref, '^plan:', '')) = 0
                        OR hp.harness_slug = split_part(regexp_replace(wr.ref, '^plan:', ''), '/', 1)
                      )
                 )
               )) AS live_worklist_plans
      FROM harness_shared.goal_pots gp
      JOIN harness_shared.goals g
        ON g.workspace_id = gp.workspace_id
       AND g.id = gp.goal_id
     WHERE gp.workspace_id = ${args.workspaceId}
       AND gp.harness_slug = ${args.harnessSlug}
       AND gp.role = 'owner'
       AND gp.removed_at IS NULL
       AND g.status = 'active'
     ORDER BY gp.added_at DESC
     LIMIT 2
  `;
  const owner = rows[0] ?? null;
  if (!owner) {
    return {
      allowed: true,
      reason: 'no-active-owner',
      ownerGoalId: null,
      ownerGoalTitle: null,
    };
  }
  if (owner.owner_goal_id === args.launcherGoalId) {
    return {
      allowed: true,
      reason: 'caller-goal-owns-pot',
      ownerGoalId: owner.owner_goal_id,
      ownerGoalTitle: owner.owner_goal_title,
    };
  }
  // Another active goal holds the edge. Decide whether it still EARNS it.
  const worklistCount = owner.live_worklist_plans == null ? null : Number(owner.live_worklist_plans);
  const ownerState: GoalPotOwnerState = {
    disposition: owner.owner_disposition ?? null,
    standing: owner.owner_standing === true,
    liveWorklistPlans: worklistCount !== null && Number.isFinite(worklistCount) ? worklistCount : null,
    holderLiveness: 'not-checked',
  };
  // Holder liveness is the expensive leg (presence oracle) and only matters when
  // the cheap legs are inconclusive: no live plan, and no releasing disposition.
  const dispositionReleases =
    !ownerState.standing && ownerState.disposition !== null && POT_OWNER_RELEASING_DISPOSITIONS.includes(ownerState.disposition);
  if (ownerState.liveWorklistPlans === 0 && !dispositionReleases) {
    try {
      const { resolveGoalHolders } = await import('./goals/holder');
      const holders = await resolveGoalHolders(sql, {
        workspaceId: args.workspaceId,
        goalId: owner.owner_goal_id,
      });
      ownerState.holderLiveness = holders.liveness;
    } catch {
      // An unreadable oracle is UNKNOWN, never dead — the edge stays live and the
      // caller keeps refusing, exactly as before this check existed.
      ownerState.holderLiveness = 'unknown';
    }
  }
  if (potOwnerEdgeIsStale(ownerState)) {
    return {
      allowed: true,
      reason: 'stale-owner-edge-vacant',
      ownerGoalId: owner.owner_goal_id,
      ownerGoalTitle: owner.owner_goal_title,
      ownerState,
    };
  }
  return {
    allowed: false,
    reason: 'different-active-goal-owns-pot',
    ownerGoalId: owner.owner_goal_id,
    ownerGoalTitle: owner.owner_goal_title,
    ownerState,
  };
}

/**
 * `budget_cents` is a bigint (postgres-js hands it over as a string);
 * `metadata->'spentCents'` is a jsonb scalar (a number when the rollup wrote
 * it, but historically agent-written values could be anything). Anything not a
 * finite number is null — "unknown", never 0, because 0 would read as "nothing
 * spent" and admit a launch on garbage.
 */
function asFiniteNumber(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function asFiniteCents(v: unknown): number | null {
  return asFiniteNumber(v);
}

/**
 * Replace one goal's launch settings. Pass null to clear them back to "none
 * declared". Validates before writing so an invalid document can never reach the
 * column — the read path's parse failure is for rows written before this
 * existed, not a licence to write junk.
 */
export async function writeGoalLaunchSettings(
  goalId: string,
  settings: GoalLaunchSettings | null,
  sql?: Sql,
): Promise<{ ok: boolean; error: string | null }> {
  if (!goalId) return { ok: false, error: 'goalId is required' };
  let payload: string | null = null;
  let topologyProblem: string | null = null;
  if (settings != null) {
    const parsed = goalLaunchSettingsSchema.safeParse(settings);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    payload = JSON.stringify(parsed.data);
    topologyProblem = drainFleetTopologyProblem(parsed.data);
  }
  try {
    /* DRAIN-FLEET FLOOR ON UPDATE (WI-10004407, follow-up to EI-24556293106348130).
       goals:start and goals:start-from-package refuse ceilings below
       DRAIN_FLEET_MIN_CEILINGS, but a later goals:update could still lower a
       running goal's ceilings below them. The drain worker is the agent that
       launches LAST, so it is the one those ceilings refuse: a leader with zero
       workers, reported as drain-fleet-dead. The floor therefore binds HERE, at
       the one writer every post-start door goes through.

       Bound only for a goal that HAS a drain fleet (`metadata.drainFleet`). A
       sole-member goal runs the goal agent alone and is exempt, as it is at the
       start doors. The read happens only when the new document already fails
       the predicate, so a compliant write costs no extra round-trip. It runs on
       the caller's `sql`, so inside goals:update's transaction it sees a
       drainFleet stamped earlier in the same call. `null` (clear to defaults)
       always passes, because GOAL_LAUNCH_DEFAULTS clears the floor.

       Its own query rather than readGoalLaunchSettings().drainFleetSlug: that
       reader turns a failed read into drainFleetSlug:null, which here would let
       the write through (fail OPEN). This query throws into the catch below, so
       an unreadable row refuses the write instead. */
    if (topologyProblem) {
      const rows = (await pg(sql)`
        SELECT metadata->>'drainFleet' AS drain_fleet
          FROM harness_shared.goals
         WHERE id = ${goalId}`) as unknown as Array<{ drain_fleet: string | null }>;
      const drainFleet = rows[0]?.drain_fleet ?? null;
      if (drainFleet) {
        return {
          ok: false,
          error:
            `${topologyProblem} Goal ${goalId} runs drain fleet ${drainFleet}, so its ceilings must keep ` +
            `room for the drain worker after start as well as at start.`,
        };
      }
    }
    await pg(sql)`
      UPDATE harness_shared.goals
         SET launch_settings = ${payload}::jsonb, updated_at = now()
       WHERE id = ${goalId}`;
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Declare (or revise) ONE goal's holder policy, leaving the rest of its launch
 * settings alone — the remediation P-003's refusals name.
 *
 * WHY THIS EXISTS RATHER THAN "JUST CALL writeGoalLaunchSettings". That writer
 * REPLACES the whole document, which is right for `goals:update
 * { launchSettings }` (the owner is editing the document as a document) and
 * wrong for every caller who only wants to answer the holder question: sending
 * `{ holder }` alone silently drops the goal's ceilings and launch profile. A
 * refusal whose stated fix destroys a ceiling is worse than the refusal, so the
 * fix gets its own merge-safe door.
 *
 * Read-modify-write, not a jsonb merge in SQL, so the merged document goes
 * through the SAME validation as any other write — the point of the strict
 * schema is that no path may install a typo'd key, including this one.
 */
export async function declareGoalHolderPolicy(
  goalId: string,
  holder: GoalHolderPolicy,
  sql?: Sql,
): Promise<{ ok: boolean; error: string | null }> {
  if (!goalId) return { ok: false, error: 'goalId is required' };
  const current = await readGoalLaunchSettings(goalId, sql);
  // A stored document that does not parse is NOT overwritten: it may hold a
  // ceiling the owner is relying on, and merging into `{}` would erase it while
  // reporting success. The caller hears the parse error instead.
  if (current.error) return { ok: false, error: current.error };
  return writeGoalLaunchSettings(goalId, { ...(current.settings ?? {}), holder }, sql);
}

/** One presence-bearing session the headcount SQL counted, with the liveness inputs the oracle needs. */
interface HeadcountPresenceRow {
  ownerId: string;
  inFleet: boolean;
  heartbeatAt: string | null;
  host: string | null;
  pid: number | null;
  source: string | null;
}

export interface GoalHeadcountMember {
  ownerId: string;
  inFleet: boolean;
  basis: 'heartbeat' | 'boot-grace' | 'launch-reservation';
  heartbeatAt: string | null;
  briefUpdatedAt: string | null;
}

export interface GoalHeadcountMeasurement {
  measuredAt: string | null;
  /** False if the owner aggregate is unavailable or does not reconcile to the count. */
  populationComplete: boolean;
  candidate: GoalHeadcount;
  counted: GoalHeadcountMember[];
  oracleEndedOwnerIds: string[];
  excludedOwnerIds: string[];
}

function parseHeadcountPopulation(raw: unknown): GoalHeadcountMember[] {
  let parsed = raw;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    if (typeof row.ownerId !== 'string' || !row.ownerId ||
        (row.basis !== 'heartbeat' && row.basis !== 'boot-grace' && row.basis !== 'launch-reservation')) return [];
    return [{
      ownerId: row.ownerId,
      inFleet: row.inFleet === true,
      basis: row.basis,
      heartbeatAt: typeof row.heartbeatAt === 'string' ? row.heartbeatAt : null,
      briefUpdatedAt: typeof row.briefUpdatedAt === 'string' ? row.briefUpdatedAt : null,
    } satisfies GoalHeadcountMember];
  });
}

/**
 * Tolerant reader for the `presence_rows` json aggregate of `goalHeadcount`'s
 * query. An absent/malformed aggregate parses to `[]` — i.e. "no row for the
 * oracle to judge", which leaves the heartbeat count standing (the pre-oracle
 * behaviour) rather than throwing away a count that was successfully taken.
 */
function parseHeadcountPresenceRows(raw: unknown): HeadcountPresenceRow[] {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const out: HeadcountPresenceRow[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.ownerId !== 'string' || row.ownerId === '') continue;
    out.push({
      ownerId: row.ownerId,
      inFleet: row.inFleet === true,
      heartbeatAt: typeof row.heartbeatAt === 'string' ? row.heartbeatAt : null,
      host: typeof row.host === 'string' ? row.host : null,
      pid: typeof row.pid === 'number' ? row.pid : null,
      source: typeof row.source === 'string' ? row.source : null,
    });
  }
  return out;
}

/**
 * The rows the SHARED liveness oracle (`resolveSessionStates`) calls `ended` —
 * never a re-derivation from heartbeat age, which is process keepalive and not
 * an agent-liveness verdict (see `goalHeadcount`). Dynamic import for the same
 * reason as the other heavyweight seams here: this module rides in every launch
 * path and must not drag the presence tool's dependency graph into its static
 * graph. A verdict of `null` (not measured) or any other state is NOT excluded.
 *
 * `recorded` is deliberately NOT excluded: the oracle defines it as
 * "authoritatively LIVE per the session log" (presence-wakeability.ts), so
 * dropping it would under-count live sessions and weaken the ceiling.
 */
async function oracleEndedHeadcountRows(rows: HeadcountPresenceRow[]): Promise<HeadcountPresenceRow[]> {
  if (rows.length === 0) return [];
  const { resolveSessionStates } = await import('./agent-tools/coordination/liveness-oracle');
  const verdicts = await resolveSessionStates(
    rows.map((r) => ({ ownerId: r.ownerId, heartbeatAt: r.heartbeatAt, host: r.host, pid: r.pid, source: r.source })),
  );
  return rows.filter((r) => {
    const state = verdicts.get(r.ownerId)?.sessionState;
    return state === 'ended';
  });
}

/**
 * Live headcounts for a goal, and optionally for one of its fleets.
 *
 * The population is `session_briefs.goal_id` — every session whose WORK BELONGS
 * TO the goal — joined to presence for liveness. This is computable only because
 * of P-002: before that column existed the sole session attributable to a goal
 * was the goal's own agent, so D-005's "ALL agent sessions associated with that
 * goal" could not have been counted at all.
 *
 * A session counts when its heartbeat is fresh, OR when it was launched inside
 * the boot grace and has not yet registered presence. The second leg is what
 * covers bootstrap delay. Concurrent admission additionally reserves the existing
 * governor receipt under a goal-scoped registration lock (registerGoalLaunch).
 * Those reservations include fleet attribution before presence exists and stop
 * counting on cancellation, lease expiry, boot-grace expiry, or newer presence.
 *
 * ⚠ A FRESH HEARTBEAT IS NOT LIVENESS (WI-10005672). Heartbeat freshness is
 * process KEEPALIVE; the one agent-liveness verdict is the shared oracle's
 * `sessionState`. A session the oracle calls `ended` therefore does not count
 * even while its last heartbeat is inside the stale window — before
 * this a goal's relaunch right after its members died was refused or
 * under-admitted for up to GOAL_HEADCOUNT_STALE_MS although zero agents were
 * alive. The oracle only SUBTRACTS from the heartbeat count, and only for rows
 * that have a presence row (a boot-grace row has none to judge): `suspect`,
 * `draining`, `parked`, `live`, `recorded` (authoritatively live per the session
 * log) and an unclassifiable (`null`) verdict all keep counting, so the ceiling errs toward over-counting, never toward admitting a
 * burst. An oracle failure propagates to the caller's fail-open path like any
 * other count failure ("ceiling not enforced", reported in band).
 */
export async function goalHeadcount(args: {
  workspaceId: string;
  goalId: string;
  fleetSlug?: string | null;
  /**
   * Owner ids that do NOT occupy a seat for THIS count. A respawn is net-zero on
   * headcount — it replaces one member with one — so the member being replaced
   * must not be charged against maxAgents/maxPerFleet while its replacement is
   * being admitted (EI-24909345582884838: the old member was still `live` when the
   * replacement's ceiling check ran, so a full fleet refused its own respawn after
   * the SIGTERM had already gone out).
   */
  excludeOwnerIds?: readonly string[];
  sql?: Sql;
}): Promise<{ headcount: GoalHeadcount; measurement: GoalHeadcountMeasurement | null; error: string | null }> {
  const empty: GoalHeadcount = { total: 0, fleet: args.fleetSlug ? 0 : null };
  if (!args.workspaceId || args.workspaceId === '*' || !args.goalId) {
    return { headcount: empty, measurement: null, error: null };
  }
  const staleSecs = Math.max(1, Math.floor(GOAL_HEADCOUNT_STALE_MS / 1000));
  const graceSecs = Math.max(1, Math.floor(GOAL_HEADCOUNT_BOOT_GRACE_MS / 1000));
  try {
    const fleetKey = args.fleetSlug || '';
    const excludedOwnerIds = [...new Set((args.excludeOwnerIds ?? []).filter((id) => id.length > 0))];
    const rows = await pg(args.sql)`
      WITH pending_launches AS (
        SELECT DISTINCT ON (reservation.owner_id) reservation.*
        FROM (
          SELECT
            coalesce(nullif(wi.payload->'resource_governor'->'metadata'->>'targetOwnerId', ''),
                     'reservation:' || wi.feature_id) AS owner_id,
            coalesce(wi.payload->'resource_governor'->'metadata'->>'fleetSlug' = ${fleetKey}, false) AS in_fleet,
            to_timestamp((wi.payload->'resource_governor'->>'enqueuedAtMs')::double precision / 1000) AS admitted_at
          FROM harness_shared.work_items wi
          WHERE wi.workspace_id = ${args.workspaceId}
            AND wi.payload->'resource_governor'->>'schemaVersion' = '1'
            AND wi.payload->'resource_governor'->>'namespace' = 'agent-process'
            AND wi.payload->'resource_governor'->>'admissionClass' = 'agent'
            AND wi.payload->'resource_governor'->'metadata'->>'goalReservation' = 'true'
            AND wi.payload->'resource_governor'->'metadata'->>'goalId' = ${args.goalId}
            AND wi.payload->'resource_governor'->>'state' IN ('leased', 'running')
            AND CASE WHEN jsonb_typeof(wi.payload->'resource_governor'->'lease'->'expiresAtMs') = 'number'
                THEN (wi.payload->'resource_governor'->'lease'->>'expiresAtMs')::double precision
                     > extract(epoch FROM clock_timestamp()) * 1000 ELSE false END
            AND CASE WHEN jsonb_typeof(wi.payload->'resource_governor'->'enqueuedAtMs') = 'number'
                THEN (wi.payload->'resource_governor'->>'enqueuedAtMs')::double precision
                     > extract(epoch FROM clock_timestamp() - ${`${graceSecs} seconds`}::interval) * 1000 ELSE false END
        ) reservation
        WHERE reservation.owner_id <> ALL(${excludedOwnerIds}::text[])
        ORDER BY reservation.owner_id, reservation.admitted_at DESC
      ), candidates AS (
        SELECT b.owner_id, coalesce(p.fleet_slug = ${fleetKey}, false) AS in_fleet,
          CASE WHEN p.owner_id IS NULL THEN 'boot-grace' ELSE 'heartbeat' END AS basis,
          p.heartbeat_at, b.updated_at AS brief_updated_at, p.host, p.pid, p.source
        FROM harness_shared.session_briefs b
        LEFT JOIN harness_shared.coord_presence p ON p.owner_id = b.owner_id
        WHERE b.workspace_id = ${args.workspaceId}
          AND b.goal_id = ${args.goalId}
          AND b.owner_id <> ALL(${excludedOwnerIds}::text[])
          AND (p.heartbeat_at > now() - ${`${staleSecs} seconds`}::interval
            OR (p.owner_id IS NULL AND b.updated_at > now() - ${`${graceSecs} seconds`}::interval))
          AND NOT EXISTS (
            SELECT 1 FROM pending_launches r WHERE r.owner_id = b.owner_id
              AND (p.heartbeat_at IS NULL OR r.admitted_at > p.heartbeat_at)
          )
        UNION ALL
        SELECT r.owner_id, r.in_fleet, 'launch-reservation', NULL::timestamptz,
          r.admitted_at, NULL::text, NULL::integer, NULL::text
        FROM pending_launches r
        WHERE NOT EXISTS (
          SELECT 1 FROM harness_shared.session_briefs b
          JOIN harness_shared.coord_presence p ON p.owner_id = b.owner_id
          WHERE b.owner_id = r.owner_id AND b.workspace_id = ${args.workspaceId}
            AND b.goal_id = ${args.goalId} AND p.heartbeat_at >= r.admitted_at
            AND p.heartbeat_at > now() - ${`${staleSecs} seconds`}::interval
        )
      )
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE c.in_fleet)::int AS fleet,
        now()::text AS measured_at,
        coalesce(json_agg(json_build_object(
          'ownerId', c.owner_id,
          'inFleet', c.in_fleet,
          'basis', c.basis,
          'heartbeatAt', c.heartbeat_at,
          'briefUpdatedAt', c.brief_updated_at
        )), '[]'::json) AS population_rows,
        coalesce(
          json_agg(json_build_object(
            'ownerId', c.owner_id,
            'inFleet', c.in_fleet,
            'heartbeatAt', c.heartbeat_at,
            'host', c.host,
            'pid', c.pid,
            'source', c.source
          )) FILTER (WHERE c.basis = 'heartbeat'),
          '[]'::json
        ) AS presence_rows
      FROM candidates c`;
    const r = (rows[0] ?? {}) as {
      total?: unknown; fleet?: unknown; presence_rows?: unknown;
      measured_at?: unknown; population_rows?: unknown;
    };
    let total = Number(r.total ?? 0);
    let fleet = Number(r.fleet ?? 0);
    const candidate = { total, fleet: args.fleetSlug ? fleet : null };
    const population = parseHeadcountPopulation(r.population_rows);
    // The heartbeat count above is only an UPPER BOUND; the shared oracle then
    // removes every presence-bearing row it calls ended. Recorded stays counted.
    const ended = await oracleEndedHeadcountRows(parseHeadcountPresenceRows(r.presence_rows));
    const endedIds = new Set(ended.map((row) => row.ownerId));
    for (const gone of ended) {
      total -= 1;
      if (gone.inFleet) fleet -= 1;
    }
    return {
      headcount: {
        total: Math.max(0, total),
        fleet: args.fleetSlug ? Math.max(0, fleet) : null,
      },
      measurement: {
        measuredAt: typeof r.measured_at === 'string' ? r.measured_at : null,
        populationComplete: r.population_rows != null && typeof r.measured_at === 'string' &&
          population.length === candidate.total &&
          new Set(population.map((row) => row.ownerId)).size === candidate.total &&
          (!args.fleetSlug || population.filter((row) => row.inFleet).length === candidate.fleet),
        candidate,
        counted: population.filter((row) => !endedIds.has(row.ownerId)),
        oracleEndedOwnerIds: [...endedIds],
        excludedOwnerIds,
      },
      error: null,
    };
  } catch (e) {
    return { headcount: empty, measurement: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Serialize the final count with registration of the existing governor receipt.
 * The receipt reserves goal/fleet seats until bootstrap supplies newer presence,
 * the spawn cancels, or the existing boot grace expires. No presence is forged.
 * Only read/lock failures can fail open; a registration/commit failure is never
 * retried, because its external durable write may already have succeeded.
 */
export async function registerGoalLaunch<T>(args: {
  workspaceId: string;
  launcherOwnerId: string;
  targetOwnerId?: string | null;
  fleetSlug?: string | null;
  excludeOwnerIds?: readonly string[];
  sql?: Sql;
  /** Test seam: production uses the existing complete policy resolver. */
  resolve?: typeof resolveGoalLaunchForGoal;
}, register: (goalId: string | null, resolution: GoalLaunchResolution | null, degradedReason: string | null) => Promise<T>): Promise<{
  value: T | null; resolution: GoalLaunchResolution | null; degradedReason: string | null;
}> {
  let goalId: string | null;
  try {
    goalId = await resolveGoalContext(args.workspaceId, args.launcherOwnerId, args.sql);
  } catch (error) {
    if (isGoalHolderAuthorityError(error)) throw error;
    const degradedReason = `goal admission registration not enforced — ${error instanceof Error ? error.message : String(error)}`;
    return { value: await register(null, null, degradedReason), resolution: null, degradedReason };
  }
  if (!goalId) return { value: await register(null, null, null), resolution: null, degradedReason: null };
  let registrationStarted = false;
  try {
    return await pg(args.sql).begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`goal-launch:${args.workspaceId}:${goalId}`}, 0))`;
      const resolution = await (args.resolve ?? resolveGoalLaunchForGoal)({
        workspaceId: args.workspaceId, launcherOwnerId: args.launcherOwnerId, goalId,
        fleetSlug: args.fleetSlug, count: 1,
        excludeOwnerIds: [...(args.excludeOwnerIds ?? []), ...(args.targetOwnerId ? [args.targetOwnerId] : [])],
        sql: tx as unknown as Sql,
      });
      if (resolution.refusal) return { value: null, resolution, degradedReason: null };
      registrationStarted = true;
      return { value: await register(goalId, resolution, null), resolution, degradedReason: null };
    }) as unknown as { value: T | null; resolution: GoalLaunchResolution | null; degradedReason: string | null };
  } catch (error) {
    if (registrationStarted || isGoalHolderAuthorityError(error)) throw error;
    const degradedReason = `goal admission registration not enforced — ${error instanceof Error ? error.message : String(error)}`;
    return { value: await register(goalId, null, degradedReason), resolution: null, degradedReason };
  }
}

/**
 * P-006: is the budget launch gate on? Tri-state on purpose: `infraError`
 * distinguishes "the owner turned it off" (deliberate config — silent) from
 * "the flag could not be read" (a declared budget silently unenforced — which
 * the resolution must report as degraded, same principle as an uncountable
 * ceiling). Fail OPEN on error, per the module header: a broken flag read must
 * not brick every launch in the workspace.
 *
 * Dynamic imports keep the flags dependency out of this module's static graph —
 * the same reasoning as the presence-window copy above (this module rides in
 * every launch path), and the same shape as windDownDispositionGateEnabled.
 */
async function budgetLaunchGateEnabled(): Promise<{ enabled: boolean; infraError: string | null }> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([import('@papercusp/flags/server'), import('@papercusp/flags')]);
    return { enabled: await getFlag(FLAGS.GOAL_BUDGET_LAUNCH_GATE, 'system'), infraError: null };
  } catch (e) {
    return { enabled: false, infraError: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * P-006: tell the owner their goal's budget is exhausted and launches are being
 * refused. Fire-and-forget: an escalation write must never delay or fail the
 * launch path (the refusal itself is already returned synchronously). Deduped
 * per goal ({dedupKind, subjectSignature}) so every subsequently refused launch
 * bumps the one card instead of stacking a new one — the
 * deliverGoalWindDownReport pattern.
 */
/**
 * Why a declared ceiling has no figure to judge. Each cause names its own
 * repair, which is why they are not one message.
 */
type BudgetUnmeasurableCause =
  | 'unpriced-lineage-samples'
  | 'unattributed-goal-samples'
  | 'no-lineage-samples'
  | 'interactive-usage-stale'
  | 'interactive-usage-unavailable'
  | 'measurement-failed';

const UNMEASURABLE_SCOPE: Record<BudgetUnmeasurableCause, string> = {
  'unpriced-lineage-samples': REFUSAL_SCOPES.BUDGET_UNMEASURABLE,
  'unattributed-goal-samples': REFUSAL_SCOPES.BUDGET_UNATTRIBUTED,
  'no-lineage-samples': REFUSAL_SCOPES.BUDGET_NO_SAMPLES,
  'interactive-usage-stale': REFUSAL_SCOPES.BUDGET_MEASUREMENT_FAILED,
  'interactive-usage-unavailable': REFUSAL_SCOPES.BUDGET_MEASUREMENT_FAILED,
  'measurement-failed': REFUSAL_SCOPES.BUDGET_MEASUREMENT_FAILED,
};

/**
 * WI-10002052 / D-011 clause 3: a ceiling that cannot MEASURE must not silently
 * fail open. `current: null` is load-bearing: the gate refuses BECAUSE the number
 * is unknown, and a 0 here would assert the very figure it is refusing over not
 * having.
 */
function budgetUnmeasurableRefusal(args: {
  goalId: string;
  budgetCents: number;
  count: number;
  cause: BudgetUnmeasurableCause;
  detail?: string;
}): GoalLaunchRefusal {
  const head = `goal ${args.goalId} declares budget_cents=${args.budgetCents}, but its spend CANNOT BE MEASURED: `;
  const noHeadroom =
    `do not infer headroom from the missing value or raise/clear the ceiling merely to get a launch admitted. ` +
    `⚠ Do NOT attach a pot to change this — goal spend is measured from goal-attributed samples, not pots.`;
  const body =
    args.cause === 'unpriced-lineage-samples'
      ? `the platform snapshot (metadata.spentCents) is null because usage samples attributed to this goal in its ` +
        `budget window carry no price, so any total would only be a floor. Refusing rather than admitting: a ` +
        `ceiling that fails open on a partial measurement never binds. Repair the pricing of those samples ` +
        `(the model or provider that produced them has no cost), or wait for them to leave the window; `
      : args.cause === 'unattributed-goal-samples'
        ? `no usage in its budget window was attributed to the goal at write time (agent_usage_samples.goal_id), ` +
          `yet ${args.detail ?? "the goal's pot/session legs carry usage"}. Spend happened that the authoritative ` +
          `stream never recorded, so any figure would be a floor. Refusing rather than admitting: an empty ` +
          `authoritative stream beside non-empty goal usage is not "nothing spent". Repair write-time goal ` +
          `attribution for those sessions, or wait for the samples to leave the window; `
        : args.cause === 'no-lineage-samples'
          ? `the launch-time measurement found no goal-attributed, pot, or session usage samples in its budget ` +
            `window. An empty stream is unmeasured, not a priced zero; refusing rather than admitting without ` +
            `a figure that can be checked against the ceiling; `
          : isInteractiveUsageUnmeasuredReason(args.cause)
            ? `the goal's interactive usage stream is ${args.cause === 'interactive-usage-stale' ? 'stale' : 'unavailable'}` +
              `${args.detail ? ` (${args.detail})` : ''}, so its priced spend cannot be verified against the ceiling. ` +
              `Refusing rather than treating an unmeasured total as budget headroom; repair the usage ingestion ` +
              `or freshness read before retrying; `
        : `the platform snapshot carries no spend figure, so the gate measured at launch, and that measurement ` +
          `failed (${args.detail ?? 'unknown error'}). With no figure there is no headroom to judge. Refusing ` +
          `rather than admitting: a ceiling that fails open whenever its read fails never binds. Retry once the ` +
          `ledger read succeeds; `;
  return {
    reason: 'goal_budget_unmeasurable',
    limit: args.budgetCents,
    current: null,
    requested: args.count,
    currentScope: UNMEASURABLE_SCOPE[args.cause],
    message: head + body + noHeadroom,
  };
}

function budgetExceededRefusal(args: {
  goalId: string;
  budgetCents: number;
  spentCents: number;
  count: number;
  spendScope: string;
  /** Where the figure came from, rendered after the scope, e.g. ` (platform snapshot at …)`. */
  measuredAt: string;
}): GoalLaunchRefusal {
  return {
    reason: 'goal_budget_exceeded',
    limit: args.budgetCents,
    current: args.spentCents,
    requested: args.count,
    currentScope: args.spendScope,
    message:
      // NAME THE POPULATION (P-004). The scope travels in the sentence, not
      // just in the structured field a human reading the refusal never sees.
      `goal ${args.goalId} has spent ${args.spentCents} of its ${args.budgetCents} cent budget ` +
      `[measured over ${args.spendScope}` +
      `${
        args.spendScope === REFUSAL_SCOPES.BUDGET_UNVERIFIED
          ? ' — this figure carries no provenance marker, so what it counted is unknown'
          : ' — usage attributed to this goal within its budget window'
      }]` +
      `${args.measuredAt}; further agent/fleet ` +
      `launches are refused. Review spend and raise budget_cents on the goal, or wind the goal down. ` +
      `The owner has an open escalation for this (deduped per goal).`,
  };
}

/**
 * D-011 clause 3 at launch time. An absent or stale snapshot is re-measured
 * with the rollup's OWN function; neither an absent figure nor stale ingestion
 * is evidence that nothing was spent.
 *
 * Dynamic import for the reason REFUSAL_SCOPES documents: a static import of
 * `./goals/spend-rollup` would close a runtime cycle through `@papercusp/agent-mcp`.
 */
async function measureGoalSpendAtLaunch(args: {
  workspaceId: string;
  goalId: string;
  windowSec: number | null;
  sql?: Sql;
}): Promise<{ ok: true; rollup: GoalSpendRollup } | { ok: false; error: string }> {
  try {
    const { computeGoalSpendRollup } = await import('./goals/spend-rollup');
    const rollup = await computeGoalSpendRollup(pg(args.sql), {
      workspaceId: args.workspaceId,
      goalId: args.goalId,
      windowSec: args.windowSec,
    });
    return { ok: true, rollup };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type GoalInferenceAdmissionDecision =
  | {
      allowed: true;
      goalId: string | null;
      reason:
        | 'no-goal' | 'no-budget' | 'budget-gate-disabled' | 'under-budget';
    }
  | {
      allowed: false;
      goalId: string;
      status: 403 | 503;
      code: string;
      message: string;
      budgetCents?: number;
      spentCents?: number | null;
      budgetWindowSec?: number | null;
    };

/** Pure decision for the gateway's pre-spool, per-turn goal budget admission. */
export function evaluateGoalInferenceBudget(args: {
  goalId: string;
  goalStatus: string | null;
  budgetCents: number | null;
  budgetWindowSec: number | null;
  rollup?: GoalSpendRollup | null;
  measurementError?: string;
}): GoalInferenceAdmissionDecision {
  if (!args.goalStatus) {
    return {
      allowed: false,
      goalId: args.goalId,
      status: 503,
      code: 'goal_status_unavailable',
      message: `goal ${args.goalId} status could not be verified; inference is refused before provider dispatch`,
    };
  }
  if (args.goalStatus !== 'active') {
    return {
      allowed: false,
      goalId: args.goalId,
      status: 403,
      code: 'goal_inactive',
      message: `goal ${args.goalId} is ${args.goalStatus}; inference is refused until the goal is active`,
    };
  }
  if (args.budgetCents == null) return { allowed: true, goalId: args.goalId, reason: 'no-budget' };

  const refuseUnmeasured = (
    cause: BudgetUnmeasurableCause,
    detail?: string,
  ): GoalInferenceAdmissionDecision => {
    const refusal = budgetUnmeasurableRefusal({
      goalId: args.goalId,
      budgetCents: args.budgetCents!,
      count: 1,
      cause,
      ...(detail ? { detail } : {}),
    });
    return {
      allowed: false,
      goalId: args.goalId,
      status: cause === 'measurement-failed' || isInteractiveUsageUnmeasuredReason(cause) ? 503 : 403,
      code: 'goal_budget_unmeasurable',
      message: `${refusal.message} Model inference requests are refused before provider dispatch.`,
      budgetCents: args.budgetCents!,
      spentCents: null,
      budgetWindowSec: args.budgetWindowSec,
    };
  };

  if (args.measurementError) return refuseUnmeasured('measurement-failed', args.measurementError);
  const rollup = args.rollup;
  if (!rollup) return refuseUnmeasured('measurement-failed', 'the live spend rollup returned no result');
  if (isInteractiveUsageUnmeasuredReason(rollup.unmeasuredReason)) {
    return refuseUnmeasured(rollup.unmeasuredReason, rollup.interactiveUsageFreshness.reason);
  }
  if (rollup.spentCents != null) {
    if (rollup.spentCents >= args.budgetCents) {
      const window = rollup.windowSec == null ? 'the goal lifetime' : `the trailing ${rollup.windowSec}s budget window`;
      return {
        allowed: false,
        goalId: args.goalId,
        status: 403,
        code: 'goal_budget_exceeded',
        message:
          `goal ${args.goalId} has spent ${rollup.spentCents} of its ${args.budgetCents} cent budget over ${window}; ` +
          'further model inference requests are refused before provider dispatch',
        budgetCents: args.budgetCents,
        spentCents: rollup.spentCents,
        budgetWindowSec: args.budgetWindowSec,
      };
    }
    return { allowed: true, goalId: args.goalId, reason: 'under-budget' };
  }
  if (rollup.unmeasuredReason === 'unpriced-lineage-samples') {
    return refuseUnmeasured('unpriced-lineage-samples');
  }
  if (rollup.samples > 0 || rollup.lineage.samples > 0) {
    return refuseUnmeasured(
      'unattributed-goal-samples',
      `the goal's pot/session legs carry ${rollup.samples} usage sample(s) ` +
        `(${rollup.pot.samples} pot, ${rollup.session.samples} session)`,
    );
  }
  // D-011 clause 3: empty measurement is still unmeasured, never priced zero.
  return refuseUnmeasured('no-lineage-samples');
}

/**
 * Resolve current goal context and measure its current budget window for every
 * inference turn. Unlike launch admission, this reads the source ledger rather
 * than trusting the periodic metadata snapshot.
 */
export async function checkGoalInferenceAdmission(args: {
  workspaceId: string;
  ownerId: string;
  sql?: Sql;
}): Promise<GoalInferenceAdmissionDecision> {
  let goalId: string | null;
  try {
    goalId = await resolveGoalContext(args.workspaceId, args.ownerId, args.sql);
  } catch (error) {
    const superseded = isGoalHolderAuthorityError(error) && error.code === 'goal_holder_superseded';
    return {
      allowed: false,
      goalId: isGoalHolderAuthorityError(error) ? error.authority?.goalId ?? 'unknown' : 'unknown',
      status: superseded ? 403 : 503,
      code: superseded ? 'goal_holder_superseded' : 'goal_context_unavailable',
      message: superseded
        ? 'this session is no longer an authorized goal holder; inference is refused'
        : 'goal context could not be verified; inference is refused before provider dispatch',
    };
  }
  if (!goalId) return { allowed: true, goalId: null, reason: 'no-goal' };

  let rows: Array<{ status?: unknown; budget_cents?: unknown; budget_window_sec?: unknown }>;
  try {
    rows = await pg(args.sql)<Array<{ status?: unknown; budget_cents?: unknown; budget_window_sec?: unknown }>>`
      SELECT status, budget_cents, budget_window_sec
        FROM harness_shared.goals
       WHERE id = ${goalId} AND workspace_id = ${args.workspaceId}
       LIMIT 1`;
  } catch {
    return {
      allowed: false,
      goalId,
      status: 503,
      code: 'goal_budget_read_unavailable',
      message: `goal ${goalId} status and budget could not be read; inference is refused before provider dispatch`,
    };
  }
  const row = rows[0];
  if (!row) {
    return {
      allowed: false,
      goalId,
      status: 503,
      code: 'goal_budget_read_unavailable',
      message: `goal ${goalId} is missing from the current workspace; inference is refused before provider dispatch`,
    };
  }
  const goalStatus = typeof row.status === 'string' ? row.status.trim() || null : null;
  const budgetCents = asFiniteCents(row.budget_cents);
  const budgetWindowSec = asFiniteNumber(row.budget_window_sec);
  if ((row.budget_cents != null && budgetCents == null) || (row.budget_window_sec != null && budgetWindowSec == null)) {
    return {
      allowed: false,
      goalId,
      status: 503,
      code: 'goal_budget_read_unavailable',
      message: `goal ${goalId} budget or window is invalid; inference is refused before provider dispatch`,
    };
  }
  if (!goalStatus || goalStatus !== 'active') {
    return evaluateGoalInferenceBudget({ goalId, goalStatus, budgetCents, budgetWindowSec });
  }
  if (budgetCents == null) return { allowed: true, goalId, reason: 'no-budget' };

  const gate = await budgetLaunchGateEnabled();
  if (gate.infraError) {
    return {
      allowed: false,
      goalId,
      status: 503,
      code: 'goal_budget_gate_unavailable',
      message: `goal ${goalId} budget enforcement could not be verified; inference is refused before provider dispatch`,
      budgetCents,
      budgetWindowSec,
    };
  }
  if (!gate.enabled) return { allowed: true, goalId, reason: 'budget-gate-disabled' };

  const live = await measureGoalSpendAtLaunch({
    workspaceId: args.workspaceId,
    goalId,
    windowSec: budgetWindowSec,
    sql: args.sql,
  });
  return evaluateGoalInferenceBudget({
    goalId,
    goalStatus,
    budgetCents,
    budgetWindowSec,
    ...(live.ok ? { rollup: live.rollup } : { measurementError: live.error }),
  });
}

function escalateBudgetRefusal(args: {
  workspaceId: string;
  goalId: string;
  launcherOwnerId?: string | null;
  refusal: GoalLaunchRefusal;
}): void {
  void (async () => {
    const { openEscalation } = await import('./agent-tools/coordination/escalations');
    await openEscalation(
      {
        // Attributed to the refused launcher when known; otherwise the gate
        // itself. 'principal' = in-process caller, the closest source for a
        // platform gate speaking for itself.
        ownerId: args.launcherOwnerId || `goal-budget-gate:${args.goalId}`,
        ownerLabel: 'goal budget launch gate',
        source: 'principal',
        workspaceId: args.workspaceId,
        userId: null,
      },
      {
        // 'blocker': launches are actively being refused until the owner raises
        // the budget or winds the goal down (EscalationSeverity has no 'major').
        severity: 'blocker',
        summary:
          args.refusal.reason === 'goal_budget_unmeasurable'
            ? `goal ${args.goalId}: budget UNMEASURABLE — further launches refused`
            : `goal ${args.goalId}: budget exhausted — further launches refused`,
        body: args.refusal.message,
        meta: {
          // WI-10002052: distinct dedup kinds on purpose. "Exhausted" and
          // "unmeasurable" are different owner problems with different levers,
          // so collapsing them onto one card would let whichever fired first
          // hide the other for as long as it stays open.
          dedupKind:
            args.refusal.reason === 'goal_budget_unmeasurable' ? 'goal-budget-unmeasurable' : 'goal-budget-exceeded',
          subjectSignature: `${args.workspaceId}:${args.goalId}`,
          goalId: args.goalId,
          budgetCents: args.refusal.limit,
          spentCents: args.refusal.current,
        },
      },
    );
  })().catch((e: unknown) => {
    console.warn(
      `[goal-budget-gate] owner escalation failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  });
}

/**
 * Fold a goal's stored profiles into the effective one for a role.
 *
 * Precedence, most specific first: what the CALLER explicitly asked for, then the
 * per-role profile, then the goal's defaults. An explicitly requested value
 * always wins — the settings are the goal agent's standing policy, not an
 * override of a decision it just made deliberately for one launch.
 *
 * Absent stays absent: a key nobody set is left off so the launch composer
 * applies the SYSTEM default (e.g. `defaultLaunchAccount()`), rather than this
 * function inventing a value and pinning it.
 */
export function foldLaunchProfile(
  settings: GoalLaunchSettings | null,
  goalRole: GoalLaunchRole | null | undefined,
  requested?: LaunchProfile | null,
): LaunchProfile {
  const out: LaunchProfile = {};
  const layers: Array<LaunchProfile | undefined> = [
    settings?.defaults,
    goalRole ? settings?.roles?.[goalRole] : undefined,
    requested ?? undefined,
  ];
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v !== undefined && v !== null && v !== '') (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/**
 * THE resolver every launch path calls.
 *
 * Note what it does NOT take: a `goalId`. It derives one from the launcher, so
 * no door can drop goal context by forgetting an argument (D-008/D-009).
 *
 * `count` is how many agents this launch intends to start, so a fleet asking for
 * 10 seats against a ceiling with room for 3 is refused ONCE here rather than
 * discovering it on the 4th spawn with 3 half-briefed members already running.
 */
export async function resolveGoalLaunch(args: {
  workspaceId: string;
  /** The owner id of the agent DOING the launching — the goal is derived from it. */
  launcherOwnerId: string;
  /**
   * D-016: the launch SLOT this spawn fills, NOT psu `--role`. Pass null when
   * the door cannot determine one — an absent role layer is correct, whereas a
   * psu role here silently mis-binds (that was WI-38048).
   */
  goalRole?: GoalLaunchRole | null;
  fleetSlug?: string | null;
  /** How many agents this launch will start. Default 1. */
  count?: number;
  /**
   * Owner ids this launch REPLACES (fleet:respawn-member): excluded from the
   * ceiling headcount so a respawn is net-zero. See {@link goalHeadcount}.
   */
  excludeOwnerIds?: readonly string[];
  requested?: LaunchProfile | null;
  sql?: Sql;
}): Promise<GoalLaunchResolution> {
  const degradedReasons: string[] = [];
  let goalId: string | null = null;
  try {
    goalId = await resolveGoalContext(args.workspaceId, args.launcherOwnerId, args.sql);
  } catch (e) {
    if (isFatalGoalHolderVerdict(e)) throw e;
    // resolveGoalContext USED to be fail-soft, so reaching here used to mean
    // something below it broke hard. Since 02d9c38d1f it also refuses when the
    // authority store is merely unreadable, so this leg is now the normal path
    // for a storage blip too (WI-1195329). Either way: no goal context = no
    // ceiling and no profile, which is exactly the pre-P-004 behaviour — but
    // say so, rather than failing the launch.
    degradedReasons.push(`goal context unresolved: ${e instanceof Error ? e.message : String(e)}`);
  }
  return resolveGoalLaunchForGoal({ ...args, goalId, priorDegraded: degradedReasons });
}

/**
 * The same resolution for a goal named EXPLICITLY.
 *
 * Exists for exactly one shape of caller: the door that is MINTING the
 * association rather than inheriting it. `goals:start` launches a goal's own
 * agent, so at that moment the goal is the SUBJECT of the launch and not yet
 * anybody's context — `resolveGoalContext(caller)` correctly returns null there,
 * and the goal's own settings (which model its agent runs at, how many agents it
 * may go on to spawn) must still apply.
 *
 * Prefer {@link resolveGoalLaunch} everywhere else. Taking a `goalId` is exactly
 * the thing a door can forget to pass, which is why the launcher-derived form is
 * the default and this one is the documented exception rather than the general
 * API.
 */
export async function resolveGoalLaunchForGoal(args: {
  workspaceId: string;
  goalId: string | null;
  /** D-016: the launch SLOT, not psu `--role`. See {@link resolveGoalLaunch}. */
  goalRole?: GoalLaunchRole | null;
  fleetSlug?: string | null;
  count?: number;
  /** Owner ids this launch replaces — not charged against the ceilings. See {@link goalHeadcount}. */
  excludeOwnerIds?: readonly string[];
  requested?: LaunchProfile | null;
  sql?: Sql;
  /** Degraded reasons accumulated by a caller before delegating here. */
  priorDegraded?: string[];
  /**
   * P-006: the owner id of the agent DOING the launching, when known — flows in
   * from {@link resolveGoalLaunch}'s spread. Used ONLY to attribute the budget
   * escalation; never consulted for the decision itself.
   */
  launcherOwnerId?: string | null;
}): Promise<GoalLaunchResolution> {
  const count = Math.max(1, Math.floor(args.count ?? 1));
  const degradedReasons: string[] = [...(args.priorDegraded ?? [])];
  const goalId = args.goalId;
  if (!goalId) {
    return {
      goalId: null,
      settings: null,
      goalBrief: null,
      holderReadiness: null,
      effective: foldLaunchProfile(null, args.goalRole, args.requested),
      ceilings: { maxAgents: null, maxPerFleet: null },
      headcount: { total: 0, fleet: args.fleetSlug ? 0 : null },
      budget: null,
      refusal: null,
      degraded: degradedReasons.length > 0,
      degradedReasons,
    };
  }

  const {
    settings,
    budget,
    brief: rawGoalBrief,
    error: settingsError,
  } = await readGoalLaunchSettings(goalId, args.sql);
  let goalBrief = rawGoalBrief;
  if (settingsError) degradedReasons.push(`launch settings not applied: ${settingsError}`);

  // P-006 (D-001/D-011): goals.budget_cents is a BINDING ceiling over the
  // goal-attributed spend stream, checked FIRST — an exhausted budget refuses the
  // launch regardless of agent headroom, and a formed refusal skips the
  // headcount read entirely. The snapshot is authoritative only when its
  // provenance marker identifies one of the platform writers; a legacy or
  // otherwise unmarked value triggers a live rollup rather than deciding from
  // an unknown population. Measured budget
  // spend and unmeasured live rollups are binding; the fail-open rule for agent
  // headcount does not apply to an unmeasured budget. `>=` and not `>`: a goal
  // that has REACHED it is out of budget — an off-by-one here admits one launch
  // past every budget in the workspace.
  let refusal: GoalLaunchRefusal | null = null;
  if (budget?.budgetCents != null) {
    const gate = await budgetLaunchGateEnabled();
    if (gate.infraError) {
      degradedReasons.push(`budget ceiling not enforced — flag read failed: ${gate.infraError}`);
    } else if (gate.enabled) {
      const recordedFreshness = budget.interactiveUsageFreshnessStatus === 'fresh'
        ? evaluateInteractiveUsageFreshness(budget.interactiveUsageLastIngestedAtMs)
        : null;
      const snapshotIsFresh = recordedFreshness?.status === 'fresh';
      if (budget.spentCents == null && budget.unmeasuredPricedSpend && snapshotIsFresh) {
        // WI-10002052 / D-011 clause 3: a ceiling that cannot MEASURE must not
        // silently fail open. A null spentCents has two populations behind it,
        // and only this one is a hole: the goal's window holds attributed
        // samples with no price, so the total is unknown and any figure would
        // be a floor. Failing open here admits launches past a ceiling nobody
        // can check, for as long as those samples stay in the window.
        refusal = budgetUnmeasurableRefusal({
          goalId,
          budgetCents: budget.budgetCents,
          count,
          cause: 'unpriced-lineage-samples',
        });
        // Refusing without telling anyone would trade a silent fail-OPEN for a
        // silent fail-CLOSED — the same invisibility defect pointed the other
        // way. Keep the owner informed while the measurement repair is pursued;
        // the refusal grants no authority to widen or clear the budget.
        escalateBudgetRefusal({
          workspaceId: args.workspaceId,
          goalId,
          launcherOwnerId: args.launcherOwnerId,
          refusal,
        });
      } else if (
        budget.spentCents == null || !snapshotIsFresh ||
        budgetSpendScope(budget.spentCentsSource) !== REFUSAL_SCOPES.BUDGET_LINEAGE
      ) {
        // The other null: no snapshot at all (the rollup has not ticked for this
        // goal yet), a window whose write-time-attributed stream is empty, or a
        // snapshot whose interactive-usage watermark is no longer fresh, or a
        // cached figure without authoritative provenance. None can safely
        // enforce from cached cents, so re-measure with the rollup's
        // own function before deciding.
        const live = await measureGoalSpendAtLaunch({
          workspaceId: args.workspaceId,
          goalId,
          windowSec: rawGoalBrief?.budgetWindowSec ?? null,
          sql: args.sql,
        });
        if (!live.ok) {
          refusal = budgetUnmeasurableRefusal({
            goalId,
            budgetCents: budget.budgetCents,
            count,
            cause: 'measurement-failed',
            detail: live.error,
          });
        } else if (isInteractiveUsageUnmeasuredReason(live.rollup.unmeasuredReason)) {
          refusal = budgetUnmeasurableRefusal({
            goalId,
            budgetCents: budget.budgetCents,
            count,
            cause: live.rollup.unmeasuredReason,
            detail: live.rollup.interactiveUsageFreshness.reason,
          });
        } else if (live.rollup.spentCents != null) {
          if (live.rollup.spentCents >= budget.budgetCents) {
            refusal = budgetExceededRefusal({
              goalId,
              budgetCents: budget.budgetCents,
              spentCents: live.rollup.spentCents,
              count,
              spendScope: REFUSAL_SCOPES.BUDGET_LINEAGE,
              measuredAt: ' (measured at launch; the platform snapshot carried no figure)',
            });
          }
        } else if (live.rollup.unmeasuredReason === 'unpriced-lineage-samples') {
          refusal = budgetUnmeasurableRefusal({
            goalId,
            budgetCents: budget.budgetCents,
            count,
            cause: 'unpriced-lineage-samples',
          });
        } else if (live.rollup.samples > 0) {
          refusal = budgetUnmeasurableRefusal({
            goalId,
            budgetCents: budget.budgetCents,
            count,
            cause: 'unattributed-goal-samples',
            detail:
              `the goal's pot/session legs carry ${live.rollup.samples} usage sample(s) in the same window ` +
              `(${live.rollup.pot.samples} pot, ${live.rollup.session.samples} session)`,
          });
        } else {
          // D-011 clause 3 and accepted R-3: no samples is an unmeasured
          // figure, not proof of a priced zero or available budget headroom.
          refusal = budgetUnmeasurableRefusal({
            goalId,
            budgetCents: budget.budgetCents,
            count,
            cause: 'no-lineage-samples',
          });
        }
        if (refusal) {
          escalateBudgetRefusal({
            workspaceId: args.workspaceId,
            goalId,
            launcherOwnerId: args.launcherOwnerId,
            refusal,
          });
        }
      } else if (budget.spentCents >= budget.budgetCents) {
        refusal = budgetExceededRefusal({
          goalId,
          budgetCents: budget.budgetCents,
          spentCents: budget.spentCents,
          count,
          spendScope: budgetSpendScope(budget.spentCentsSource),
          measuredAt: budget.spentCentsAt ? ` (platform snapshot at ${budget.spentCentsAt})` : '',
        });
        escalateBudgetRefusal({
          workspaceId: args.workspaceId,
          goalId,
          launcherOwnerId: args.launcherOwnerId,
          refusal,
        });
      }
    }
  }

  const effective = foldLaunchProfile(settings, args.goalRole, args.requested);
  // D-015: an unpinned ceiling resolves to the SYSTEM DEFAULT, not to null.
  // Only an explicit 'unlimited' still lands on null here.
  const ceilings = {
    maxAgents: resolveCeiling(settings?.maxAgents, GOAL_LAUNCH_DEFAULTS.maxAgents),
    maxPerFleet: resolveCeiling(settings?.maxPerFleet, GOAL_LAUNCH_DEFAULTS.maxPerFleet),
  };

  // Only pay for the count when a ceiling actually exists to check it against
  // AND no budget refusal already formed (a refused launch needs no headcount).
  // Since D-015 the ceiling half is the normal case — it goes false only for a
  // goal that has explicitly declared BOTH ceilings unlimited.
  const needsCount = !refusal && (ceilings.maxAgents != null || ceilings.maxPerFleet != null);
  let headcount: GoalHeadcount = { total: 0, fleet: args.fleetSlug ? 0 : null };
  let headcountMeasurement: GoalHeadcountMeasurement | null = null;
  if (needsCount) {
    const counted = await goalHeadcount({
      workspaceId: args.workspaceId,
      goalId,
      fleetSlug: args.fleetSlug ?? null,
      excludeOwnerIds: args.excludeOwnerIds,
      sql: args.sql,
    });
    headcount = counted.headcount;
    headcountMeasurement = counted.measurement;
    if (counted.error) degradedReasons.push(`ceiling not enforced — headcount failed: ${counted.error}`);
  }

  // A ceiling we could not count is not enforced. Fail OPEN and say so (see the
  // module header): refusing every launch on a transient count failure would take
  // out the whole workspace, including whatever would fix it.
  const enforceable = needsCount && !degradedReasons.some((r) => r.startsWith('ceiling not enforced'));
  // Name the SOURCE of the number in the refusal. The first time a default fires
  // it refuses a launch against a ceiling the owner never typed, and "raise
  // maxAgents" sends them looking for a value that is not in the panel.
  const provenance = (pinned: unknown): string =>
    pinned == null ? ' (the system default — this goal has not pinned one)' : '';
  if (enforceable) {
    if (ceilings.maxAgents != null && headcount.total + count > ceilings.maxAgents) {
      refusal = {
        reason: 'goal_max_agents',
        limit: ceilings.maxAgents,
        current: headcount.total,
        requested: count,
        // Already named inline ("N live") in the prose below; carried structurally
        // too so a consumer never has to parse a sentence to learn the population.
        currentScope: REFUSAL_SCOPES.LIVE_AGENTS_IN_GOAL,
        message:
          `goal ${goalId} allows ${ceilings.maxAgents} concurrent agent(s)${provenance(settings?.maxAgents)}; ` +
          `${headcount.total} live, so launching ${count} more would exceed it. Raise maxAgents in the goal's ` +
          `launch settings (or set it to '${UNLIMITED_CEILING}'), or wind down finished sessions first. ` +
          `To free a slot, end each finished session with \`session:end\` (self-only). If the direct ` +
          `\`session:end\` wrapper is unavailable, use \`tools:find\` to locate \`session:end\`, then ` +
          `\`tools:invoke\` the returned exact tool name with \`{}\`. Do not idle or park the session: ` +
          `idle/parked sessions still retain this goal's concurrency slot until \`session:end\` completes.`,
      };
    } else if (
      ceilings.maxPerFleet != null &&
      args.fleetSlug &&
      (headcount.fleet ?? 0) + count > ceilings.maxPerFleet
    ) {
      refusal = {
        reason: 'fleet_max_agents',
        limit: ceilings.maxPerFleet,
        current: headcount.fleet ?? 0,
        requested: count,
        currentScope: REFUSAL_SCOPES.LIVE_AGENTS_IN_FLEET,
        message:
          `goal ${goalId} allows ${ceilings.maxPerFleet} agent(s) per fleet${provenance(settings?.maxPerFleet)}; ` +
          `fleet ${args.fleetSlug} has ${headcount.fleet ?? 0} live, so launching ${count} more would exceed it. ` +
          `Raise maxPerFleet in the goal's launch settings, or split the work across another fleet (it still ` +
          `counts against maxAgents).`,
      };
    }
  }

  // P-012: only the goal-holder slot pays for the portfolio read. Ordinary
  // descendant launches still use this resolver for policy/ceilings, but their
  // kickoff is not a portfolio-manager kickoff and must not assemble the whole
  // goal on every child spawn.
  let holderReadiness: GoalOperatingInputs | null = null;
  if (args.goalRole === 'goal' && goalBrief) {
    const portfolio = await readGoalPortfolioBrief({
      workspaceId: args.workspaceId,
      goalId,
      sql: args.sql,
      launch: {
        goalBrief,
        settings,
        budget,
        ceilings,
        headcount,
        degradedReasons,
      },
    });
    if (portfolio) {
      goalBrief = { ...goalBrief, portfolio };
      holderReadiness = portfolio.operatingInputs ?? null;
    }
  }
  if (args.goalRole === 'goal' && !holderReadiness) {
    holderReadiness = evaluateGoalOperatingInputs({
      standing: goalBrief?.standing ?? false,
      killCriterion: goalBrief?.killCriterion ?? null,
      budgetCents: budget?.budgetCents ?? goalBrief?.budgetCents ?? null,
      budgetWindowSec: goalBrief?.budgetWindowSec ?? null,
      spentCents: budget?.spentCents ?? null,
      spentCentsSource: budget?.spentCentsSource ?? null,
      unmeasuredPricedSpend: budget?.unmeasuredPricedSpend ?? false,
      tripwires: null,
      portfolioReadFailed: true,
    });
  }

  return {
    goalId,
    settings,
    goalBrief,
    holderReadiness,
    effective,
    ceilings,
    headcount,
    headcountMeasurement,
    budget,
    refusal,
    degraded: degradedReasons.length > 0,
    degradedReasons,
  };
}
